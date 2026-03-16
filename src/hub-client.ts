/**
 * Perry Hub client — submits build jobs to perry-hub's HTTP API.
 *
 * Perry Hub API:
 *   POST /api/v1/build (multipart/form-data)
 *     Fields: license_key, manifest (JSON), credentials (JSON), tarball_b64
 *     Optional: artifact_upload_url, auth_token
 *     Response: { job_id, ws_url, position }
 */

export interface BuildManifest {
  app_name: string;
  bundle_id: string;
  version: string;
  entry: string;
  targets: string[];
  build_type?: string; // 'plugin' for marketplace plugins
  icon?: string;
}

export interface BuildSubmission {
  hubUrl: string;
  licenseKey: string;
  manifest: BuildManifest;
  tarballB64: string;
  artifactUploadUrl?: string;
  credentials?: Record<string, string>;
}

export interface BuildResult {
  jobId: string;
  wsUrl?: string;
  position?: number;
}

/**
 * Submit a build job to perry-hub via HTTP multipart.
 */
export async function submitBuild(submission: BuildSubmission): Promise<BuildResult> {
  const url = `${submission.hubUrl}/api/v1/build`;

  // Build multipart form data
  const formData = new FormData();
  formData.append('license_key', submission.licenseKey);
  formData.append('manifest', JSON.stringify(submission.manifest));
  formData.append('credentials', JSON.stringify(submission.credentials || {}));
  formData.append('tarball_b64', submission.tarballB64);

  if (submission.artifactUploadUrl) {
    formData.append('artifact_upload_url', submission.artifactUploadUrl);
  }

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perry Hub returned ${response.status}: ${text}`);
  }

  const data = await response.json() as any;

  if (data.error) {
    throw new Error(`Perry Hub error: ${data.error}`);
  }

  return {
    jobId: data.job_id || data.jobId || '',
    wsUrl: data.ws_url || data.wsUrl,
    position: data.position,
  };
}

/**
 * Check build status on perry-hub (optional — we rely on artifact callbacks).
 */
export async function checkBuildStatus(hubUrl: string, jobId: string): Promise<{
  status: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${hubUrl}/api/v1/build/${jobId}/status`);
    if (!response.ok) {
      return { status: 'unknown', error: `HTTP ${response.status}` };
    }
    const data = await response.json() as any;
    return { status: data.status || 'unknown' };
  } catch (err: any) {
    return { status: 'unknown', error: err.message };
  }
}
