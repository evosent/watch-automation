import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');

function declaration(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function ${name}`);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/^\}/m) + 2;
  assert.ok(end > 1, `Missing end of ${name}`);
  return tail.slice(0, end);
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => structuredClone(payload) };
}

function workerHarness({ version = '0.3.40', lock = null, run = null, fetcher = async () => jsonResponse({ status: { phase: 'applying' } }) } = {}) {
  const data = { run, devAutoReload: { revision: 'previous' } };
  if (lock) data.manualExtensionUpdateLock = structuredClone(lock);
  const requests = [];
  const context = vm.createContext({
    Date,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
    chrome: {
      runtime: { getManifest: () => ({ version }), reload() {} },
      storage: { local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter((key) => data[key] !== undefined).map((key) => [key, structuredClone(data[key])])),
        set: async (patch) => Object.assign(data, structuredClone(patch)),
        remove: async (key) => { delete data[key]; }
      } }
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return fetcher(String(url), options);
    },
    getDevControlClientIdentity: async () => ({ extensionId: 'test-id', clientId: 'test-client', version }),
    getStored: async () => structuredClone(data),
    runHasActiveAutomationWork: (value) => value?.state === 'RUNNING',
    hasLiveSlotWork: () => false,
    appendLog: async () => {},
    updateRuntime: async () => {},
    queueDomBridgeFlush() {},
    queueLastDiagnosticBridge() {},
    DEV_UPDATE_STATUS_URL: 'http://127.0.0.1:17321/update/status',
    DEV_UPDATE_START_URL: 'http://127.0.0.1:17321/update',
    DEV_UPDATE_APPLY_URL: 'http://127.0.0.1:17321/update/apply',
    DEV_RELOAD_STATUS_URL: 'http://127.0.0.1:17321/reload-status',
    DEV_RELOAD_POLL_TIMEOUT_MS: 1000
  });
  vm.runInContext(`let stateChain = Promise.resolve();
    let manualUpdateApplyInFlight = null;
    let devReloadPollInFlight = false;
    ${[
      'withStateLock',
      'requestLocalExtensionUpdate',
      'clearManualExtensionUpdateLock',
      'reconcileManualExtensionUpdateLock',
      'assertManualExtensionUpdateNotApplying',
      'startManualExtensionUpdate',
      'applyManualExtensionUpdate',
      'getManualExtensionUpdateStatus',
      'pollDevReload',
      'startRun',
      'resumeRun'
    ].map((name) => declaration(worker, name)).join('\n')}`, context);
  return { context, data, requests };
}

const updateLock = () => ({ active: true, targetVersion: '0.3.40', startedAt: '2026-10-05T10:00:00.000Z' });

test('manual apply requests coalesce and serialize the lock with run state', async () => {
  let finishRequest;
  const response = new Promise((resolve) => { finishRequest = resolve; });
  const h = workerHarness({ fetcher: async () => response });
  const first = h.context.applyManualExtensionUpdate('0.3.40');
  const second = h.context.applyManualExtensionUpdate('0.3.40');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.manualExtensionUpdateLock?.active, true);
  finishRequest(jsonResponse({ status: { phase: 'applying' } }));
  assert.equal((await first).started, true);
  assert.equal((await second).started, true);
});

test('lost apply acknowledgement keeps the lock and prevents Start or Resume until target code is loaded', async () => {
  const h = workerHarness({
    version: '0.3.39',
    lock: updateLock(),
    fetcher: async () => {
      throw new Error('Failed to fetch');
    }
  });
  await assert.rejects(h.context.applyManualExtensionUpdate('0.3.40'), /Failed to fetch/);
  assert.equal(h.data.manualExtensionUpdateLock?.active, true);

  h.context.fetch = async () => jsonResponse({
    status: { phase: 'complete' },
    installed: { extensionVersion: '0.3.40' }
  });
  await assert.rejects(h.context.startRun(), /обновления расширения ещё выполняется/i);
  await assert.rejects(h.context.resumeRun(), /обновления расширения ещё выполняется/i);
  assert.equal(h.data.manualExtensionUpdateLock?.active, true);
});

test('an explicit HTTP rejection releases the apply lock', async () => {
  const h = workerHarness({
    fetcher: async () => jsonResponse({ error: 'Нет подготовленного пакета' }, { ok: false, status: 409 })
  });
  await assert.rejects(h.context.applyManualExtensionUpdate('0.3.40'), /Нет подготовленного пакета/);
  assert.equal(h.data.manualExtensionUpdateLock, undefined);
});

test('terminal update status clears the lock only after the target version is loaded', async () => {
  const stale = workerHarness({ version: '0.3.39', lock: updateLock() });
  const pending = await stale.context.reconcileManualExtensionUpdateLock(
    { phase: 'complete' },
    { extensionVersion: '0.3.40' }
  );
  assert.equal(pending.pending, true);
  assert.equal(stale.data.manualExtensionUpdateLock.active, true);

  const updated = workerHarness({ lock: updateLock() });
  const cleared = await updated.context.reconcileManualExtensionUpdateLock(
    { phase: 'complete' },
    { extensionVersion: '0.3.40' }
  );
  assert.equal(cleared.cleared, true);
  assert.equal(updated.data.manualExtensionUpdateLock, undefined);
});

test('development auto-reload defers while a manual update owns the lock', async () => {
  const h = workerHarness({ lock: updateLock() });
  const result = await h.context.pollDevReload();
  assert.equal(result.reason, 'manual_update');
  assert.equal(h.requests.length, 0);
});
