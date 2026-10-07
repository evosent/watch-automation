import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/chatgpt-adapter.js', import.meta.url), 'utf8');

// Exercise the real adapter and its mutation/poll waiter. Only ChatGPT's page
// and clock are fake; no account, browser, file picker or generation is used.
function harness({ present = false, lazy = true, mountAt = Infinity,
  quotaAt = Infinity, abortAt = Infinity, expanded = false, plusDisabled = false,
  remountDuringFetch = false, remountDuringHighlight = false, single = false,
  workMode = false, closeThrows = false } = {}) {
  let now = 0;
  const controller = new AbortController();
  const page = { count: 0, clicks: 0, dispatches: 0, events: [], observedInputs: [], opened: expanded, issue: null, intervals: 0 };
  class Clock extends Date { static now() { return now; } }
  function makeInput() {
    return { isConnected: true, disabled: false, multiple: !single, files: [],
      getAttribute: () => null,
      dispatchEvent(event) {
        page.events.push(event.type);
        if (event.type !== 'change') return;
        page.dispatches++;
        page.observedInputs.push(this);
        page.count += this.files.length;
      }
    };
  }
  let input = present ? makeInput() : null;
  const remount = () => { if (input) input.isConnected = false; input = makeInput(); };
  const plus = { isConnected: true, disabled: plusDisabled, id: 'composer-plus', tagName: 'BUTTON',
    getAttribute(name) { return name === 'aria-expanded' ? String(page.opened) : null; },
    click() {
      page.clicks++;
      if (page.opened && closeThrows) throw new Error('Menu was remounted');
      page.opened = !page.opened;
      if (page.opened && lazy) remount();
    }
  };
  const composer = { isConnected: true, disabled: false, getAttribute: () => null };
  const modes = [];
  if (workMode) {
    const chat = { textContent: 'Чат', getAttribute: (key) => key === 'aria-selected' ? 'false' : null };
    const work = { textContent: 'Работа', getAttribute: (key) => key === 'aria-selected' ? 'true' : null };
    const parent = { querySelectorAll: () => [chat, work] };
    chat.parentElement = work.parentElement = parent;
    modes.push(chat, work);
  }
  const resolver = {
    resolve(name) { return { element: name === 'fileInput' ? input : name === 'composerPlus' ? plus : name === 'composer' ? composer : null, selector: `#${name}` }; },
    visible: () => true,
    uploadError: () => page.issue,
    attachmentTiles: () => Array(page.count).fill({}),
    assistantTurns: () => [],
    fileInputDiagnostics: () => ({ composerFound: true, totalCandidates: input ? 1 : 0,
      candidates: input ? [{ id: 'upload-files', connected: input.isConnected, enabled: true, scope: 'composer' }] : [] })
  };
  let nextTimer = 0;
  const timers = new Map();
  function interval(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, true);
    const tick = () => {
      if (!timers.has(id)) return;
      now += delay;
      page.intervals++;
      if (!input && now >= mountAt) remount();
      if (now >= quotaAt) page.issue = { text: 'File upload limit reached. Try again in 3 hours.', uploadLimit: true };
      if (now >= abortAt) controller.abort();
      callback();
      if (timers.has(id)) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    return id;
  }
  class DataTransfer { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } }
  const window = { __WATCH_AUTOMATION_ENABLED__: true, WatchSelectorResolver: resolver,
    WatchAutomationOverlay: { async highlightTarget() { if (remountDuringHighlight) remount(); } } };
  vm.runInContext(source, vm.createContext({ window,
    document: { documentElement: {}, querySelectorAll: () => modes },
    Date: Clock, Blob, File, Event, DOMException, DataTransfer,
    fetch: async () => ({ blob: async () => { if (remountDuringFetch) remount(); return new Blob(['fake'], { type: 'image/png' }); } }),
    MutationObserver: class { observe() {} }, queueMicrotask,
    setInterval: interval, clearInterval: (id) => timers.delete(id), setTimeout, clearTimeout
  }));
  return { adapter: window.WatchChatGPTAdapter, page, signal: controller.signal,
    get input() { return input; }, get now() { return now; } };
}

const files = [
  { name: 'first.png', dataUrl: 'data:image/png;base64,AA==' },
  { name: 'second.png', dataUrl: 'data:image/png;base64,AA==' }
];

test('an existing input uploads immediately without opening the menu or waiting', async () => {
  const h = harness({ present: true });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  assert.equal(h.page.clicks, 0);
  assert.equal(h.now, 0);
  assert.equal(h.page.dispatches, 1);
});

test('a lazy upload input mounts after one Add click and the owned menu closes after selection', async () => {
  for (const selected of [files.slice(0, 1), files]) {
    const h = harness();
    assert.equal((await h.adapter.uploadFiles({ files: selected, debugOverlay: false })).count, selected.length);
    assert.equal(h.page.clicks, 2, 'one open and one close, no native picker item');
    assert.equal(h.page.opened, false);
    assert.equal(h.page.dispatches, 1);
    assert.deepEqual(h.page.events, ['change', 'input']);
    const report = h.adapter.dryRunReport();
    assert.equal(report.fileInputDiagnostics.totalCandidates, 1);
    assert.doesNotMatch(JSON.stringify(report.uploadInputRecovery), /first\.png|second\.png|data:image|base64/);
  }
});

test('normal composer remount and an already open menu never get toggled by the adapter', async () => {
  for (const expanded of [false, true]) {
    const h = harness({ lazy: false, mountAt: 1500, expanded });
    assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
    assert.equal(h.page.clicks, 0);
    assert.equal(h.page.opened, expanded);
  }
});

test('a menu that was already open waits for a delayed portal without closing it', async () => {
  const h = harness({ lazy: false, expanded: true, mountAt: 4500 });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  assert.equal(h.page.clicks, 0);
});

test('persistent missing input fails within a bounded wait with a typed error and retained diagnostics', async () => {
  const h = harness({ lazy: false });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'DOM_CHANGED');
  assert.ok(h.now <= 14000, `bounded input preparation: ${h.now}`);
  assert.equal(h.page.dispatches, 0);
  assert.equal(h.page.clicks, 1);
  const report = h.adapter.dryRunReport();
  assert.equal(report.lastUpload.type, 'upload-input-failed');
  assert.equal(report.uploadInputRecovery.reason, 'DOM_CHANGED');
  assert.equal(report.uploadInputRecovery.inputCandidates.totalCandidates, 0);
});

test('a disabled Add control is never clicked', async () => {
  const h = harness({ lazy: false, plusDisabled: true });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'DOM_CHANGED');
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.dispatches, 0);
});

test('real quota and cancellation during input preparation keep their distinct causes and dispatch nothing', async () => {
  for (const [options, predicate, reason] of [
    [{ quotaAt: 1500 }, (error) => error.code === 'UPLOAD_LIMIT', 'UPLOAD_LIMIT'],
    [{ abortAt: 1500 }, (error) => error.name === 'AbortError', 'AbortError']
  ]) {
    const h = harness(options);
    await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false, signal: h.signal }), predicate);
    assert.equal(h.page.clicks, 0);
    assert.equal(h.page.dispatches, 0);
    assert.equal(h.adapter.dryRunReport().uploadInputRecovery.reason, reason);
  }
});

test('quota or stop after the Add menu opened cannot turn into a missing-input retry', async () => {
  for (const [options, predicate] of [
    [{ quotaAt: 4500 }, (error) => error.code === 'UPLOAD_LIMIT'],
    [{ abortAt: 4500 }, (error) => error.name === 'AbortError']
  ]) {
    const h = harness({ lazy: false, ...options });
    await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false, signal: h.signal }), predicate);
    assert.equal(h.page.clicks, 1);
    assert.equal(h.page.dispatches, 0);
  }
});

test('an input mounted while highlighting the Add button avoids an unnecessary menu click', async () => {
  const h = harness({ remountDuringHighlight: true });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: true })).count, 2);
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.dispatches, 1);
});

test('failure to close a menu after selection does not fail or duplicate the upload', async () => {
  const h = harness({ closeThrows: true });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  assert.equal(h.page.dispatches, 1);
  assert.equal(h.adapter.dryRunReport().uploadInputRecovery.type, 'upload-input-menu-close-failed');
});

test('a composer remounted during decoding or highlighting receives files exactly once on its current input', async () => {
  for (const options of [{ remountDuringFetch: true }, { remountDuringHighlight: true }]) {
    for (const selected of [files.slice(0, 1), files]) {
      const h = harness({ present: true, ...options });
      assert.equal((await h.adapter.uploadFiles({ files: selected, debugOverlay: true })).count, selected.length);
      assert.equal(h.page.dispatches, 1);
      assert.equal(h.page.observedInputs[0], h.input);
      assert.equal(h.input.isConnected, true);
    }
  }
});

test('lazy single-file controls preserve the sequential fallback without toggling the menu for each file', async () => {
  const h = harness({ single: true });
  const result = await h.adapter.uploadFiles({ files, debugOverlay: false });
  assert.equal(result.mode, 'sequential');
  assert.equal(result.count, 2);
  assert.equal(h.page.dispatches, 2);
  assert.equal(h.page.clicks, 2);
});

test('upload recovery refuses to open the menu in Work mode', async () => {
  const h = harness({ workMode: true });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'CHAT_MODE_REQUIRED');
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.dispatches, 0);
});

