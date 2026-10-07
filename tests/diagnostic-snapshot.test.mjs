import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDiagnosticOutbox, RUN_DIAGNOSTIC_OUTBOX_KEY } from '../extension/diagnostic-outbox-utils.js';
import {
  completeRunDiagnostic, listCompleteRunDiagnosticHeaders, latestDiagnosticOperationId
} from '../extension/diagnostic-export-utils.js';

const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const start = panel.indexOf('async function exportDiagnosticSnapshot(');
const end = panel.indexOf('async function exportGenerationMemory(', start);
const production = panel.slice(start, end);

function workerFunction(name) {
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
  assert.ok(declaration, `production function ${name} exists`);
  const following = /^(?:async )?function \w+\(/m.exec(worker.slice(declaration.index + declaration[0].length));
  const end = following ? declaration.index + declaration[0].length + following.index : worker.length;
  return worker.slice(declaration.index, end);
}
function harness(value, { archiveError = false, pending = [], live = null } = {}) {
  const calls = { ids: [], downloads: [] };
  const archive = { run: { operationId: 'previous-run', startedAt: '2026-10-05T18:00:00.000Z', eventCount: 789 },
    events: Array.from({ length: 789 }, (_, i) => ({ operationId: 'previous-run', sequence: i + 1, type: 'event',
      at: '2026-10-05T18:00:00.000Z' })) };
  const values = { run: live, queue: { groups: {} }, [RUN_DIAGNOSTIC_OUTBOX_KEY]: {
    schemaVersion: 1, runs: Object.fromEntries(pending.map(snapshot => [snapshot.operationId, snapshot]))
  } };
  const storage = { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
    .map(key => [key, structuredClone(values[key])])) };
  const context = vm.createContext({
    chrome: { storage: { local: { ...storage, set: async () => {} } },
      runtime: { sendMessage: async () => ({ ok: true, value }), getManifest: () => ({ version: '0.3.49' }) } },
    createDiagnosticOutbox, completeRunDiagnostic, listCompleteRunDiagnosticHeaders, latestDiagnosticOperationId,
    listRunDiagnostics: async () => { if (archiveError) throw new Error('Fake archive unavailable'); return [archive.run]; },
    getRunDiagnostic: async (id) => {
      calls.ids.push(id);
      if (archiveError) throw new Error('Fake archive unavailable');
      if (!['previous-run', 'active-run'].includes(id)) return null;
      return { run: { ...archive.run, operationId: id }, events: archive.events.map(event => ({ ...event, operationId: id })) };
    },
    downloadJson: (_name, payload) => calls.downloads.push(structuredClone(payload)), showFeedback: () => {}
  });
  vm.runInContext(production, context);
  return { context, calls };
}

test('diagnostic snapshot includes the complete active run journal instead of only twenty recent events', async () => {
  const h = harness({ run: { operationId: 'active-run', recentEvents: Array(20).fill({ type: 'recent' }) } });
  await h.context.exportDiagnosticSnapshot();
  assert.deepEqual(h.calls.ids, ['active-run']);
  assert.equal(h.calls.downloads[0].runArchive.events.length, 789);
  assert.equal(h.calls.downloads[0].run.recentEvents.length, 20);
});

test('a diagnostic snapshot after Reset retains the most recent archived run', async () => {
  const h = harness({ run: null, runtime: { state: 'IDLE' } });
  await h.context.exportDiagnosticSnapshot();
  assert.deepEqual(h.calls.ids, ['previous-run']);
  assert.equal(h.calls.downloads[0].run, null);
  assert.equal(h.calls.downloads[0].runArchive.events.length, 789);
});

test('archive failure does not prevent current diagnostics and is explicit in the exported file', async () => {
  const h = harness({ run: { operationId: 'active-run' }, logs: [{ message: 'upload timeout' }] }, { archiveError: true });
  await h.context.exportDiagnosticSnapshot();
  assert.equal(h.calls.downloads[0].runArchive, null);
  assert.equal(h.calls.downloads[0].runArchiveError, 'Fake archive unavailable');
  assert.equal(h.calls.downloads[0].logs.length, 1);
});

test('after Reset a diagnostics snapshot exports the latest outbox-only run despite archive failure', async () => {
  const operationId = 'pending-reset-run';
  const pending = [{ operationId, header: { operationId, state: 'RESET', eventCount: 2,
    startedAt: '2026-10-06T00:00:00.000Z' }, records: [
    { operationId, sequence: 1, type: 'session_reset_requested', at: '2026-10-06T00:10:00.000Z' },
    { operationId, sequence: 2, type: 'session_reset_completed', at: '2026-10-06T00:10:01.000Z' }
  ] }];
  const h = harness({ run: null, runtime: { state: 'IDLE', operationId: null } }, { archiveError: true, pending });
  await h.context.exportDiagnosticSnapshot();
  assert.deepEqual(h.calls.ids, [operationId]);
  assert.equal(h.calls.downloads[0].runArchive.run.operationId, operationId);
  assert.equal(h.calls.downloads[0].runArchive.events.length, 2);
  assert.equal(h.calls.downloads[0].runArchiveError, 'Fake archive unavailable');
});

test('outbox-only newer run is selected over an older available archive after Reset', async () => {
  const operationId = 'newer-pending-run';
  const pending = [{ operationId, header: { operationId, state: 'RESET', eventCount: 1,
    startedAt: '2026-10-06T00:00:00.000Z' }, records: [
    { operationId, sequence: 1, type: 'session_reset_completed', at: '2026-10-06T00:10:00.000Z' }
  ] }];
  const h = harness({ run: null }, { pending });
  await h.context.exportDiagnosticSnapshot();
  assert.deepEqual(h.calls.ids, [operationId]);
  assert.equal(h.calls.downloads[0].runArchive.run.operationId, operationId);
  assert.equal(h.calls.downloads[0].runArchive.events.length, 1);
});

test('local diagnostic control returns the same complete run archive as the manual exporter', async () => {
  const run = { operationId: 'control-run', state: 'DONE' };
  const value = {
    runtime: { state: 'DONE' }, run, logs: [{ message: 'saved' }],
    generationMemory: { items: {
      ready: { status: 'ready' }, running: { status: 'running' },
      error: { status: 'not_ready', lastError: 'timeout' }
    } },
    lastPreflight: { ok: true }
  };
  const archive = { run: { operationId: run.operationId }, events: [{ operationId: run.operationId, sequence: 1 }] };
  const calls = [];
  const context = vm.createContext({
    ensureGenerationMemoryState: async () => value,
    chrome: { storage: { local: {} }, runtime: { getManifest: () => ({ version: '0.3.52' }) } },
    diagnosticOutbox: { read: async () => null },
    getRunDiagnostic: async () => archive,
    listRunDiagnostics: async () => [],
    latestDiagnosticOperationId: async () => run.operationId,
    completeRunDiagnostic: async (operationId, ports) => {
      calls.push({ operationId, hasArchiveReader: typeof ports.readArchive === 'function' });
      return archive;
    }
  });
  vm.runInContext(workerFunction('buildControlDiagnosticSnapshot'), context);

  const snapshot = await context.buildControlDiagnosticSnapshot();
  assert.equal(snapshot.extensionVersion, '0.3.52');
  assert.equal(snapshot.runArchiveError, null);
  assert.equal(snapshot.runArchive.events.length, 1);
  assert.deepEqual(calls, [{ operationId: 'control-run', hasArchiveReader: true }]);
  assert.equal(snapshot.generationMemorySummary.total, 3);
  assert.equal(snapshot.generationMemorySummary.running, 1);
  assert.equal(snapshot.activeMemoryItems.length, 2);
  assert.deepEqual(Array.from(snapshot.domSnapshots), []);
});

test('local diagnostic control captures DOM from tracked ChatGPT tabs in the automation window', async () => {
  const value = {
    runtime: { state: 'STOPPED', automationWindowId: 7 },
    run: { slots: { 1: { tabId: 12 } } },
    generationMemory: { items: {} }
  };
  const capturedTabs = [];
  const tabs = [
    { id: 12, windowId: 7, url: 'https://chatgpt.com/c/one' },
    { id: 13, windowId: 7, url: 'https://chatgpt.com/c/two' },
    { id: 14, windowId: 7, url: 'https://example.com/' },
    { id: 15, windowId: 8, url: 'https://chatgpt.com/c/other-window' }
  ];
  const context = vm.createContext({
    URL,
    ensureGenerationMemoryState: async () => value,
    chrome: {
      storage: { local: {} },
      runtime: { getManifest: () => ({ version: '0.3.52' }) },
      tabs: { query: async (query) => tabs.filter((tab) => tab.windowId === query.windowId) }
    },
    diagnosticOutbox: { read: async () => null },
    getRunDiagnostic: async () => null,
    listRunDiagnostics: async () => [],
    latestDiagnosticOperationId: async () => null,
    completeRunDiagnostic: async () => null,
    sendTabMessage: async (tabId, message) => {
      capturedTabs.push({ tabId, message });
      return { ok: true, value: { href: `https://chatgpt.com/c/${tabId}`, bodyText: `tab ${tabId}` } };
    }
  });
  vm.runInContext(workerFunction('buildControlDiagnosticSnapshot'), context);

  const snapshot = await context.buildControlDiagnosticSnapshot();
  assert.deepEqual(capturedTabs.map(({ tabId }) => tabId), [12, 13]);
  assert.deepEqual(Array.from(snapshot.domSnapshots, ({ tabId }) => tabId), [12, 13]);
  assert.equal(capturedTabs[0].message.reason, 'manual');
});

