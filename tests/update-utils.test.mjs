import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUpdateArchive } from '../dev/update-utils.mjs';

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
