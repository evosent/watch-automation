import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { initResultsTransfer } from '../extension/results-transfer-ui.js';
import { MAX_RESULTS_ARCHIVE_BYTES, RESULTS_ARCHIVE_TOO_LARGE_MESSAGE } from '../extension/results-archive-limits.js';

function fixture(t, { maxArchiveBytes = MAX_RESULTS_ARCHIVE_BYTES } = {}) {
  const originals = Object.fromEntries(['document', 'chrome', 'Option', 'fetch'].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const nodes = new Map(), uploads = [], messages = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, disabled: false, value: '', files: [], listeners: {}, textContent: '',
      classList: { toggle() {} },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      showModal() {}, close() {},
      replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
      append(option) { this.options.push(option); }
    });
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node };
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value; } };
  globalThis.chrome = { runtime: { async sendMessage(message) {
    messages.push(message.type);
    if (message.type === 'GET_RESULTS_TRANSFER_INFO') return { ok: true, value: {
      count: 1235, runs: [], identity: { extensionId: 'a'.repeat(32), clientId: 'ui-limits-test' }
    } };
    if (message.type === 'PREVIEW_RESULTS_IMPORT') return { ok: true, value: {
      total: 1235, models: 1235, newResults: 1235, duplicates: 0, conflicts: 0, withoutFacts: 0
    } };
    throw new Error(`Unexpected message: ${message.type}`);
  } } };
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/health') return { ok: true, json: async () => ({ apiVersion: 12,
      resultsTransfer: { maxArchiveBytes, downloadAcknowledgement: true } }) };
    if (pathname.endsWith('/import')) uploads.push(options.body);
    else assert.ok(pathname.endsWith('/status'));
    return { ok: true, json: async () => ({ ok: true, value: { id: 'import-id', kind: 'import', phase: 'ready' } }) };
  };
  initResultsTransfer({ reload: async () => {} });
  const click = async (id) => {
    node(id).listeners.click();
    for (let i = 0; i < 100 && node('resultsTransferClose').disabled; i++) await nextTurn();
    assert.equal(node('resultsTransferClose').disabled, false, 'UI action must finish and re-enable controls');
  };
  return { node, uploads, messages, click };
}

function archiveWithReportedSize(size) {
  // Simulate File metadata at the boundary without allocating a multi-GB browser buffer.
  const file = new File(['fixture'], 'results.zip');
  Object.defineProperty(file, 'size', { value: size });
  file.arrayBuffer = () => { throw new Error('The UI must upload the File directly'); };
  return file;
}

test('transfer UI accepts archives above 1 GiB and up to the shared ZIP32 limit', async (t) => {
  const ui = fixture(t);
  await ui.click('resultsTransferOpen');
  for (const size of [2 * 1024 ** 3, MAX_RESULTS_ARCHIVE_BYTES]) {
    const file = archiveWithReportedSize(size);
    ui.node('resultsImportFile').files = [file];
    ui.node('resultsImportFile').listeners.change();
    await ui.click('resultsImportCheck');
    assert.equal(ui.uploads.at(-1), file);
    assert.equal(ui.node('resultsImportApply').hidden, false);
    assert.match(ui.node('resultsTransferStatus').textContent, /Новых: 1235/);
  }
  assert.equal(ui.uploads.length, 2);
  assert.equal(ui.messages.filter((type) => type === 'PREVIEW_RESULTS_IMPORT').length, 2);
  assert.equal(ui.messages.includes('COMMIT_RESULTS_IMPORT'), false);
});

test('transfer UI rejects oversized archives before upload and keeps import unapplied', async (t) => {
  const ui = fixture(t);
  await ui.click('resultsTransferOpen');
  ui.node('resultsImportFile').files = [archiveWithReportedSize(MAX_RESULTS_ARCHIVE_BYTES + 1)];
  ui.node('resultsImportFile').listeners.change();
  await ui.click('resultsImportCheck');
  assert.equal(ui.node('resultsTransferStatus').textContent, RESULTS_ARCHIVE_TOO_LARGE_MESSAGE);
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.node('resultsImportApply').hidden, true);
  assert.equal(ui.messages.includes('PREVIEW_RESULTS_IMPORT'), false);
});

test('transfer UI blocks a still-running 1 GiB backend and explains how to restart it', async (t) => {
  const ui = fixture(t, { maxArchiveBytes: 1024 ** 3 });
  await ui.click('resultsTransferOpen');
  assert.match(ui.node('resultsTransferStatus').textContent, /старое ограничение архива/);
  ui.node('resultsImportFile').files = [archiveWithReportedSize(2 * 1024 ** 3)];
  ui.node('resultsImportFile').listeners.change();
  await ui.click('resultsImportCheck');
  assert.match(ui.node('resultsTransferStatus').textContent, /START_AUTOGENERATION\.cmd/);
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.node('resultsImportApply').hidden, true);
});
