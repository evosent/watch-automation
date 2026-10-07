import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { syncRunProgress } from '../extension/run-progress-utils.js';
import {
  elapsedRunClock,
  pauseRunClock,
  resumeRunClock,
  stopRunClock,
  syncRunClock
} from '../extension/run-clock-utils.js';

const at = (milliseconds) => new Date(milliseconds).toISOString();

function extractFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing function end marker: ${endMarker}`);
  return source.slice(start, end);
}

function activeRun(startedAt = 0) {
  return {
    state: 'RUNNING',
    status: 'RUNNING',
    pauseReason: null,
    startedAt: at(startedAt),
    lastActivityAt: at(startedAt),
    eventJournal: []
  };
}

test('active time excludes user pause, blocked Stop, and persists through reload and terminal states', () => {
  const run = activeRun(0);
  syncRunClock(run, 0);
  assert.equal(elapsedRunClock(run, 10_000), 10_000);

  pauseRunClock(run, 10_000);
  run.state = 'PAUSED';
  run.status = 'PAUSED';
  run.pauseReason = 'USER';
  run.lastActivityAt = at(10_000);
  assert.equal(elapsedRunClock(run, 610_000), 10_000);
  assert.equal(elapsedRunClock(run, 610_000) / 2, 5_000, 'average remains fixed during pause');

  run.state = 'RUNNING';
  run.status = 'RUNNING';
  run.pauseReason = null;
  resumeRunClock(run, 610_000);
  assert.equal(elapsedRunClock(run, 620_000), 20_000);

  stopRunClock(run, 620_000);
  run.stopBlocked = { at: at(620_000) };
  assert.equal(elapsedRunClock(run, 1_220_000), 20_000, 'first Stop click freezes even when blocked');
  const reopened = JSON.parse(JSON.stringify(run));
  assert.equal(elapsedRunClock(reopened, 86_400_000), 20_000, 'persisted blocked-stop time survives worker reload');

  delete run.stopBlocked;
  resumeRunClock(run, 1_220_000);
  assert.equal(elapsedRunClock(JSON.parse(JSON.stringify(run)), 1_225_000), 25_000,
    'explicit Continue clears the stop latch and starts a new active interval');

  run.state = 'DONE';
  run.status = 'DONE';
  run.finishedAt = at(1_230_000);
  syncRunClock(run, 1_230_000);
  const finished = JSON.parse(JSON.stringify(run));
  assert.equal(elapsedRunClock(finished, 10_000_000), 30_000, 'completed elapsed time remains fixed after reload');
});

test('rate-limit cooldown and automatic rest freeze active elapsed time', () => {
  const run = activeRun(0);
  syncRunClock(run, 0);
  run.status = 'RATE_LIMIT_PAUSE';
  run.rateLimitPauseStartedAt = at(5_000);
  run.rateLimitPauseUntil = 600_000;
  run.lastActivityAt = at(5_000);
  syncRunClock(run, 10_000);
  assert.equal(elapsedRunClock(run, 600_000), 5_000);

  run.status = 'RUNNING';
  run.rateLimitPauseStartedAt = null;
  run.rateLimitPauseUntil = null;
  resumeRunClock(run, 600_000);
  assert.equal(elapsedRunClock(run, 601_000), 6_000);

  const resting = activeRun(0);
  syncRunClock(resting, 0);
  resting.state = 'PAUSED';
  resting.status = 'STALLED_BATCH_RECOVERY';
  resting.pauseReason = 'STALLED_BATCH';
  resting.stalledBatchRecovery = { stage: 'WAITING', waitStartedAt: at(3_000) };
  syncRunClock(resting, 600_000);
  assert.equal(elapsedRunClock(resting, 3_600_000), 3_000);
});

test('legacy event journal migration subtracts past pauses and avoids counting an old current pause', () => {
  const legacy = {
    state: 'DONE',
    status: 'DONE',
    startedAt: at(0),
    finishedAt: at(615_000),
    eventJournal: [
      { type: 'run_started', at: at(0), sequence: 1 },
      { type: 'run_pause_requested', at: at(10_000), sequence: 2 },
      { type: 'run_pause_applied', at: at(10_000), sequence: 3 },
      { type: 'run_resumed', at: at(610_000), sequence: 4 },
      { type: 'run_completed', at: at(615_000), sequence: 5 }
    ]
  };
  assert.equal(elapsedRunClock(legacy, 86_400_000), 15_000);

  const oldPausedRun = {
    state: 'PAUSED',
    status: 'PAUSED',
    pauseReason: 'USER',
    startedAt: at(0),
    lastActivityAt: at(7_200_000),
    eventJournal: []
  };
  assert.equal(elapsedRunClock(oldPausedRun, 7_200_000 + 86_400_000), 7_200_000,
    'legacy paused run freezes at its last known activity boundary');
});

test('a new run starts with an independent clock and active clock fields survive a cold wake', () => {
  const first = activeRun(0);
  syncRunClock(first, 0);
  assert.equal(elapsedRunClock(JSON.parse(JSON.stringify(first)), 30_000), 30_000);

  const second = activeRun(3_600_000);
  syncRunClock(second, 3_600_000);
  assert.equal(second.clockAccumulatedMs, 0);
  assert.equal(elapsedRunClock(JSON.parse(JSON.stringify(second)), 3_602_000), 2_000);
});

test('an accepted Stop remains fixed after persistence and worker restart', () => {
  const run = activeRun(0);
  syncRunClock(run, 0);
  run.state = 'STOPPED';
  run.status = 'STOPPED';
  run.finishedAt = at(2_000);
  syncRunClock(run, 2_000);

  const reopened = JSON.parse(JSON.stringify(run));
  assert.equal(elapsedRunClock(reopened, 86_400_000), 2_000);
});

test('worker persistence and event functions apply the active clock to the saved run', async () => {
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const saveSource = extractFunction(worker, 'async function saveRunAndQueue(', 'function normalizedDownloadPath(');
  const eventSource = extractFunction(worker, 'function recordRunEvent(', 'function scheduleRunDiagnosticsFlush(');
  const summarySource = extractFunction(worker, 'function runSummary(run, queue)', 'async function publishRun(');
  const context = {
    QUEUE_GROUP_IDS: [],
    MAX_RUN_EVENTS: 600,
    RUN_CLOCK_PAUSE_EVENTS: new Set([
      'run_pause_requested', 'run_pause_applied', 'run_paused_on_error',
      'rate_limit_pause', 'image_limit_pause', 'run_retry_backoff_scheduled',
      'upload_limit_pause', 'upload_backoff_pause',
      'stalled_batch_recovery_started', 'stalled_batch_recovery_waiting',
      'conversation_load_recovery_started', 'run_stop_accepted', 'run_completed'
    ]),
    queueRunDiagnostics() {},
    ensureSessionWatchdog() {},
    noteSessionUsefulProgress() {},
    recordRecoveryTransitions() {},
    persistRunDiagnosticDecision: async () => {},
    groupEntries: () => [],
    syncRunProgress,
    syncRunClock,
    elapsedRunClock,
    pauseRunClock,
    resumeRunClock,
    stopRunClock,
    normalizeWatchFilter: (value) => value || {},
    parseFilterSelectionId: () => null,
    filterFromQueueGroup: () => null,
    watchFilterLabel: () => '',
    normalizeCoverageMode: (value) => value,
    activeSlots: () => 0,
    normalizeWorkerCount: (value) => value || 1,
    DEFAULT_WORKERS: 1,
    EXTENSION_BUILD_ID: 'test-build',
    normalizeInputMode: (value) => value,
    DEFAULT_INPUT_MODE: 'files',
    normalizeRateLimitPauseMinutes: (value) => value,
    normalizeRateLimitIgnoreMinutes: (value) => value,
    normalizeGenerationPauseMinutes: (value) => value,
    normalizeGenerationJitterSeconds: (value) => value,
    factsProgressSummaries: () => [],
    slotSummaries: () => [],
    chrome: { storage: { local: { set: async (value) => { context.saved = structuredClone(value); } } } }
  };
  runInNewContext(`${saveSource}\n${eventSource}\n${summarySource}\n` +
    'globalThis.persistRun = saveRunAndQueue; globalThis.appendEvent = recordRunEvent; globalThis.summarize = runSummary;', context);

  const startedAtMs = Date.now() - 30_000;
  const run = {
    operationId: 'clock-integration',
    state: 'RUNNING',
    status: 'RUNNING',
    pauseReason: null,
    startedAt: at(startedAtMs),
    lastActivityAt: at(startedAtMs),
    eventJournal: [],
    eventSequence: 0,
    eventCount: 0,
    plannedIds: []
  };
  await context.persistRun(run, { groups: {} });
  assert.equal(context.saved.run.clockVersion, 1);
  assert.equal(context.saved.run.clockActiveSinceMs, startedAtMs);

  context.appendEvent(run, 'run_pause_requested');
  run.state = 'PAUSED';
  run.status = 'PAUSED';
  run.pauseReason = 'USER';
  run.lastActivityAt = run.eventJournal.at(-1).at;
  await context.persistRun(run, { groups: {} });
  const pausedElapsed = context.summarize(run, { groups: {} }).elapsedMs;
  assert.ok(pausedElapsed >= 29_000 && pausedElapsed <= 31_000);
  assert.equal(elapsedRunClock(context.saved.run, Date.now() + 600_000), pausedElapsed,
    'worker save persists a stable clock across a long paused interval');

  run.state = 'RUNNING';
  run.status = 'RUNNING';
  run.pauseReason = null;
  resumeRunClock(run, Date.now());
  context.appendEvent(run, 'run_stop_requested');
  assert.equal(run.clockStopped, true, 'the worker event path latches the first Stop request');
  const stopped = context.summarize(run, { groups: {} });
  assert.equal(stopped.clockStopped, true);
  assert.equal(stopped.elapsedMs, run.clockAccumulatedMs);

  const retrying = activeRun(Date.now() - 20_000);
  await context.persistRun(retrying, { groups: {} });
  retrying.status = 'RETRY_BACKOFF';
  retrying.lastActivityAt = at(Date.now() - 60_000);
  context.appendEvent(retrying, 'run_retry_backoff_scheduled');
  assert.equal(retrying.clockActiveSinceMs, null);
  assert.ok(retrying.clockAccumulatedMs >= 19_000,
    'a pause event settles to its event boundary even after status changed');
});
