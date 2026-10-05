import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as queueUtils from '../extension/queue-utils.js';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
function section(from, to) {
  const begin = worker.indexOf(from);
  const end = worker.indexOf(to, begin + from.length);
  assert.ok(begin >= 0 && end > begin, from);
  return worker.slice(begin, end);
}
function harness(stored) {
  let writes = 0;
  const context = {
    ...queueUtils,
    groupEntries: (queue, id) => queue.groups[id] || [],
    withStateLock: async (fn) => fn(),
    getStored: async () => stored,
    getAllModelCatalog: async () => [],
    chrome: { storage: { local: { set: async (value) => { writes++; Object.assign(stored, value); } } } }
  };
  runInNewContext(`
    ${section('function normalizeHistory(', 'function recordCompletedEntry(')}
    ${section('function setGenerationMemoryRecordStatus(', 'async function discoverAutomationTabsForRun(')}
    ${section('function allQueueEntries(', 'function applyGenerationMemoryStatusChange(')}
    ${section('async function ensureGenerationMemoryState(', 'async function quickProbeReadyResultsBeforeReset(')}
    globalThis.api = { repairStoppedQueueStatuses, syncGenerationMemory, ensureGenerationMemoryState };
  `, context);
  return { api: context.api, writes: () => writes };
}
function fixture() {
  const identity = { sourceId: 'casio:pending', skuKey: 'casio:pending', groupId: 'in_sale_good',
    sourceVariantId: 'variant-pending', relativePath: 'in_sale_good/Pending.png',
    fileName: 'Pending.png', modelName: 'Casio Pending', fingerprint: 'fingerprint', sourceHash: 'a'.repeat(64) };
  const unfinished = { ...identity, status: 'pending', generationId: 'stale', lastError: 'tab lost',
    variants: [{ ...identity, status: 'running', generationId: 'stale', lastError: 'DOM change timeout' }] };
  const ready = { ...identity, sourceId: 'casio:ready', skuKey: 'casio:ready', sourceVariantId: 'variant-ready',
    relativePath: 'in_sale_good/Ready.png', fileName: 'Ready.png', status: 'done',
    generationId: 'verified', outputPath: 'Downloads/WatchAutomation/Ready.png', outputHash: 'b'.repeat(64) };
  return { run: null, runtime: { state: 'STOPPED' },
    queue: { groups: { in_sale_good: [unfinished, ready] }, repairQueue: [{ sourceId: ready.sourceId, status: 'pending' }] },
    history: { items: {}, ignored: {} },
    generationMemory: { items: {
      [identity.sourceId]: { ...identity, status: 'not_ready', lastError: 'tab lost', errorClass: 'transport',
        generationId: 'stale', generationStartedAt: '2026-10-01T00:00:00.000Z',
        lastRunId: 'old-run', attempt: 3, retryCount: 2, nextRetryAt: 100, updatedAt: 'old' },
      [ready.sourceId]: { ...ready, status: 'ready', updatedAt: 'confirmed' }
    } } };
}

test('stopped storage cleanup clears attempt state, preserves completed results and is idempotent', async () => {
  const stored = fixture();
  const h = harness(stored);
  const completed = JSON.stringify(stored.generationMemory.items['casio:ready']);
  const repairs = JSON.stringify(stored.queue.repairQueue);
  assert.equal(h.api.repairStoppedQueueStatuses(stored.queue, stored.generationMemory), true);
  const record = stored.generationMemory.items['casio:pending'];
  assert.equal(record.status, 'not_ready');
  for (const field of ['generationId', 'generationStartedAt', 'lastError', 'errorClass', 'lastRunId', 'nextRetryAt']) {
    assert.equal(record[field], null, field);
  }
  assert.equal(record.retryCount, 0);
  assert.equal(record.attempt, 0);
  assert.equal(stored.queue.groups.in_sale_good[0].variants[0].status, 'pending');
  const after = JSON.stringify(stored);
  assert.equal(h.api.repairStoppedQueueStatuses(stored.queue, stored.generationMemory), false);
  assert.equal(JSON.stringify(stored), after, 'repeating cleanup leaves timestamps and content unchanged');
  assert.equal(JSON.stringify(stored.generationMemory.items['casio:ready']), completed);
  assert.equal(JSON.stringify(stored.queue.repairQueue), repairs);
});

test('opening stopped memory cleans stale errors while active and paused runs preserve their attempt state', async () => {
  const stopped = fixture();
  await harness(stopped).api.ensureGenerationMemoryState();
  assert.equal(stopped.generationMemory.items['casio:pending'].lastError, null);
  for (const state of ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED']) {
    const stored = fixture();
    stored.run = { state, operationId: 'current-run' };
    stored.generationMemory.items['casio:pending'].status = 'running';
    await harness(stored).api.ensureGenerationMemoryState();
    assert.equal(stored.generationMemory.items['casio:pending'].status, 'running', state);
    assert.equal(stored.generationMemory.items['casio:pending'].lastError, 'tab lost', state);
    assert.equal(stored.generationMemory.items['casio:pending'].retryCount, 2, state);
  }
});

test('changed bytes for the same input asset invalidate completion without borrowing a different quality variant', () => {
  const stored = fixture();
  const entry = stored.queue.groups.in_sale_good[0];
  const record = stored.generationMemory.items[entry.sourceId];
  record.status = 'ready';
  record.outputPath = 'Downloads/WatchAutomation/Old.png';
  record.outputHash = 'c'.repeat(64);
  entry.sourceHash = 'd'.repeat(64);
  entry.fingerprint = 'new-fingerprint';
  entry.variants[0].sourceHash = entry.sourceHash;
  entry.variants[0].fingerprint = entry.fingerprint;
  const synced = harness(stored).api.syncGenerationMemory(stored.queue, stored.generationMemory, stored.history, null);
  assert.equal(synced.memory.items[entry.sourceId].status, 'not_ready');
  assert.equal(synced.memory.items[entry.sourceId].outputPath, null);
  assert.equal(synced.memory.items[entry.sourceId].outputHash, null);
  assert.equal(synced.memory.items[entry.sourceId].sourceHash, entry.sourceHash);
});
