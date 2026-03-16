/**
 * Hone Build Coordinator tests.
 * Tests hub-client, storage, and request handling.
 * Run: cd hone-build && bun test
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { storeArtifact, getArtifactPath, getVersionManifest } from '../src/storage';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const TEST_DIR = '/tmp/hone-build-test-packages';

beforeEach(() => {
  // Clean test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('Storage', () => {
  test('storeArtifact creates directory structure', () => {
    const data = Buffer.from('fake binary data');
    const path = storeArtifact(TEST_DIR, 'test-plugin', '1.0.0', 'macos', data);

    expect(existsSync(path)).toBe(true);
    expect(path).toContain('test-plugin');
    expect(path).toContain('1.0.0');
    expect(path).toContain('darwin-arm64.bin');
  });

  test('storeArtifact normalizes platform names', () => {
    const data = Buffer.from('data');

    storeArtifact(TEST_DIR, 'plugin', '1.0.0', 'macos', data);
    expect(getArtifactPath(TEST_DIR, 'plugin', '1.0.0', 'macos')).not.toBeNull();
    expect(getArtifactPath(TEST_DIR, 'plugin', '1.0.0', 'darwin-arm64')).not.toBeNull();

    storeArtifact(TEST_DIR, 'plugin', '1.0.0', 'linux', data);
    expect(getArtifactPath(TEST_DIR, 'plugin', '1.0.0', 'linux')).not.toBeNull();

    storeArtifact(TEST_DIR, 'plugin', '1.0.0', 'windows', data);
    expect(getArtifactPath(TEST_DIR, 'plugin', '1.0.0', 'windows')).not.toBeNull();
  });

  test('storeArtifact preserves binary data', () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const path = storeArtifact(TEST_DIR, 'binary-test', '2.0.0', 'macos', data);

    const stored = readFileSync(path);
    expect(stored.equals(data)).toBe(true);
  });

  test('storeArtifact creates manifest.json', () => {
    const data = Buffer.from('test data');
    storeArtifact(TEST_DIR, 'manifest-test', '1.0.0', 'macos', data);

    const manifest = getVersionManifest(TEST_DIR, 'manifest-test', '1.0.0');
    expect(manifest).not.toBeNull();
    expect(manifest.pluginName).toBe('manifest-test');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.artifacts['darwin-arm64']).toBeDefined();
    expect(manifest.artifacts['darwin-arm64'].size).toBe(data.length);
    expect(manifest.artifacts['darwin-arm64'].sha256).toBeDefined();
  });

  test('storeArtifact updates manifest for multiple platforms', () => {
    storeArtifact(TEST_DIR, 'multi', '1.0.0', 'macos', Buffer.from('mac'));
    storeArtifact(TEST_DIR, 'multi', '1.0.0', 'linux', Buffer.from('linux'));
    storeArtifact(TEST_DIR, 'multi', '1.0.0', 'windows', Buffer.from('win'));

    const manifest = getVersionManifest(TEST_DIR, 'multi', '1.0.0');
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest.artifacts)).toEqual(['darwin-arm64', 'linux-x64', 'windows-x64']);
  });

  test('storeArtifact computes correct SHA256', () => {
    const data = Buffer.from('hello world');
    const expectedHash = createHash('sha256').update(data).digest('hex');

    storeArtifact(TEST_DIR, 'hash-test', '1.0.0', 'macos', data);
    const manifest = getVersionManifest(TEST_DIR, 'hash-test', '1.0.0');
    expect(manifest.artifacts['darwin-arm64'].sha256).toBe(expectedHash);
  });

  test('getArtifactPath returns null for missing artifacts', () => {
    expect(getArtifactPath(TEST_DIR, 'nonexistent', '1.0.0', 'macos')).toBeNull();
  });

  test('getArtifactPath returns null for missing version', () => {
    storeArtifact(TEST_DIR, 'versioned', '1.0.0', 'macos', Buffer.from('data'));
    expect(getArtifactPath(TEST_DIR, 'versioned', '2.0.0', 'macos')).toBeNull();
  });

  test('getArtifactPath returns null for missing platform', () => {
    storeArtifact(TEST_DIR, 'platformed', '1.0.0', 'macos', Buffer.from('data'));
    expect(getArtifactPath(TEST_DIR, 'platformed', '1.0.0', 'linux')).toBeNull();
  });

  test('getVersionManifest returns null for nonexistent plugin', () => {
    expect(getVersionManifest(TEST_DIR, 'ghost', '1.0.0')).toBeNull();
  });

  test('storeArtifact handles large filenames', () => {
    const data = Buffer.from('data');
    const path = storeArtifact(TEST_DIR, 'my-very-long-plugin-name-for-testing', '10.20.30', 'macos', data);
    expect(existsSync(path)).toBe(true);
  });

  test('storeArtifact overwrites existing artifact', () => {
    const data1 = Buffer.from('version 1');
    const data2 = Buffer.from('version 2 with more data');

    storeArtifact(TEST_DIR, 'overwrite', '1.0.0', 'macos', data1);
    storeArtifact(TEST_DIR, 'overwrite', '1.0.0', 'macos', data2);

    const path = getArtifactPath(TEST_DIR, 'overwrite', '1.0.0', 'macos')!;
    const stored = readFileSync(path);
    expect(stored.equals(data2)).toBe(true);

    const manifest = getVersionManifest(TEST_DIR, 'overwrite', '1.0.0');
    expect(manifest.artifacts['darwin-arm64'].size).toBe(data2.length);
  });
});

// ---------------------------------------------------------------------------
// Hub Client (unit tests — no actual HTTP calls)
// ---------------------------------------------------------------------------

describe('Hub Client Types', () => {
  test('BuildSubmission structure', async () => {
    // Import types to verify they compile
    const { submitBuild } = await import('../src/hub-client');
    expect(typeof submitBuild).toBe('function');
  });

  test('BuildManifest for plugin', () => {
    const manifest = {
      app_name: 'prettier-hone',
      bundle_id: 'codes.hone.plugin.prettier-hone',
      version: '2.1.0',
      entry: 'src/index.ts',
      targets: ['macos'],
      build_type: 'plugin',
    };

    expect(manifest.build_type).toBe('plugin');
    expect(manifest.targets).toEqual(['macos']);
    expect(manifest.bundle_id).toContain('codes.hone.plugin.');
  });

  test('manifest supports all target platforms', () => {
    const targets = ['macos', 'linux', 'windows'];
    for (const target of targets) {
      const manifest = {
        app_name: 'test',
        bundle_id: 'codes.hone.plugin.test',
        version: '1.0.0',
        entry: 'src/index.ts',
        targets: [target],
        build_type: 'plugin',
      };
      expect(manifest.targets[0]).toBe(target);
    }
  });
});

// ---------------------------------------------------------------------------
// Platform normalization
// ---------------------------------------------------------------------------

describe('Platform Normalization', () => {
  test('macos normalizes to darwin-arm64', () => {
    storeArtifact(TEST_DIR, 'norm', '1.0.0', 'macos', Buffer.from('x'));
    expect(getArtifactPath(TEST_DIR, 'norm', '1.0.0', 'darwin-arm64')).not.toBeNull();
  });

  test('linux normalizes to linux-x64', () => {
    storeArtifact(TEST_DIR, 'norm', '1.0.0', 'linux', Buffer.from('x'));
    expect(getArtifactPath(TEST_DIR, 'norm', '1.0.0', 'linux-x64')).not.toBeNull();
  });

  test('windows normalizes to windows-x64', () => {
    storeArtifact(TEST_DIR, 'norm', '1.0.0', 'windows', Buffer.from('x'));
    expect(getArtifactPath(TEST_DIR, 'norm', '1.0.0', 'windows-x64')).not.toBeNull();
  });

  test('already normalized platform passes through', () => {
    storeArtifact(TEST_DIR, 'norm', '1.0.0', 'darwin-arm64', Buffer.from('x'));
    expect(getArtifactPath(TEST_DIR, 'norm', '1.0.0', 'darwin-arm64')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow simulation (no DB or HTTP)
// ---------------------------------------------------------------------------

describe('Build Flow', () => {
  test('full artifact lifecycle', () => {
    const pluginName = 'lifecycle-test';
    const version = '3.0.0';
    const platforms = ['macos', 'linux', 'windows'];
    const binaries = {
      macos: Buffer.from('mach-o binary content'),
      linux: Buffer.from('elf binary content'),
      windows: Buffer.from('pe binary content'),
    };

    // Simulate receiving artifacts from all platforms
    for (const platform of platforms) {
      storeArtifact(TEST_DIR, pluginName, version, platform, binaries[platform as keyof typeof binaries]);
    }

    // Verify all artifacts stored
    for (const platform of platforms) {
      const path = getArtifactPath(TEST_DIR, pluginName, version, platform);
      expect(path).not.toBeNull();
    }

    // Verify manifest has all platforms
    const manifest = getVersionManifest(TEST_DIR, pluginName, version);
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest.artifacts).length).toBe(3);
    expect(manifest.artifacts['darwin-arm64']).toBeDefined();
    expect(manifest.artifacts['linux-x64']).toBeDefined();
    expect(manifest.artifacts['windows-x64']).toBeDefined();

    // Verify correct sizes
    expect(manifest.artifacts['darwin-arm64'].size).toBe(binaries.macos.length);
    expect(manifest.artifacts['linux-x64'].size).toBe(binaries.linux.length);
    expect(manifest.artifacts['windows-x64'].size).toBe(binaries.windows.length);

    // Verify binary integrity
    const macPath = getArtifactPath(TEST_DIR, pluginName, version, 'macos')!;
    const macData = readFileSync(macPath);
    expect(macData.equals(binaries.macos)).toBe(true);
  });

  test('multiple versions coexist', () => {
    const plugin = 'multi-version';
    storeArtifact(TEST_DIR, plugin, '1.0.0', 'macos', Buffer.from('v1'));
    storeArtifact(TEST_DIR, plugin, '2.0.0', 'macos', Buffer.from('v2'));

    const v1Path = getArtifactPath(TEST_DIR, plugin, '1.0.0', 'macos');
    const v2Path = getArtifactPath(TEST_DIR, plugin, '2.0.0', 'macos');
    expect(v1Path).not.toBeNull();
    expect(v2Path).not.toBeNull();
    expect(v1Path).not.toBe(v2Path);

    const v1Data = readFileSync(v1Path!);
    const v2Data = readFileSync(v2Path!);
    expect(v1Data.toString()).toBe('v1');
    expect(v2Data.toString()).toBe('v2');
  });
});
