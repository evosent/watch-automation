import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('let browserSessionInitialization = null;');
const end = worker.indexOf('chrome.runtime.onStartup.addListener', start);
const initializer = worker.slice(start, end);

function context(sessionValues, calls, reconcile = async () => {}) {
  return {
    chrome: { storage: { session: {
      get: async () => ({ ...sessionValues }),
      set: async (value) => { Object.assign(sessionValues, value); }
    } } },
    getStored: async () => ({}),
    scheduleInterruptedRunRecovery: async () => { calls.push('reconcile'); await reconcile(); },
    rehydrateWorkerWake: async () => { calls.push('worker-wake'); }
  };
}

test('first browser session reconciles once before reconstructing any Send tasks', async () => {
  const calls = [];
  const values = {};
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const api = runInNewContext(`${initializer}; ({ initializeBrowserSessionTasks });`, context(values, calls, () => pending));
  const first = api.initializeBrowserSessionTasks();
  const startupEvent = api.initializeBrowserSessionTasks();
  assert.equal(first, startupEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['reconcile']);
  finish();
  await first;
  assert.equal(values.watchAutomationBrowserSessionInitialized, true);
});

test('ordinary MV3 wake in the same browser session preserves active run recovery', async () => {
  const calls = [];
  const values = { watchAutomationBrowserSessionInitialized: true };
  const api = runInNewContext(`${initializer}; ({ initializeBrowserSessionTasks });`, context(values, calls));
  await api.initializeBrowserSessionTasks();
  assert.deepEqual(calls, ['worker-wake']);
});

test('new browser session with empty session storage reconciles again', async () => {
  const calls = [];
  const api = runInNewContext(`${initializer}; ({ initializeBrowserSessionTasks });`, context({}, calls));
  await api.initializeBrowserSessionTasks();
  assert.deepEqual(calls, ['reconcile']);
  assert.match(worker, /initializeBrowserSessionTasks\(\)\.catch/);
});

test('interrupted reset takes precedence and saved cooldown recovery survives browser startup', async () => {
  const resetCalls = [];
  const resetContext = context({}, resetCalls);
  resetContext.getStored = async () => ({ sessionResetIntent: { operationId: 'reset' } });
  resetContext.resumeInterruptedSessionReset = async (intent) => { resetCalls.push(intent.operationId); };
  const resetApi = runInNewContext(`${initializer}; ({ initializeBrowserSessionTasks });`, resetContext);
  await resetApi.initializeBrowserSessionTasks();
  assert.deepEqual(resetCalls, ['reset']);

  const cooldownCalls = [];
  const cooldownContext = context({}, cooldownCalls);
  cooldownContext.getStored = async () => ({ run: { stalledBatchRecovery: { stage: 'WAITING' } } });
  const cooldownApi = runInNewContext(`${initializer}; ({ initializeBrowserSessionTasks });`, cooldownContext);
  await cooldownApi.initializeBrowserSessionTasks();
  assert.deepEqual(cooldownCalls, ['worker-wake']);
});
