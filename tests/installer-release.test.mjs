import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub installer verifies release assets and preserves an existing watch-photo folder', async () => {
  const installer = await readFile(path.join(root, 'Install_From_GitHub.ps1'), 'utf8');
  const installerBytes = await readFile(path.join(root, 'Install_From_GitHub.ps1'));
  const bootstrap = await readFile(path.join(root, 'INSTALL_FROM_GITHUB.cmd'), 'utf8');
  const builder = await readFile(path.join(root, 'scripts/build-release-packages.mjs'), 'utf8');

  assert.deepEqual(installerBytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.match(bootstrap, /releases\/latest\/download\/Install_From_GitHub\.ps1/);
  assert.match(bootstrap, /-InstallRoot "%~dp0\."/);
  assert.match(installer, /api\.github\.com\/repos\//);
  assert.match(installer, /\[string\]\$InstallRoot\s*=\s*\$PSScriptRoot/);
  assert.match(installer, /\$targetRoot\s*=\s*\$InstallRoot/);
  assert.doesNotMatch(installer, /\$InstallBase/);
  assert.match(installer, /\$matchingAssets = @\(/);
  assert.match(installer, /return \$matchingAssets\[0\]/);
  assert.doesNotMatch(installer, /\$matches\s*=\s*@\(/i);
  assert.match(installer, /function Get-Sha256Hex/);
  assert.match(installer, /\.ComputeHash\(\$stream\)/);
  assert.doesNotMatch(installer, /Get-FileHash/);
  assert.match(installer, /browser_download_url/);
  assert.match(installer, /watch-photos-v1/);
  assert.match(installer, /if \(\$existing\.Count -gt 0\)/);
  assert.match(installer, /input-watches-images/);
  assert.match(installer, /robocopy\.exe \$PackageStage \$Target \/E/);
  assert.doesNotMatch(installer, /robocopy\.exe[^\r\n]*\/MIR/i);

  assert.match(builder, /watch-automation-installer-package\.zip/);
  assert.match(builder, /watch-photos-v1\.tar/);
  assert.match(builder, /input-ref-images/);
  assert.match(builder, /input-watches-images/);
  assert.match(builder, /MAX_RELEASE_ASSET_BYTES/);
  assert.match(builder, /files\.some\(\(file\) => file\.path\.startsWith\('input-watches-images\/'\)\)/);
});

test('first-run input libraries are resolved from the local app root', async () => {
  const sidepanel = await readFile(path.join(root, 'extension/sidepanel.js'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.match(sidepanel, /\/local-input-files\?kind=/);
  assert.match(sidepanel, /\/local-input-file\?path=/);
  assert.match(sidepanel, /autoConnectBundledInputs\(\)/);
  assert.match(sidepanel, /sourceRoot:\s*projectRoot/);
  assert.match(sidepanel, /batchSize:\s*12/);
  assert.match(sidepanel, /concurrency:\s*3/);
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:17321/*'));
});
