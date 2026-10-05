import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'extension/service-worker.js'), 'utf8');
const AUDIT_ALARM_NAME = 'watch-automation-generation-audit';

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function makeHarness({ alarms: initialAlarms = [], getStored = async () => ({ run: null, queue: null }) } = {}) {
  const alarms = new Map(initialAlarms.map((alarm) => [alarm.name, alarm]));
  const timers = new Map();
  const calls = { creates: [], clears: [], gets: [], scheduledRecovery: [], genericRecovery: 0 };
  let nextTimerId = 0;
  const chrome = {
    alarms: {
      get: async (name) => {
        calls.gets.push(name);
        return alarms.get(name) || null;
      },
      create: async (name, info) => {
        calls.creates.push({ name, info });
        alarms.set(name, { name, ...info });
      },
      clear: async (name) => {
        calls.clears.push(name);
        return alarms.delete(name);
      }
    },
    storage: { local: { get: async () => ({ resultsImportJournal: null }) } }
  };
  const context = {
    chrome,
    AUDIT_ALARM_NAME,
    AUDIT_INTERVAL_MS: 5000,
    auditTimer: null,
    auditInFlight: null,
    auditMonitorDesired: false,
    auditMonitorEpoch: 0,
    auditAlarmKnownPresent: false,
    auditAlarmReconcilePromise: null,
    auditTimerGeneration: 0,
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    flushRunDiagnosticsSafely: async () => {},
    updateRuntime: async () => {},
    runSummary: () => ({}),
    conversationRecoveryIsBlocked: (run) => run?.blocked === true,
    hasObservationWork: (run) => run?.observationWork === true,
    hasScheduledRunRetries: (run) => run?.scheduledRetry === true,
    processDueScheduledRetries: async () => {},
    appendLog: () => {},
    auditActiveRun: async () => {},
    getStored,
    scheduleStalledBatchRecovery: (...args) => calls.scheduledRecovery.push(args),
    restoreStalledBatchRecovery: async () => { calls.genericRecovery += 1; },
    pauseForImageLimit: async () => {},
    scheduleInterruptedRunRecovery: async () => {},
    Date,
    Promise,
    Object,
    Boolean,
    Number,
    String,
    console
  };

  const monitorSource = section('function shouldKeepAuditMonitor(', 'function shouldWakeSlot(');
  const rehydrateSource = section('async function rehydrateWorkerWake()', '\nfunction clockTime(');
  const publishSource = section('async function publishRun(', '\nasync function waitTabReady(');
  runInNewContext(`
    ${monitorSource}
    ${rehydrateSource}
    ${publishSource}
    globalThis.monitorApi = { shouldKeepAuditMonitor, reconcileAuditAlarm, startAuditMonitor, stopAuditMonitor, scheduleAudit, rehydrateWorkerWake, publishRun };
  `, context);
  return { api: context.monitorApi, alarms, timers, calls, context };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test('a paused run with submitted observations keeps its existing durable audit alarm', async () => {
  const { api, alarms, calls, timers } = makeHarness({
    alarms: [{ name: AUDIT_ALARM_NAME, periodInMinutes: 0.5 }]
  });

  await api.publishRun({ state: 'PAUSED', observationWork: true }, {});
  await settle();

  assert.equal(alarms.has(AUDIT_ALARM_NAME), true);
  assert.equal(calls.creates.length, 0, 'publishing must not reset the existing periodic alarm');
  assert.equal(calls.clears.length, 0);
  assert.equal(timers.size, 1, 'an in-worker audit is also scheduled');
  await api.stopAuditMonitor();
});

test('a cold worker wake rearms the audit alarm for paused observation work', async () => {
  const run = { operationId: 'run-1', state: 'PAUSED', status: 'PAUSED_ON_ERROR', unresolvedError: true, observationWork: true };
  const { api, alarms, calls, timers } = makeHarness({ getStored: async () => ({ run, queue: {} }) });

  await api.rehydrateWorkerWake();
  await settle();

  assert.equal(alarms.has(AUDIT_ALARM_NAME), true);
  assert.equal(calls.creates.length, 1);
  assert.equal(timers.size, 1);
  await api.stopAuditMonitor();
});

test('a manually paused run without observations or retries stops the durable monitor', async () => {
  const { api, alarms, calls, timers } = makeHarness({
    alarms: [{ name: AUDIT_ALARM_NAME, periodInMinutes: 0.5 }]
  });

  await api.publishRun({ state: 'PAUSED', pauseReason: 'USER', observationWork: false, scheduledRetry: false }, {});
  await settle();

  assert.equal(alarms.has(AUDIT_ALARM_NAME), false);
  assert.equal(calls.clears.length, 1);
  assert.equal(timers.size, 0);
});

test('PREPARATION_STALL waiting rehydrates only its due-time alarm when no observation remains', async () => {
  const dueAt = Date.now() + 60000;
  const run = {
    operationId: 'run-2', state: 'PAUSED', status: 'PAUSED_ON_ERROR', unresolvedError: true,
    stalledBatchRecovery: { kind: 'PREPARATION_STALL', stage: 'WAITING', dueAt },
    observationWork: false, scheduledRetry: false
  };
  const { api, alarms, calls, timers } = makeHarness({ getStored: async () => ({ run, queue: {} }) });

  await api.rehydrateWorkerWake();
  await settle();

  assert.equal(calls.scheduledRecovery.length, 1);
  assert.equal(calls.scheduledRecovery[0][0], 'run-2');
  assert.equal(calls.scheduledRecovery[0][1], dueAt);
  assert.equal(calls.genericRecovery, 0, 'preparation cooldown must not enter batch tab restoration');
  assert.equal(alarms.has(AUDIT_ALARM_NAME), false, 'the due-time recovery alarm owns this wait');
  assert.equal(timers.size, 0);
});

test('start followed by stop while alarms.get is pending cannot create a zombie alarm', async () => {
  let releaseGet;
  const harness = makeHarness();
  let deferFirstGet = true;
  harness.context.chrome.alarms.get = (name) => {
    if (deferFirstGet) {
      deferFirstGet = false;
      return new Promise((resolve) => { releaseGet = resolve; });
    }
    return Promise.resolve(harness.alarms.get(name) || null);
  };

  const starting = harness.api.startAuditMonitor();
  const stopping = harness.api.stopAuditMonitor();
  releaseGet(null);
  await Promise.all([starting, stopping]);
  await settle();

  assert.equal(harness.alarms.has(AUDIT_ALARM_NAME), false);
  assert.equal(harness.calls.creates.length, 0);
  assert.equal(harness.timers.size, 0);
});

test('publishing probe state preserves the normal timer instead of accelerating checks to 250ms', async () => {
  const h = makeHarness();
  await h.api.startAuditMonitor();
  h.api.scheduleAudit(5000);
  const timerId = [...h.timers.keys()][0];
  await h.api.publishRun({ state: 'RUNNING' }, {});
  assert.equal([...h.timers.keys()][0], timerId);
  assert.equal(h.timers.get(timerId).delay, 5000);
  h.context.auditTimer = null;
  h.context.auditInFlight = Promise.resolve();
  h.timers.clear();
  await h.api.publishRun({ state: 'RUNNING' }, {});
  assert.equal(h.timers.size, 0, 'the in-flight audit owns its next regular interval');
  await h.api.stopAuditMonitor();
});
