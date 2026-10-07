import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as policy from '../extension/session-watchdog-utils.js';
import * as diagnostics from '../extension/run-diagnostics-utils.js';
import * as queueUtils from '../extension/queue-utils.js';
import * as reliability from '../extension/reliability-utils.js';
import * as clocks from '../extension/run-clock-utils.js';
import * as repairs from '../extension/repair-queue-utils.js';
import * as revisions from '../extension/generation-revision-utils.js';
import { buildInputPlan } from '../extension/input-plan.js';
import { createDiagnosticOutbox } from '../extension/diagnostic-outbox-utils.js';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const initialTime = Date.parse('2026-10-06T10:00:00Z');
const copy = value => structuredClone(value);
function implementation(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, name);
  const next = /^(?:async )?function \w+\(/m.exec(source.slice(start.index + start[0].length));
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}
function harness() {
  const clock = { value: initialTime };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.value])); }
    static now() { return clock.value; }
  }
  const stored = { run: { operationId: 'worker-test', state: 'RUNNING', plannedIds: ['a', 'b'],
    startedAt: new Date(initialTime - 20 * 60_000).toISOString(), groupId: 'in_sale_good',
    eventJournal: [], eventSequence: 10, slots: {} }, queue: { groups: { in_sale_good: [] } }, job: {} };
  const archive = [];
  const storage = {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, copy(stored[key])])),
    set: async patch => Object.assign(stored, copy(patch)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; }
  };
  const outbox = createDiagnosticOutbox({ storage, archive: async (_header, records) => archive.push(...copy(records)) });
  let chain = Promise.resolve();
  const calls = { begins: 0, reloads: 0, executions: [], deferred: [] };
  const context = vm.createContext({ ...policy, ...diagnostics, ...queueUtils, ...reliability, ...clocks, ...repairs, ...revisions,
    Date: TestDate, structuredClone, console, crypto: { randomUUID },
    chrome: { storage: { local: storage }, runtime: { getManifest: () => ({ version: '0.3.49' }),
      reload: () => calls.reloads++, sendMessage: async () => {} } },
    getStored: async () => copy(stored),
    withStateLock: fn => { const pending = chain.then(fn); chain = pending.catch(() => {}); return pending; },
    appendLog: async () => {}, diagnosticOutbox: outbox, diagnosticDecisionSequences: new Map(),
    queueRunDiagnostics: () => {}, MAX_RUN_EVENTS: 600, RUN_CLOCK_PAUSE_EVENTS: new Set(),
    sessionWatchdogInFlight: null, sessionRestartController: { begin: async () => { calls.begins++; return {}; } },
    resumeRestoredSessionAssignments: async () => {},
    runSessionRestartWithTimeout: async fn => fn(),
    sessionWatchdogTimer: null, runDiagnosticsFlushInFlight: false, runDiagnosticsFlushTimer: null,
    pendingRunDiagnosticSnapshots: new Map(), runDiagnosticPersistenceState: new Map(),
    RUN_DIAGNOSTICS_RETRY_BASE_MS: 30_000, RUN_DIAGNOSTICS_RETRY_MAX_MS: 300_000,
    scheduleRunDiagnosticsFlush: delay => calls.deferred.push(delay),
    activeSlotExecutionTasks: new Map(),
    executeSlotInternal: async (...args) => calls.executions.push(args)
  });
  for (const name of ['recordRunEvent', 'persistRunDiagnosticDecision', 'recordSafetyEvent',
    'recordRecoveryFailure', 'recordDetachedRecoveryFailure', 'checkSessionWatchdog',
    'flushQueuedRunDiagnostics', 'executeSlot']) vm.runInContext(implementation(name), context);
  context.saveRunAndQueue = async (run, queue) => {
    await context.persistRunDiagnosticDecision(run, queue);
    await storage.set({ run, queue });
  };
  return { context, stored, archive, storage, calls, outbox, clock, settle: () => chain };
}

test('real worker failure handler persists unique sequences before subsequent and concurrent decisions', async () => {
  const h = harness();
  await h.context.recordRecoveryFailure('audit_failed', new Error('offline failure'));
  assert.equal(h.stored.run.eventSequence, 11);
  await h.context.recordSafetyEvent('worker-test', 'tab_recovery_started', { tabId: 9 });
  await Promise.all([h.context.recordRecoveryFailure('facts_monitor_failed', new Error('facts failure')),
    h.context.recordRecoveryFailure('session_watchdog_failed', new Error('watchdog failure'))]);
  const snapshot = await h.outbox.read('worker-test');
  assert.deepEqual(snapshot.records.map(e => e.sequence), [11, 12, 13, 14]);
  assert.deepEqual(snapshot.records.map(e => e.type), ['audit_failed', 'tab_recovery_started', 'facts_monitor_failed', 'session_watchdog_failed']);
  assert.equal(h.stored.run.eventSequence, 14);
});

test('interleaved identical facts errors are deduplicated per owner, while new errors and leases remain visible', async () => {
  const h = harness();
  for (const tabId of [8, 9, 8, 9]) await h.context.recordSafetyEvent('worker-test', 'facts_pulse_failed', { tabId, error: 'same' });
  assert.equal(h.stored.run.eventJournal.length, 2);
  await h.context.recordSafetyEvent('worker-test', 'facts_pulse_failed', { tabId: 8, error: 'different' });
  await h.context.recordSafetyEvent('worker-test', 'facts_pulse_failed', { tabId: 8, error: 'different', leaseId: 'fresh' });
  assert.equal(h.stored.run.eventJournal.length, 4);
});

test('emergency reload diagnostic bypasses a stuck state mutex without overwriting normal run sequences', async () => {
  const h = harness();
  h.context.withStateLock = () => new Promise(() => {});
  await h.context.recordDetachedRecoveryFailure('session_restart_worker_reload', new Error('timeout'),
    { operationId: 'worker-test', restartId: 'restart-test' });
  await h.outbox.drain();
  assert.equal(h.stored.run.eventSequence, 10);
  assert.equal(h.archive.length, 1);
  assert.equal(h.archive[0].type, 'session_restart_worker_reload');
  assert.equal(h.archive[0].previousOperationId, 'worker-test');
  assert.notEqual(h.archive[0].operationId, 'worker-test');
});

test('a recovery failure after run:null remains exportable and links back to its original session', async () => {
  const h = harness();
  h.stored.run = null;
  h.stored.sessionRestartIntent = { restartId: 'after-reset', operationId: 'worker-test', stage: 'RESTORING' };
  await h.context.recordRecoveryFailure('session_watchdog_failed', new Error('Restoration failed'));
  await h.outbox.drain();
  assert.equal(h.archive.length, 1);
  assert.equal(h.archive[0].previousOperationId, 'worker-test');
  assert.equal(h.archive[0].restartId, 'after-reset');
  assert.equal(h.archive[0].stage, 'RESTORING');
});

test('bounded archive drain cannot falsely acknowledge records still in durable storage', async () => {
  const h = harness();
  const snapshot = { operationId: 'worker-test', header: { operationId: 'worker-test' },
    records: [{ operationId: 'worker-test', sequence: 11, type: 'audit_failed' }], maxSequence: 11, headerFingerprint: 'head' };
  h.context.pendingRunDiagnosticSnapshots.set('worker-test', snapshot);
  const outbox = h.context.diagnosticOutbox;
  h.context.diagnosticOutbox = { persist: value => outbox.persist(value), read: id => outbox.read(id),
    drain: async () => ({ failures: [], remainingRuns: 1 }) };
  await h.context.flushQueuedRunDiagnostics();
  assert.equal(h.context.runDiagnosticPersistenceState.get('worker-test').persistedSequence || 0, 0);
  assert.equal(h.context.pendingRunDiagnosticSnapshots.size, 1);
  assert.equal((await outbox.read('worker-test')).records.length, 1);
  h.clock.value += 30_001;
  h.context.diagnosticOutbox = outbox;
  await h.context.flushQueuedRunDiagnostics();
  assert.equal(h.context.runDiagnosticPersistenceState.get('worker-test').persistedSequence, 11);
  assert.equal(h.context.pendingRunDiagnosticSnapshots.size, 0);
});

test('expired known quota re-arms actual worker watchdog instead of triggering an immediate full reset', async () => {
  const h = harness();
  h.stored.run.sessionWatchdog = { lastUsefulAt: new Date(initialTime - 4 * 3600_000).toISOString(),
    armedAt: initialTime - 4 * 3600_000, blockedReason: 'confirmed_quota', resultKeys: [] };
  h.stored.run.imageLimitDetected = true;
  h.stored.run.rateLimitPauseUntil = initialTime - 1;
  await h.context.checkSessionWatchdog();
  await h.settle();
  assert.equal(h.calls.begins, 0);
  assert.equal(h.stored.run.sessionWatchdog.armedAt, initialTime);
  h.clock.value += 10 * 60_000;
  await h.context.checkSessionWatchdog();
  assert.equal(h.calls.begins, 1);
});

test('independent watchdog persists recovery intent even if the ordinary audit mutex cannot settle', async () => {
  const h = harness();
  h.context.withStateLock = () => new Promise(() => {});
  h.context.sessionRestartController.begin = async run => {
    await h.storage.set({ sessionRestartIntent: { operationId: run.operationId, stage: 'RESETTING' } });
    return { waiting: true };
  };
  await h.context.checkSessionWatchdog();
  assert.equal(h.stored.sessionRestartIntent.stage, 'RESETTING');
});

test('ordinary startup reconciliation cannot replace a pending full restart with a manual restart pause', async () => {
  const h = harness();
  h.stored.sessionRestartIntent = { operationId: 'worker-test', stage: 'RESETTING' };
  let resumed = false;
  h.context.checkSessionWatchdog = async () => { resumed = true; };
  h.context.resumeInterruptedSessionReset = () => { throw new Error('Must keep the full restart plan'); };
  vm.runInContext(implementation('recoverInterruptedRun'), h.context);
  await h.context.recoverInterruptedRun('Extension worker reload');
  assert.equal(resumed, true);
  assert.equal(h.stored.run.state, 'RUNNING');
});

test('a new Start cannot replace the frozen continuation while the current session is being restored', async () => {
  const h = harness();
  h.stored.run = null;
  h.stored.sessionRestartIntent = { operationId: 'worker-test', stage: 'RESTORING', plannedIds: ['a', 'b'] };
  h.context.assertManualExtensionUpdateNotApplying = async () => {};
  h.context.waitForStartupReconciliation = async () => {};
  h.context.runPreflight = async () => { throw new Error('Starting a different playlist is forbidden'); };
  vm.runInContext(implementation('startRun'), h.context);
  await assert.rejects(h.context.startRun(), /Восстановление текущего прогона/);
  assert.deepEqual(h.stored.sessionRestartIntent.plannedIds, ['a', 'b']);
  assert.equal(h.stored.run, null);
});

test('restored assignment and normal start share a single preparation task', async () => {
  const h = harness();
  let finish;
  h.context.executeSlotInternal = async (...args) => { h.calls.executions.push(args); await new Promise(resolve => { finish = resolve; }); };
  const first = h.context.executeSlot('new-run', 0, 'a');
  const second = h.context.executeSlot('new-run', 0, 'a');
  assert.equal(first, second);
  assert.equal(h.calls.executions.length, 1);
  finish(); await first;
  assert.equal(h.context.activeSlotExecutionTasks.size, 0);
});

test('actual preflight preserves frozen repair IDs after part membership changes', async () => {
  const h = harness();
  const entries = ['a', 'b', 'outside'].map(sourceId => ({ sourceId, skuKey: sourceId, groupId: 'in_sale_good',
    modelName: `Casio ${sourceId}`, fileName: `${sourceId}.png`, status: 'pending', inputSourceId: sourceId }));
  h.stored.queue.groups.in_sale_good = entries;
  h.stored.queue.repairQueue = [{ sourceId: 'a', status: 'completed' }, { sourceId: 'b', status: 'queued' }];
  const frozen = { prompt: '{{REF_TEMPLATE}} {{REF_WATCH}}', inputMode: '2',
    filters: { saleStatus: 'in_sale', quality: 'good', brand: 'casio' }, runPart: 1,
    runPartSignature: 'obsolete-part-signature', runQueueMode: queueUtils.REGENERATION_QUEUE_ID, runLimit: 100 };
  const recipes = [];
  Object.assign(h.context, { buildInputPlan, computeEntryRecipeHash: async (job, _queue, entry) => {
    assert.equal(job.prompt, frozen.prompt); recipes.push(entry.sourceId); return 'recipe'; },
    getAssetKeys: async prefix => prefix === 'ref:' ? ['ref:template'] : ['watch:a', 'watch:b', 'watch:outside'],
    detectBrandProfile: () => 'casio', referenceCandidatesForRole: () => ['template'],
    fetchWithTimeout: async () => ({ ok: true }), outputDirectoryAccess: async () => ({ config: { mode: 'downloads' } }),
    PROMPT_PIPELINE_VERSION: '6' });
  vm.runInContext(implementation('runPreflight'), h.context);
  vm.runInContext(implementation('groupEntries'), h.context);
  const result = await h.context.runPreflight({ selectedIds: ['a', 'b'], queueMode: queueUtils.REGENERATION_QUEUE_ID,
    partNumber: null, validateLaunchSelection: false, exactPlannedScope: true, jobSnapshot: frozen });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.candidates, 2);
  assert.deepEqual(recipes, ['a', 'b']);
  assert.deepEqual(Array.from(result.selectedIds), ['a', 'b']);
});

test('finished photos with failed specifications remain eligible, fully finished run does not', () => {
  const h = harness();
  h.stored.run.state = 'DONE'; h.stored.run.status = 'DONE_WITH_FACTS_ERRORS';
  assert.equal(policy.sessionWatchdogDecision(h.stored.run, initialTime).due, true);
  h.stored.run.status = 'DONE';
  assert.equal(policy.sessionWatchdogDecision(h.stored.run, initialTime).due, false);
});

test('actual emergency timeout reloads a hung recovery and preserves its intent and diagnostic', async () => {
  const h = harness();
  const timers = [];
  h.context.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  h.context.clearTimeout = () => {};
  h.context.sleep = () => new Promise(() => {});
  h.stored.sessionRestartIntent = { restartId: 'recovery-id', operationId: 'worker-test', stage: 'RESETTING' };
  h.context.withStateLock = () => new Promise(() => {});
  vm.runInContext(implementation('runSessionRestartWithTimeout'), h.context);
  let finish;
  const task = h.context.runSessionRestartWithTimeout(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(timers[0].delay, 45000);
  timers[0].fn();
  for (let tick = 0; tick < 80 && !h.calls.reloads; tick++) await Promise.resolve();
  assert.equal(h.calls.reloads, 1);
  assert.equal(h.stored.sessionRestartIntent.restartId, 'recovery-id');
  await h.outbox.drain();
  assert.ok(h.archive.some(event => event.type === 'session_restart_worker_reload'));
  finish({ restarted: true }); await task;
});

test('a user cancellation arriving before the emergency timeout prevents background reload', async () => {
  const h = harness();
  let callback;
  h.context.setTimeout = fn => { callback = fn; return 1; };
  h.context.clearTimeout = () => {};
  h.context.sleep = () => new Promise(() => {});
  h.stored.sessionRestartIntent = { restartId: 'cancelled', operationId: 'worker-test' };
  h.stored.sessionRestartCancellation = { restartId: 'cancelled', reason: 'pause' };
  vm.runInContext(implementation('runSessionRestartWithTimeout'), h.context);
  let finish;
  const task = h.context.runSessionRestartWithTimeout(() => new Promise(resolve => { finish = resolve; }));
  callback();
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  assert.equal(h.calls.reloads, 0);
  finish(); await task;
});

for (const mode of ['restart', 'stop']) {
test(`production ${mode} cleanup preserves results, logs and displayed run progress before clearing run`, async () => {
  const h = harness();
  const good = { sourceId: 'a', skuKey: 'a', groupId: 'in_sale_good', modelName: 'Casio a',
    status: 'done', generationId: 'saved-a', outputPath: 'fake/a.png', outputHash: 'a'.repeat(64), factsStatus: 'ok' };
  const incomplete = { sourceId: 'b', skuKey: 'b', groupId: 'in_sale_good', modelName: 'Casio b',
    status: 'running', generationId: 'draft-b', lastError: 'unknown stall', retryCount: 2 };
  const outside = { sourceId: 'outside', skuKey: 'outside', groupId: 'not_in_sale_good',
    status: 'running', generationId: 'untouched-draft' };
  h.stored.queue.groups.in_sale_good = [good, incomplete];
  h.stored.queue.groups.not_in_sale_good = [outside];
  h.stored.history = { items: {}, ignored: {} };
  h.stored.generationMemory = { items: {
    a: { ...good, status: 'ready' }, b: { ...incomplete, status: 'running' },
    outside: { ...outside, status: 'running' }
  } };
  h.stored.logs = [{ message: 'old run log' }];
  h.stored.run.slots = { 0: { slotId: 0, entryId: 'b', leaseId: 'b-lease', generationId: 'draft-b', tabId: 19, status: 'PREPARING' } };
  const removed = [], cancelled = [], runtime = [];
  Object.assign(h.context, { stopAuditMonitor: () => {}, updateRuntime: async value => runtime.push(value),
    EXTENSION_BUILD_ID: '2026-10-06.3', cancelUnsubmittedGenerationRevision: async id => cancelled.push(id),
    quickProbeReadyResultsBeforeReset: async () => ({ checked: 1, downloadsStarted: 0 }),
    reconcileActiveDownloads: async () => {}, reconcileRunVerifiedRevisions: async () => 0,
    reconcilePersistedCurrentRevisions: async () => 0,
    flushRunDiagnosticsSafely: async (run, queue) => h.context.persistRunDiagnosticDecision(run, queue, true),
    sendTabMessage: async (_id, message) => { assert.equal(message.type, 'STOP'); },
    CONVERSATION_LOAD_RECOVERY_ALARM_NAME: 'conversation', STALLED_BATCH_RECOVERY_ALARM_NAME: 'batch' });
  h.context.chrome.tabs = { query: async () => [], remove: async id => removed.push(id) };
  h.context.chrome.alarms = { clear: async () => {} };
  h.context.chrome.windows = { remove: async () => { throw new Error('A user window must not be closed'); } };
  for (const name of ['normalizeHistory', 'normalizeGenerationMemory', 'groupEntries', 'allQueueEntries', 'indexQueueRowsBySource',
    'resetQueueSourceForIdentity', 'generationMemoryHasVerifiedResult', 'clearUnfinishedGenerationMemoryRecord',
    'setGenerationMemoryStatus', 'setGenerationMemoryRecordStatus', 'slotGenerationSubmitted',
    'currentSlotSendClicked', 'performResetRunAndRescan']) vm.runInContext(implementation(name), h.context);
  const beforeGood = copy(good), beforeOutside = copy(outside);
  await h.context.performResetRunAndRescan({ automatic: true, sessionRestart: mode === 'restart',
    preserveRunProgress: mode === 'stop', preserveLogs: true, plannedOnly: ['a', 'b'] });
  assert.equal(h.stored.run, null);
  const originalFields = (actual, original) => Object.fromEntries(Object.keys(original).map(key => [key, actual[key]]));
  assert.deepEqual(originalFields(h.stored.queue.groups.in_sale_good[0], beforeGood), beforeGood);
  assert.deepEqual(originalFields(h.stored.queue.groups.not_in_sale_good[0], beforeOutside), beforeOutside);
  assert.equal(h.stored.queue.groups.in_sale_good[1].status, 'pending');
  assert.equal(h.stored.queue.groups.in_sale_good[1].generationId, null);
  assert.equal(h.stored.generationMemory.items.b.status, 'not_ready');
  assert.equal(h.stored.logs.length, 1);
  assert.deepEqual(removed, [19]); assert.deepEqual(cancelled, ['draft-b']);
  assert.equal(runtime[0].status, mode === 'restart' ? 'SESSION_RESTARTING' : 'MIGRATING');
  assert.equal(runtime.at(-1).state, mode === 'restart' ? 'RECONCILING' : 'STOPPED');
  assert.ok(runtime.every(snapshot => snapshot.state !== 'IDLE'), 'cleanup never flashes an idle preview');
  const pending = await h.outbox.read('worker-test');
  assert.ok(pending.records.some(event => event.type === 'session_reset_completed' && event.automatic));
  assert.equal(h.stored.sessionResetIntent, undefined);
});
}

