import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function requestInputFile(');
const end = source.indexOf('async function requestInputFileFromCandidates(', start);
const production = source.slice(start, end);

function harness(getAsset) {
  const context = vm.createContext({ inputFilePromiseCache: new Map(), getAsset,
    base64FromArrayBuffer: (buffer) => Buffer.from(buffer).toString('base64') });
  vm.runInContext(production, context);
  return context;
}
const asset = () => ({ name: 'fake.png', blob: new Blob(['fake PNG'], { type: 'image/png' }) });

test('a thousand individual product photos do not accumulate base64 in the worker cache', async () => {
  const h = harness(async () => asset());
  await h.requestInputFile('ref:template');
  for (let i = 0; i < 1000; i++) {
    assert.ok((await h.requestInputFile(`watch:${i}`)).dataUrl);
    assert.equal(h.inputFilePromiseCache.size, 1);
  }
  assert.ok(h.inputFilePromiseCache.has('ref:template'));
});

test('concurrent loads share a product conversion while it is in flight, then release it', async () => {
  let release;
  let reads = 0;
  const h = harness(async () => { reads++; await new Promise((resolve) => { release = resolve; }); return asset(); });
  const a = h.requestInputFile('watch:same');
  const b = h.requestInputFile('watch:same');
  assert.equal(reads, 1);
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(h.inputFilePromiseCache.size, 0);
});

test('common references are converted once and remain available to later workers', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; return asset(); });
  const first = await h.requestInputFile('ref:shared');
  assert.equal(await h.requestInputFile('ref:shared'), first);
  assert.equal(reads, 1);
});

test('missing or failed product loads do not poison future retries', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; if (reads === 1) return null; if (reads === 2) throw new Error('fake storage failure'); return asset(); });
  assert.equal(await h.requestInputFile('watch:retry', { allowMissing: true }), null);
  await assert.rejects(h.requestInputFile('watch:retry'), /fake storage failure/);
  assert.ok((await h.requestInputFile('watch:retry')).dataUrl);
  assert.equal(h.inputFilePromiseCache.size, 0);
});

test('an old run finishing its load cannot evict a replacement run cache entry', async () => {
  let release;
  const h = harness(async () => { await new Promise((resolve) => { release = resolve; }); return asset(); });
  const oldLoad = h.requestInputFile('watch:reuse');
  const replacement = Promise.resolve({ dataUrl: 'replacement' });
  h.inputFilePromiseCache.set('watch:reuse', replacement);
  release();
  await oldLoad;
  assert.equal(h.inputFilePromiseCache.get('watch:reuse'), replacement);
});

