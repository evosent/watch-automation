import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness({ abort, disconnected = false } = {}) {
  const source = await readFile(new URL('../extension/chatgpt-adapter.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('  function assertUploadAllowed('), source.indexOf('  function normalizePromptText('));
  let inputLookups = 0;
  let tiles = [];
  const dispatched = [];
  const stale = { multiple: true, isConnected: true, dispatchEvent() { throw new Error('Stale input was used'); } };
  const current = { multiple: true, isConnected: !disconnected, dispatchEvent(event) {
    dispatched.push(event.type);
    if (event.type === 'change') tiles = Array.from(this.files, () => ({}));
  } };
  const context = vm.createContext({
    R: () => ({ resolve(role) {
      if (role === 'composerPlus') return { element: null };
      inputLookups++;
      return { element: inputLookups === 1 ? stale : current, selector: inputLookups === 1 ? 'old-input' : 'current-input' };
    }, attachmentTiles: () => tiles, uploadError: () => null }),
    O: () => ({}), recordAdapterAction() {},
    // This fixture isolates upload dispatch; page/mode checks have separate suites.
    assertPreparationPageReady() {},
    fetch: async () => { abort?.(); return { blob: async () => new Blob(['image'], { type: 'image/png' }) }; },
    Blob, File, Event, DOMException,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
    waitForDomCondition: async ({ predicate, name, timeout }) => { const result = predicate(); if (!result) throw new Error(`Timeout waiting for ${name} (${timeout}ms)`); return result; }
  });
  vm.runInContext(`let uploadMenuOpenedByAdapter = null;\n${functions}\nthis.uploadFile = uploadFile; this.uploadFiles = uploadFiles;`, context);
  return { context, current, dispatched };
}

test('single upload targets the fresh composer input after asynchronous blob preparation', async () => {
  const { context, current, dispatched } = await harness();
  const result = await context.uploadFile({ dataUrl: 'data:image/png;base64,aQ==', name: 'watch.png', expectedCount: 1, debugOverlay: false });
  assert.equal(result.count, 1);
  assert.equal(result.selector, 'current-input');
  assert.equal(current.files.length, 1);
  assert.deepEqual(dispatched, ['change', 'input']);
});

test('two-image batch re-resolves the input and dispatches both files together', async () => {
  const { context, current, dispatched } = await harness();
  const result = await context.uploadFiles({ files: [
    { dataUrl: 'data:image/png;base64,aQ==', name: 'template.png' },
    { dataUrl: 'data:image/png;base64,aQ==', name: 'watch.png' }
  ], debugOverlay: false });
  assert.equal(result.count, 2);
  assert.equal(current.files.length, 2);
  assert.equal(result.selector, 'current-input');
  assert.deepEqual(dispatched, ['change', 'input']);
});

test('cancelled or detached upload cannot dispatch files into a replacement composer', async () => {
  const controller = new AbortController();
  const { context, dispatched } = await harness({ abort: () => controller.abort() });
  await assert.rejects(context.uploadFile({ dataUrl: 'data:image/png;base64,aQ==', name: 'watch.png', expectedCount: 1, debugOverlay: false, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(dispatched, []);
  const detached = await harness({ disconnected: true });
  await assert.rejects(detached.context.uploadFile({ dataUrl: 'data:image/png;base64,aQ==', name: 'watch.png', expectedCount: 1, debugOverlay: false }), { code: 'DOM_CHANGED' });
  assert.deepEqual(detached.dispatched, []);
});
