import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  beginGenerationRevision, cancelUnsubmittedGenerationRevision,
  getGenerationRevision, getModelCatalog, markGenerationForSessionRetry,
  persistGenerationFactsRevision, persistGenerationImageRevision, replaceModelCatalog
} from '../extension/idb.js';

// These exercise real IndexedDB transactions in memory, without Chrome,
// network requests, generated images or application files.
const hash = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);
function factsFor(record) {
  return { status: 'ok', generationId: record.generationId, factsJobId: record.factsJobId,
    outputPath: record.outputPath, outputHash: record.outputHash,
    chatUrl: record.chatUrl, titleModel: 'Offline test watch', uncertain: [] };
}
function fileVerificationFor(record) {
  return {
    generationId: record.generationId, sourceId: record.sourceId,
    outputPath: record.outputPath, outputHash: record.outputHash,
    verified: true, exists: true, isFile: true, sizeBytes: 128,
    verifiedAt: '2026-10-06T12:00:00.000Z'
  };
}
function tuple(revision) {
  return Object.fromEntries(['generationId', 'sourceId', 'sourceVariantId', 'status',
    'outputPath', 'outputHash', 'chatUrl', 'factsStatus', 'factsJobId', 'facts']
    .map((key) => [key, revision[key]]));
}
async function fixture({ image = true, complete = false } = {}) {
  const sourceId = `session-retry-${randomUUID()}`;
  const inputSourceId = `variant-${sourceId}`;
  const generationId = `old-${randomUUID()}`;
  const otherVariant = { sourceVariantId: `other-${sourceId}`, variantId: `other-${sourceId}`,
    groupId: 'in_sale_bad', status: 'done', generationId: 'unrelated-ready',
    outputPath: 'fake://unrelated.png', outputHash: hash('unrelated'), factsStatus: 'ok' };
  await replaceModelCatalog([{ skuKey: sourceId, sourceId, sourcePresent: true,
    variants: [{ sourceVariantId: inputSourceId, variantId: inputSourceId,
      groupId: 'in_sale_good', relativePath: `${sourceId}.png`, status: 'pending' }, otherVariant],
    queueState: { status: 'pending' } }]);
  const record = { sourceId, generationId, sourceVariantId: inputSourceId,
    factsJobId: `facts-${generationId}`, operationId: 'offline-run', leaseId: `lease-${generationId}`,
    outputPath: `fake://${generationId}.png`, outputHash: hash(generationId),
    chatUrl: `https://chatgpt.com/c/offline-${generationId}` };
  await beginGenerationRevision({ ...record, outputPath: undefined, outputHash: undefined });
  if (image) await persistGenerationImageRevision({ ...record, factsStatus: 'pending', fileVerification: fileVerificationFor(record) });
  if (complete) await persistGenerationFactsRevision({ ...record, facts: factsFor(record) });
  const restartId = `restart-${randomUUID()}`;
  return { sourceId, inputSourceId, generationId, record, restartId, otherVariant,
    mark: () => markGenerationForSessionRetry(sourceId, generationId, { restartId, inputSourceId }) };
}
function replacement(h) {
  const generationId = `fresh-${randomUUID()}`;
  return { ...h.record, generationId, factsJobId: `facts-${generationId}`,
    previousGenerationId: h.generationId, leaseId: `lease-${generationId}`,
    outputPath: `fake://${generationId}.png`, outputHash: hash(generationId) };
}
async function beginReplacement(record) {
  return beginGenerationRevision({ ...record, outputPath: undefined, outputHash: undefined });
}

test('session retry detaches incomplete PNG and preserves its revision and other input variant', async () => {
  const h = await fixture();
  const before = await getGenerationRevision(h.generationId);
  const marked = await h.mark();
  assert.equal(marked.marked, true);
  const model = await getModelCatalog(h.sourceId);
  const revision = await getGenerationRevision(h.generationId);
  assert.deepEqual(tuple(revision), tuple(before));
  assert.equal(revision.supersededBySessionRestartId, h.restartId);
  assert.equal(model.currentGenerationId, null);
  assert.equal(model.currentOutputPath, null);
  assert.equal(model.currentOutputHash, null);
  assert.equal(model.retryRequired, true);
  assert.equal(model.sessionRetry.previousGenerationId, h.generationId);
  assert.equal(model.sessionRetry.inputSourceId, h.inputSourceId);
  assert.equal(model.queueState.status, 'pending');
  assert.equal(model.variants[0].generationId, null);
  assert.equal(model.variants[0].outputPath, null);
  assert.deepEqual(model.variants[1], h.otherVariant);
});

test('complete photo and exact specification are never marked for automatic retry', async () => {
  const h = await fixture({ complete: true });
  const model = await getModelCatalog(h.sourceId);
  const revision = await getGenerationRevision(h.generationId);
  assert.equal((await h.mark()).reason, 'result_complete');
  assert.deepEqual(await getModelCatalog(h.sourceId), model);
  assert.deepEqual(await getGenerationRevision(h.generationId), revision);
});

test('stale generation CAS cannot detach a newer current attempt', async () => {
  const h = await fixture();
  const fresh = replacement(h);
  await beginReplacement(fresh);
  const model = await getModelCatalog(h.sourceId);
  const old = await getGenerationRevision(h.generationId);
  assert.equal((await h.mark()).reason, 'current_generation_changed');
  assert.deepEqual(await getModelCatalog(h.sourceId), model);
  assert.deepEqual(await getGenerationRevision(h.generationId), old);
});

test('wrong input variant and incomplete request identity do not change persisted data', async () => {
  const h = await fixture();
  const before = await getModelCatalog(h.sourceId);
  const mismatch = await markGenerationForSessionRetry(h.sourceId, h.generationId,
    { restartId: h.restartId, inputSourceId: 'wrong-variant' });
  assert.equal(mismatch.reason, 'revision_identity_mismatch');
  assert.equal((await markGenerationForSessionRetry(h.sourceId, h.generationId)).reason, 'missing_identity');
  assert.deepEqual(await getModelCatalog(h.sourceId), before);
});

test('retry intent is idempotent after worker interruption', async () => {
  const h = await fixture();
  await h.mark();
  const model = await getModelCatalog(h.sourceId);
  const revision = await getGenerationRevision(h.generationId);
  const repeated = await h.mark();
  assert.equal(repeated.alreadyMarked, true);
  assert.equal(repeated.marked, false);
  assert.deepEqual(await getModelCatalog(h.sourceId), model);
  assert.deepEqual(await getGenerationRevision(h.generationId), revision);
});

test('late old facts can complete historical revision without reviving its current projection', async () => {
  const h = await fixture();
  await h.mark();
  const before = await getModelCatalog(h.sourceId);
  const saved = await persistGenerationFactsRevision({ ...h.record, facts: factsFor(h.record) });
  assert.equal(saved.matched, true);
  assert.equal(saved.latest, false);
  assert.equal((await getGenerationRevision(h.generationId)).factsStatus, 'ok');
  assert.deepEqual(await getModelCatalog(h.sourceId), before);
});

test('late old image callback cannot clear marker or restore pointer', async () => {
  const h = await fixture();
  await h.mark();
  const before = await getModelCatalog(h.sourceId);
  const saved = await persistGenerationImageRevision({ ...h.record, factsStatus: 'pending', fileVerification: fileVerificationFor(h.record) });
  assert.equal(saved.current, false);
  assert.deepEqual(await getModelCatalog(h.sourceId), before);
});

test('late historical image callback preserves exact facts already saved for its revision', async () => {
  const h = await fixture();
  await h.mark();
  await persistGenerationFactsRevision({ ...h.record, facts: factsFor(h.record) });
  const before = tuple(await getGenerationRevision(h.generationId));
  await persistGenerationImageRevision({ ...h.record, factsStatus: 'pending', fileVerification: fileVerificationFor(h.record) });
  assert.deepEqual(tuple(await getGenerationRevision(h.generationId)), before);
  assert.equal((await getModelCatalog(h.sourceId)).retryRequired, true);
});

test('new draft stays current and keeps pending retry intent until a real image is saved', async () => {
  const h = await fixture();
  await h.mark();
  const fresh = replacement(h);
  await beginReplacement(fresh);
  const model = await getModelCatalog(h.sourceId);
  assert.equal(model.currentGenerationId, fresh.generationId);
  assert.equal(model.retryRequired, true);
  assert.equal(model.queueState.status, 'running');
  assert.equal(model.variants[0].status, 'running');
});

test('cancelled replacement draft cannot return superseded PNG to the current catalog', async () => {
  const h = await fixture();
  await h.mark();
  const fresh = replacement(h);
  await beginReplacement(fresh);
  assert.equal((await cancelUnsubmittedGenerationRevision(fresh.generationId, h.sourceId)).cancelled, true);
  const model = await getModelCatalog(h.sourceId);
  assert.equal(model.currentGenerationId, null);
  assert.equal(model.retryRequired, true);
  assert.equal(model.generationStatus, 'NOT_READY');
  assert.equal(model.variants[0].generationId, null);
  assert.equal(model.currentOutputPath, null);
  assert.equal((await getGenerationRevision(h.generationId)).outputHash, h.record.outputHash);
});

test('fallback refuses superseded previous revision even without a live retry marker', async () => {
  const h = await fixture();
  await h.mark();
  const fresh = replacement(h);
  await beginReplacement(fresh);
  const model = await getModelCatalog(h.sourceId);
  await replaceModelCatalog([{ ...model, retryRequired: false, sessionRetry: null }]);
  await cancelUnsubmittedGenerationRevision(fresh.generationId, h.sourceId);
  assert.equal((await getModelCatalog(h.sourceId)).currentGenerationId, null);
});

test('fresh exact current PNG resolves retry intent while keeping historical image unchanged', async () => {
  const h = await fixture();
  await h.mark();
  const historical = tuple(await getGenerationRevision(h.generationId));
  const fresh = replacement(h);
  await beginReplacement(fresh);
  assert.equal((await persistGenerationImageRevision({ ...fresh, factsStatus: 'pending', fileVerification: fileVerificationFor(fresh) })).current, true);
  const model = await getModelCatalog(h.sourceId);
  assert.equal(model.currentGenerationId, fresh.generationId);
  assert.equal(model.currentOutputHash, fresh.outputHash);
  assert.equal(model.retryRequired, false);
  assert.equal(model.sessionRetry, null);
  assert.equal(model.lastSessionRetry.resolvedByGenerationId, fresh.generationId);
  assert.deepEqual(tuple(await getGenerationRevision(h.generationId)), historical);
  assert.equal((await persistGenerationFactsRevision({ ...fresh, facts: factsFor(fresh) })).latest, true);
  assert.equal((await getModelCatalog(h.sourceId)).latestReadyGenerationId, fresh.generationId);
});

test('facts arriving before new PNG do not resolve retry intent prematurely', async () => {
  const h = await fixture();
  await h.mark();
  const fresh = replacement(h);
  await beginReplacement(fresh);
  const staged = await persistGenerationFactsRevision({ ...fresh, outputPath: undefined, outputHash: undefined,
    facts: { ...factsFor(fresh), outputPath: null, outputHash: null } });
  assert.equal(staged.latest, false);
  assert.equal((await getModelCatalog(h.sourceId)).retryRequired, true);
  await persistGenerationImageRevision({ ...fresh, factsStatus: 'ok', fileVerification: fileVerificationFor(fresh) });
  const model = await getModelCatalog(h.sourceId);
  assert.equal(model.retryRequired, false);
  assert.equal(model.latestReadyGenerationId, fresh.generationId);
});

test('superseded revision ID cannot be reused for a fresh generation', async () => {
  const h = await fixture({ image: false });
  await h.mark();
  const model = copy(await getModelCatalog(h.sourceId));
  await assert.rejects(beginReplacement(h.record), /superseded by a session restart/);
  assert.deepEqual(await getModelCatalog(h.sourceId), model);
});

