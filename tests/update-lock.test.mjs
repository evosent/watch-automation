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

function workerHarness({ version = '0.3.40', lock = null, run = null, importJournal = null,
  fetcher = async () => jsonResponse({ status: { phase: 'applying' } }) } = {}) {
  const data = { run, devAutoReload: { revision: 'previous' } };
  if (lock) data.manualExtensionUpdateLock = structuredClone(lock);
  if (importJournal) data.resultsImportJournal = structuredClone(importJournal);
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
    let manualUpdateRestartInFlight = null;
    let manualExtensionUpdateStatusCache = null;
    let manualExtensionUpdateStatusInFlight = null;
    const MANUAL_EXTENSION_UPDATE_STATUS_CACHE_MS = 5000;
    let devReloadPollInFlight = false;
    ${[
      'withStateLock',
      'requestLocalExtensionUpdate',
      'readManualExtensionUpdateStatus',
      'invalidateManualExtensionUpdateStatus',
      'clearManualExtensionUpdateLock',
      'reconcileManualExtensionUpdateLock',
      'assertManualExtensionUpdateNotApplying',
      'startManualExtensionUpdate',
      'applyManualExtensionUpdate',
      'retryManualExtensionRestart',
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

test('the pre-launch update guard deduplicates status reads and has a fresh no-pending fast path', async () => {
  const h = workerHarness();
  await h.context.assertManualExtensionUpdateNotApplying();
  await h.context.assertManualExtensionUpdateNotApplying();
  assert.equal(h.requests.length, 1, 'a second Start/Resume guard reuses the recent successful status read');
  h.context.invalidateManualExtensionUpdateStatus();
  await h.context.assertManualExtensionUpdateNotApplying();
  assert.equal(h.requests.length, 2, 'an explicit invalidation forces a fresh authoritative read');
});

function pendingRestartPayload({ retryAvailable = true, requestedAt = new Date(Date.now() - 3 * 60_000).toISOString() } = {}) {
  return {
    status: { phase: 'restarting', restartRetryAvailable: retryAvailable },
    installed: { packageId: 'package-1', extensionVersion: '0.3.40', restart: { phase: 'pending', requestedAt } }
  };
}

test('restart retry preserves the lock when an accepted request loses its acknowledgement', async () => {
  const h = workerHarness({ version: '0.3.39', fetcher: async (url) => {
    if (url.includes('/update/status')) return jsonResponse(pendingRestartPayload());
    throw new Error('Failed to fetch after POST was accepted');
  } });
  await assert.rejects(h.context.retryManualExtensionRestart(), /Failed to fetch/);
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].url, /\/update\/restart\?/);
  assert.equal(h.data.manualExtensionUpdateLock?.active, true);
  assert.equal(h.data.manualExtensionUpdateLock?.targetVersion, '0.3.40');
  assert.equal(h.data.devAutoReload.suppressNextTabRefresh, true);
});

test('restart retry coalesces repeated clicks while the endpoint is in flight', async () => {
  let accept;
  const endpoint = new Promise((resolve) => { accept = resolve; });
  const h = workerHarness({ version: '0.3.39', fetcher: async (url) => {
    if (url.includes('/update/status')) return jsonResponse(pendingRestartPayload());
    return endpoint;
  } });
  const first = h.context.retryManualExtensionRestart();
  const second = h.context.retryManualExtensionRestart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2, 'one status read plus one restart POST');
  accept(jsonResponse({ status: { phase: 'restarting' }, installed: pendingRestartPayload().installed }));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.launchBlocked, true);
  assert.equal(right.launchBlocked, true);
  assert.equal(h.requests.filter((request) => request.url.includes('/update/restart?')).length, 1);
});

test('restart retry refuses active runs and import transactions before contacting the watcher', async () => {
  const running = workerHarness({ run: { state: 'RUNNING' } });
  await assert.rejects(running.context.retryManualExtensionRestart(), /Перед перезапуском/);
  assert.equal(running.requests.length, 0);
  const importing = workerHarness({ importJournal: { id: 'import-1' } });
  await assert.rejects(importing.context.retryManualExtensionRestart(), /импорта результатов/);
  assert.equal(importing.requests.length, 0);
});

test('legacy status responses infer retry availability from the durable pending timestamp', async () => {
  const payload = pendingRestartPayload();
  delete payload.status.restartRetryAvailable;
  const h = workerHarness({ version: '0.3.39', fetcher: async () => jsonResponse(payload) });
  const status = await h.context.getManualExtensionUpdateStatus();
  assert.equal(status.canRetryRestart, true);
  assert.equal(status.launchBlocked, true);
  assert.equal(h.data.manualExtensionUpdateLock?.targetVersion, '0.3.40');
});
