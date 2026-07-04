/**
 * Hone Build Coordinator — Perry-compiled native binary.
 *
 * Bridges the marketplace to perry-hub for plugin compilation.
 * Same pattern as hone-auth: Fastify + MySQL, single file, all Perry constraints.
 *
 * Perry async constraints (all workarounds applied):
 * - NO function calls that return strings in async context
 * - NO fetch() — use execSync + curl for outbound HTTP
 * - NO JSON.stringify/JSON.parse in async — manual string building
 * - NO new Date() — use Date.now()
 * - All param extraction inlined in handlers
 * - writeFileSync for temp files, execSync for shell commands
 */

import Fastify from 'fastify';
import mysql2 from 'mysql2/promise';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { t } from 'perry/i18n';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let dbHost = 'webserver.skelpo.net';
let dbUser = 'hone';
let dbPass = '';
let dbName = 'hone_marketplace';
let httpPort = 8447;
let perryHubUrl = 'https://hub.perryts.com';
let perryHubLicenseKey = '';
let packagesDir = '../hone-marketplace/data/packages';
let uploadsDir = './data/uploads';
// Shared secret gating /upload and the /artifact callback. When set, callers must
// present a matching ?token=. Leave empty only for isolated local dev.
let uploadSecret = '';

try {
  const conf = readFileSync('./build.conf', 'utf-8');
  const lines = conf.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 3) continue;
    if (line.charCodeAt(0) === 35) continue; // skip # comments
    let eqIdx = -1;
    for (let j = 0; j < line.length; j++) {
      if (line.charCodeAt(j) === 61) { eqIdx = j; break; }
    }
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx);
    const val = line.slice(eqIdx + 1);
    if (key === 'DB_HOST') dbHost = val;
    if (key === 'DB_USER') dbUser = val;
    if (key === 'DB_PASS') dbPass = val;
    if (key === 'DB_NAME') dbName = val;
    if (key === 'PORT') httpPort = Number(val);
    if (key === 'PERRY_HUB_URL') perryHubUrl = val;
    if (key === 'PERRY_HUB_LICENSE_KEY') perryHubLicenseKey = val;
    if (key === 'PACKAGES_DIR') packagesDir = val;
    if (key === 'UPLOADS_DIR') uploadsDir = val;
    if (key === 'UPLOAD_SECRET') uploadSecret = val;
  }
} catch (e: any) { /* no config file — use defaults */ }

// Ensure directories exist (execSync mkdir -p is safe to call multiple times)
try { execSync('mkdir -p ' + uploadsDir); } catch (e: any) { /* ignore */ }
try { execSync('mkdir -p ' + packagesDir); } catch (e: any) { /* ignore */ }

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const pool = mysql2.createPool({
  host: dbHost,
  user: dbUser,
  password: dbPass,
  database: dbName,
  waitForConnections: true,
  connectionLimit: 5,
});

// ---------------------------------------------------------------------------
// Helpers — all return void or numbers (Perry safe)
// ---------------------------------------------------------------------------

let _extracted = '';

function extractParam(url: string, paramName: string): void {
  _extracted = '';
  const idx = url.indexOf(paramName);
  if (idx < 0) return;
  const start = idx + paramName.length;
  let end = start;
  while (end < url.length) {
    if (url.charCodeAt(end) === 38) break; // &
    end = end + 1;
  }
  _extracted = url.slice(start, end);
}

function extractPathSegment(url: string, prefix: string): void {
  _extracted = '';
  if (url.length <= prefix.length) return;
  const start = prefix.length;
  let end = start;
  while (end < url.length) {
    const c = url.charCodeAt(end);
    if (c === 63 || c === 47) break; // ? or /
    end = end + 1;
  }
  _extracted = url.slice(start, end);
}

let _subPath = '';

function extractSubPath(url: string, prefix: string): void {
  _subPath = '';
  if (url.length <= prefix.length) return;
  const start = prefix.length;
  let nameEnd = start;
  while (nameEnd < url.length) {
    const c = url.charCodeAt(nameEnd);
    if (c === 63 || c === 47) break;
    nameEnd = nameEnd + 1;
  }
  if (nameEnd < url.length && url.charCodeAt(nameEnd) === 47) {
    let subEnd = nameEnd + 1;
    while (subEnd < url.length) {
      if (url.charCodeAt(subEnd) === 63) break;
      subEnd = subEnd + 1;
    }
    _subPath = url.slice(nameEnd + 1, subEnd);
  }
}

// Map perry-hub platform names to storage identifiers (void, writes _extracted)
function normalizePlatform(platform: string): void {
  if (platform === 'macos') _extracted = 'darwin-arm64';
  else if (platform === 'linux') _extracted = 'linux-x64';
  else if (platform === 'windows') _extracted = 'windows-x64';
  else if (platform === 'ios') _extracted = 'ios-arm64';
  else if (platform === 'android') _extracted = 'android-arm64';
  else _extracted = platform;
}

// Extract a JSON string value by key (void, writes _extracted)
// Only works for simple {"key":"value"} — no nesting
function extractJsonString(json: string, key: string): void {
  _extracted = '';
  let search = '"';
  search += key;
  search += '":"';
  const idx = json.indexOf(search);
  if (idx < 0) return;
  const start = idx + search.length;
  let end = start;
  while (end < json.length) {
    if (json.charCodeAt(end) === 34) break; // "
    end = end + 1;
  }
  _extracted = json.slice(start, end);
}

// DJB2 hash for temp file naming (returns number — Perry safe)
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) + s.charCodeAt(i)) | 0;
  }
  if (h < 0) h = -h;
  return h;
}

// Strict allowlist for names/versions/platforms that flow into shell commands
// (execSync) and filesystem paths. Only [A-Za-z0-9._-], non-empty, no "..".
// This is the primary defense against command injection (CWE-78) and path
// traversal (CWE-22) on /upload and /artifact.
function isSafeIdent(s: string): boolean {
  if (s.length === 0 || s.length > 128) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45;
    if (!ok) return false;
    if (c === 46 && i > 0 && s.charCodeAt(i - 1) === 46) return false; // reject ".."
  }
  return true;
}

// Entry is a relative source path: allow [A-Za-z0-9._/-], no "..", no leading "/".
// Written into a manifest file (not directly into a shell) but validated defensively.
function isSafeEntry(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false;
  if (s.charCodeAt(0) === 47) return false; // no absolute path
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45 || c === 47;
    if (!ok) return false;
    if (c === 46 && i > 0 && s.charCodeAt(i - 1) === 46) return false; // reject ".."
  }
  return true;
}

// Length-checked byte compare for secret tokens.
function strEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false, bodyLimit: 209715200 }); // 200MB limit

// ===== HEALTH =====

app.get('/health', async (request: any, reply: any) => {
  reply.header('Content-Type', 'application/json');
  return '{"status":"ok","service":"hone-build"}';
});

// ===== UPLOAD — Accept plugin source + trigger builds =====

app.post('/upload', async (request: any, reply: any) => {
  reply.header('Content-Type', 'application/json');
  const url = String(request.url);

  // Require a matching upload secret when configured. This route shells out to
  // perry-hub, so it must not be open to the network.
  if (uploadSecret.length > 0) {
    extractParam(url, 'token=');
    if (!strEq(_extracted, uploadSecret)) {
      reply.status(401);
      return '{"error":"' + t('authentication required') + '"}';
    }
  }

  // Extract metadata from query params
  extractParam(url, 'name=');
  const pluginName = _extracted;
  extractParam(url, 'version=');
  const version = _extracted;
  extractParam(url, 'displayName=');
  const displayName = _extracted;
  extractParam(url, 'description=');
  const description = _extracted;
  extractParam(url, 'entry=');
  let entry = _extracted;
  if (entry.length === 0) entry = 'src/index.ts';

  if (pluginName.length === 0) {
    reply.status(400);
    return '{"error":"' + t('name required') + '"}';
  }
  if (version.length === 0) {
    reply.status(400);
    return '{"error":"' + t('version required') + '"}';
  }
  // Reject anything that could break out of a shell argument or escape the
  // uploads/packages directory before these values touch execSync or a path.
  if (!isSafeIdent(pluginName) || !isSafeIdent(version)) {
    reply.status(400);
    return '{"error":"' + t('name and version must match [A-Za-z0-9._-]') + '"}';
  }
  if (!isSafeEntry(entry)) {
    reply.status(400);
    return '{"error":"' + t('invalid entry path') + '"}';
  }

  // Read tarball from request body (base64-encoded)
  const body = String(request.body);
  if (body.length < 10) {
    reply.status(400);
    return '{"error":"' + t('tarball body required (base64)') + '"}';
  }

  // Ensure plugin exists in DB
  const now = Math.floor(Date.now() / 1000);

  const [existingRows]: any = await pool.execute(
    'SELECT id FROM plugins WHERE name = ?',
    [pluginName]
  );

  let pluginId = 0;
  if (existingRows.length > 0) {
    pluginId = Number(existingRows[0].id);
    await pool.execute(
      'UPDATE plugins SET displayName = ?, description = ?, updatedAt = ? WHERE id = ?',
      [displayName.length > 0 ? displayName : pluginName, description, now, pluginId]
    );
  } else {
    const [result]: any = await pool.execute(
      'INSERT INTO plugins (name, displayName, description, publishedAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      [pluginName, displayName.length > 0 ? displayName : pluginName, description, now, now]
    );
    pluginId = Number(result.insertId);
  }

  // Insert version if not exists
  const [existingVer]: any = await pool.execute(
    'SELECT id FROM pluginVersions WHERE pluginId = ? AND version = ?',
    [pluginId, version]
  );
  if (existingVer.length === 0) {
    await pool.execute(
      'INSERT INTO pluginVersions (pluginId, version, publishedAt) VALUES (?, ?, ?)',
      [pluginId, version, now]
    );
  }

  // --- All DB awaits done. Now sync operations only. ---

  // Write tarball to disk
  const nameHash = djb2(pluginName);
  let tarballPath = uploadsDir;
  tarballPath += '/';
  tarballPath += pluginName;
  tarballPath += '-';
  tarballPath += version;
  tarballPath += '.tar.gz.b64';
  writeFileSync(tarballPath, body);

  // Build manifest JSON manually (sync string ops)
  let manifest = '{"app_name":"';
  manifest += pluginName;
  manifest += '","bundle_id":"codes.hone.plugin.';
  manifest += pluginName;
  manifest += '","version":"';
  manifest += version;
  manifest += '","entry":"';
  manifest += entry;
  manifest += '","build_type":"plugin","targets":["PLATFORM_PLACEHOLDER"]}';

  // Submit build to perry-hub for each platform
  let resp = '{"success":true,"pluginName":"';
  resp += pluginName;
  resp += '","version":"';
  resp += version;
  resp += '","builds":[';

  let buildCount = 0;

  // Platform 0: macOS
  let m0 = manifest.slice(0, manifest.indexOf('PLATFORM_PLACEHOLDER'));
  m0 += 'macos';
  m0 += manifest.slice(manifest.indexOf('PLATFORM_PLACEHOLDER') + 20);
  let jobId0 = submitToHub(pluginName, version, 'macos', m0, tarballPath);
  if (buildCount > 0) resp += ',';
  resp += '{"platform":"macos","jobId":"';
  resp += jobId0;
  resp += '","status":"';
  resp += jobId0.length > 0 ? 'queued' : 'error';
  resp += '"}';
  buildCount = buildCount + 1;

  // Platform 1: linux
  let m1 = manifest.slice(0, manifest.indexOf('PLATFORM_PLACEHOLDER'));
  m1 += 'linux';
  m1 += manifest.slice(manifest.indexOf('PLATFORM_PLACEHOLDER') + 20);
  let jobId1 = submitToHub(pluginName, version, 'linux', m1, tarballPath);
  resp += ',{"platform":"linux","jobId":"';
  resp += jobId1;
  resp += '","status":"';
  resp += jobId1.length > 0 ? 'queued' : 'error';
  resp += '"}';

  // Platform 2: windows
  let m2 = manifest.slice(0, manifest.indexOf('PLATFORM_PLACEHOLDER'));
  m2 += 'windows';
  m2 += manifest.slice(manifest.indexOf('PLATFORM_PLACEHOLDER') + 20);
  let jobId2 = submitToHub(pluginName, version, 'windows', m2, tarballPath);
  resp += ',{"platform":"windows","jobId":"';
  resp += jobId2;
  resp += '","status":"';
  resp += jobId2.length > 0 ? 'queued' : 'error';
  resp += '"}';

  resp += ']}';

  // Store build jobs in DB (fire-and-forget — don't await to avoid string corruption)
  if (jobId0.length > 0) {
    pool.execute(
      'INSERT INTO buildJobs (pluginId, version, platform, hubJobId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [pluginId, version, 'macos', jobId0, 'queued', now]
    );
  }
  if (jobId1.length > 0) {
    pool.execute(
      'INSERT INTO buildJobs (pluginId, version, platform, hubJobId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [pluginId, version, 'linux', jobId1, 'queued', now]
    );
  }
  if (jobId2.length > 0) {
    pool.execute(
      'INSERT INTO buildJobs (pluginId, version, platform, hubJobId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [pluginId, version, 'windows', jobId2, 'queued', now]
    );
  }

  return resp;
});

// Submit a single build to perry-hub via curl (sync — returns job ID string)
// Called AFTER last await in handler — string return is safe
function submitToHub(pluginName: string, version: string, platform: string, manifestJson: string, tarballPath: string): string {
  // Use a unique temp prefix based on name+version+platform
  let prefix = '/tmp/hb-';
  prefix += String(djb2(pluginName));
  prefix += '-';
  prefix += platform;

  let manifestPath = prefix;
  manifestPath += '-manifest.json';
  writeFileSync(manifestPath, manifestJson);

  let callbackUrl = 'http://localhost:';
  callbackUrl += String(httpPort);
  callbackUrl += '/artifact/';
  callbackUrl += pluginName;
  callbackUrl += '-';
  callbackUrl += version;
  callbackUrl += '-';
  callbackUrl += platform;
  // Carry the upload secret back on the callback so /artifact can authenticate it.
  if (uploadSecret.length > 0) {
    callbackUrl += '?token=';
    callbackUrl += uploadSecret;
  }

  let responsePath = prefix;
  responsePath += '-response.json';

  // Build curl command
  let cmd = 'curl -s -m 30 -X POST';
  cmd += ' -F "license_key=';
  cmd += perryHubLicenseKey;
  cmd += '"';
  cmd += ' -F "manifest=<';
  cmd += manifestPath;
  cmd += '"';
  cmd += ' -F "tarball_b64=<';
  cmd += tarballPath;
  cmd += '"';
  cmd += ' -F "artifact_upload_url=';
  cmd += callbackUrl;
  cmd += '"';
  cmd += ' ';
  cmd += perryHubUrl;
  cmd += '/api/v1/build';
  cmd += ' -o ';
  cmd += responsePath;

  try {
    execSync(cmd);
  } catch (e: any) {
    return '';
  }

  // Read response and extract job_id
  try {
    const respText = readFileSync(responsePath, 'utf-8');
    extractJsonString(respText, 'job_id');
    return _extracted;
  } catch (e: any) {
    return '';
  }
}

// ===== ARTIFACT CALLBACK — Workers POST compiled binaries here =====

app.post('/artifact/*', async (request: any, reply: any) => {
  reply.header('Content-Type', 'application/json');
  const url = String(request.url);

  // The build callback carries the upload secret (submitToHub appends it to the
  // callback URL). Reject unauthenticated callbacks when a secret is configured.
  if (uploadSecret.length > 0) {
    extractParam(url, 'token=');
    if (!strEq(_extracted, uploadSecret)) {
      reply.status(401);
      return '{"error":"' + t('authentication required') + '"}';
    }
  }

  // Extract callback ID: /artifact/<pluginName>-<version>-<platform>
  extractPathSegment(url, '/artifact/');
  const callbackId = _extracted;
  if (callbackId.length === 0) {
    reply.status(400);
    return '{"error":"' + t('callback ID required') + '"}';
  }

  // Parse callbackId: last segment is platform, second-to-last is version
  // Format: pluginName-version-platform (e.g., prettier-hone-2.1.0-macos)
  let lastDash = -1;
  for (let i = callbackId.length - 1; i >= 0; i--) {
    if (callbackId.charCodeAt(i) === 45) { lastDash = i; break; }
  }
  if (lastDash < 1) {
    reply.status(400);
    return '{"error":"' + t('invalid callback ID') + '"}';
  }
  const platform = callbackId.slice(lastDash + 1);
  const nameVersion = callbackId.slice(0, lastDash);

  let secondDash = -1;
  for (let i = nameVersion.length - 1; i >= 0; i--) {
    if (nameVersion.charCodeAt(i) === 45) { secondDash = i; break; }
  }
  if (secondDash < 1) {
    reply.status(400);
    return '{"error":"' + t('invalid callback ID format') + '"}';
  }
  const pluginVersion = nameVersion.slice(secondDash + 1);
  const pluginName = nameVersion.slice(0, secondDash);

  // These parsed segments become shell arguments (mkdir/base64/shasum) and
  // filesystem paths. Reject anything outside the strict allowlist.
  if (!isSafeIdent(pluginName) || !isSafeIdent(pluginVersion) || !isSafeIdent(platform)) {
    reply.status(400);
    return '{"error":"' + t('invalid callback ID format') + '"}';
  }

  // Read artifact body (base64-encoded binary)
  const body = String(request.body);
  if (body.length < 10) {
    reply.status(400);
    return '{"error":"' + t('empty artifact body') + '"}';
  }

  // Normalize platform name
  normalizePlatform(platform);
  const normalizedPlatform = _extracted;

  // Create package directory
  let pkgDir = packagesDir;
  pkgDir += '/';
  pkgDir += pluginName;
  pkgDir += '/';
  pkgDir += pluginVersion;
  try { execSync('mkdir -p ' + pkgDir); } catch (e: any) { /* ignore */ }

  // Write base64 to temp file
  let b64Path = '/tmp/hb-artifact-';
  b64Path += String(djb2(callbackId));
  b64Path += '.b64';
  writeFileSync(b64Path, body);

  // Decode base64 to final binary
  let binPath = pkgDir;
  binPath += '/';
  binPath += normalizedPlatform;
  binPath += '.bin';

  let decodeCmd = 'base64 --decode < ';
  decodeCmd += b64Path;
  decodeCmd += ' > ';
  decodeCmd += binPath;
  try {
    execSync(decodeCmd);
  } catch (e: any) {
    // macOS uses -D, Linux uses -d, try alternate
    let altCmd = 'base64 -D < ';
    altCmd += b64Path;
    altCmd += ' > ';
    altCmd += binPath;
    try { execSync(altCmd); } catch (e2: any) {
      // Last resort: just copy the b64 file as-is
      let cpCmd = 'cp ';
      cpCmd += b64Path;
      cpCmd += ' ';
      cpCmd += binPath;
      execSync(cpCmd);
    }
  }

  // Clean up temp file
  try { execSync('rm -f ' + b64Path); } catch (e: any) { /* ignore */ }

  // Get file size
  let sizeBytes = 0;
  try {
    const sizeOutput = readFileSync(binPath);
    sizeBytes = sizeOutput.length;
  } catch (e: any) { /* ignore */ }

  // Compute SHA256
  let sha256 = '';
  try {
    let shaCmd = 'shasum -a 256 ';
    shaCmd += binPath;
    const shaResult = readFileSync(binPath);
    // Use execSync for sha256 — redirect to temp file
    let shaTmpPath = '/tmp/hb-sha-';
    shaTmpPath += String(djb2(callbackId));
    shaTmpPath += '.txt';
    let shaExecCmd = 'shasum -a 256 ';
    shaExecCmd += binPath;
    shaExecCmd += ' > ';
    shaExecCmd += shaTmpPath;
    execSync(shaExecCmd);
    const shaOut = readFileSync(shaTmpPath, 'utf-8');
    // shasum output format: "hash  filename\n"
    let spaceIdx = 0;
    while (spaceIdx < shaOut.length && shaOut.charCodeAt(spaceIdx) !== 32) {
      spaceIdx = spaceIdx + 1;
    }
    sha256 = shaOut.slice(0, spaceIdx);
    try { execSync('rm -f ' + shaTmpPath); } catch (e: any) { /* ignore */ }
  } catch (e: any) { /* ignore sha errors */ }

  // Update DB
  const now = Math.floor(Date.now() / 1000);

  // Update build job status
  await pool.execute(
    'UPDATE buildJobs SET status = ?, completedAt = ? WHERE pluginId = (SELECT id FROM plugins WHERE name = ?) AND version = ? AND platform = ?',
    ['completed', now, pluginName, pluginVersion, platform]
  );

  // Update pluginVersions with download info
  let downloadUrl = '/api/v1/pkg/';
  downloadUrl += pluginName;
  downloadUrl += '/';
  downloadUrl += pluginVersion;
  downloadUrl += '?platform=';
  downloadUrl += normalizedPlatform;

  await pool.execute(
    'UPDATE pluginVersions SET downloadUrl = ?, sha256 = ?, sizeBytes = ? WHERE pluginId = (SELECT id FROM plugins WHERE name = ?) AND version = ?',
    [downloadUrl, sha256, sizeBytes, pluginName, pluginVersion]
  );

  let r = '{"success":true,"plugin":"';
  r += pluginName;
  r += '","version":"';
  r += pluginVersion;
  r += '","platform":"';
  r += normalizedPlatform;
  r += '","size":';
  r += String(sizeBytes);
  r += ',"sha256":"';
  r += sha256;
  r += '"}';
  return r;
});

// ===== BUILD STATUS =====

app.get('/status/*', async (request: any, reply: any) => {
  reply.header('Content-Type', 'application/json');
  const url = String(request.url);

  // /status/<name>/<version>
  extractPathSegment(url, '/status/');
  const pluginName = _extracted;
  extractSubPath(url, '/status/');
  const version = _subPath;

  if (pluginName.length === 0 || version.length === 0) {
    reply.status(400);
    return '{"error":"' + t('format: /status/:name/:version') + '"}';
  }

  const [jobs]: any = await pool.execute(
    'SELECT bj.platform, bj.hubJobId, bj.status, bj.createdAt, bj.completedAt, bj.errorMessage FROM buildJobs bj JOIN plugins p ON bj.pluginId = p.id WHERE p.name = ? AND bj.version = ? ORDER BY bj.platform',
    [pluginName, version]
  );

  if (jobs.length === 0) {
    reply.status(404);
    return '{"error":"' + t('no builds found') + '"}';
  }

  let allComplete = 1;
  let anyFailed = 0;

  let j = '{"pluginName":"';
  j += pluginName;
  j += '","version":"';
  j += version;
  j += '","builds":[';

  for (let i = 0; i < jobs.length; i++) {
    if (i > 0) j += ',';
    j += '{"platform":"';
    j += String(jobs[i].platform);
    j += '","hubJobId":"';
    j += String(jobs[i].hubJobId || '');
    j += '","status":"';
    const st = String(jobs[i].status);
    j += st;
    j += '"';
    if (jobs[i].createdAt !== null) {
      j += ',"createdAt":';
      j += String(Number(jobs[i].createdAt));
    }
    if (jobs[i].completedAt !== null) {
      j += ',"completedAt":';
      j += String(Number(jobs[i].completedAt));
    }
    if (jobs[i].errorMessage !== null && String(jobs[i].errorMessage).length > 0) {
      j += ',"errorMessage":"';
      j += String(jobs[i].errorMessage);
      j += '"';
    }
    j += '}';
    if (st !== 'completed') allComplete = 0;
    if (st === 'failed') anyFailed = 1;
  }

  j += '],"overall":"';
  if (anyFailed === 1) j += 'failed';
  else if (allComplete === 1) j += 'completed';
  else j += 'building';
  j += '"}';

  return j;
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen({ host: '0.0.0.0', port: httpPort }, onListen);

function onListen(err: any): void {
  if (err) {
    console.log('Build coordinator error');
  } else {
    console.log('Hone Build Coordinator on port ' + String(httpPort));
  }
}
