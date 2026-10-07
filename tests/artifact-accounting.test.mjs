import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactAccountingVerifier } from '../extension/local-service/artifact-accounting.mjs';

const hash = 'a'.repeat(64);
function fixture(overrides = {}) {
  let reads = 0;
  let stamp = 1;
  let missing = false;
  const verify = createArtifactAccountingVerifier({
    validatePath: value => { if (!value.startsWith('/WatchAutomation/')) throw new Error('Outside results'); return value; },
    stat: async () => {
      if (missing) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return { isFile: () => true, size: 500, mtimeMs: stamp, ctimeMs: stamp, dev: 1, ino: 1 };
    },
    readPngMetadata: async () => { reads++; return { valid: true, sha256: hash, bytes: 500, width: 768, height: 1024 }; },
    ...overrides
  });
  return { verify, reads: () => reads, change: () => stamp++, remove: () => { missing = true; } };
}
const artifact = (generationId = 'gen1', outputHash = hash) => ({ generationId, path: '/WatchAutomation/in_sale_good/result.png', outputHash });

test('physical hash evidence is cached while file metadata stays unchanged', async () => {
  const f = fixture();
  assert.equal((await f.verify([artifact()])).checks.gen1.valid, true);
  assert.equal((await f.verify([artifact()])).checks.gen1.valid, true);
  assert.equal(f.reads(), 1);
  f.change();
  assert.equal((await f.verify([artifact()])).checks.gen1.valid, true);
  assert.equal(f.reads(), 2);
});
test('expected hash is independently checked for each immutable revision', async () => {
  const f = fixture();
  const results = await f.verify([artifact('correct'), artifact('wrong', 'b'.repeat(64))]);
  assert.equal(results.checks.correct.valid, true);
  assert.equal(results.checks.wrong.valid, false);
  assert.equal(results.checks.wrong.exists, true);
  assert.equal(f.reads(), 1);
});
test('deleting a cached PNG immediately invalidates its evidence', async () => {
  const f = fixture();
  await f.verify([artifact()]);
  f.remove();
  const result = (await f.verify([artifact()])).checks.gen1;
  assert.equal(result.exists, false);
  assert.equal(result.verified, true);
  assert.equal(result.valid, false);
});
test('path validation, suffix and hash validation fail closed', async () => {
  const f = fixture();
  for (const value of [{ ...artifact(), path: '/private/x.png' },
    { ...artifact(), path: '/WatchAutomation/x.txt' }, artifact('gen1', 'bad')]) {
    assert.equal((await f.verify([value])).checks.gen1.valid, false);
  }
  assert.equal(f.reads(), 0);
});
test('permissions failure is unknown and cannot assert that an image was lost', async () => {
  const f = fixture({ stat: async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } });
  const check = (await f.verify([artifact()])).checks.gen1;
  assert.equal(check.exists, null);
  assert.equal(check.verified, false);
});
test('file mutation while hashing is rejected and does not enter cache', async () => {
  let n = 0;
  const f = fixture({ stat: async () => ({ isFile: () => true, size: 500, mtimeMs: ++n }) });
  const check = (await f.verify([artifact()])).checks.gen1;
  assert.equal(check.valid, false);
  assert.equal(check.error, 'FILE_CHANGED');
});
test('batch size and duplicate generation identities are bounded', async () => {
  const f = fixture();
  await assert.rejects(f.verify([artifact(), artifact()]), /Unique/);
  await assert.rejects(f.verify(new Array(10001)), /Invalid/);
});
test('parallel requests coalesce and cap expensive hash streams', async () => {
  let active = 0, maxActive = 0, reads = 0;
  const f = fixture({ concurrency: 2, readPngMetadata: async () => {
    reads++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { valid: true, sha256: hash, bytes: 500 };
  } });
  const artifacts = Array.from({ length: 7 }, (_, i) => ({ ...artifact(`gen${i}`), path: `/WatchAutomation/${i}.png` }));
  await Promise.all([f.verify(artifacts), f.verify(artifacts)]);
  assert.equal(reads, 7);
  assert.equal(maxActive, 2);
});
