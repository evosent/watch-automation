import { promises as fs } from 'node:fs';

// Cache file evidence rather than readiness. Every use checks metadata; a
// different expected hash is always compared independently with the evidence.
export function createArtifactAccountingVerifier({ validatePath, readPngMetadata, stat = fs.stat,
  maximumEntries = 4096, concurrency = 4 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  const waiters = [];
  async function limited(action) {
    if (active >= concurrency) await new Promise(resolve => waiters.push(resolve));
    else active++;
    try { return await action(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  }
  const signature = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
  async function evidence(filePath) {
    if (pending.has(filePath)) return pending.get(filePath);
    const task = limited(async () => {
      const before = await stat(filePath);
      if (!before.isFile()) throw Object.assign(new Error('PNG is not a file'), { code: 'NOT_FILE' });
      const stamp = signature(before);
      const saved = cache.get(filePath);
      if (saved?.stamp === stamp) return saved.metadata;
      const metadata = await readPngMetadata(filePath);
      const after = await stat(filePath);
      if (signature(after) !== stamp) throw Object.assign(new Error('PNG changed during verification'), { code: 'FILE_CHANGED' });
      cache.delete(filePath);
      cache.set(filePath, { stamp, metadata });
      while (cache.size > maximumEntries) cache.delete(cache.keys().next().value);
      return metadata;
    });
    pending.set(filePath, task);
    try { return await task; }
    finally { if (pending.get(filePath) === task) pending.delete(filePath); }
  }
  return async function verifyArtifacts(artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length > 10000) throw new Error('Invalid artifacts list');
    const ids = new Set();
    const checks = {};
    const checkedAt = new Date().toISOString();
    await Promise.all(artifacts.map(async artifact => {
      const id = String(artifact?.generationId || '');
      if (!id || ids.has(id)) throw new Error('Unique generationId is required');
      ids.add(id);
      const expected = String(artifact?.outputHash || '').toLowerCase();
      let filePath = String(artifact?.path || '');
      try {
        filePath = validatePath(filePath);
        if (!/\.png$/i.test(filePath) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('PNG path and SHA-256 are required');
        const metadata = await evidence(filePath);
        const sha256 = String(metadata.sha256 || '').toLowerCase();
        const hashMatches = sha256 === expected;
        Object.defineProperty(checks, id, { enumerable: true, configurable: true, value: {
          path: filePath, exists: true, verified: metadata.valid === true,
          valid: metadata.valid === true && hashMatches, sha256, hashMatches,
          size: Number(metadata.bytes || 0), width: metadata.width, height: metadata.height, checkedAt
        } });
      } catch (error) {
        cache.delete(filePath);
        Object.defineProperty(checks, id, { enumerable: true, configurable: true, value: {
          path: filePath, exists: error.code === 'ENOENT' ? false : null,
          verified: error.code === 'ENOENT', valid: false, hashMatches: false,
          error: error.code || error.message, checkedAt
        } });
      }
    }));
    return { ok: true, checkedAt, checks };
  };
}
