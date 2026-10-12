// Small uncompressed ZIP writer for XLSX and browser exports; no remote code.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function zipBytes(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, input] of entries) {
    if (!name || name.startsWith('/') || name.split('/').some(p => p === '..') || name.includes('\\')) throw new Error('Unsafe archive path');
    const filename = encoder.encode(name), bytes = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);
    let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + filename.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, filename.length, true); header.set(filename, 30);
    const directory = new Uint8Array(46 + filename.length), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint32(16, crc, true); d.setUint32(20, bytes.length, true); d.setUint32(24, bytes.length, true); d.setUint16(28, filename.length, true); d.setUint32(42, offset, true); directory.set(filename, 46);
    local.push(header, bytes); central.push(directory); offset += header.length + bytes.length;
    if (offset > 0xffffffff) throw new Error('Archive exceeds ZIP32 limit');
  }
  if (entries.length > 65535) throw new Error('Too many archive entries');
  const size = central.reduce((sum, bytes) => sum + bytes.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + size + 22); let cursor = 0;
  for (const bytes of [...local, ...central, end]) { output.set(bytes, cursor); cursor += bytes.length; }
  return output;
}
