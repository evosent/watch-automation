import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_RESULTS_ARCHIVE_BYTES, calculateZip32ArchiveLayout } from '../extension/results-archive-limits.js';
import { writeResultsZip, inspectResultsZip, extractResultsZip } from '../extension/local-service/results-archive.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-archive-limits-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('ZIP32 limit includes the central directory and end record at the exact boundary', () => {
  assert.equal(MAX_RESULTS_ARCHIVE_BYTES, 4294967294);
  assert.equal(calculateZip32ArchiveLayout(MAX_RESULTS_ARCHIVE_BYTES - 22, 0, 1).archiveBytes,
    MAX_RESULTS_ARCHIVE_BYTES);
  assert.throws(() => calculateZip32ArchiveLayout(MAX_RESULTS_ARCHIVE_BYTES - 21, 0, 1), /чуть меньше 4 ГБ/);
  assert.throws(() => calculateZip32ArchiveLayout(0, 0, 0xffff), /Слишком много файлов/);
  assert.throws(() => calculateZip32ArchiveLayout(-1, 0, 1), /Некорректный размер/);
});

test('writer rejects an oversized file before opening its destination', async t => {
  const root = await temporary(t), source = path.join(root, 'source'), destination = path.join(root, 'results.zip');
  const handle = await open(source, 'wx');
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(writeResultsZip(destination, [{ name: 'manifest.json', path: source }]), /размер записи/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('writer rejects a ZIP whose payload fits the cap while its headers would exceed it', async t => {
  const root = await temporary(t), source = path.join(root, 'source'), destination = path.join(root, 'results.zip');
  const size = Math.floor((MAX_RESULTS_ARCHIVE_BYTES - 8000) / 64);
  const handle = await open(source, 'wx');
  try { await handle.truncate(size); } finally { await handle.close(); }
  const entries = [{ name: 'manifest.json', bytes: Buffer.from('{}') }, ...Array.from({ length: 64 }, (_, i) => ({
    name: `images/${i.toString(16).padStart(64, '0')}.png`, path: source
  }))];
  assert.ok(size * 64 + 2 < MAX_RESULTS_ARCHIVE_BYTES);
  await assert.rejects(writeResultsZip(destination, entries), /чуть меньше 4 ГБ/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('ZIP inspector rejects a huge compressed entry before allocating its declared buffer', async t => {
  const root = await temporary(t), archive = path.join(root, 'results.zip');
  await writeResultsZip(archive, [{ name: 'manifest.json', bytes: Buffer.from('{}') }]);
  const bytes = await readFile(archive), first = bytes.indexOf(Buffer.from('manifest.json')),
    last = bytes.lastIndexOf(Buffer.from('manifest.json'));
  bytes.writeUInt32LE(0xf0000000, first - 30 + 18);
  bytes.writeUInt32LE(0xf0000000, last - 46 + 20);
  await writeFile(archive, bytes);
  await assert.rejects(inspectResultsZip(archive), /Недопустимый файл/);
  await assert.rejects(extractResultsZip(archive, path.join(root, 'extracted')), /Недопустимый файл/);
  await assert.rejects(stat(path.join(root, 'extracted')), { code: 'ENOENT' });
});
