import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createUpdateManager, inspectUpdateArchive, UPDATE_ASSET_NAME } from '../dev/update-utils.mjs';

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
});

test('update package archive rejects traversal and incoming watch photos', () => {
  assert.throws(() => inspectUpdateArchive(storedZipEntry('../extension/manifest.json')), /недопустимый путь/i);
  assert.throws(() => inspectUpdateArchive(storedZipEntry('input-watches-images/watch.png')), /недопустимый путь/i);
});

test('update package archive rejects symlinks', () => {
  const unixSymlinkMode = (0xa000 << 16) >>> 0;
  assert.throws(() => inspectUpdateArchive(storedZipEntry('extension/manifest.json', '{}', unixSymlinkMode)), /символическая ссылка/i);
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
