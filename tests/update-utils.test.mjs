import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createUpdateManager, installedUpdateStatus, inspectUpdateArchive, UPDATE_ASSET_NAME,
  UPDATE_PACKAGE_MANIFEST, UPDATE_STATE_FILE, validateExtractedPackage } from '../dev/update-utils.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntry(name, body = 'sample', externalAttributes = 0) {
  const nameBytes = Buffer.from(name, 'utf8');
  const contents = Buffer.from(body);
  const checksum = crc32(contents);
  const local = Buffer.alloc(30 + nameBytes.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  contents.copy(local, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(externalAttributes >>> 0, 38);
  nameBytes.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test('update package archive permits extension, prompt, and reference files', () => {
  const entries = inspectUpdateArchive(storedZipEntry('input-ref-images/brands/Casio/ref.png'));
  assert.deepEqual(entries.map((entry) => entry.name), ['input-ref-images/brands/Casio/ref.png']);
  assert.equal(entries[0].uncompressedSize, Buffer.byteLength('sample'));
  for (const name of ['extension/local-service/results-transfer.mjs', 'extension/local-service/results-archive.mjs',
    'extension/results-transfer-utils.js', 'extension/results-transfer-ui.js']) {
    assert.equal(inspectUpdateArchive(storedZipEntry(name))[0].name, name,
      'result-transfer dependencies stay inside the legacy updater extension-path allowlist');
  }
});

test('update package archive rejects traversal and incoming watch photos', () => {
  assert.throws(() => inspectUpdateArchive(storedZipEntry('../extension/manifest.json')), /недопустимый путь/i);
  assert.throws(() => inspectUpdateArchive(storedZipEntry('input-watches-images/watch.png')), /недопустимый путь/i);
});

test('update package archive rejects symlinks', () => {
  const unixSymlinkMode = (0xa000 << 16) >>> 0;
  assert.throws(() => inspectUpdateArchive(storedZipEntry('extension/manifest.json', '{}', unixSymlinkMode)), /символическая ссылка/i);
});

test('update package extension version must match the GitHub release tag', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'watch-update-package-version-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const files = {
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, version: '0.3.39' }),
    'extension/sidepanel.html': '<main></main>',
    'extension/sidepanel.js': '',
    'extension/service-worker.js': '',
    'extension/prompts/base.txt': 'prompt',
    'input-ref-images/brands/Casio/reference.png': 'reference',
    'dev/control-routing.mjs': '',
    'dev/watch-extension.mjs': '',
    'dev/update-utils.mjs': '',
    'dev/update-watch-automation.mjs': ''
  };
  const archivedFiles = Object.entries(files).map(([relative, contents]) => ({
    path: path.join(projectRoot, ...relative.split('/')),
    relative,
    contents
  }));
  for (const file of archivedFiles) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
  const packageManifest = {
    schemaVersion: 1,
    releaseTag: 'v0.3.40',
    extensionVersion: '0.3.39',
    packageId: 'mismatched-version-test',
    files: archivedFiles.map(({ relative, contents }) => ({
      path: relative,
      size: Buffer.byteLength(contents),
      sha256: sha256(contents)
    }))
  };
  await writeFile(path.join(projectRoot, UPDATE_PACKAGE_MANIFEST), JSON.stringify(packageManifest));
  const archiveEntries = [
    ...archivedFiles.map(({ relative }) => ({ name: relative, isDirectory: false })),
    { name: UPDATE_PACKAGE_MANIFEST, isDirectory: false }
  ];

  await assert.rejects(
    validateExtractedPackage(projectRoot, 'v0.3.40', archiveEntries),
    /версия расширения в архиве не совпадает с тегом GitHub Release/i
  );
});

test('update manager reports an older GitHub release and never downloads it over a newer installation', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'watch-update-version-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, 'extension'), { recursive: true });
  await writeFile(path.join(projectRoot, 'extension', 'manifest.json'), JSON.stringify({ version: '0.3.38' }));

  const requests = [];
  const manager = createUpdateManager(projectRoot);
  manager.startPrepare(async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        draft: false,
        prerelease: false,
        tag_name: 'v0.3.35',
        html_url: 'https://github.com/evosent/watch-automation/releases/tag/v0.3.35',
        assets: [{
          name: UPDATE_ASSET_NAME,
          id: 1,
          updated_at: '2026-10-03T17:15:00Z',
          size: 123,
          browser_download_url: 'https://github.com/evosent/watch-automation/releases/download/v0.3.35/watch-automation-update.zip'
        }]
      })
    };
  });

  const status = await manager.waitForPrepare();
  assert.equal(status.phase, 'current');
  assert.equal(status.currentVersion, '0.3.38');
  assert.equal(status.latestVersion, null);
  assert.match(status.message, /более старая версия 0\.3\.35/i);
  assert.match(status.message, /откат версии отменён/i);
  assert.equal(requests.length, 1, 'the updater must stop before downloading the older ZIP');
});

test('durable restart state exposes a cooldown, then permits a safe retry', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'watch-update-restart-state-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const marker = { schemaVersion: 1, packageId: 'package-retry', extensionVersion: '0.3.40',
    restart: { phase: 'pending', requestedAt: new Date(Date.now() - 60_000).toISOString() } };
  await writeFile(path.join(projectRoot, UPDATE_STATE_FILE), JSON.stringify(marker));
  let restartCount = 0;
  const manager = createUpdateManager(projectRoot, { onRestart: async () => { restartCount += 1; } });

  const coolingDown = await manager.startRestart();
  assert.equal(coolingDown.started, false);
  assert.equal(coolingDown.reason, 'busy');
  assert.equal(coolingDown.status.restartRetryAvailable, false);
  assert.equal(restartCount, 0);

  marker.restart.requestedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  await writeFile(path.join(projectRoot, UPDATE_STATE_FILE), JSON.stringify(marker));
  const available = installedUpdateStatus({ phase: 'idle' }, marker);
  assert.equal(available.restartRetryAvailable, true);
  const retried = await manager.startRestart();
  assert.equal(retried.started, true);
  assert.equal(restartCount, 1);
  assert.equal(retried.installed.restart.phase, 'pending');
  assert.equal(retried.status.phase, 'restarting');
});

test('restart retries coalesce clicks, preserve helper errors, and allow immediate retry after failure', async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'watch-update-restart-retry-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, UPDATE_STATE_FILE), JSON.stringify({ schemaVersion: 1,
    packageId: 'package-retry', extensionVersion: '0.3.40',
    restart: { phase: 'error', requestedAt: new Date(Date.now() - 5 * 60_000).toISOString(), error: 'lost launch ack' } }));
  let restartCount = 0, release;
  const manager = createUpdateManager(projectRoot, { onRestart: async () => {
    restartCount += 1;
    if (restartCount === 1) throw new Error('simulated acknowledgement loss');
    await new Promise((resolve) => { release = resolve; });
  } });

  const failed = await manager.startRestart();
  assert.equal(failed.started, false);
  assert.equal(failed.reason, 'restart_failed');
  assert.equal(failed.status.phase, 'error');
  const failedMarker = JSON.parse(await readFile(path.join(projectRoot, UPDATE_STATE_FILE), 'utf8'));
  assert.equal(failedMarker.restart.phase, 'error');
  assert.equal(failedMarker.restart.error, 'simulated acknowledgement loss');
  assert.equal(failedMarker.restartRetryAvailable, undefined);
  assert.equal(installedUpdateStatus({ phase: 'idle' }, failedMarker).restartRetryAvailable, true);

  const first = manager.startRestart();
  const second = manager.startRestart();
  for (let attempt = 0; attempt < 100 && !release; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(restartCount, 2, 'two clicks share one restart helper request');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.started, true);
  assert.equal(right.started, true);
  assert.equal(restartCount, 2);

  const rapidRepeat = await manager.startRestart();
  assert.equal(rapidRepeat.started, false);
  assert.equal(rapidRepeat.reason, 'busy');
  assert.equal(restartCount, 2, 'a rapid repeat respects the freshly written pending marker cooldown');
});
