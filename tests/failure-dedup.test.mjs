import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as reliability from '../extension/reliability-utils.js';
import * as revisions from '../extension/generation-revision-utils.js';
import * as queueUtils from '../extension/queue-utils.js';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const initialTime = Date.parse('2026-10-06T01:00:00Z');
const clone = (value) => structuredClone(value);
function implementation(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `worker implements ${name}`);
  const next = /^(?:async )?function \w+\(/m.exec(source.slice(start.index + start[0].length));
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}

// Invoke the production error handler in an isolated worker. No real browser,
// persisted extension records, network requests or prompt sends are available.
function worker({ pauseReason = null, manualUpload = false } = {}) {
  const clock = { value: initialTime };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.value])); }
    static now() { return clock.value; }
  }
  const stored = {
    run: { operationId: 'fake-error-run', groupId: 'fake', state: pauseReason ? 'PAUSED' : 'RUNNING',
      status: pauseReason ? 'PAUSED' : 'RUNNING', pauseReason, plannedIds: ['sku-a'], pendingIds: ['sku-b'],
      uploadManualPause: manualUpload, uploadLimitAutoResume: !manualUpload,
      rateLimitPauseUntil: null, rateLimitReason: manualUpload ? 'storage full' : null,
      slots: { 0: { slotId: 0, entryId: 'sku-a', tabId: 200, leaseId: 'lease-a', generationId: 'draft-a',
        status: 'STARTING', phase: 'UPLOADING', preparedForSubmit: false,
        pageSubmissionLeaseId: 'lease-a', pageGenerationSubmitted: false } }, errors: [] },
    queue: { groups: { fake: [{ sourceId: 'sku-a', fileName: 'fake-a.png', status: 'running' }] } },
    history: { items: {}, ignored: {} }, generationMemory: { items: {} }
  };
  const calls = { events: [], cancelled: [], claims: [], recoveries: [], messages: [], quotaSnapshots: [] };
  let chain = Promise.resolve();
  const context = {
    ...reliability, ...revisions, ...queueUtils,
    Date: FakeDate, console, Promise, Set, Map,
    FINAL_CHECK_TIMEOUT_MS: 900000,
    lastLaunchAt: 0, lastAnySendAt: 0,
    normalizeChatConversationUrl: () => null,
    flushRunDiagnosticsSafely: async () => {},
    getStored: async () => clone(stored),
    withStateLock: (fn) => { const task = chain.then(fn); chain = task.catch(() => {}); return task; },
    saveRunAndQueue: async (run, queue, history, memory) => {
      Object.assign(stored, { run: clone(run), queue: clone(queue) });
      if (history !== undefined) stored.history = clone(history);
      if (memory !== undefined) stored.generationMemory = clone(memory);
    },
    normalizeHistory: (value) => value,
    normalizeGenerationMemory: (value) => value,
    groupEntries: (queue, group) => queue.groups[group] || [],
    setGenerationMemoryStatus: (memory, entry, status, patch) => {
      memory.items[entry.sourceId] = { sourceId: entry.sourceId, status, ...patch };
    },
    shouldTripAttachmentFailureCircuitBreaker: (run, failure) => reliability.shouldTripAttachmentFailureCircuitBreaker(run, failure, clock.value),
    randomInt: () => 500,
    recordRunEvent: (_run, type, details) => calls.events.push({ type, ...details }),
    appendLog: async () => {}, publishRun: async () => {}, storeDiagnostics: async () => {},
    cancelUnsubmittedGenerationRevision: async (...args) => calls.cancelled.push(args),
    claimNext: async (...args) => { calls.claims.push(args); return null; },
    executeSlot: async () => { throw new Error('A fake error handler cannot send a prompt'); },
    finalizeDrainingRun: () => false,
    schedulePreparationStallRecovery: async (...args) => calls.recoveries.push(args),
    finalCheckDeadline: () => clock.value + 900000,
    sendTabMessage: async (_tab, message) => {
      calls.messages.push(message.type);
      assert.ok(['CAPTURE_DIAGNOSTICS', 'RESET_DOWNLOAD', 'CHECK_GENERATION'].includes(message.type));
      if (message.type === 'CHECK_GENERATION') return { ok: true, value: { state: 'WAITING_ASSISTANT' } };
      return { ok: true, value: null };
    },
    pauseForUploadLimit: async () => calls.quotaSnapshots.push(clone(stored.run)),
    pauseForImageLimit: async () => calls.quotaSnapshots.push(clone(stored.run)),
    ignoreRateLimitDuringWindow: async () => false,
    pauseNewLaunchesForRateLimit: async () => calls.quotaSnapshots.push(clone(stored.run)),
    chrome: { storage: { local: {
      get: async () => ({ run: clone(stored.run) }),
      set: async (patch) => Object.assign(stored, clone(patch))
    } }, tabs: { get: async () => null, remove: async () => { throw new Error('No real tab removal'); } } }
  };
  vm.createContext(context);
  for (const name of ['errorContextMatchesSlot', 'currentSlotSendClicked', 'slotGenerationSubmitted', 'entryDisplayName', 'pauseRunOnError', 'handleStateEvent']) {
    vm.runInContext(implementation(name), context, { filename: `worker.fake.error.${name}.js` });
  }
  const report = (patch = {}, message = 'Timeout waiting for attachment batch 2 (90000ms)') => context.pauseRunOnError('fake-error-run',
    new Error(message), {
      slotId: 0, entryId: 'sku-a', tabId: 200, leaseId: 'lease-a', generationSubmitted: false,
      errorClass: 'TIMEOUT', ...patch
    });
  return { stored, calls, context, report, advance: (ms) => { clock.value += ms; } };
}

test('page ERROR callback and executeSlot catch count the same unsent lease failure once', async () => {
  const h = worker();
  await h.report({ source: 'page_error_callback' });
  const originalRetryAt = h.stored.queue.groups.fake[0].nextRetryAt;
  h.advance(5170); // First duplicate pair in the supplied journal is 5.170 s apart.
  await h.report({ source: 'execute_slot_catch' });
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 1);
  assert.equal(h.stored.queue.groups.fake[0].nextRetryAt, originalRetryAt);
  assert.equal(h.calls.events.filter((event) => event.type === 'slot_error').length, 1);
  assert.equal(h.calls.cancelled.length, 1);
  assert.equal(h.calls.claims.length, 1);
});

test('concurrent reports of one unsent failure do not double retry count', async () => {
  const h = worker();
  await Promise.all([h.report({ source: 'page_error_callback' }), h.report({ source: 'execute_slot_catch' })]);
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 1);
  assert.equal(h.calls.events.filter((event) => event.type === 'slot_error').length, 1);
});

test('an obsolete lease cannot fail a fresh preparation of the same product', async () => {
  const h = worker();
  h.stored.run.slots[0].leaseId = 'lease-b';
  h.stored.run.slots[0].pageSubmissionLeaseId = 'lease-b';
  await h.report();
  assert.equal(h.stored.queue.groups.fake[0].retryCount, undefined);
  assert.equal(h.calls.events.length, 0);
});

test('the same upload error in a new lease is a new failure', async () => {
  const h = worker();
  await h.report();
  Object.assign(h.stored.run.slots[0], { leaseId: 'lease-b', pageSubmissionLeaseId: 'lease-b', status: 'STARTING', phase: 'UPLOADING' });
  h.advance(120000);
  await h.report({ leaseId: 'lease-b' });
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 2);
  assert.equal(h.calls.events.filter((event) => event.type === 'slot_error').length, 2);
});

test('a late ordinary upload timeout preserves a manual upload/storage pause', async () => {
  const h = worker({ pauseReason: 'UPLOAD_LIMIT', manualUpload: true });
  await h.report();
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.stored.run.pauseReason, 'UPLOAD_LIMIT');
  assert.equal(h.stored.run.uploadManualPause, true);
  assert.equal(h.stored.run.rateLimitPauseUntil, null);
  assert.equal(h.calls.claims.length, 0);
  assert.equal(h.calls.recoveries.length, 0);
});

test('a late global error cannot replace a user pause with automatic recovery', async () => {
  const h = worker({ pauseReason: 'USER' });
  await h.report({ globalNoProgress: true });
  assert.equal(h.stored.run.state, 'PAUSED');
  assert.equal(h.stored.run.pauseReason, 'USER');
  assert.equal(h.calls.claims.length, 0);
  assert.equal(h.calls.recoveries.length, 0);
});

test('late physical Send evidence in ERROR is preserved before the generic duplicate gate', async () => {
  const h = worker();
  await h.report();
  h.advance(5000);
  h.stored.run.slots[0].preparedForSubmit = true;
  const physicalSendAtMs = initialTime + 5000;
  await h.context.handleStateEvent({
    operationId: 'fake-error-run', slotId: 0, entryId: 'sku-a', leaseId: 'lease-a',
    patch: { state: 'ERROR', phase: 'SENDING', error: 'Timeout waiting for prompt acceptance (120000ms)',
      errorClass: 'TIMEOUT', generationSubmitted: true, preparedForSubmit: false, physicalSendAtMs }
  }, { tab: { id: 200 } });
  assert.equal(h.stored.run.slots[0].physicalSendAtMs, physicalSendAtMs);
  assert.equal(h.stored.run.slots[0].physicalSendLeaseId, 'lease-a');
  assert.equal(h.stored.run.slots[0].submissionObservationDeadlineAt, physicalSendAtMs + 900000);
  assert.equal(h.stored.run.slots[0].status, 'OBSERVING');
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 2);
  assert.equal(h.calls.cancelled.length, 1, 'the late Send must not cancel the same revision again');
  assert.equal(h.calls.claims.length, 1, 'the late Send must not replace its observation lease');
});

test('newly persisted physical Send is a new failure after an unsent failure', async () => {
  const h = worker();
  await h.report();
  h.advance(5000);
  Object.assign(h.stored.run.slots[0], {
    physicalSendAtMs: initialTime + 5000, physicalSendLeaseId: 'lease-a',
    lastSendClickedAt: new Date(initialTime + 5000).toISOString()
  });
  await h.report();
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 2);
  assert.equal(h.stored.run.slots[0].finalCheckPending, true);
  assert.equal(h.calls.cancelled.length, 1);
});

test('a terminal refusal after an observation timeout is handled as a distinct outcome', async () => {
  const h = worker();
  Object.assign(h.stored.run.slots[0], {
    physicalSendAtMs: initialTime, physicalSendLeaseId: 'lease-a',
    generationSubmittedAt: new Date(initialTime).toISOString(), preparedForSubmit: false
  });
  await h.report();
  await h.report({ errorClass: 'MODEL_REFUSAL', terminalResponse: true }, 'MODEL_REFUSAL: fake refusal');
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 2);
  assert.equal(h.stored.run.slots[0].finalCheckPending, false);
  assert.equal(h.stored.run.slots[0].errorClass, 'MODEL_REFUSAL');
});

test('late physical Send plus terminal refusal is not swallowed as an old unsent failure', async () => {
  const h = worker();
  await h.report();
  h.advance(5000);
  await h.report({ physicalSendAtMs: initialTime + 5000, generationSubmitted: true,
    errorClass: 'MODEL_REFUSAL', terminalResponse: true }, 'MODEL_REFUSAL: fake refusal');
  assert.equal(h.stored.run.slots[0].physicalSendAtMs, initialTime + 5000);
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 2);
  assert.equal(h.stored.run.slots[0].errorClass, 'MODEL_REFUSAL');
  assert.equal(h.stored.run.slots[0].finalCheckPending, false);
  assert.equal(h.calls.events.filter((event) => event.type === 'slot_error').length, 2);
});

test('a rejected error-state save leaves no durable duplicate marker suppressing the retry', async () => {
  const h = worker();
  const save = h.context.saveRunAndQueue;
  h.context.saveRunAndQueue = async () => { throw new Error('Fake storage write rejected'); };
  await assert.rejects(h.report(), /Fake storage write rejected/);
  assert.equal(h.stored.run.slots[0].lastHandledFailure, undefined);
  assert.equal(h.stored.queue.groups.fake[0].retryCount, undefined);
  h.context.saveRunAndQueue = save;
  await h.report();
  assert.equal(h.stored.queue.groups.fake[0].retryCount, 1);
  assert.equal(h.stored.run.errors.length, 1);
});

for (const pauseReason of ['USER', 'IMAGE_LIMIT', 'UPLOAD_LIMIT']) {
  test(`late physical Send error preserves the ${pauseReason} pause and observes the accepted request`, async () => {
    const h = worker({ pauseReason, manualUpload: pauseReason === 'UPLOAD_LIMIT' });
    if (pauseReason === 'IMAGE_LIMIT') h.stored.run.imageLimitDetected = true;
    h.stored.run.slots[0].preparedForSubmit = true;
    await h.report({ physicalSendAtMs: initialTime, generationSubmitted: true }, 'Timeout waiting for prompt acceptance (120000ms)');
    assert.equal(h.stored.run.state, 'PAUSED');
    assert.equal(h.stored.run.pauseReason, pauseReason);
    assert.equal(h.stored.run.slots[0].finalCheckPending, true);
    assert.equal(h.stored.run.slots[0].physicalSendAtMs, initialTime);
    assert.equal(h.calls.cancelled.length, 0);
    assert.equal(h.calls.claims.length, 0);
    assert.equal(h.calls.recoveries.length, 0);
  });
}

for (const errorClass of ['UPLOAD_LIMIT', 'RATE_LIMIT']) {
  test(`physical Send evidence survives before the early ${errorClass} branch`, async () => {
    const h = worker();
    h.stored.run.slots[0].preparedForSubmit = true;
    const message = errorClass === 'UPLOAD_LIMIT'
      ? 'You have reached your file upload limit'
      : 'You have reached your image creation limit. Try again in 3 hours';
    await h.report({ physicalSendAtMs: initialTime, generationSubmitted: true, errorClass }, message);
    await Promise.resolve();
    assert.equal(h.calls.quotaSnapshots.length, 1);
    const snapshot = h.calls.quotaSnapshots[0];
    assert.equal(snapshot.slots[0].physicalSendAtMs, initialTime);
    assert.equal(snapshot.slots[0].physicalSendLeaseId, 'lease-a');
    assert.equal(snapshot.slots[0].preparedForSubmit, false);
    assert.equal(snapshot.slots[0].pageGenerationSubmitted, true);
    assert.equal(h.calls.cancelled.length, 0);
  });
}

for (const persistedPhysicalSend of [false, true]) {
  test(`known rate rejection before acceptance retains the prepared draft (${persistedPhysicalSend ? 'stored' : 'late'} Send evidence)`, async () => {
    const h = worker();
    const slot = h.stored.run.slots[0];
    Object.assign(slot, { preparedForSubmit: true, status: 'SENDING', phase: 'SENDING' });
    if (persistedPhysicalSend) Object.assign(slot, {
      physicalSendAtMs: initialTime, physicalSendLeaseId: 'lease-a',
      lastSendClickedAt: new Date(initialTime).toISOString(),
      generationSubmittedAt: new Date(initialTime).toISOString(), pageGenerationSubmitted: true
    });
    await h.report({ physicalSendAtMs: initialTime, generationSubmitted: false,
      preparedForSubmit: true, rateLimitBeforeAssistant: true, rateLimit: true, errorClass: 'RATE_LIMIT'
    }, 'Too many requests');
    assert.equal(h.stored.run.slots[0].preparedForSubmit, true);
    assert.equal(h.stored.run.slots[0].status, 'READY_TO_SEND');
    assert.equal(h.stored.run.slots[0].phase, 'RATE_LIMIT_PAUSE');
    assert.equal(h.stored.run.slots[0].rateLimitRetryNeeded, true);
    assert.equal(h.stored.run.slots[0].finalCheckPending, false);
    assert.equal(Boolean(h.stored.run.slots[0].generationSubmittedAt), false,
      'the cooldown resume predicate must classify this known rejection as unsubmitted');
    assert.equal(h.stored.run.slots[0].pageGenerationSubmitted, false);
    assert.equal(h.context.slotGenerationSubmitted(h.stored.run.slots[0]), false,
      'other recovery paths must not mistake a rejected click for an accepted request');
    assert.equal(h.stored.queue.groups.fake[0].retryCount, undefined);
    assert.equal(h.calls.cancelled.length, 0);
    assert.equal(h.calls.claims.length, 0);
  });
}

for (const patch of [{ leaseId: 'obsolete-lease' }, { tabId: 999 }, { entryId: 'other-product' }]) {
  test(`late physical Send from a mismatched owner is ignored (${Object.keys(patch)[0]})`, async () => {
    const h = worker();
    await h.report({ physicalSendAtMs: initialTime, generationSubmitted: true, ...patch });
    assert.equal(h.stored.run.slots[0].physicalSendAtMs, undefined);
    assert.equal(h.stored.queue.groups.fake[0].retryCount, undefined);
    assert.equal(h.calls.events.length, 0);
  });
}

test('a rejected click ignores delayed SENDING while a later physical click and acceptance are allowed', async () => {
  const h = worker();
  h.stored.run.slots[0].preparedForSubmit = true;
  await h.report({ physicalSendAtMs: initialTime, generationSubmitted: false,
    preparedForSubmit: true, rateLimitBeforeAssistant: true, errorClass: 'RATE_LIMIT' }, 'Too many requests');
  const message = (patch) => ({ operationId: 'fake-error-run', slotId: 0, entryId: 'sku-a', leaseId: 'lease-a', patch });
  await h.context.handleStateEvent(message({ state: 'SENDING', phase: 'SENDING',
    physicalSendAtMs: initialTime, generationSubmitted: false, preparedForSubmit: false }), { tab: { id: 200 } });
  assert.equal(h.stored.run.slots[0].status, 'READY_TO_SEND');
  assert.equal(h.context.slotGenerationSubmitted(h.stored.run.slots[0]), false);
  h.advance(5000);
  await h.context.handleStateEvent(message({ state: 'SENDING', phase: 'SENDING',
    physicalSendAtMs: initialTime + 5000, generationSubmitted: false, preparedForSubmit: false }), { tab: { id: 200 } });
  assert.equal(h.stored.run.slots[0].status, 'SENDING');
  assert.equal(h.context.slotGenerationSubmitted(h.stored.run.slots[0]), true);
  await h.context.handleStateEvent(message({ state: 'PROMPT_SENT', physicalSendAtMs: initialTime + 5000,
    generationSubmitted: true, preparedForSubmit: false }), { tab: { id: 200 } });
  assert.equal(h.stored.run.slots[0].rejectedSendAtMs, null);
  assert.equal(h.stored.run.slots[0].pageGenerationSubmitted, true);
  assert.equal(h.stored.run.slots[0].preparedForSubmit, false);
});

test('a later generic ERROR cannot revive physical evidence of an explicitly rejected click', async () => {
  const h = worker();
  h.stored.run.slots[0].preparedForSubmit = true;
  await h.report({ physicalSendAtMs: initialTime, generationSubmitted: false,
    preparedForSubmit: true, rateLimitBeforeAssistant: true, errorClass: 'RATE_LIMIT' }, 'Too many requests');
  await h.report({ physicalSendAtMs: initialTime, generationSubmitted: false, errorClass: 'NETWORK' }, 'Network connection error');
  assert.equal(h.stored.run.slots[0].rejectedSendAtMs, initialTime);
  assert.equal(h.stored.run.slots[0].pageGenerationSubmitted, false);
  assert.equal(Boolean(h.stored.run.slots[0].generationSubmittedAt), false);
  assert.equal(h.context.slotGenerationSubmitted(h.stored.run.slots[0]), false);
  assert.equal(h.stored.run.slots[0].finalCheckPending, false);
});

test('blocking history failure retries only the unsent slot and preserves another generation and facts job', async () => {
  const h = worker();
  h.stored.run.slots[1] = { slotId: 1, entryId: 'sku-sent', leaseId: 'sent-lease', tabId: 201,
    phase: 'GENERATING', status: 'GENERATING', physicalSendAtMs: initialTime,
    physicalSendLeaseId: 'sent-lease', generationSubmittedAt: new Date(initialTime).toISOString() };
  h.stored.run.postprocessTabs = { 'facts-job': { tabId: 202, generationId: 'saved-image', stage: 'WAITING' } };
  const protectedGeneration = structuredClone(h.stored.run.slots[1]);
  const facts = structuredClone(h.stored.run.postprocessTabs);
  await h.report({ errorClass: 'HISTORY_LOAD_ERROR' }, 'Не удалось загрузить историю Повторить');
  assert.equal(h.stored.run.state, 'RUNNING');
  assert.equal(h.stored.run.slots[0].phase, 'RETRY_BACKOFF');
  assert.equal(h.stored.queue.groups.fake[0].autoRetryPending, true);
  assert.ok(Date.parse(h.stored.queue.groups.fake[0].nextRetryAt) > initialTime);
  assert.deepEqual(h.stored.run.slots[1], protectedGeneration);
  assert.deepEqual(h.stored.run.postprocessTabs, facts);
  assert.equal(h.calls.cancelled.length, 1);
  assert.equal(h.calls.recoveries.length, 0, 'a history sidebar error must not restart the whole batch');
});

test('history failure after a physical Send protects its result and does not requeue the generation', async () => {
  const h = worker();
  await h.report({ errorClass: 'HISTORY_LOAD_ERROR', physicalSendAtMs: initialTime,
    generationSubmitted: true }, 'Не удалось загрузить историю Повторить');
  assert.equal(h.stored.run.slots[0].status, 'OBSERVING');
  assert.equal(h.stored.run.slots[0].finalCheckPending, true);
  assert.equal(h.stored.queue.groups.fake[0].autoRetryPending, false);
  assert.equal(h.calls.cancelled.length, 0);
  assert.equal(h.calls.claims.length, 0);
});

