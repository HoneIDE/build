# Hone Build

Perry-compiled build coordinator that bridges the Hone marketplace to [perry-hub](https://github.com/nicholasgasior/perry-hub) for cross-platform plugin compilation.

When a plugin is published, hone-build submits compilation jobs to perry-hub workers (macOS, Linux, Windows), receives the compiled binaries, and stores them for the marketplace to serve.

## Architecture

```
Publisher ──POST /upload──▶ hone-build ──curl──▶ Perry Hub
                                                    │
                                              Workers compile
                                              (perry compile --target X)
                                                    │
                           hone-build ◀──POST /artifact/:id──┘
                               │
                          stores binary in
                          data/packages/:name/:version/:platform.bin
                               │
Users ──GET /api/v1/pkg/──▶ marketplace serves download
```

- **Perry-compiled Fastify server** — same pattern as hone-auth (653 lines, single `src/app.ts`)
- **MySQL** — shared database with hone-marketplace (buildJobs table)
- **Outbound HTTP** via `execSync` + `curl` (Perry can't use `fetch()` in server context)
- **Artifact storage** — compiled binaries in shared `data/packages/` directory

## Build

```bash
perry compile src/app.ts --output hone-build
```

## Run

```bash
./hone-build   # reads build.conf, listens on port 8447
```

## Test

```bash
bun test   # 21 tests
```

## Configuration

`build.conf` (KEY=VALUE):

```
DB_HOST=webserver.skelpo.net
DB_USER=hone
DB_PASS=...
DB_NAME=hone_marketplace
PORT=8447
PERRY_HUB_URL=https://hub.perryts.com
PERRY_HUB_LICENSE_KEY=...
PACKAGES_DIR=../hone-marketplace/data/packages
UPLOADS_DIR=./data/uploads
```

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/upload` | POST | Accept plugin source (base64 tarball in body, metadata in query params) |
| `/artifact/:id` | POST | Callback for perry-hub workers to upload compiled binaries |
| `/status/:name/:version` | GET | Build status for all platforms |
| `/health` | GET | Health check |

## Perry-Hub Integration

hone-build submits builds to perry-hub with `build_type: "plugin"` in the manifest. Workers should skip packaging/signing/publishing stages and return the raw compiled binary.

**Manifest format:**
```json
{
  "app_name": "prettier-hone",
  "bundle_id": "codes.hone.plugin.prettier-hone",
  "version": "2.1.0",
  "entry": "src/index.ts",
  "targets": ["macos"],
  "build_type": "plugin"
}
```

## Perry Builder Worker Change Required

In `perry-builder/macos/src/build/pipeline.rs`, add early return for plugin builds:

```rust
if manifest.build_type.as_deref() == Some("plugin") {
    // Compile only — skip bundling, signing, publishing
    return Ok(actual_binary);
}
```
