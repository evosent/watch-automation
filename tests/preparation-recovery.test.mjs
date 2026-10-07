import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { SLOT_PHASES, AUTOMATION_ERROR_CLASSES, classifyAutomationError, retryDelayMs, shouldTripAttachmentFailureCircuitBreaker, isStalledUnsubmittedPreparation, shouldExpireSubmittedObservation, shouldRefreshStalledGeneration } from '../extension/reliability-utils.js';
import { freshSlotRevisionFields, currentLeasePhysicalSend, pageProbeConfirmsUnsubmitted, canAuditSlot } from '../extension/generation-revision-utils.js';
import { syncRunClock, elapsedRunClock, pauseRunClock } from '../extension/run-clock-utils.js';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const begin = worker.indexOf(from);
  const end = worker.indexOf(to, begin + from.length);
  assert.ok(begin >= 0 && end > begin, `${from} must exist`);
  return worker.slice(begin, end);
};
const time = 1_000_000;
const iso = (value) => new Date(value).toISOString();

function harness({ now = time, snapshot = null } = {}) {
  let instant = now;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }
  const entries = [{ sourceId: 'done', status: 'done' }, { sourceId: 'draft', status: 'running' }, { sourceId: 'sent', status: 'running' }];
  const stored = snapshot || {
    run: { operationId: 'run', groupId: 'good', state: 'RUNNING', status: 'RUNNING', pauseReason: null,
      startedAt: iso(now - 60_000), lastActivityAt: iso(now), plannedIds: entries.map((e) => e.sourceId), pendingIds: [],
      slots: {
        0: { ...freshSlotRevisionFields(), slotId: 0, entryId: 'draft', leaseId: 'draft-lease', generationId: 'draft-gen', tabId: 10,
          status: 'PREPARING', phase: 'UPLOADING', lastProgressAt: iso(now - 300_000) },
        1: { ...freshSlotRevisionFields(), slotId: 1, entryId: 'sent', leaseId: 'sent-lease', generationId: 'sent-gen', tabId: 11,
          status: 'GENERATING', phase: 'GENERATING', generationSubmittedAt: iso(now - 10_000) }
      }, postprocessTabs: {}, recoveryTabs: {}, eventJournal: [] },
    queue: { groups: { good: entries } }, history: { items: {}, ignored: {} }, generationMemory: { items: {} }
  };
  const removed = [], cancelled = [], alarms = [], resumed = [], events = [], uploadPauses = [];
  const context = {
    Date: Clock, SLOT_PHASES, currentLeasePhysicalSend, freshSlotRevisionFields,
    MAX_AUTOMATIC_PREPARATION_RECOVERIES: 2, STALLED_BATCH_RECOVERY_DELAY_MS: 300_000,
    UPLOAD_BACKOFF_MS: 3 * 60 * 60_000 + 60_000,
    stalledBatchRecoveryRuns: new Set(), GENERATION_MEMORY_STATUSES: { NOT_READY: 'not_ready', RUNNING: 'running' },
    withStateLock: async (fn) => fn(), getStored: async () => stored,
    pauseForUploadLimit: async (id, details) => { uploadPauses.push({ id, details }); },
    groupEntries: (q, id) => q.groups[id], normalizeHistory: (h) => h, normalizeGenerationMemory: (m) => m,
    setGenerationMemoryStatus: (m, e, status) => { m.items[e.sourceId] = { status }; },
    saveRunAndQueue: async (r) => syncRunClock(r, instant), publishRun: async () => {}, appendLog: async () => {},
    activeSlots: () => 2, reconcileRunVerifiedRevisions: async () => 0, armRateLimitIgnoreWindow: () => {},
    finalCheckDeadline: () => instant + 900_000,
    recordRunEvent: (r, type, data) => { events.push({ type, ...data }); if (type.includes('pause') || type.startsWith('stalled_batch_recovery')) pauseRunClock(r, instant); },
    clockTime: (n) => String(n), cancelUnsubmittedGenerationRevision: async (...args) => cancelled.push(args),
    chrome: { tabs: { remove: async (id) => removed.push(id) } }, startAuditMonitor: () => {}, closeAutomationWindowIfEmpty: async () => {},
    scheduleStalledBatchRecovery: (id, dueAt) => alarms.push({ id, dueAt }),
    resumeRun: async (options) => { resumed.push(options); stored.run.state = 'RUNNING'; stored.run.pauseReason = null; stored.run.stalledBatchRecovery.stage = 'RESUMED'; },
    failStalledBatchRecovery: async (_id, error) => assert.fail(error.stack)
  };
  runInNewContext(`
    ${section('function plannedTaskIsCompleted(', 'function reconcileReadyRunTaskPlan(')}
    ${section('function slotGenerationSubmitted(', 'async function pauseStalledPreparedSlots(')}
    ${section('async function pauseRun(', 'async function stopRun(')}
    ${section('async function schedulePreparationStallRecovery(', 'async function restoreStalledBatchRecovery(')}
    globalThis.api = { schedulePreparationStallRecovery, resumePreparationStallRecovery, pauseRun, slotGenerationSubmitted };
  `, context);
  return { stored, context, api: context.api, removed, cancelled, alarms, resumed, events, uploadPauses,
    advance: (n) => { instant += n; } };
}

test('draft upload stall enters durable cooldown while real Send and completed PNG stay protected', async () => {
  const h = harness();
  await h.api.schedulePreparationStallRecovery('run', ['draft']);
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.stored.run.stalledBatchRecovery.stage, 'WAITING');
  assert.equal(h.stored.run.stalledBatchRecovery.dueAt, time + 300_000);
  assert.deepEqual(h.removed, [10]);
  assert.equal(h.stored.run.slots[1].entryId, 'sent');
  assert.equal(h.stored.run.slots[1].finalCheckPending, true);
  assert.equal(h.stored.queue.groups.good[0].status, 'done');
  assert.equal(h.stored.queue.groups.good[1].status, 'pending');
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.cancelled[0][0], 'draft-gen');
  assert.ok(h.alarms.some((a) => a.dueAt === time + 300_000));
  assert.equal(h.resumed.length, 0);
  h.advance(300_001);
  await h.api.resumePreparationStallRecovery();
  assert.equal(h.resumed.length, 1);
  assert.equal(h.resumed[0].preparationStallRecoveryInternal, true);
});

test('persisted CLOSING, WAITING and RESTARTING recover after a cold worker wake', async () => {
  for (const stage of ['CLOSING', 'WAITING', 'RESTARTING']) {
    const first = harness();
    first.stored.run.state = 'PAUSED'; first.stored.run.pauseReason = 'ERROR';
    first.stored.run.stalledBatchRecovery = { kind: 'PREPARATION_STALL', stage, dueAt: time - 1 };
    const cold = harness({ snapshot: JSON.parse(JSON.stringify(first.stored)) });
    await cold.api.resumePreparationStallRecovery();
    assert.equal(stage === 'CLOSING' ? cold.stored.run.stalledBatchRecovery.stage : cold.resumed.length,
      stage === 'CLOSING' ? 'WAITING' : 1);
  }
});

test('automatic preparation recovery stops after two rounds and user Stop or Pause prevents auto-resume', async () => {
  const h = harness();
  h.stored.run.preparationRecoveryAttempts = 2;
  const result = await h.api.schedulePreparationStallRecovery('run', ['draft']);
  assert.equal(result.cooldown, true);
  assert.equal(h.stored.run.stalledBatchRecovery.stage, 'UPLOAD_COOLDOWN');
  assert.equal(h.uploadPauses.length, 1);
  assert.equal(h.uploadPauses[0].id, 'run');
  assert.equal(h.uploadPauses[0].details.inferred, true);
  assert.equal(h.stored.queue.groups.good[0].status, 'done');
  assert.equal(h.resumed.length, 0);
  for (const modifier of [{ clockStopped: true }, { stopBlocked: { at: iso(time) } }, { pauseReason: 'USER' }]) {
    const stopped = harness();
    stopped.stored.run.state = 'PAUSED'; stopped.stored.run.pauseReason = 'ERROR';
    stopped.stored.run.stalledBatchRecovery = { kind: 'PREPARATION_STALL', stage: 'WAITING', dueAt: time - 1 };
    Object.assign(stopped.stored.run, modifier);
    await stopped.api.resumePreparationStallRecovery();
    assert.equal(stopped.resumed.length, 0);
    assert.equal(stopped.removed.length, 0);
  }
});

test('recovery intent from an old run cannot pause a new run', async () => {
  const h = harness();
  assert.equal((await h.api.schedulePreparationStallRecovery('obsolete', ['draft'])).skipped, true);
  await h.api.pauseRun('ERROR', 'obsolete');
  assert.equal(h.stored.run.state, 'RUNNING');
  assert.equal(h.removed.length, 0);
});

test('current-lease page false repairs a phantom observation but cannot erase actual Send evidence', () => {
  const slot = { leaseId: 'a', entryId: 'draft', tabId: 10, status: 'OBSERVING', phase: 'OBSERVING', finalCheckPending: true };
  const probe = { leaseId: 'a', generationSubmitted: false, assistantCount: 0, chatUrl: null };
  assert.equal(pageProbeConfirmsUnsubmitted(slot, probe), true);
  for (const evidence of [
    { generationSubmittedAt: iso(time) }, { physicalSendAtMs: time, physicalSendLeaseId: 'a' },
    { pageSubmissionLeaseId: 'a', pageGenerationSubmitted: true }, { chatUrl: 'https://chatgpt.com/c/existing' },
    { assistantCount: 1 }, { downloadId: 3 }
  ]) assert.equal(pageProbeConfirmsUnsubmitted({ ...slot, ...evidence }, probe), false);
  assert.equal(pageProbeConfirmsUnsubmitted(slot, { ...probe, leaseId: 'obsolete' }), false);
});

test('responsive but idle preparation and submitted generation have fixed deadlines', () => {
  const draft = { entryId: 'a', tabId: 10, status: 'STARTING', phase: 'UPLOADING', lastProgressAt: iso(time - 300_000), lastHeartbeatAt: iso(time) };
  assert.equal(isStalledUnsubmittedPreparation(draft, time), true);
  assert.equal(isStalledUnsubmittedPreparation({ ...draft, physicalSendAtMs: time - 1000 }, time), false);
  const sent = { entryId: 'a', tabId: 10, generationId: 'g', leaseId: 'a', generationSubmittedAt: iso(time - 900_000), lastProgressAt: iso(time - 300_000), lastHeartbeatAt: iso(time) };
  assert.equal(shouldExpireSubmittedObservation(sent, time), true);
  assert.equal(shouldRefreshStalledGeneration(sent, time), true);
  assert.equal(shouldRefreshStalledGeneration({ ...sent, autoRefreshGenerationId: 'g' }, time), false);
  assert.equal(shouldExpireSubmittedObservation({ ...sent, downloadId: 4 }, time), false);
  assert.equal(canAuditSlot({ ...sent, observationExpired: true }), false);
});

test('empty page probe keeps a current unsent draft in preparation phase', () => {
  const context = { SLOT_PHASES };
  runInNewContext(`${section('function phaseForProbeState(', 'async function wakeTabForAudit(')} globalThis.phase = phaseForProbeState;`, context);
  assert.equal(context.phase('WAITING_ASSISTANT', { generationSubmitted: false }), 'PREPARING');
  assert.equal(context.phase('WAITING_ASSISTANT', { generationSubmitted: false, preparedForSubmit: true }), 'WAITING_LAUNCH');
  assert.equal(context.phase('WAITING_ASSISTANT', { generationSubmitted: true }), 'GENERATING');
});

test('delayed old-lease failure cannot address a replacement slot', () => {
  const context = {};
  runInNewContext(`${section('function errorContextMatchesSlot(', 'async function pauseRunOnError(')} globalThis.matches = errorContextMatchesSlot;`, context);
  const run = { slots: { 0: { entryId: 'a', tabId: 10, leaseId: 'new' } } };
  assert.equal(context.matches(run, { slotId: 0, entryId: 'a', tabId: 10, leaseId: 'old' }), false);
  assert.equal(context.matches(run, { slotId: 0, entryId: 'a', tabId: 10, leaseId: 'new' }), true);
});

test('due retry leaves RETRY_BACKOFF and resumes active clock while Stop prevents launch', async () => {
  const h = harness();
  const { run } = h.stored;
  run.slots = {}; run.state = 'RUNNING'; run.status = 'RETRY_BACKOFF'; run.pendingIds = [];
  run.clockVersion = 1; run.clockAccumulatedMs = 12_000; run.clockActiveSinceMs = null;
  const entry = h.stored.queue.groups.good[1]; entry.status = 'error';
  Object.assign(h.context, {
    DEFAULT_WORKERS: 6, scheduledRetriesForRun: () => [{ entryId: 'draft', due: true, retryAt: time - 1, slotId: null }],
    claimNext: async () => null, executeSlot: () => assert.fail('no slot'),
  });
  runInNewContext(`${section('async function processDueScheduledRetries(', 'function isAutomationChatTab(')} globalThis.processDue = processDueScheduledRetries;`, h.context);
  await h.context.processDue('run');
  assert.equal(run.status, 'RUNNING');
  assert.equal(elapsedRunClock(run, time + 10_000), 22_000);
  run.clockStopped = true; entry.status = 'error'; run.pendingIds = [];
  assert.equal((await h.context.processDue('run')).started, 0);
  assert.equal(entry.status, 'error');
});

test('actual upload error handler keeps an unsent attempt retryable and ignores an old lease', async () => {
  const h = harness();
  h.stored.run.automationWindowId = 1;
  Object.assign(h.context, {
    AUTOMATION_ERROR_CLASSES, classifyAutomationError, retryDelayMs, shouldTripAttachmentFailureCircuitBreaker,
    randomInt: () => 500, isUserPauseCancellation: () => false,
    finalizeDrainingRun: () => {}, entryDisplayName: (entry) => entry?.sourceId,
    sendTabMessage: async () => ({ ok: false }), storeDiagnostics: async () => {}, claimNext: async () => null,
    executeSlot: () => assert.fail('test should not launch a generation'),
    isAutomationChatTab: (tab, id) => tab?.windowId === id,
  });
  h.context.chrome.tabs.get = async () => ({ windowId: 1 });
  runInNewContext(`${section('function errorContextMatchesSlot(', 'async function recoverVisibleResults(')} globalThis.failUpload = pauseRunOnError;`, h.context);
  await h.context.failUpload('run', new Error('Timeout waiting for attachment batch 2 (90000ms)'), {
    slotId: 0, entryId: 'draft', leaseId: 'draft-lease', tabId: 10, generationSubmitted: false
  });
  assert.equal(h.stored.run.slots[0].finalCheckPending, false);
  assert.equal(h.stored.run.slots[0].phase, 'RETRY_BACKOFF');
  assert.equal(h.stored.queue.groups.good[1].autoRetryPending, true);
  assert.equal(h.stored.queue.groups.good[0].status, 'done');
  assert.deepEqual(h.removed, [10]);
  const before = JSON.stringify(h.stored);
  h.stored.run.slots[0].leaseId = 'new';
  const replacement = JSON.stringify(h.stored);
  await h.context.failUpload('run', new Error('late duplicate error'), {
    slotId: 0, entryId: 'draft', leaseId: 'draft-lease', tabId: 10
  });
  assert.notEqual(before, replacement);
  assert.equal(JSON.stringify(h.stored), replacement);
});
