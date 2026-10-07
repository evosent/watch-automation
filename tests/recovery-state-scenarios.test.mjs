import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as reliability from '../extension/reliability-utils.js';
import * as revision from '../extension/generation-revision-utils.js';
import * as queueUtils from '../extension/queue-utils.js';
import { GENERATION_MEMORY_STATUSES, pendingEntryIds, pendingEntryIdsForFilter } from '../extension/queue-utils.js';

// Run production orchestration against a deterministic fake browser. There is
// no extension messaging, network request, image generation or real storage.
const worker = await readFile(fileURLToPath(new URL('../extension/service-worker.js', import.meta.url)), 'utf8');
const now = Date.parse('2026-10-05T20:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const copy = (value) => structuredClone(value);
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

function productionFunction(name) {
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
  assert.ok(declaration, `production function ${name} exists`);
  const following = /^(?:async )?function \w+\(/m.exec(worker.slice(declaration.index + declaration[0].length));
  const end = following ? declaration.index + declaration[0].length + following.index : worker.length;
  return worker.slice(declaration.index, end);
}

const draft = (id = 0) => ({
  slotId: id, entryId: `sku-${id}`, tabId: 100 + id, leaseId: `lease-${id}`,
  generationId: `generation-${id}`, status: 'READY_TO_SEND', phase: 'WAITING_LAUNCH',
  preparedForSubmit: true, preparedAt: iso(-30000), lastProgressAt: iso(-30000),
  pageSubmissionLeaseId: `lease-${id}`, pageGenerationSubmitted: false,
  assistantCount: 0, baselineAssistantCount: 0
});
const sent = (id = 1) => ({
  ...draft(id), status: 'GENERATING', phase: 'GENERATING',
  preparedForSubmit: false, generationSubmittedAt: iso(-20000),
  submissionObservationDeadlineAt: now + 880000,
  physicalSendAtMs: now - 21000, physicalSendLeaseId: `lease-${id}`,
  lastSendClickedAt: iso(-21000), pageGenerationSubmitted: true,
  chatUrl: `https://chatgpt.com/c/fake-${id}`
});

function harness({ slots = { 0: draft(0), 1: sent(1) }, state = 'RUNNING', pauseReason = null,
  rateLimitPauseUntil = null, extraRun = {} } = {}, additional = {}) {
  const entries = [0, 1, 2].map((id) => ({ sourceId: `sku-${id}`, fileName: `fake-${id}.png`,
    modelName: `Fake ${id}`, groupId: 'in_sale_good', status: id === 2 ? 'pending' : 'running' }));
  const stored = {
    run: { operationId: 'fake-run', groupId: 'in_sale_good', state, status: state, pauseReason,
      plannedIds: entries.map((entry) => entry.sourceId), pendingIds: ['sku-2'], slots,
      startedAt: iso(-2000000), lastProgressAt: iso(-1000000), postprocessTabs: {}, recoveryTabs: {},
      rateLimitPauseUntil, ...extraRun },
    queue: { groups: { in_sale_good: entries } }, history: { items: {}, ignored: {} },
    generationMemory: { items: {} }
  };
  const calls = { cancelled: [], removed: [], resumes: [], batches: [], pauses: [], schedules: [], events: [] };
  const clock = { value: now };
  class HarnessDate extends FakeDate {
    constructor(...args) { super(...(args.length ? args : [clock.value])); }
    static now() { return clock.value; }
  }
  const context = {
    ...reliability, ...revision, ...queueUtils, GENERATION_MEMORY_STATUSES,
    Date: HarnessDate, console, Promise, Set, Map, Number, String, Object, Array, Boolean,
    structuredClone, FINAL_CHECK_TIMEOUT_MS: 900000, GLOBAL_NO_PROGRESS_WINDOW_MS: 300000,
    MAX_AUTOMATIC_PREPARATION_RECOVERIES: 2, SLOT_PROBE_TIMEOUT_MS: 8000,
    CONVERSATION_LOAD_RECOVERY_ALARM_NAME: 'fake-conversation-alarm', TAB_MESSAGE_TIMEOUT_MS: 30000,
    auditInFlight: null, conversationRecoveryRuns: new Set(), stalledBatchRecoveryRuns: new Set(),
    getStored: async () => copy(stored), withStateLock: async (fn) => fn(),
    saveRunAndQueue: async (run, queue, history, generationMemory) => {
      Object.assign(stored, { run: copy(run), queue: copy(queue) });
      if (history !== undefined) stored.history = copy(history);
      if (generationMemory !== undefined) stored.generationMemory = copy(generationMemory);
    },
    publishRun: async () => {}, appendLog: async () => {},
    groupEntries: (queue, group) => queue.groups[group] || [],
    normalizeHistory: (value) => value || { items: {}, ignored: {} },
    normalizeGenerationMemory: (value) => value || { items: {} },
    setGenerationMemoryStatus: (memory, entry, status, overrides) => {
      memory.items[entry.sourceId] = { sourceId: entry.sourceId, status, ...overrides };
    },
    recordRunEvent: (run, type, details) => calls.events.push({ type, ...details }),
    reconcileRunVerifiedRevisions: async () => 0,
    cancelUnsubmittedGenerationRevision: async (generationId, sourceId) => calls.cancelled.push({ generationId, sourceId }),
    armRateLimitIgnoreWindow: () => {}, clockTime: (time) => String(time), finalCheckDeadline: () => now + 900000,
    startAuditMonitor: () => {}, stopAuditMonitor: () => {}, closeAutomationWindowIfEmpty: async () => {},
    closeConversationRecoveryTabs: async () => {}, ensureAutomationWindow: async () => ({ windowId: 9 }),
    scheduleConversationLoadRecovery: (...args) => calls.schedules.push(args),
    resumeRun: async (options) => calls.resumes.push({ options, pauseReason: stored.run.pauseReason }),
    failConversationLoadRecovery: async (_id, error) => { throw new Error(error); },
    reconcileActiveDownloads: async () => {}, processDueScheduledRetries: async () => {},
    pulsePostprocessTabs: async () => {}, shouldWakeSlot: () => false,
    sendTabMessage: async () => { throw new Error('Fake renderer does not answer'); },
    reloadTabForRecovery: async () => {}, captureDiagnosticsFromTab: async () => {},
    beginConversationLoadRecovery: async () => {},
    pauseNewLaunchesForRateLimit: async () => {}, ignoreRateLimitDuringWindow: async () => false,
    schedulePreparationStallRecovery: async () => ({ skipped: true }),
    beginStalledBatchRecovery: async (id, candidate) => { calls.batches.push({ id, candidate }); return { triggered: true }; },
    pauseRunOnError: async (_id, _error, details) => calls.pauses.push(details),
    entryDisplayName: (entry, slot) => entry?.fileName || slot?.entryId || '',
    chrome: { storage: { local: {
      get: async (key) => ({ [key]: copy(stored[key]) }),
      set: async (patch) => Object.assign(stored, copy(patch))
    } }, tabs: { remove: async (id) => calls.removed.push(id), get: async () => null },
      alarms: { clear: async () => {}, create: async () => {} } },
    ...additional
  };
  vm.createContext(context);
  for (const name of ['plannedTaskIsCompleted', 'pendingPlannedIds', 'slotGenerationSubmitted', 'currentSlotSendClicked', 'errorContextMatchesSlot',
    'hasObservationWork', 'activeSlots', 'hasLiveSlotWork', 'hasUnresolvedSlotErrors', 'scheduledRetriesForRun',
    'finalizeDrainingRun', 'phaseForProbeState', 'isLegacyObservationWithoutSendEvidence',
    'isLegacyObservationSlot', 'markObservationNeedsManualAttention', 'cancelSessionRestartForUserAction', 'pauseRun',
    'conversationRecoveryPauseBlocked', 'canResumeConversationRecovery', 'failConversationLoadRecovery',
    'resumeConversationLoadRecovery', 'auditActiveRun', 'allQueueEntries', 'queueRowsForSource', 'indexQueueRowsBySource',
    'resetQueueSourceForIdentity', 'generationMemoryHasVerifiedResult',
    'clearUnfinishedGenerationMemoryRecord', 'repairStoppedQueueStatuses']) {
    vm.runInContext(productionFunction(name), context, { filename: `service-worker.${name}.js` });
  }
  return { stored, calls, context, advance: (milliseconds) => { clock.value += milliseconds; } };
}

test('prepared draft is unsent even if old UI phases claim OBSERVING', () => {
  const { context } = harness();
  assert.equal(context.slotGenerationSubmitted({ ...draft(), status: 'OBSERVING', phase: 'OBSERVING' }), false);
  assert.equal(context.slotGenerationSubmitted({ ...draft(), status: 'SENDING', phase: 'SENDING' }), false);
});

test('current physical Send remains protected after a stale false page report', () => {
  const { context } = harness();
  const owner = { ...sent(), generationSubmittedAt: null, preparedForSubmit: true, pageGenerationSubmitted: false };
  assert.equal(context.slotGenerationSubmitted(owner), true);
  assert.equal(context.slotGenerationSubmitted({ ...draft(), physicalSendAtMs: now - 10000,
    physicalSendLeaseId: 'previous-lease' }), false, 'another lease cannot turn a draft into a submitted request');
});

for (const reason of ['USER', 'IMAGE_LIMIT', 'ERROR']) {
  test(`${reason} pause cancels only drafts and preserves physical Send and an active cooldown`, async () => {
    const deadline = now + 6 * 3600000;
    const h = harness({ rateLimitPauseUntil: deadline });
    await h.context.pauseRun(reason, 'fake-run');
    assert.equal(h.stored.run.state, 'PAUSED');
    assert.equal(h.stored.run.pauseReason, reason);
    assert.equal(h.stored.run.rateLimitPauseUntil, deadline);
    assert.equal(h.stored.run.slots[0].entryId, null);
    assert.equal(h.stored.run.slots[1].entryId, 'sku-1');
    assert.equal(h.stored.run.slots[1].finalCheckPending, true);
    assert.deepEqual(h.calls.removed, [100]);
    assert.deepEqual(h.calls.cancelled, [{ generationId: 'generation-0', sourceId: 'sku-0' }]);
    assert.deepEqual(h.stored.run.pendingIds.sort(), ['sku-0', 'sku-2']);
  });
}

for (const pauseReason of ['USER', 'IMAGE_LIMIT']) {
  test(`conversation recovery alarm cannot replace an explicit ${pauseReason} pause`, async () => {
    const h = harness({ slots: {}, state: 'PAUSED', pauseReason,
      rateLimitPauseUntil: pauseReason === 'IMAGE_LIMIT' ? now + 6 * 3600000 : null,
      extraRun: { imageLimitDetected: pauseReason === 'IMAGE_LIMIT',
        conversationRecovery: { stage: 'WAITING', dueAt: now - 1000, attempts: 1, slots: [] } } });
    await h.context.resumeConversationLoadRecovery('fake-run');
    assert.equal(h.stored.run.pauseReason, pauseReason);
    assert.equal(h.stored.run.state, 'PAUSED');
    assert.equal(h.calls.resumes.length, 0, 'a recovery alarm cannot silently continue the queue');
  });
}

test('conversation recovery resumes once after its own pause with no extra Send', async () => {
  const h = harness({ slots: {}, state: 'PAUSED', pauseReason: 'CONVERSATION_LOAD',
    extraRun: { conversationRecovery: { stage: 'WAITING', dueAt: now - 1000, attempts: 1, slots: [] } } });
  await h.context.resumeConversationLoadRecovery('fake-run');
  assert.equal(h.stored.run.conversationRecovery.stage, 'COMPLETED');
  assert.equal(h.calls.resumes.length, 1);
  assert.equal(h.calls.resumes[0].options.conversationRecoveryInternal, true);
});

test('a USER pause arriving during conversation reopening wins before recovery completion', async () => {
  const h = harness({ slots: {}, state: 'PAUSED', pauseReason: 'CONVERSATION_LOAD',
    extraRun: { conversationRecovery: { stage: 'WAITING', dueAt: now - 1000, attempts: 1, slots: [] } } });
  h.context.ensureAutomationWindow = async () => {
    h.stored.run.pauseReason = 'USER';
    h.stored.run.status = 'PAUSED';
    return { windowId: 9 };
  };
  await h.context.resumeConversationLoadRecovery('fake-run');
  assert.equal(h.stored.run.pauseReason, 'USER');
  assert.equal(h.calls.resumes.length, 0);
});

test('a reopening failure after a USER pause cannot replace it with a conversation error pause', async () => {
  const h = harness({ slots: {}, state: 'PAUSED', pauseReason: 'CONVERSATION_LOAD',
    extraRun: { conversationRecovery: { stage: 'WAITING', dueAt: now - 1000, slots: [] } } });
  h.context.ensureAutomationWindow = async () => {
    h.stored.run.pauseReason = 'USER';
    throw new Error('Fake window failure after user pause');
  };
  await h.context.resumeConversationLoadRecovery('fake-run');
  assert.equal(h.stored.run.pauseReason, 'USER');
  assert.equal(h.calls.resumes.length, 0);
});

for (const pauseReason of ['UPLOAD_LIMIT', 'USER', 'RESTART']) {
  test(`conversation recovery failure cannot override ${pauseReason}`, async () => {
    const h = harness({ slots: {}, state: 'PAUSED', pauseReason,
      extraRun: { uploadCooldownActive: pauseReason === 'UPLOAD_LIMIT' } });
    await h.context.failConversationLoadRecovery('fake-run', 'Fake late conversation failure');
    assert.equal(h.stored.run.pauseReason, pauseReason);
    assert.equal(h.calls.resumes.length, 0);
  });
}

test('whole-batch watchdog still sees submitted leases when their fifteen-minute observation expires', async () => {
  const slots = Object.fromEntries([0, 1].map((id) => [id, { ...sent(id),
    status: 'OBSERVING', phase: 'OBSERVING', finalCheckPending: true,
    generationSubmittedAt: iso(-1000000), physicalSendAtMs: now - 1000000,
    lastSendClickedAt: iso(-1000000), submissionObservationDeadlineAt: now - 100000,
    finalCheckDeadlineAt: now - 100000, noResponseSince: iso(-950000),
    lastProgressAt: iso(-1000000), autoRefreshGenerationId: `generation-${id}`,
    lastCheckState: 'NO_RESPONSE' }]));
  const h = harness({ slots });
  assert.ok(reliability.findStalledBatchRecoveryCandidate(h.stored.run, now), 'the persisted snapshot qualifies for batch recovery');
  await h.context.auditActiveRun();
  assert.equal(h.calls.batches.length, 1, 'expiry must not erase every stalled lease before recovery can inspect them');
});

test('Send deadline cannot destroy stalled-batch evidence just before continuous silence reaches fifteen minutes', async () => {
  const slots = Object.fromEntries([0, 1].map((id) => [id, { ...sent(id),
    status: 'OBSERVING', phase: 'OBSERVING', finalCheckPending: true,
    generationSubmittedAt: iso(-900001), physicalSendAtMs: now - 900001,
    lastSendClickedAt: iso(-900001), submissionObservationDeadlineAt: now - 1,
    finalCheckDeadlineAt: now - 1, noResponseSince: iso(-899000),
    lastProgressAt: iso(-900001), autoRefreshGenerationId: `generation-${id}`,
    lastCheckState: 'NO_RESPONSE' }]));
  const h = harness({ slots });
  assert.equal(reliability.findStalledBatchRecoveryCandidate(h.stored.run, now), null);
  await h.context.auditActiveRun();
  assert.equal(h.calls.batches.length, 0, 'shorter silence cannot trigger an early batch reset');
  assert.notEqual(h.stored.run.slots[0].observationExpired, true,
    'the bounded pending recovery retains its Send and chat identity');
  h.advance(2000);
  await h.context.auditActiveRun();
  assert.equal(h.calls.batches.length, 1, 'the next check can recover after the full silence window');
});

test('audit cannot trigger a batch reset or global watchdog during a long image quota pause', async () => {
  const slots = Object.fromEntries([0, 1].map((id) => [id, { ...sent(id),
    status: 'OBSERVING', phase: 'OBSERVING', finalCheckPending: true,
    generationSubmittedAt: iso(-1000000), noResponseSince: iso(-950000),
    lastProgressAt: iso(-1000000), autoRefreshGenerationId: `generation-${id}`,
    submissionObservationDeadlineAt: now + 100000, finalCheckDeadlineAt: now + 100000,
    lastCheckState: 'NO_RESPONSE' }]));
  const h = harness({ slots, state: 'PAUSED', pauseReason: 'IMAGE_LIMIT',
    rateLimitPauseUntil: now + 6 * 3600000, extraRun: { imageLimitDetected: true } });
  await h.context.auditActiveRun();
  assert.equal(h.calls.batches.length, 0);
  assert.equal(h.calls.pauses.length, 0);
  assert.equal(h.stored.run.pauseReason, 'IMAGE_LIMIT');
  assert.equal(h.stored.run.rateLimitPauseUntil, now + 6 * 3600000);
});

test('late errors from the old slot lease cannot affect its replacement for the same model', () => {
  const h = harness();
  const old = { slotId: 0, entryId: 'sku-0', tabId: 100, leaseId: 'lease-0' };
  assert.equal(h.context.errorContextMatchesSlot(h.stored.run, old), true);
  h.stored.run.slots[0].leaseId = 'replacement-lease';
  assert.equal(h.context.errorContextMatchesSlot(h.stored.run, old), false);
  assert.equal(h.context.errorContextMatchesSlot(h.stored.run, { ...old, leaseId: 'replacement-lease', tabId: 999 }), false);
});

test('unfinished error statuses can enter another run while saved images and submitted work stay excluded', () => {
  const entries = [
    { sourceId: 'saved', status: 'done' }, { sourceId: 'submitted', status: 'running' },
    { sourceId: 'unsubmitted-error', status: 'error' }, { sourceId: 'failed', status: 'failed' },
    { sourceId: 'pending', status: 'pending' }
  ];
  const expected = ['unsubmitted-error', 'failed', 'pending'];
  assert.deepEqual(pendingEntryIds(entries), expected);
  assert.deepEqual(pendingEntryIdsForFilter(entries), expected);
});

test('stopped unfinished records return to pending without changing a saved image revision', () => {
  const h = harness({ slots: {}, state: 'STOPPED' });
  for (const entry of h.stored.queue.groups.in_sale_good) {
    entry.sourceVariantId = `variant-${entry.sourceId}`;
    entry.relativePath = `${entry.sourceId}.png`;
    entry.sourceHash = 'a'.repeat(64);
    entry.status = 'error';
    entry.lastError = 'Old upload failure';
    entry.errorClass = 'TIMEOUT';
    entry.nextRetryAt = iso(-30000);
    entry.retryCount = 3;
    h.stored.generationMemory.items[entry.sourceId] = { ...entry, status: 'not_ready',
      generationId: `old-${entry.sourceId}`, generationStartedAt: iso(-1000000), lastRunId: 'old-run' };
  }
  const saved = h.stored.queue.groups.in_sale_good[2];
  Object.assign(saved, { status: 'done', outputPath: 'fake/saved.png', outputHash: 'b'.repeat(64), generationId: 'saved-revision' });
  h.stored.generationMemory.items[saved.sourceId] = { ...saved, status: 'ready' };
  const savedBefore = copy(saved);
  assert.equal(h.context.repairStoppedQueueStatuses(h.stored.queue, h.stored.generationMemory), true);
  assert.deepEqual(pendingEntryIds(h.stored.queue.groups.in_sale_good), ['sku-0', 'sku-1']);
  for (const id of ['sku-0', 'sku-1']) {
    const record = h.stored.generationMemory.items[id];
    assert.equal(record.status, 'not_ready');
    assert.equal(record.generationId, null);
    assert.equal(record.nextRetryAt, null);
  }
  assert.deepEqual(saved, savedBefore);
});

