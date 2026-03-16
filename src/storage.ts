/**
 * Artifact storage — saves compiled plugin binaries to disk.
 *
 * Directory structure:
 *   packages/
 *     prettier-hone/
 *       2.1.0/
 *         darwin-arm64.bin
 *         linux-x64.bin
 *         windows-x64.bin
 *         manifest.json
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * Map perry-hub platform names to our storage platform identifiers.
 */
function normalizePlatform(platform: string): string {
  switch (platform.toLowerCase()) {
    case 'macos': return 'darwin-arm64';
    case 'linux': return 'linux-x64';
    case 'windows': return 'windows-x64';
    case 'ios': return 'ios-arm64';
    case 'android': return 'android-arm64';
    default: return platform;
  }
}

/**
 * Store a compiled artifact to disk.
 * Returns the full path to the stored file.
 */
export function storeArtifact(
  packagesDir: string,
  pluginName: string,
  version: string,
  platform: string,
  data: Buffer
): string {
  const normalizedPlatform = normalizePlatform(platform);
  const dir = join(packagesDir, pluginName, version);
  mkdirSync(dir, { recursive: true });

  const filename = `${normalizedPlatform}.bin`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, data);

  // Update or create manifest.json
  const manifestPath = join(dir, 'manifest.json');
  let manifest: any = { pluginName, version, artifacts: {} };

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      // Reset if corrupt
    }
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  manifest.artifacts[normalizedPlatform] = {
    filename,
    size: data.length,
    sha256,
    storedAt: new Date().toISOString(),
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return filePath;
}

/**
 * Get the path to a stored artifact.
 * Returns null if the artifact doesn't exist.
 */
export function getArtifactPath(
  packagesDir: string,
  pluginName: string,
  version: string,
  platform: string
): string | null {
  const normalizedPlatform = normalizePlatform(platform);
  const filePath = join(packagesDir, pluginName, version, `${normalizedPlatform}.bin`);
  return existsSync(filePath) ? filePath : null;
}

/**
 * Create a .honepkg package (zip containing binary + metadata).
 * For v1, we serve raw binaries. Future: proper .honepkg format.
 */
export function createPackage(
  packagesDir: string,
  pluginName: string,
  version: string,
  platform: string
): string | null {
  // For v1, just return the binary path
  return getArtifactPath(packagesDir, pluginName, version, platform);
}

/**
 * Get the manifest for a plugin version.
 */
export function getVersionManifest(
  packagesDir: string,
  pluginName: string,
  version: string
): any | null {
  const manifestPath = join(packagesDir, pluginName, version, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}
