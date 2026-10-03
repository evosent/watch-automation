import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub installer verifies release assets and preserves an existing watch-photo folder', async () => {
  const installer = await readFile(path.join(root, 'Install_From_GitHub.ps1'), 'utf8');
  const bootstrap = await readFile(path.join(root, 'INSTALL_FROM_GITHUB.cmd'), 'utf8');
  const builder = await readFile(path.join(root, 'scripts/build-release-packages.mjs'), 'utf8');

  assert.match(bootstrap, /releases\/latest\/download\/Install_From_GitHub\.ps1/);
  assert.match(installer, /api\.github\.com\/repos\//);
  assert.match(installer, /Get-FileHash .*SHA256/);
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
