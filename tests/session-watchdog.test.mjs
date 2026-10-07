import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRestartController } from '../extension/session-restart-controller.js';
import { ensureSessionWatchdog, noteSessionUsefulProgress, sessionWatchdogDecision,
  SESSION_STALL_TIMEOUT_MS } from '../extension/session-watchdog-utils.js';

const initialTime = Date.parse('2026-10-06T00:00:00Z');
const copy = value => structuredClone(value);
const baseRun = patch => ({ operationId: 'old-run', groupId: 'selected-playlist', state: 'RUNNING',
  startedAt: new Date(initialTime).toISOString(), plannedIds: ['complete', 'image-only', 'unsent'],
  pendingIds: ['unsent'], runPart: 3, runQueueMode: 'regular', inputMode: '2', workerCount: 6,
  slots: { 0: { entryId: 'unsent', status: 'PREPARING', tabId: 51 } },
  postprocessTabs: { 52: { tabId: 52, entryId: 'image-only' } }, ...patch });

for (const state of ['STARTING', 'RUNNING', 'DRAINING', 'PAUSED']) {
  for (const status of ['PREPARING', 'UPLOADING', 'READY_TO_SEND', 'GENERATING', 'WAITING_IMAGE', 'ERROR']) {
    test(`ten minutes without a useful result catches ${state}/${status} even when the page replies`, () => {
      const run = baseRun({ state, status, pauseReason: null,
        slots: { 0: { entryId: 'unsent', tabId: null, status, lastCheckState: 'WAITING_IMAGE' } } });
      assert.equal(sessionWatchdogDecision(run, initialTime + SESSION_STALL_TIMEOUT_MS - 1).due, false);
      assert.equal(sessionWatchdogDecision(run, initialTime + SESSION_STALL_TIMEOUT_MS).due, true);
    });
  }
}

test('zero slots, a single silent slot, and an error pause without pauseReason remain recoverable', () => {
  for (const slots of [{}, { 0: { entryId: 'unsent', status: 'TAB_LOST' } }]) {
    assert.equal(sessionWatchdogDecision(baseRun({ slots, state: 'PAUSED', status: 'PAUSED_ON_ERROR' }),
      initialTime + 20 * 60_000).due, true);
  }
});

test('heartbeat, phase changes, claimed jobs and retry loops do not renew the useful-result clock', () => {
  const run = baseRun();
  ensureSessionWatchdog(run, initialTime);
  for (const type of ['progress', 'slot_claimed', 'prompt_sent', 'scheduled_retry_due', 'run_resumed']) {
    assert.equal(noteSessionUsefulProgress(run, type, {}, initialTime + 9 * 60_000), false);
  }
  run.lastProgressAt = new Date(initialTime + 9 * 60_000).toISOString();
  assert.equal(sessionWatchdogDecision(run, initialTime + 10 * 60_000).due, true);
});

test('only a new saved photo or specification renews the watchdog; duplicate notifications do not', () => {
  const run = baseRun();
  const photo = { entryId: 'a', generationId: 'g-a' };
  assert.equal(noteSessionUsefulProgress(run, 'output_verified', photo, initialTime + 9 * 60_000), true);
  assert.equal(sessionWatchdogDecision(run, initialTime + 10 * 60_000).due, false);
  assert.equal(noteSessionUsefulProgress(run, 'output_verified', photo, initialTime + 18 * 60_000), false);
  assert.equal(sessionWatchdogDecision(run, initialTime + 19 * 60_000).due, true);
  assert.equal(noteSessionUsefulProgress(run, 'facts_stage', { ...photo, stage: 'SAVED', factsJobId: 'f-a' },
    initialTime + 19 * 60_000), true);
  assert.equal(sessionWatchdogDecision(run, initialTime + 20 * 60_000).due, false);
});

for (const patch of [{ pauseReason: 'USER' }, { clockStopped: true }, { stopBlocked: {} },
  { state: 'STOPPED' }, { state: 'DONE' }, { uploadManualPause: true },
  { error: { code: 'AUTH_REQUIRED' } }, { error: { code: 'SECURITY_CHALLENGE' } }]) {
  test(`a known manual or terminal condition is respected: ${JSON.stringify(patch)}`, () => {
    assert.equal(sessionWatchdogDecision(baseRun(patch), initialTime + 60 * 60_000).due, false);
  });
}

test('confirmed quotas retain their deadline while inferred attachment outages remain recoverable', () => {
  const quota = { uploadCooldownActive: true, rateLimitPauseUntil: initialTime + 4 * 3600000,
    state: 'PAUSED', pauseReason: 'UPLOAD_LIMIT' };
  const at = initialTime + 20 * 60_000;
  assert.equal(sessionWatchdogDecision(baseRun({ ...quota, uploadLimitDetected: true }), at).due, false);
  assert.equal(sessionWatchdogDecision(baseRun({ ...quota, uploadLimitDetected: false }), at).due, true);
  assert.equal(sessionWatchdogDecision(baseRun({ imageLimitDetected: true, rateLimitPauseUntil: quota.rateLimitPauseUntil }), at).due, false);
});

test('a long configured launch pause and application installation are respected', () => {
  const at = initialTime + 20 * 60_000;
  const run = baseRun({ generationPauseMinutes: 30, slots: { 0: {
    preparedForSubmit: true, status: 'READY_TO_SEND', launchWaitUntil: at + 10 * 60_000 } } });
  assert.equal(sessionWatchdogDecision(run, at).blocked.reason, 'configured_launch_pause');
  assert.equal(sessionWatchdogDecision(baseRun(), at, { manualExtensionUpdateLock: { active: true } }).due, false);
  assert.equal(sessionWatchdogDecision(baseRun(), at, { resultsImportJournal: {} }).due, false);
});

function fixture(overrides = {}) {
  let clock = initialTime + 20 * 60_000, ids = 0;
  const entries = ['complete', 'image-only', 'unsent', 'outside'].map(sourceId => ({ sourceId,
    inputSourceId: `v-${sourceId}`, generationId: sourceId === 'unsent' ? null : `g-${sourceId}`,
    status: sourceId === 'unsent' ? 'running' : 'done', factsStatus: sourceId === 'complete' ? 'ok' : 'pending' }));
  const revisions = new Map(entries.filter(e => e.generationId).map(e => [e.generationId,
    { generationId: e.generationId, sourceId: e.sourceId, complete: e.sourceId === 'complete' || e.sourceId === 'outside' }]));
  const data = { run: baseRun(), job: { prompt: 'Original prompt', inputMode: '2' },
    queue: { groups: { list: entries } }, history: { items: {} }, generationMemory: { items: {} } };
  const calls = { resets: [], stops: [], resumes: [], markers: [], persisted: [], events: [] };
  const storage = {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, copy(data[key])])),
    set: async patch => Object.assign(data, copy(patch)), remove: async key => { delete data[key]; }
  };
  const ports = { storage, getStored: async () => copy(data), lock: async fn => fn(), now: () => clock,
    newId: () => `new-id-${++ids}`, shouldRestart: () => true,
    save: async (run, queue, history, memory) => {
      Object.assign(data, { run: copy(run), queue: copy(queue) });
      if (history) data.history = copy(history);
      if (memory) data.generationMemory = copy(memory);
    },
    record: (run, type, details) => { run.eventJournal ||= []; run.eventJournal.push({ type, ...details }); calls.events.push({ type, ...details }); },
    persistDiagnostics: async run => calls.persisted.push(copy(run)),
    stopPages: async run => calls.stops.push(run.operationId),
    reset: async options => { calls.resets.push(options); data.run = null; },
    findEntry: (queue, _run, sourceId) => queue.groups.list.find(e => e.sourceId === sourceId),
    readModel: async sourceId => ({ currentGenerationId: entries.find(e => e.sourceId === sourceId)?.generationId }),
    readRevision: async id => copy(revisions.get(id)), isComplete: rev => rev?.complete === true,
    revisionMatches: () => true,
    markRetry: async (...args) => { calls.markers.push(args); return { marked: true }; },
    resetEntry: (stored, entry) => { entry.status = 'pending'; entry.generationId = null; stored.history.items[entry.sourceId] = 'reset'; },
    resume: async options => { calls.resumes.push(options); data.run.state = 'RUNNING'; data.run.pauseReason = null; },
    ...overrides
  };
  return { data, calls, ports, controller: createSessionRestartController(ports),
    advance: ms => { clock += ms; }, revisions };
}

test('full restart saves the exact playlist and prompt, preserves completed results and retries every unfinished model', async () => {
  const h = fixture();
  const originalRun = copy(h.data.run), originalJob = copy(h.data.job), outside = copy(h.data.queue.groups.list[3]);
  h.data.job = { prompt: 'Changed UI prompt', inputMode: '4', runPart: 1 };
  assert.equal((await h.controller.begin(originalRun, originalJob)).restarted, true);
  assert.deepEqual(h.data.run.plannedIds, originalRun.plannedIds);
  assert.equal(h.data.run.runPart, 3);
  assert.deepEqual(h.data.run.jobSnapshot, originalJob);
  assert.equal(h.data.run.previousOperationId, 'old-run');
  assert.notEqual(h.data.run.operationId, 'old-run');
  assert.deepEqual(h.data.run.pendingIds, ['image-only', 'unsent']);
  assert.equal(h.data.queue.groups.list[0].status, 'done');
  assert.equal(h.data.queue.groups.list[1].status, 'pending');
  assert.equal(h.data.queue.groups.list[2].status, 'pending');
  assert.deepEqual(h.data.queue.groups.list[3], outside);
  assert.equal(h.calls.resets[0].preserveLogs, true);
  assert.equal(h.calls.resets[0].salvageReady, true);
  assert.deepEqual(h.calls.resets[0].plannedOnly, originalRun.plannedIds);
  assert.equal(h.calls.resumes[0].sessionRestartInternal, true);
  assert.equal(h.data.sessionRestartIntent, undefined);
  assert.ok(h.calls.events.some(e => e.type === 'session_restart_completed'));
});

test('concurrent watchdog ticks coalesce into one reset and one continuation', async () => {
  const h = fixture();
  await Promise.all([h.controller.begin(h.data.run, h.data.job), h.controller.continueRestart(), h.controller.continueRestart()]);
  assert.equal(h.calls.resets.length, 1);
  assert.equal(h.calls.resumes.length, 1);
});

test('a resume failure keeps the original plan durable and a recreated worker resumes without another reset', async () => {
  const h = fixture();
  h.ports.resume = async () => { throw new Error('Fake renderer failure'); };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
  assert.equal(h.data.sessionRestartIntent.stage, 'RESUMING');
  h.advance(61000);
  h.ports.resume = async options => { h.calls.resumes.push(options); h.data.run.state = 'RUNNING'; };
  const recreated = createSessionRestartController(h.ports);
  assert.equal((await recreated.continueRestart()).restarted, true);
  assert.equal(h.calls.resets.length, 1);
});

test('worker loss after run:null retains the plan and finishes an idempotent reset', async () => {
  const h = fixture();
  const reset = h.ports.reset;
  h.ports.reset = async options => { await reset(options); throw new Error('Fake worker interruption'); };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
  assert.equal(h.data.run, null);
  assert.deepEqual(h.data.sessionRestartIntent.runSnapshot.plannedIds, ['complete', 'image-only', 'unsent']);
  h.advance(61000); h.ports.reset = reset;
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).restarted, true);
  assert.equal(h.calls.resumes.length, 1);
});

test('a user pause while reset is awaited prevents any automatic continuation', async () => {
  const h = fixture();
  h.ports.reset = async () => { h.data.run = null; h.data.sessionRestartCancellation = {
    restartId: h.data.sessionRestartIntent.restartId, reason: 'pause' }; };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).cancelled, true);
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.data.sessionRestartIntent, undefined);
  assert.equal(h.data.run.state, 'PAUSED');
  assert.equal(h.data.run.pauseReason, 'USER');
  assert.deepEqual(h.data.run.plannedIds, ['complete', 'image-only', 'unsent']);
});

test('restored run, queue, history and memory commit together before a recreated worker resumes', async () => {
  const h = fixture();
  h.data.history = { items: { 'image-only': 'old-image-history' }, ignored: {} };
  h.data.generationMemory = { items: { 'image-only': { status: 'facts_pending', generationId: 'g-image-only' } } };
  h.ports.resetEntry = (stored, entry) => {
    entry.status = 'pending'; entry.generationId = null;
    delete stored.history.items[entry.sourceId]; stored.history.ignored[entry.sourceId] = true;
    stored.generationMemory.items[entry.sourceId] = { status: 'not_ready', generationId: null };
  };
  const save = h.ports.save;
  let interrupted = false;
  h.ports.save = async (...args) => {
    if (!interrupted && args[0].operationId !== 'old-run') {
      assert.ok(args[2], 'history must accompany the first visible restored run');
      assert.ok(args[3], 'memory must accompany the first visible restored run');
      await save(...args); interrupted = true;
      throw new Error('Virtual worker loss after the first restored run commit');
    }
    return save(...args);
  };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
  assert.equal(h.data.run.state, 'PAUSED');
  assert.equal(h.data.history.items['image-only'], undefined);
  assert.deepEqual(h.data.generationMemory.items['image-only'], { status: 'not_ready', generationId: null });
  h.ports.save = save; h.advance(61000);
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).restarted, true);
  assert.equal(h.data.history.items['image-only'], undefined);
  assert.equal(h.data.generationMemory.items['image-only'].status, 'not_ready');
  assert.deepEqual(h.data.run.pendingIds, ['image-only', 'unsent']);
  assert.equal(h.calls.resets.length, 1);
});

test('pause after run was cleared retains the exact playlist and frozen prompt across worker recreation', async () => {
  const h = fixture();
  const originalRun = copy(h.data.run), originalJob = copy(h.data.job);
  h.ports.reset = async options => {
    h.calls.resets.push(options); h.data.run = null;
    h.data.job = { prompt: 'New UI prompt', runPart: 1, inputMode: '4' };
    h.data.sessionRestartCancellation = { restartId: h.data.sessionRestartIntent.restartId, reason: 'pause' };
    throw new Error('Virtual worker stops while Pause is pending');
  };
  assert.equal((await h.controller.begin(originalRun, originalJob)).failed, true);
  assert.equal(h.data.run, null);
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).cancelled, true);
  assert.equal(h.data.run.pauseReason, 'USER');
  assert.equal(h.data.run.state, 'PAUSED');
  assert.deepEqual(h.data.run.plannedIds, originalRun.plannedIds);
  assert.equal(h.data.run.runPart, originalRun.runPart);
  assert.deepEqual(h.data.run.jobSnapshot, originalJob);
  assert.deepEqual(h.data.run.pendingIds, ['image-only', 'unsent']);
  assert.notEqual(h.data.run.operationId, originalRun.operationId);
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.calls.resets.length, 1);
  assert.equal(h.data.sessionRestartIntent, undefined);
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).skipped, true);
});

test('pause arriving during reconstruction is durable before the ordinary Pause handler runs', async () => {
  const h = fixture();
  h.ports.markRetry = async (...args) => {
    h.calls.markers.push(args);
    h.data.sessionRestartCancellation = { restartId: h.data.sessionRestartIntent.restartId, reason: 'pause' };
    return { marked: true };
  };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).cancelled, true);
  assert.equal(h.data.run.pauseReason, 'USER');
  assert.equal(h.data.run.state, 'PAUSED');
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.data.sessionRestartIntent, undefined);
});

for (const reason of ['reset', 'stop']) {
  test(`${reason} after run was cleared can discard the automatic continuation`, async () => {
    const h = fixture();
    h.ports.reset = async () => {
      h.data.run = null;
      h.data.sessionRestartCancellation = { restartId: h.data.sessionRestartIntent.restartId, reason };
    };
    assert.equal((await h.controller.begin(h.data.run, h.data.job)).cancelled, true);
    assert.equal(h.data.run, null);
    assert.equal(h.calls.resumes.length, 0);
    assert.equal(h.calls.markers.length, 0);
    assert.equal(h.data.sessionRestartIntent, undefined);
  });
}

test('restored session uses the installed build instead of an old snapshot build', async () => {
  const h = fixture({ buildId: 'installed-build' });
  h.data.run.buildId = 'previous-build';
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).restarted, true);
  assert.equal(h.data.run.buildId, 'installed-build');
});

for (const [lockKey, lockValue] of [['manualExtensionUpdateLock', { active: true }], ['resultsImportJournal', {}]]) {
  test(`${lockKey} starting after run:null defers restoration without losing the playlist`, async () => {
    const h = fixture();
    const reset = h.ports.reset;
    h.ports.reset = async options => { await reset(options); h.data[lockKey] = copy(lockValue); };
    assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
    assert.equal(h.data.run, null);
    assert.equal(h.data.sessionRestartIntent.stage, 'RESTORING');
    assert.deepEqual(h.data.sessionRestartIntent.runSnapshot.plannedIds, ['complete', 'image-only', 'unsent']);
    assert.equal(h.calls.markers.length, 0);
    assert.equal(h.calls.resumes.length, 0);
    delete h.data[lockKey]; h.advance(61000);
    assert.equal((await createSessionRestartController(h.ports).continueRestart()).restarted, true);
    assert.equal(h.calls.resets.length, 1);
    assert.equal(h.calls.resumes.length, 1);
  });

  test(`Pause during ${lockKey} retains its recovery intent until the original list can be restored`, async () => {
    const h = fixture();
    const reset = h.ports.reset;
    h.ports.reset = async options => {
      await reset(options); h.data[lockKey] = copy(lockValue);
      h.data.sessionRestartCancellation = { restartId: h.data.sessionRestartIntent.restartId, reason: 'pause' };
    };
    assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
    assert.equal(h.data.run, null);
    assert.ok(h.data.sessionRestartIntent);
    assert.equal(h.calls.markers.length, 0);
    delete h.data[lockKey]; h.advance(61000);
    assert.equal((await createSessionRestartController(h.ports).continueRestart()).cancelled, true);
    assert.equal(h.data.run.state, 'PAUSED');
    assert.equal(h.data.run.pauseReason, 'USER');
    assert.deepEqual(h.data.run.plannedIds, ['complete', 'image-only', 'unsent']);
    assert.equal(h.calls.resumes.length, 0);
    assert.equal(h.data.sessionRestartIntent, undefined);
  });
}

test('application installation during RESUMING preserves the frozen continuation instead of cancelling it', async () => {
  const h = fixture();
  h.ports.resume = async () => { throw new Error('Simulated stop before resume'); };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).failed, true);
  h.data.manualExtensionUpdateLock = { active: true }; h.advance(61000);
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).failed, true);
  assert.equal(h.data.sessionRestartIntent.stage, 'RESUMING');
  assert.equal(h.calls.resumes.length, 0);
  delete h.data.manualExtensionUpdateLock; h.advance(61000);
  h.ports.resume = async options => { h.calls.resumes.push(options); h.data.run.state = 'RUNNING'; };
  assert.equal((await createSessionRestartController(h.ports).continueRestart()).restarted, true);
  assert.equal(h.calls.resets.length, 1);
});

test('completion diagnostics preserve slots and journal updates arriving after resume', async () => {
  const h = fixture();
  const getStored = h.ports.getStored, resume = h.ports.resume;
  let race = false;
  h.ports.resume = async options => { await resume(options); race = true; };
  h.ports.getStored = async () => {
    const observed = await getStored();
    if (race) {
      race = false;
      h.data.run.slots = { 0: { entryId: 'image-only', status: 'GENERATING', generationId: 'fresh-slot' } };
      h.data.run.eventSequence = 77;
      h.data.run.eventJournal.push({ type: 'slot_claimed', sequence: 77 });
      h.data.queue.groups.list[1].status = 'running';
    }
    return observed;
  };
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).restarted, true);
  assert.equal(h.data.run.slots[0].generationId, 'fresh-slot');
  assert.equal(h.data.run.eventSequence, 77);
  assert.ok(h.data.run.eventJournal.some(event => event.type === 'slot_claimed'));
  assert.ok(h.data.run.eventJournal.some(event => event.type === 'session_restart_completed'));
  assert.equal(h.data.queue.groups.list[1].status, 'running');
});

test('useful progress arriving before the reset lock cancels the obsolete watchdog decision', async () => {
  const h = fixture({ shouldRestart: () => false });
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).reason, 'useful_progress_arrived');
  assert.equal(h.calls.resets.length, 0);
  assert.equal(h.calls.resumes.length, 0);
});

test('all results finishing during salvage prevents unnecessary new generation', async () => {
  const h = fixture();
  h.ports.readRevision = async id => ({ generationId: id, complete: true });
  h.ports.readModel = async sourceId => ({ currentGenerationId: `g-${sourceId}` });
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).restarted, true);
  assert.equal(h.data.run.state, 'DONE');
  assert.equal(h.calls.resumes.length, 0);
  assert.equal(h.calls.markers.length, 0);
});

test('a quota arriving before continuation keeps its pause and cancels the recovery intent', async () => {
  const h = fixture();
  h.data.run.uploadLimitDetected = true; h.data.run.uploadCooldownActive = true;
  h.data.run.rateLimitPauseUntil = initialTime + 4 * 3600000;
  assert.equal((await h.controller.begin(h.data.run, h.data.job)).reason, 'confirmed_quota');
  assert.equal(h.calls.resets.length, 0);
  assert.equal(h.calls.resumes.length, 0);
});

