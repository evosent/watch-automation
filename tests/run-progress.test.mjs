import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { syncRunProgress, mergeRuntimeSnapshot } from '../extension/run-progress-utils.js';
import { pendingEntryIdsForFilter } from '../extension/queue-utils.js';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
function section(start, end) {
  const left = worker.indexOf(start);
  const right = worker.indexOf(end, left);
  assert.ok(left >= 0 && right > left, `${start} production function exists`);
  return worker.slice(left, right);
}
function makeRun(plannedIds = ['a', 'b', 'c']) {
  return { operationId: 'run-one', groupId: 'selected', plannedIds, state: 'RUNNING', status: 'RUNNING' };
}
function workerHarness() {
  const writes = [];
  let stored = {};
  const context = {
    syncRunProgress, mergeRuntimeSnapshot,
    elapsedRunClock: () => 10000,
    groupEntries: (queue) => queue?.entries || [],
    normalizeWatchFilter: (value) => value,
    parseFilterSelectionId: () => ({}), filterFromQueueGroup: () => ({}),
    watchFilterLabel: () => '', normalizeCoverageMode: (value) => value,
    activeSlots: () => 0, normalizeWorkerCount: () => 6, DEFAULT_WORKERS: 6,
    normalizeInputMode: (value) => value, DEFAULT_INPUT_MODE: 'template-watch',
    normalizeRateLimitPauseMinutes: (value) => value,
    normalizeRateLimitIgnoreMinutes: (value) => value,
    normalizeGenerationPauseMinutes: (value) => value,
    normalizeGenerationJitterSeconds: (value) => value,
    factsProgressSummaries: () => [], slotSummaries: () => [],
    flushRunDiagnosticsSafely: async () => {},
    shouldKeepAuditMonitor: () => false, startAuditMonitor() {}, stopAuditMonitor() {},
    EXTENSION_BUILD_ID: 'progress-test',
    chrome: {
      storage: { local: {
        // Yield to exercise concurrent read/merge/write publishers.
        get: async () => { await Promise.resolve(); return { runtime: structuredClone(stored) }; },
        set: async ({ runtime }) => { await Promise.resolve(); stored = structuredClone(runtime); writes.push(stored); }
      } },
      runtime: { sendMessage: async () => {} }
    }
  };
  runInNewContext(
    section('let runtimeUpdateChain =', 'function flushPendingLogsSoon(')
    + section('function runSummary(run, queue)', 'async function waitTabReady(')
    + '\nglobalThis.publish = publishRun; globalThis.update = updateRuntime; globalThis.summary = runSummary;', context
  );
  return { context, writes, read: () => stored };
}

test('66 existing results in a 100-model part produce exactly 34 current-launch tasks', () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    sourceId: `model-${index}`, status: index < 66 ? 'done' : 'pending'
  }));
  const run = makeRun(pendingEntryIdsForFilter(entries, 100, 'queue'));
  assert.equal(run.plannedIds.length, 34);
  assert.deepEqual(syncRunProgress(run, entries), {
    progressRunId: 'run-one', runTotal: 34, runCompleted: 0, runRemaining: 34
  });
  entries[66].status = 'done';
  assert.equal(syncRunProgress(run, entries).runCompleted, 1);
  assert.equal(entries.filter((entry) => entry.status === 'done').length, 67);
  assert.ok(run.plannedIds.every((id) => Number(id.split('-')[1]) >= 66));
  assert.equal(pendingEntryIdsForFilter(entries, 10).length, 10, 'configured cap is respected');
});

test('production status-only publications preserve progress and group totals through many status changes', async () => {
  const { context, writes, read } = workerHarness();
  const run = makeRun();
  const queue = { entries: [{ sourceId: 'a', status: 'done' }, { sourceId: 'b', status: 'running' }, { sourceId: 'c', status: 'pending' }] };
  await context.publish(run, queue);
  const saved = JSON.parse(JSON.stringify(run));
  for (let index = 0; index < 60; index++) {
    saved.status = index % 2 ? 'CHECKING' : 'DOWNLOADING';
    await context.publish(saved, null);
  }
  assert.ok(writes.every((value) => value.runTotal === 3 && value.runCompleted === 1 && value.runRemaining === 2));
  assert.equal(read().completed, 1);
  assert.equal(read().pending, 2);
  assert.equal(read().runtimeSequence, 61);
  queue.entries[1].status = 'done';
  await context.publish(saved, queue);
  await context.publish(saved, null);
  assert.equal(read().runCompleted, 2);
  assert.equal(read().runTotal, 3);
});

test('legacy null-queue publications preserve known counters until a queue-backed migration', async () => {
  const { context, read } = workerHarness();
  await context.update({ operationId: 'run-one', runTotal: 3, runCompleted: 2, runRemaining: 1 });
  const legacy = makeRun();
  const summary = context.summary(legacy, null);
  assert.equal(summary.runTotal, 3);
  assert.equal(Object.hasOwn(summary, 'runCompleted'), false);
  await context.publish(legacy, null);
  assert.equal(read().runCompleted, 2);
  await context.publish(legacy, { entries: [{ sourceId: 'a', status: 'done' }, { sourceId: 'b', status: 'done' }] });
  assert.equal(legacy.progress.completedIds.length, 2);
  assert.equal(read().runTotal, 3, 'a missing queue entry cannot shrink the fixed plan');
});

test('runtime run summary preserves the ready-result progress contract for fast and full reads', () => {
  const { context } = workerHarness();
  const run = { ...makeRun(), progressCompletionMode: 'ready', completedTaskIds: ['a'] };
  const summary = context.summary(run, null);
  assert.equal(summary.progressCompletionMode, 'ready');
  assert.equal(summary.runTotal, 3);
  assert.equal(summary.runCompleted, 1);
  assert.equal(summary.runRemaining, 2);
});

test('production full runtime read heals an already paused legacy run and persists its plan counters', async () => {
  const { context, read } = workerHarness();
  const stored = {
    run: { ...makeRun(), state: 'PAUSED' },
    queue: { groups: {}, entries: [{ sourceId: 'a', status: 'done' }, { sourceId: 'b', status: 'pending' }] },
    history: {}, generationMemory: {}, runtime: { operationId: 'run-one', state: 'PAUSED', runTotal: 0, runCompleted: 0 }
  };
  const saved = [];
  Object.assign(context, {
    withStateLock: async (fn) => fn(), getStored: async () => ({ ...stored, runtime: read() }),
    getAllModelCatalog: async () => [],
    normalizeHistory: (value) => value, normalizeGenerationMemory: (value) => value,
    allQueueEntries: (queue) => queue.entries,
    syncQueueWithHistory: (queue, history, memory) => ({ queue, history, memory }),
    QUEUE_GROUP_IDS: []
  });
  const setRuntime = context.chrome.storage.local.set;
  context.chrome.storage.local.set = async (patch) => {
    if (patch.runtime) await setRuntime(patch);
    else { saved.push(structuredClone(patch)); Object.assign(stored, patch); }
  };
  runInNewContext(section('async function ensureGenerationMemoryState(', 'async function quickProbeReadyResultsBeforeReset(')
    + '\nglobalThis.readFull = ensureGenerationMemoryState;', context);
  await context.update(stored.runtime);
  const full = await context.readFull();
  assert.equal(full.runtime.runTotal, 3);
  assert.equal(full.runtime.runCompleted, 1);
  assert.equal(full.runtime.state, 'PAUSED');
  assert.deepEqual(saved[0].run.progress.completedIds, ['a']);
  const sequence = read().runtimeSequence;
  await context.readFull();
  assert.equal(read().runtimeSequence, sequence, 'repeat read avoids redundant writes');
  assert.equal(saved.length, 1);
});

test('persisted completed task IDs survive worker reload, retries, pause, and automatic session restart', () => {
  const run = makeRun();
  syncRunProgress(run, [{ sourceId: 'a', status: 'done' }]);
  const recovered = JSON.parse(JSON.stringify(run));
  recovered.originOperationId = run.operationId;
  recovered.operationId = 'recovered-child';
  recovered.state = 'PAUSED';
  recovered.pendingIds = ['b', 'c'];
  const value = syncRunProgress(recovered, [{ sourceId: 'a', status: 'pending' }]);
  assert.deepEqual(value, { progressRunId: 'run-one', runTotal: 3, runCompleted: 1, runRemaining: 2 });
  recovered.state = 'RUNNING';
  assert.equal(syncRunProgress(recovered).runCompleted, 1);
  recovered.state = 'STOPPED';
  assert.equal(syncRunProgress(recovered).runCompleted, 1);
  assert.deepEqual(recovered.progress.completedIds, ['a']);
});

test('simultaneous production runtime writers serialize and preserve the latest run counters', async () => {
  const { context, read } = workerHarness();
  await context.update({ operationId: 'run-one', runTotal: 3, runCompleted: 0 });
  await Promise.all([
    context.update({ operationId: 'run-one', runCompleted: 2 }),
    context.update({ operationId: 'run-one', status: 'CHECKING', runTotal: 0, runCompleted: 0 }),
    context.update({ operationId: 'run-one', status: 'PAUSED' })
  ]);
  assert.equal(read().runCompleted, 2);
  assert.equal(read().runTotal, 3);
  assert.equal(read().status, 'PAUSED');
  assert.equal(read().runtimeSequence, 4);
});

test('out-of-order full/fast snapshots cannot roll back progress, status, or a newly started run', () => {
  const latest = { progressRunId: 'run-one', operationId: 'run-one', runTotal: 34, runCompleted: 9, runtimeSequence: 20, state: 'PAUSED' };
  assert.equal(mergeRuntimeSnapshot(latest, { operationId: 'run-one', runTotal: 34, runCompleted: 3, runtimeSequence: 19, state: 'RUNNING' }), latest);
  const recovered = mergeRuntimeSnapshot(latest, { operationId: 'recovered-child', progressRunId: 'run-one', runTotal: 34, runCompleted: 0, runtimeSequence: 21 });
  assert.equal(recovered.runCompleted, 9);
  const stopped = mergeRuntimeSnapshot(recovered, { operationId: null, progressRunId: 'run-one', state: 'STOPPED', runtimeSequence: 22 });
  assert.equal(stopped.runCompleted, 9);
  const fresh = mergeRuntimeSnapshot(stopped, { operationId: 'run-two', runTotal: 5, runCompleted: 0, runtimeSequence: 23, state: 'RUNNING' });
  assert.equal(fresh.runTotal, 5);
  assert.equal(fresh.runCompleted, 0);
  assert.equal(fresh.progressRunId, 'run-two');
  const reset = mergeRuntimeSnapshot(fresh, { state: 'IDLE', operationId: null, runtimeSequence: 24 });
  assert.equal(reset.runTotal, 0);
  assert.equal(reset.progressRunId, null);
});

test('duplicate done records and results outside the current plan are counted once and cannot inflate progress', () => {
  const run = makeRun(['a', 'b', 'b']);
  const result = syncRunProgress(run, ['a', 'a', 'other'].map((sourceId) => ({ sourceId, status: 'done' })));
  assert.equal(result.runTotal, 2);
  assert.equal(result.runCompleted, 1);
});
