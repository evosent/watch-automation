// Loaded by the local Node service; packaged under extension/ for updater compatibility.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

export const MAX_RESULTS_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function allowedName(name) {
  return name === 'manifest.json' || /^images\/[a-f0-9]{64}\.png$/.test(name);
}
export function pngMetadata(bytes) {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Файл не является PNG');
  let offset = 8;
  const imageChunks = [];
  let palette = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG обрывается внутри блока');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Контрольная сумма блока PNG не совпала');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') imageChunks.push(bytes.subarray(offset + 8, end - 4));
    if (type === 'PLTE') palette = length > 0 && length <= 768 && length % 3 === 0;
    if (type === 'IEND') { ended = length === 0 && end === bytes.length; break; }
    offset = end;
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 12000 || height > 12000 || !imageChunks.length || !ended) throw new Error('PNG повреждён или имеет неверные размеры');
  const depth = bytes[24], color = bytes[25], interlace = bytes[28];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (!depths[color]?.includes(depth) || bytes[26] || bytes[27] || interlace > 1 || (color === 3 && !palette)) throw new Error('Неверный формат пикселей PNG');
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.flatMap(([x, y, dx, dy]) => {
    const passWidth = Math.max(0, Math.ceil((width - x) / dx)), passHeight = Math.max(0, Math.ceil((height - y) / dy));
    return passWidth && passHeight ? [{ count: passHeight, bytes: Math.ceil(passWidth * channels[color] * depth / 8) + 1 }] : [];
  });
  const expectedBytes = rows.reduce((sum, row) => sum + row.count * row.bytes, 0);
  if (expectedBytes > 128 * 1024 * 1024) throw new Error('PNG слишком большой для обработки');
  let pixels;
  try { pixels = inflateSync(Buffer.concat(imageChunks), { maxOutputLength: expectedBytes }); }
  catch (_) { throw new Error('Данные пикселей PNG повреждены'); }
  if (pixels.length !== expectedBytes) throw new Error('Размер данных PNG не соответствует изображению');
  let position = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++) {
    if (pixels[position] > 4) throw new Error('Неверный фильтр пикселей PNG');
    position += row.bytes;
  }
  return { bytes: bytes.length, width, height, sha256: sha256(bytes) };
}

// PNGs are already compressed. Store entries sequentially; never load a whole
// export or import archive into memory.
export async function writeResultsZip(destination, entries) {
  const file = await fs.open(destination, 'wx');
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      if (!allowedName(entry.name)) throw new Error('Недопустимый путь в архиве');
      const body = entry.bytes || await fs.readFile(entry.path);
      if (body.length > MAX_FILE_BYTES || offset + body.length > MAX_RESULTS_ARCHIVE_BYTES) throw new Error('Архив превышает допустимый размер');
      const name = Buffer.from(entry.name);
      const crc = crc32(body);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
      header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22);
      header.writeUInt16LE(name.length, 26);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16);
      directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(body.length, 24);
      directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
      await file.writeFile(Buffer.concat([header, name])); await file.writeFile(body);
      central.push(directory, name); offset += header.length + name.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    await file.writeFile(directory); await file.writeFile(end); await file.sync();
  } finally { await file.close(); }
}

async function readAt(file, count, offset) {
  const bytes = Buffer.alloc(count);
  const result = await file.read(bytes, 0, count, offset);
  if (result.bytesRead !== count) throw new Error('Архив обрывается');
  return bytes;
}

export async function inspectResultsZip(zipPath) {
  const file = await fs.open(zipPath, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 22 || size > MAX_RESULTS_ARCHIVE_BYTES) throw new Error('Неверный размер ZIP: максимум 1 ГБ');
    const tail = await readAt(file, Math.min(size, 65557), size - Math.min(size, 65557));
    let end;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = tail.subarray(i); break; }
    }
    if (!end || end.readUInt16LE(4) || end.readUInt16LE(6) || end.readUInt16LE(8) !== end.readUInt16LE(10)) throw new Error('Неверное оглавление ZIP');
    const count = end.readUInt16LE(10), directorySize = end.readUInt32LE(12), start = end.readUInt32LE(16);
    if (!count || count > 5001 || directorySize > 2 * 1024 * 1024 || start + directorySize + end.length !== size) throw new Error('Неверное оглавление ZIP');
    const directory = await readAt(file, directorySize, start);
    const entries = [];
    const names = new Set();
    let offset = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('Повреждено оглавление ZIP');
      const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10);
      const checksum = directory.readUInt32LE(offset + 16), compressed = directory.readUInt32LE(offset + 20), length = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28), extra = directory.readUInt16LE(offset + 30), comment = directory.readUInt16LE(offset + 32);
      const local = directory.readUInt32LE(offset + 42), unixMode = directory.readUInt32LE(offset + 38) >>> 16;
      const next = offset + 46 + nameLength + extra + comment;
      if (next > directory.length) throw new Error('Повреждено имя файла ZIP');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(offset + 46, offset + 46 + nameLength));
      if (!allowedName(name) || names.has(name) || (flags & 1) || ![0, 8].includes(method)
        || (unixMode & 0xf000) === 0xa000 || length > MAX_FILE_BYTES || local + 30 + compressed > start) throw new Error('Недопустимый файл в архиве результатов');
      total += length;
      if (total > MAX_RESULTS_ARCHIVE_BYTES) throw new Error('Распакованный архив превышает 1 ГБ');
      names.add(name); entries.push({ name, flags, method, checksum, compressed, length, local, directoryStart: start }); offset = next;
    }
    if (offset !== directory.length || !names.has('manifest.json')) throw new Error('Неверный состав ZIP');
    return entries;
  } finally { await file.close(); }
}

export async function extractResultsZip(zipPath, destination) {
  const entries = await inspectResultsZip(zipPath);
  const file = await fs.open(zipPath, 'r');
  try {
    for (const entry of entries) {
      const header = await readAt(file, 30, entry.local);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== entry.method) throw new Error('Локальный заголовок ZIP повреждён');
      const nameLength = header.readUInt16LE(26), extra = header.readUInt16LE(28);
      if (entry.local + 30 + nameLength + extra + entry.compressed > entry.directoryStart) throw new Error('Данные ZIP выходят за пределы записи');
      const name = await readAt(file, nameLength, entry.local + 30);
      if (name.toString('utf8') !== entry.name) throw new Error('Имена файлов ZIP не совпадают');
      const compressed = await readAt(file, entry.compressed, entry.local + 30 + nameLength + extra);
      const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
      if (bytes.length !== entry.length || crc32(bytes) !== entry.checksum) throw new Error('Контрольная сумма ZIP не совпала');
      const target = path.join(destination, ...entry.name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' });
    }
    return entries;
  } finally { await file.close(); }
}
