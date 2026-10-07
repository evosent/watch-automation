import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as reliability from '../extension/reliability-utils.js';
import * as revision from '../extension/generation-revision-utils.js';
import * as queue from '../extension/queue-utils.js';
import * as runClock from '../extension/run-clock-utils.js';
import * as sessionWatchdog from '../extension/session-watchdog-utils.js';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const initialTime = Date.parse('2026-10-06T01:00:00Z');
const clone = (value) => structuredClone(value);
function implementation(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `worker implements ${name}`);
  const next = /^(?:async )?function \w+\(/m.exec(source.slice(start.index + start[0].length));
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}

// This browser cannot send a real prompt or modify extension state. All worker
// transitions operate on cloned in-memory records and an advancing fake clock.
function browser({ sentCount = 0, state = 'RUNNING', pauseReason = null, overrides = {} } = {}) {
  const clock = { value: initialTime };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.value])); }
    static now() { return clock.value; }
  }
  const iso = (offset = 0) => new Date(clock.value + offset).toISOString();
  const entries = Array.from({ length: 100 }, (_, index) => ({
    sourceId: `sku-${index}`, groupId: 'in_sale_good', fileName: `fake-${index}.png`, modelName: `Fake ${index}`,
    skuKey: `sku-${index}`, sourceVariantId: `variant-${index}`, relativePath: `fake-input-${index}.png`,
    fingerprint: `fake-input-${index}`, sourceHash: 'c'.repeat(64),
    status: index < 43 ? 'done' : (index < 49 ? 'running' : 'pending'),
    ...(index < 43 ? { generationId: `saved-${index}`, outputPath: `fake/saved-${index}.png`, outputHash: 'a'.repeat(64) } : {})
  }));
  const slots = Object.fromEntries(Array.from({ length: 6 }, (_, slotId) => {
    const submitted = slotId < sentCount;
    return [slotId, {
      slotId, tabId: 200 + slotId, entryId: `sku-${43 + slotId}`, leaseId: `lease-${slotId}`,
      generationId: `draft-${slotId}`, status: submitted ? 'GENERATING' : 'READY_TO_SEND',
      phase: submitted ? 'GENERATING' : 'WAITING_LAUNCH', preparedForSubmit: !submitted,
      preparedAt: iso(-30000), pageSubmissionLeaseId: `lease-${slotId}`, pageGenerationSubmitted: submitted,
      assistantCount: 0, baselineAssistantCount: 0,
      ...(submitted ? { generationSubmittedAt: iso(-20000), physicalSendAtMs: clock.value - 21000,
        physicalSendLeaseId: `lease-${slotId}`, lastSendClickedAt: iso(-21000), chatUrl: `https://chatgpt.com/c/fake-${slotId}` } : {})
    }];
  }));
  const stored = {
    run: { operationId: 'fake-100', buildId: '2026-10-05.5', groupId: 'in_sale_good', state, status: state,
      pauseReason, plannedIds: entries.map((entry) => entry.sourceId), pendingIds: entries.slice(49).map((entry) => entry.sourceId),
      slots, postprocessTabs: {}, recoveryTabs: {}, startedAt: iso(-3600000), ...overrides },
    queue: { groups: { in_sale_good: entries } }, history: { items: {}, ignored: {} }, generationMemory: { items: {} }
  };
  const calls = { alarms: [], clearedAlarms: [], cancelled: [], removed: [], resumes: [], submitted: [], executed: [], events: [], interrupted: [] };
  let chain = Promise.resolve();
  const context = {
    ...reliability, ...revision, ...queue, ...sessionWatchdog,
    Date: TestDate, console, Promise, Map, Set, Number, String, Object, Array, Boolean,
    uploadLimitResumeAt: (text, time = clock.value) => reliability.uploadLimitResumeAt(text, time),
    parsedImageLimitResumeAt: (text, time = clock.value) => reliability.imageLimitResumeAt(text, time),
    imageLimitFallbackResumeAt: (text, time = clock.value) => reliability.imageLimitFallbackResumeAt(text, time),
    FINAL_CHECK_TIMEOUT_MS: 900000, MAX_AUTOMATIC_PREPARATION_RECOVERIES: 2,
    UPLOAD_BACKOFF_MS: 3 * 3600000 + 60000, EXTENSION_BUILD_ID: '2026-10-05.5',
    RATE_LIMIT_RESUME_ALARM_NAME: 'fake-rate-limit-resume',
    DEFAULT_RATE_LIMIT_PAUSE_MINUTES: 3, MIN_RATE_LIMIT_PAUSE_MINUTES: 1, MAX_RATE_LIMIT_PAUSE_MINUTES: 30,
    uploadLimitTasks: new Map(), imageLimitTasks: new Map(), stalledBatchRecoveryRuns: new Set(),
    withStateLock: (fn) => { const pending = chain.then(fn); chain = pending.catch(() => {}); return pending; },
    getStored: async () => clone(stored),
    saveRunAndQueue: async (run, rows, history, memory) => {
      Object.assign(stored, { run: clone(run), queue: clone(rows) });
      if (history !== undefined) stored.history = clone(history);
      if (memory !== undefined) stored.generationMemory = clone(memory);
    },
    normalizeHistory: (value) => value || { items: {}, ignored: {} },
    normalizeGenerationMemory: (value) => value || { items: {} },
    groupEntries: (rows, groupId) => rows.groups[groupId] || [],
    setGenerationMemoryStatus: (memory, entry, status, patch) => {
      memory.items[entry.sourceId] = { sourceId: entry.sourceId, status, ...patch };
    },
    reconcileRunVerifiedRevisions: async () => 0,
    recordRunEvent: (_run, type, details) => calls.events.push({ type, ...details }),
    appendLog: async () => {}, publishRun: async () => {},
    cancelUnsubmittedGenerationRevision: async (id, sku) => calls.cancelled.push({ id, sku }),
    finalCheckDeadline: () => clock.value + 900000, clockTime: (time) => String(time),
    armRateLimitIgnoreWindow: () => {}, startAuditMonitor: () => {}, closeAutomationWindowIfEmpty: async () => {},
    scheduleRateLimitResume: (id, time) => calls.alarms.push({ id, time, kind: 'quota' }),
    scheduleStalledBatchRecovery: (id, time) => calls.alarms.push({ id, time, kind: 'preparation' }),
    scheduleInterruptedRunRecovery: async (reason) => calls.interrupted.push(reason),
    completeResultsImport: async () => {}, resumeInterruptedSessionReset: async () => {},
    restoreStalledBatchRecovery: async () => {}, beginConversationLoadRecovery: async () => {},
    closeConversationRecoveryTabs: async () => {},
    scheduleConversationLoadRecovery: (id, time) => calls.alarms.push({ id, time, kind: 'conversation' }),
    resumeConversationLoadRecovery: async () => {}, failConversationLoadRecovery: async () => {},
    quickProbeReadyResultsBeforeReset: async () => ({ checked: 0, downloadsStarted: 0 }),
    reconcileActiveDownloads: async () => {}, sleep: async (ms) => { clock.value += ms; },
    sendTabMessage: async (_id, message) => { assert.equal(message.type, 'STOP', 'real or fake Send is forbidden in quota tests'); },
    pauseStalledPreparedSlots: async () => {},
    processDueScheduledRetries: async () => {}, failStalledBatchRecovery: async (_id, error) => { throw error; },
    conversationRecoveryIsBlocked: () => false,
    submitPreparedSlot: async (...args) => calls.submitted.push(args),
    executeSlot: async (...args) => calls.executed.push(args), pauseRunOnError: async () => {},
    resumeRun: async (options) => {
      calls.resumes.push({ options, snapshot: clone(stored.run) });
      stored.run.state = 'RUNNING'; stored.run.status = 'RUNNING'; stored.run.pauseReason = null;
      if (stored.run.stalledBatchRecovery?.stage === 'RESTARTING') stored.run.stalledBatchRecovery.stage = 'RESUMED';
    },
    chrome: { storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, clone(stored[key])])),
      set: async (patch) => Object.assign(stored, clone(patch))
    } }, tabs: { remove: async (id) => calls.removed.push(id) },
    alarms: { clear: async (name) => { calls.clearedAlarms.push(name); return true; } } }
  };
  vm.createContext(context);
  for (const name of ['plannedTaskIsCompleted', 'pendingPlannedIds', 'normalizeRateLimitPauseMinutes', 'slotGenerationSubmitted', 'currentSlotSendClicked',
    'hasObservationWork', 'activeSlots', 'hasLiveSlotWork', 'hasUnresolvedSlotErrors',
    'scheduledRetriesForRun', 'hasScheduledRunRetries', 'shouldKeepAuditMonitor', 'finalizeDrainingRun',
    'cancelSessionRestartForUserAction', 'pauseRun', 'pauseForUploadLimit', 'schedulePreparationStallRecovery', 'resumePreparationStallRecovery',
    'resumeAfterRateLimitPause', 'rehydrateWorkerWake', 'imageLimitResumeAt', 'pauseForImageLimit',
    'armRateLimitIgnoreWindow', 'ignoreRateLimitDuringWindow', 'conversationRecoveryPauseBlocked']) {
    vm.runInContext(implementation(name), context, { filename: `worker.fake.${name}.js` });
  }
  return { stored, context, calls, advance: (ms) => { clock.value += ms; }, now: () => clock.value };
}

test('a general rate pause ending while conversation recovery waits restores its recovery alarm', async () => {
  const h = browser();
  Object.assign(h.stored.run, { state: 'PAUSED', pauseReason: 'CONVERSATION_LOAD',
    rateLimitPauseUntil: h.now() - 1,
    conversationRecovery: { stage: 'WAITING', dueAt: h.now() - 1000 } });
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.stored.run.pauseReason, 'CONVERSATION_LOAD');
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.calls.alarms.some((alarm) => alarm.kind === 'conversation' && alarm.time > h.now()), true);
});

function enableRealQueueFlow(h) {
  const revisions = new Map();
  let leaseSequence = 0;
  Object.assign(h.context, runClock, {
    DEFAULT_WORKERS: 6, FACTS_EXTRACTOR_VERSION: 4, crypto: { randomUUID: () => `fake-lease-${++leaseSequence}` },
    assertManualExtensionUpdateNotApplying: async () => {}, waitForStartupReconciliation: async () => {},
    runPreflight: async ({ selectedIds }) => {
      assert.equal(selectedIds.length, 100);
      return { ok: true, checks: [] };
    },
    ensureAutomationWindow: async () => ({ windowId: 1 }), moveRunTabsToAutomationWindow: async () => {},
    recoverVisibleResults: async () => [], getAllModelCatalog: async () => [],
    reconcilePersistedCurrentRevisions: async () => 0, resetLaunchScheduler: () => {},
    preallocateWorkerTabs: async () => {}, getGenerationFacts: async () => null,
    getGenerationRevision: async (id) => revisions.get(id) || null,
    persistGenerationImageRevision: async (record) => {
      assert.ok(record.generationId && record.sourceId && record.leaseId && record.outputPath);
      assert.equal(record.operationId, 'fake-100');
      assert.equal(record.fileVerification?.verified, true, 'only a positive exact watcher file proof can register the PNG');
      assert.equal(record.fileVerification?.outputHash, record.outputHash);
      assert.equal(record.fileVerification?.outputPath, record.outputPath);
      assert.equal(record.fileVerification?.generationId, record.generationId);
      assert.equal(record.fileVerification?.sourceId, record.sourceId);
      assert.equal(revisions.has(record.generationId), false, 'one immutable revision per fake artifact');
      revisions.set(record.generationId, clone(record));
      return { current: true, matched: true };
    },
    updateFactsStage: async () => {}, startFactsExtractionDetached: () => {
      throw new Error('This verified-file scenario must not send a real or fake OCR prompt');
    },
    fetch: async () => { throw new Error('Network is forbidden in the queue scenario'); }
  });
  h.context.chrome.runtime = { sendMessage: async () => { throw new Error('Browser Send is forbidden'); } };
  h.context.chrome.tabs.sendMessage = async () => { throw new Error('Browser Send is forbidden'); };
  for (const name of ['normalizeHistory', 'normalizeGenerationMemory', 'generationMemoryEntries',
    'queueEntryForGenerationMemory', 'syncGenerationMemory', 'syncQueueWithHistory',
    'plannedTaskForRun', 'applyPlannedTaskToSlot', 'markReadyTaskCompleted', 'plannedTaskIsCompleted',
    'normalizeChatConversationUrl', 'normalizedDownloadPath', 'normalizedArtifactProofPath',
    'fileVerificationForCompletedArtifact', 'makeLeaseId', 'ensureSlotGenerationIdentity',
    'recordCompletedEntry', 'clearResolvedRunError', 'shouldEnterFactsDraining',
    'startAssignments', 'resumeRun', 'finalizeCompletedArtifact']) {
    vm.runInContext(implementation(name), h.context, { filename: `worker.fake.real-flow.${name}.js` });
  }
  const resume = h.context.resumeRun;
  h.context.resumeRun = async (...args) => {
    h.calls.resumes.push({ snapshot: clone(h.stored.run) });
    return resume(...args);
  };
  return revisions;
}

test('100-item run with 43 saved images returns six unsent drafts on upload quota', async () => {
  const h = browser();
  const saved = clone(h.stored.queue.groups.in_sale_good.slice(0, 43));
  await h.context.pauseForUploadLimit('fake-100', { text: 'You have reached your file upload limit' });
  assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43), saved);
  assert.equal(h.stored.run.pendingIds.length, 57);
  assert.equal(Object.values(h.stored.run.slots).filter((slot) => slot.entryId).length, 0);
  assert.equal(h.calls.cancelled.length, 6);
  assert.equal(h.calls.removed.length, 6);
  assert.equal(h.stored.run.pauseReason, 'UPLOAD_LIMIT');
  assert.equal(h.stored.run.rateLimitPauseUntil, h.now() + 3 * 3600000 + 60000);
  assert.equal(h.calls.submitted.length, 0);
});

test('upload quota preserves already physically sent generations and saved images', async () => {
  const h = browser({ sentCount: 2 });
  const saved = clone(h.stored.queue.groups.in_sale_good.slice(0, 43));
  await h.context.pauseForUploadLimit('fake-100', { inferred: true, text: 'Attachment outage' });
  assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43), saved);
  assert.equal(h.stored.run.pendingIds.length, 55);
  for (const id of [0, 1]) {
    assert.equal(h.stored.run.slots[id].entryId, `sku-${43 + id}`);
    assert.equal(h.stored.run.slots[id].finalCheckPending, true);
    assert.equal(h.stored.run.slots[id].chatUrl, `https://chatgpt.com/c/fake-${id}`);
  }
  assert.equal(h.calls.cancelled.length, 4);
  assert.equal(h.calls.removed.length, 4);
});

test('duplicate upload quota reports keep the original deadline instead of sliding it', async () => {
  const h = browser();
  const first = await h.context.pauseForUploadLimit('fake-100', { inferred: true });
  h.advance(60000);
  const second = await h.context.pauseForUploadLimit('fake-100', { inferred: true, resumeAtMs: h.now() + 3 * 3600000 });
  assert.equal(second, first);
  assert.equal(h.stored.run.rateLimitPauseUntil, first);
});

test('storage-full refusal with autoResume=false stays manual and schedules no alarm', async () => {
  const h = browser();
  await h.context.pauseForUploadLimit('fake-100', { autoResume: false, text: 'Your storage is full' });
  assert.equal(h.stored.run.uploadManualPause, true);
  assert.equal(h.stored.run.rateLimitPauseUntil, null);
  assert.equal(h.calls.alarms.length, 0);
  h.advance(24 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.stored.run.pendingIds.length, 57);
});

test('a storage-full incident arriving after the alarm snapshot cannot be cleared by the resume lock', async () => {
  const h = browser({ state: 'PAUSED', pauseReason: 'UPLOAD_LIMIT', overrides: {
    uploadCooldownActive: true, uploadManualPause: false, rateLimitPauseUntil: initialTime - 1
  } });
  const originalGet = h.context.getStored;
  let snapshotTaken = false;
  h.context.getStored = async () => {
    const snapshot = await originalGet();
    if (!snapshotTaken) {
      snapshotTaken = true;
      h.stored.run.uploadManualPause = true;
      h.stored.run.rateLimitPauseUntil = null;
    }
    return snapshot;
  };
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.stored.run.uploadManualPause, true);
  assert.equal(h.stored.run.rateLimitPauseUntil, null);
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.calls.submitted.length, 0);
});

for (const userCancels of [false, true]) {
  test(`storage-full escalation survives an in-flight draft sweep, user cancellation ${userCancels}`, async () => {
    const h = browser();
    const saved = clone(h.stored.queue.groups.in_sale_good.slice(0, 43));
    let escalation;
    let attempted = false;
    h.context.publishRun = async () => {
      if (!attempted && h.stored.run.uploadCooldownActive) {
        attempted = true;
        if (userCancels) h.stored.run.pauseReason = 'USER';
        // Do not await a nested sweep from its own publish callback. The real
        // second page reports independently and waits on its returned promise.
        escalation = h.context.pauseForUploadLimit('fake-100', {
          autoResume: false, text: 'Your storage is full'
        });
      }
    };
    await h.context.pauseForUploadLimit('fake-100', { inferred: true });
    await escalation;
    assert.equal(h.stored.run.uploadManualPause, true);
    assert.equal(h.stored.run.rateLimitPauseUntil, null);
    assert.equal(h.stored.run.state, 'PAUSED');
    assert.equal(h.stored.run.pauseReason, userCancels ? 'USER' : 'UPLOAD_LIMIT');
    assert.ok(h.calls.clearedAlarms.includes('fake-rate-limit-resume'), 'the obsolete timed alarm is cancelled');
    assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43), saved);
    assert.equal(h.stored.run.pendingIds.length, 57);
    h.advance(4 * 3600000);
    await h.context.resumeAfterRateLimitPause();
    assert.equal(h.calls.resumes.length, 0);
    assert.equal(h.calls.submitted.length, 0);
  });
}

test('worker wake finishes a persisted upload pause whose draft sweep was interrupted', async () => {
  const h = browser({ state: 'PAUSED', pauseReason: 'UPLOAD_LIMIT', overrides: {
    uploadCooldownActive: true, uploadPauseSettled: false,
    uploadLimitDetected: false, rateLimitPauseUntil: initialTime + 3 * 3600000 + 60000
  } });
  const saved = clone(h.stored.queue.groups.in_sale_good.slice(0, 43));
  const deadline = h.stored.run.rateLimitPauseUntil;
  await h.context.rehydrateWorkerWake();
  assert.equal(h.stored.run.uploadPauseSettled, true);
  assert.equal(h.stored.run.rateLimitPauseUntil, deadline);
  assert.equal(h.stored.run.pendingIds.length, 57);
  assert.equal(Object.values(h.stored.run.slots).filter((slot) => slot.entryId).length, 0);
  assert.equal(h.calls.cancelled.length, 6);
  assert.equal(h.calls.removed.length, 6);
  assert.equal(h.calls.resumes.length, 0);
  assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43), saved);
});

test('an existing USER pause wins over an upload incident and its eventual alarm', async () => {
  const h = browser({ state: 'PAUSED', pauseReason: 'USER' });
  await h.context.pauseForUploadLimit('fake-100', { inferred: true });
  assert.equal(h.stored.run.pauseReason, 'USER');
  h.advance(4 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.stored.run.pauseReason, 'USER');
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.calls.resumes.length, 0);
});

for (const stop of [{ state: 'STOPPED' }, { clockStopped: true }, { stopBlocked: { reason: 'user' } }]) {
  test(`upload incident cannot revive user stop ${JSON.stringify(stop)}`, async () => {
    const h = browser({ overrides: stop });
    const before = clone(h.stored.run);
    await h.context.pauseForUploadLimit('fake-100', { inferred: true });
    assert.deepEqual(h.stored.run, before);
    assert.equal(h.calls.alarms.length, 0);
    assert.equal(h.calls.cancelled.length, 0);
  });
}

for (const stop of [{ state: 'STOPPED' }, { clockStopped: true }, { stopBlocked: { reason: 'user' } }]) {
  test(`a stop arriving during upload cooldown wins when the alarm expires ${JSON.stringify(stop)}`, async () => {
    const h = browser();
    await h.context.pauseForUploadLimit('fake-100', { inferred: true });
    Object.assign(h.stored.run, stop);
    h.advance(4 * 3600000);
    await h.context.resumeAfterRateLimitPause();
    assert.equal(h.calls.resumes.length, 0, 'an expired platform alarm cannot silently defeat a latched user stop');
  });
}

test('a USER pause arriving between upload quota persistence and the draft sweep remains authoritative', async () => {
  const h = browser();
  let paused = false;
  h.context.publishRun = async () => {
    if (!paused && h.stored.run.uploadCooldownActive) {
      paused = true;
      h.stored.run.state = 'PAUSED';
      h.stored.run.pauseReason = 'USER';
    }
  };
  await h.context.pauseForUploadLimit('fake-100', { inferred: true });
  assert.equal(h.stored.run.pauseReason, 'USER');
  h.advance(4 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.calls.resumes.length, 0);
});

test('expired general rate pause in PAUSED ERROR calls resumeRun even when retries are prepared', async () => {
  const h = browser({ state: 'PAUSED', pauseReason: 'ERROR', overrides: { rateLimitPauseUntil: initialTime - 1 } });
  h.stored.run.slots[0].rateLimitRetryNeeded = true;
  h.stored.run.slots[0].phase = 'RATE_LIMIT_PAUSE';
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.calls.resumes.length, 1, 'retryAssignments must not consume the PAUSED branch without actually resuming');
  assert.equal(h.stored.run.state, 'RUNNING');
  assert.equal(h.calls.submitted.length, 0, 'resumeRun owns reassignment, avoiding duplicate Send tasks');
});

test('expired upload cooldown resumes and resets the short recovery budget', async () => {
  const h = browser({ overrides: { preparationRecoveryAttempts: 2 } });
  await h.context.pauseForUploadLimit('fake-100', { inferred: true });
  h.advance(4 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.calls.resumes.length, 1);
  assert.equal(h.stored.run.preparationRecoveryAttempts, 0);
  assert.equal(h.stored.run.uploadCooldownActive, false);
  assert.equal(h.stored.run.uploadLimitDetected, false);
  assert.equal(h.stored.run.rateLimitPauseUntil, null);
  assert.equal(h.stored.queue.groups.in_sale_good.filter((entry) => entry.status === 'done').length, 43);
});

test('two short preparation recoveries escalate the third incident to a long upload cooldown', async () => {
  const h = browser();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await h.context.schedulePreparationStallRecovery('fake-100', ['sku-43']);
    assert.equal(h.stored.run.preparationRecoveryAttempts, attempt);
    assert.equal(h.stored.run.stalledBatchRecovery.stage, 'WAITING');
    assert.equal(h.stored.run.stalledBatchRecovery.dueAt, h.now() + 5 * 60000);
    h.advance(5 * 60000 + 1);
    await h.context.resumePreparationStallRecovery();
    assert.equal(h.calls.resumes.length, attempt);
  }
  await h.context.schedulePreparationStallRecovery('fake-100', ['sku-43']);
  assert.equal(h.stored.run.preparationRecoveryAttempts, 2);
  assert.equal(h.stored.run.stalledBatchRecovery.stage, 'UPLOAD_COOLDOWN');
  assert.equal(h.stored.run.uploadCooldownActive, true);
  assert.equal(h.stored.run.pauseReason, 'UPLOAD_LIMIT');
  assert.equal(h.stored.run.rateLimitPauseUntil, h.now() + 3 * 3600000 + 60000);
  assert.equal(h.calls.resumes.length, 2);
  assert.equal(h.stored.run.pendingIds.length, 57);
});

for (const sentCount of [0, 2]) {
  test(`MV3 wake restores the upload quota alarm with ${sentCount} submitted leases`, async () => {
    const h = browser({ sentCount });
    await h.context.pauseForUploadLimit('fake-100', { inferred: true });
    const deadline = h.stored.run.rateLimitPauseUntil;
    h.calls.alarms.length = 0;
    await h.context.rehydrateWorkerWake();
    assert.ok(h.calls.alarms.some((alarm) => alarm.kind === 'quota' && alarm.time === deadline));
    assert.equal(h.stored.run.rateLimitPauseUntil, deadline);
    assert.equal(h.stored.run.pauseReason, 'UPLOAD_LIMIT');
    assert.equal(h.calls.resumes.length, 0);
    assert.equal(h.calls.interrupted.length, 0);
  });
}

for (const [text, delay] of [
  ['You have reached your image generation limit. Try again in 2 hours 15 minutes.', 2 * 3600000 + 16 * 60000],
  ['Достигнут лимит генерации изображений.', 3 * 3600000 + 60000]
]) {
  test(`image quota has a bounded future deadline: ${text}`, async () => {
    const h = browser();
    const parsed = h.context.imageLimitResumeAt(text);
    assert.equal(parsed, h.now() + delay);
    await h.context.pauseForImageLimit('fake-100', { slotId: 0, text }, parsed);
    assert.equal(h.stored.run.pauseReason, 'IMAGE_LIMIT');
    assert.equal(h.stored.run.rateLimitPauseUntil, h.now() + delay);
    assert.equal(h.stored.run.pendingIds.length, 57);
    assert.equal(h.stored.queue.groups.in_sale_good.filter((entry) => entry.status === 'done').length, 43);
  });
}

test('image quota returns the rejected trigger but retains another physically sent image lease', async () => {
  const h = browser({ sentCount: 2 });
  const otherLease = clone(h.stored.run.slots[1]);
  const saved = clone(h.stored.queue.groups.in_sale_good.slice(0, 43));
  const text = 'Достигнут лимит генерации изображений. Попробуйте снова через 2 часа.';
  await h.context.pauseForImageLimit('fake-100', { slotId: 0, entryId: 'sku-43', text }, h.context.imageLimitResumeAt(text));
  assert.equal(h.stored.run.slots[0].entryId, null, 'the explicit rejected trigger can be retried after the quota');
  assert.equal(h.stored.run.slots[1].entryId, otherLease.entryId);
  assert.equal(h.stored.run.slots[1].leaseId, otherLease.leaseId);
  assert.equal(h.stored.run.slots[1].chatUrl, otherLease.chatUrl);
  assert.equal(h.stored.run.slots[1].finalCheckPending, true);
  assert.equal(h.stored.run.slots[1].status, 'OBSERVING');
  assert.equal(h.stored.run.pendingIds.length, 56);
  assert.equal(h.stored.run.pendingIds.includes(otherLease.entryId), false);
  assert.equal(h.calls.removed.includes(otherLease.tabId), false);
  assert.equal(h.calls.cancelled.some((row) => row.sku === otherLease.entryId), false);
  assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43), saved);
});

test('repeated image quota reports retain the first cooldown deadline with a submitted sibling', async () => {
  const h = browser({ sentCount: 2 });
  const text = 'Image generation limit. Try again in 2 hours.';
  const first = await h.context.pauseForImageLimit('fake-100', { slotId: 0, text }, h.context.imageLimitResumeAt(text));
  h.advance(10 * 60000);
  const second = await h.context.pauseForImageLimit('fake-100', { slotId: 0, text }, h.context.imageLimitResumeAt(text));
  assert.equal(second, first);
  assert.equal(h.stored.run.rateLimitPauseUntil, first);
  assert.equal(h.stored.run.slots[1].entryId, 'sku-44');
});

test('USER remains paused when an image quota is detected and when its deadline expires', async () => {
  const h = browser({ state: 'PAUSED', pauseReason: 'USER', sentCount: 2 });
  const text = 'Image generation limit. Try again in 2 hours.';
  await h.context.pauseForImageLimit('fake-100', { slotId: 0, text }, h.context.imageLimitResumeAt(text));
  assert.equal(h.stored.run.pauseReason, 'USER');
  h.advance(3 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.stored.run.pauseReason, 'USER');
  assert.equal(h.calls.resumes.length, 0);
});

for (const stop of [{ state: 'STOPPED' }, { clockStopped: true }, { stopBlocked: { reason: 'user' } }]) {
  test(`image quota cannot revive user stop ${JSON.stringify(stop)}`, async () => {
    const h = browser({ overrides: stop });
    const before = clone(h.stored.run);
    const text = 'Image generation limit. Try again in 2 hours.';
    await h.context.pauseForImageLimit('fake-100', { slotId: 0, text }, h.context.imageLimitResumeAt(text));
    assert.deepEqual(h.stored.run, before);
    assert.equal(h.calls.alarms.length, 0);
    assert.equal(h.calls.removed.length, 0);
  });
}

for (const quota of [
  { flags: { imageLimitDetected: true }, text: 'Image generation limit. Try again in 2 hours.' },
  { flags: { uploadCooldownActive: true }, text: 'File upload limit. Try again in 2 hours.' },
  { flags: { uploadLimitDetected: true }, text: 'File upload limit.' },
  { flags: {}, text: 'You have reached your file upload limit.' },
  { flags: {}, text: 'You have reached your image generation limit.' },
  { flags: {}, text: 'Your storage is full.' }
]) {
  test(`an ordinary active ignore window cannot bypass platform quota: ${quota.text}`, async () => {
    const h = browser({ overrides: { ...quota.flags, rateLimitIgnoreUntil: initialTime + 10 * 60000,
      rateLimitIgnoreMinutes: 10 } });
    assert.equal(await h.context.ignoreRateLimitDuringWindow('fake-100', { slotId: 0, text: quota.text }), false);
    assert.equal(h.calls.events.some((row) => row.type === 'rate_limit_ignored'), false);
  });
}

test('ordinary too-many-requests notice still follows the configured ignore window', async () => {
  const h = browser({ overrides: { rateLimitIgnoreUntil: initialTime + 10 * 60000, rateLimitIgnoreMinutes: 10 } });
  assert.equal(await h.context.ignoreRateLimitDuringWindow('fake-100', { slotId: 0, text: 'Too many requests' }), true);
  assert.equal(h.calls.events.some((row) => row.type === 'rate_limit_ignored'), true);
});

test('real resumeRun and verified-artifact finalization advance a fake queue from 43 to 100', async () => {
  const h = browser({ overrides: { workerCount: 6 } });
  const revisions = enableRealQueueFlow(h);
  const artifactTuple = (entry) => ({ sourceId: entry.sourceId, generationId: entry.generationId,
    outputPath: entry.outputPath, outputHash: entry.outputHash });
  const originals = h.stored.queue.groups.in_sale_good.slice(0, 43).map(artifactTuple);
  await h.context.pauseForUploadLimit('fake-100', { inferred: true });
  assert.equal(h.stored.run.pendingIds.length, 57);
  h.advance(4 * 3600000);
  await h.context.resumeAfterRateLimitPause();
  assert.equal(h.calls.resumes.length, 1, 'the alarm executes real resumeRun');
  assert.equal(h.stored.run.state, 'RUNNING');
  assert.equal(h.calls.executed.length, 6, 'real startAssignments dispatches the initial six fake workers');

  // Supply only fake verified-file receipts to the real production finalizer.
  // It alone sets done, persists the revision, releases the slot and dispatches
  // each next item. Neither this test nor the browser stub sets an item done.
  const completed = new Set();
  while (h.stored.run.state === 'RUNNING') {
    assert.ok(completed.size < 58, 'the production queue must terminate');
    const slot = Object.values(h.stored.run.slots).find((item) => item.entryId);
    assert.ok(slot, 'the running queue owns a work item');
    assert.equal(completed.has(slot.entryId), false, 'each unfinished product completes exactly once');
    completed.add(slot.entryId);
    const outputPath = `fake/verified-${slot.entryId}.png`;
    await h.context.finalizeCompletedArtifact('fake-100', slot.slotId, slot.entryId, outputPath,
      { valid: true, verified: true, sha256: 'd'.repeat(64), bytes: 2048, width: 300, height: 400,
        verificationMode: 'watcher' },
      { sourceMode: 'downloads', downloadItem: { filename: outputPath, fileSize: 2048 } });
  }
  assert.equal(completed.size, 57);
  assert.equal(revisions.size, 57);
  assert.equal(h.calls.executed.length, 57, 'six starts plus fifty-one real replacement assignments');
  assert.equal(h.stored.queue.groups.in_sale_good.filter((entry) => entry.status === 'done').length, 100);
  assert.equal(h.stored.run.state, 'DONE');
  assert.equal(h.stored.run.pendingIds.length, 0);
  assert.equal(Object.values(h.stored.run.slots).some((slot) => slot.entryId), false);
  assert.deepEqual(h.stored.queue.groups.in_sale_good.slice(0, 43).map(artifactTuple), originals);
  assert.equal(h.calls.submitted.length, 0);
});

