import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  AUTOMATION_ERROR_CLASSES, classifyAutomationError,
  isUploadLimitText, isStorageLimitText, isImageLimitText,
  uploadLimitResumeAt, imageLimitResumeAt, imageLimitFallbackResumeAt,
  findStalledBatchRecoveryCandidate
} from '../extension/reliability-utils.js';

const quotaSource = await readFile(new URL('../extension/quota-utils.js', import.meta.url), 'utf8');
const resolverSource = await readFile(new URL('../extension/selector-resolver.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../extension/chatgpt-adapter.js', import.meta.url), 'utf8');
const now = new Date(2026, 9, 5, 19, 42).getTime();

test('upload quota parses explicit clock, relative hours/minutes and a conservative missing-time recheck', () => {
  assert.equal(uploadLimitResumeAt("You've reached your file upload limit. Try again at 9:20 PM.", now), new Date(2026, 9, 5, 21, 21).getTime());
  assert.equal(uploadLimitResumeAt('File upload limit reached. Try again in 2 hours and 30 minutes.', now), now + 151 * 60000);
  assert.equal(uploadLimitResumeAt('Достигнут лимит загрузки файлов. Попробуйте снова через 3 часа.', now), now + 181 * 60000);
  assert.equal(uploadLimitResumeAt('Лимит загрузки файлов. Повторите попытку через 20 минут.', now), now + 21 * 60000);
  assert.equal(uploadLimitResumeAt('Лимит загрузки файлов. Попробуйте через 2 ч 30 мин.', now), now + 151 * 60000);
  assert.equal(uploadLimitResumeAt('File upload limit reached.', now), now + 181 * 60000);
  assert.equal(uploadLimitResumeAt('Failed to upload this image.', now), null);
  assert.equal(uploadLimitResumeAt('Too many requests.', now), null);
  assert.equal(classifyAutomationError('File upload limit reached.'), AUTOMATION_ERROR_CLASSES.UPLOAD_LIMIT);
});

test('storage quota requires attention rather than a timed upload retry', () => {
  for (const text of ['Your file upload storage limit has been reached.', 'Хранилище файлов переполнено.', 'Недостаточно места для загрузки файла.']) {
    assert.equal(isStorageLimitText(text), true);
    assert.equal(uploadLimitResumeAt(text, now), null);
    assert.equal(classifyAutomationError(text), AUTOMATION_ERROR_CLASSES.UPLOAD_LIMIT);
  }
});

test('image quota supports relative durations and preserves malformed-clock rejection', () => {
  assert.equal(imageLimitResumeAt('Image creation limit reached. Try again in 3 hours.', now), now + 181 * 60000);
  assert.equal(imageLimitResumeAt('Лимит генерации изображений. Попробуйте снова через 15 минут.', now), now + 16 * 60000);
  assert.equal(imageLimitResumeAt('Лимит создания изображений. Попробуйте снова в 25:90.', now), null);
  assert.equal(imageLimitResumeAt('Image generation limit reached.', now), null);
  assert.equal(imageLimitFallbackResumeAt('Image generation limit reached.', now), now + 181 * 60000);
  assert.equal(imageLimitFallbackResumeAt('Too many requests.', now), null);
  assert.equal(isImageLimitText('File upload limit reached.'), false);
  assert.equal(isUploadLimitText('Image creation limit reached.'), false);
});

function detectorHarness(entries = []) {
  class Element {
    constructor({ text = '', hidden = false, prose = false, editable = false, overlay = false, containsTurn = false } = {}) {
      this.innerText = this.textContent = text;
      Object.assign(this, { hidden, prose, editable, overlay, containsTurn, isConnected: true });
    }
    getBoundingClientRect() { return { width: 100, height: 30 }; }
    getAttribute() { return null; }
    querySelector(selector) { return selector.includes('[data-turn]') && this.containsTurn ? {} : null; }
    querySelectorAll() { return []; }
    closest(selector) {
      if (selector.includes('[data-turn]') && this.prose) return this;
      if (selector.includes('[contenteditable') && this.editable) return this;
      if (selector.includes('[data-watch-automation-overlay]') && this.overlay) return this;
      return null;
    }
  }
  const nodes = entries.map((entry) => new Element(entry));
  const composer = new Element();
  const document = {
    querySelector: (selector) => selector.startsWith('#prompt-textarea') ? composer : null,
    querySelectorAll: (selector) => selector.startsWith('[role="alert"]') || selector.startsWith('[role="dialog"]') || selector === 'div, section, main, aside, dialog' ? nodes : []
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  const context = vm.createContext({ window, document, Element, Date,
    getComputedStyle: (node) => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }) });
  vm.runInContext(quotaSource, context);
  vm.runInContext(resolverSource, context);
  return window.WatchSelectorResolver;
}

test('upload detector sees UI toast quotas and rejects conversation/prompt/hidden/debugging false positives', () => {
  const quota = 'File upload limit reached. Try again in 3 hours.';
  for (const excluded of [{ prose: true }, { editable: true }, { hidden: true }, { overlay: true }, { containsTurn: true }]) {
    assert.equal(detectorHarness([{ text: quota, ...excluded }]).uploadError(), null);
  }
  const resolver = detectorHarness([{ text: 'Model documentation mentions an upload limit.', prose: true }, { text: quota }]);
  assert.equal(resolver.uploadError().text, quota);
  assert.equal(resolver.uploadError().uploadLimit, true);
  assert.ok(resolver.uploadLimitDialog());
});

test('upload detector identifies ordinary refusal and storage-full without confusing an image quota', () => {
  assert.equal(detectorHarness([{ text: 'Failed to upload image: unsupported file type.' }]).uploadError().uploadLimit, false);
  assert.equal(detectorHarness([{ text: 'Your storage limit has been reached.' }]).uploadError().storageLimit, true);
  assert.equal(detectorHarness([{ text: 'Image creation limit reached. Try again in 2 hours.' }]).uploadError(), null);
});

test('real rate-limit resolver and worker classification share every supported image quota spelling', () => {
  for (const text of [
    'Image creation limit reached. Try again in 3 hours.',
    'Image generation limit reached. Try again at 9:20 PM.',
    'You reached the limit for creating images. Try again in 15 minutes.',
    'Достигнут лимит создания изображений. Попробуйте снова через 2 часа.',
    'Достигнут лимит запросов на генерацию изображений. Попробуйте снова в 21:20.'
  ]) {
    assert.equal(detectorHarness([{ text }]).rateLimitDialog().innerText, text);
    assert.equal(classifyAutomationError(text), AUTOMATION_ERROR_CLASSES.RATE_LIMIT);
    assert.ok(isImageLimitText(text));
    assert.ok(imageLimitResumeAt(text, now));
    assert.equal(detectorHarness([{ text, prose: true }]).rateLimitDialog(), null);
    assert.equal(detectorHarness([{ text, editable: true }]).rateLimitDialog(), null);
  }
  assert.ok(detectorHarness([{ text: 'Too many requests. Please try again later.' }]).rateLimitDialog());
  assert.equal(classifyAutomationError('Too many requests.'), AUTOMATION_ERROR_CLASSES.RATE_LIMIT);
});

function inputResolverHarness(inputs = [], composers = []) {
  class Element {
    constructor({ name, disabled = false, disconnected = false, hidden = false, surface = null,
      strategies = [0], kind = 'input' } = {}) {
      Object.assign(this, { name, disabled, isConnected: !disconnected, hidden, surface, strategies, kind });
    }
    getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 30 }; }
    getAttribute() { return null; }
    closest() { return this.surface; }
    matches(selector) { return selector === ':disabled' && this.disabled; }
  }
  const inputNodes = inputs.map((options) => new Element(options));
  const composerNodes = composers.map((options) => new Element({ ...options, kind: 'composer' }));
  const fileSelectors = [
    'input[data-testid="upload-photos-input"][type="file"]', 'input#upload-photos[type="file"]',
    'input#upload-files[data-photo-upload-enabled="true"][type="file"]', 'input[type="file"][accept^="image/"]'
  ];
  const document = {
    querySelectorAll(selector) {
      if (selector.startsWith('#prompt-textarea')) return composerNodes;
      const index = fileSelectors.indexOf(selector);
      return index >= 0 ? inputNodes.filter((input) => input.strategies.includes(index)) : [];
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  const context = vm.createContext({ window, document, Element,
    getComputedStyle: (node) => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }) });
  vm.runInContext(resolverSource, context);
  return { resolver: window.WatchSelectorResolver, inputNodes, composerNodes };
}

test('real file-input resolver skips disabled and disconnected candidates before choosing an enabled control', () => {
  const h = inputResolverHarness([
    { name: 'disabled', disabled: true }, { name: 'detached', disconnected: true }, { name: 'active' }
  ]);
  assert.equal(h.resolver.resolve('fileInput', { visibleOnly: false }).element.name, 'active');
});

test('real file-input resolver prioritizes the visible composer across competing surfaces and selector ranks', () => {
  const oldSurface = { contains: (node) => node.surface === oldSurface };
  const activeSurface = { contains: (node) => node.surface === activeSurface };
  const h = inputResolverHarness([
    { name: 'old-surface', surface: oldSurface, strategies: [0] },
    { name: 'active-surface', surface: activeSurface, strategies: [3], hidden: true }
  ], [
    { name: 'old-composer', surface: oldSurface, hidden: true },
    { name: 'active-composer', surface: activeSurface }
  ]);
  assert.equal(h.resolver.resolve('fileInput', { visibleOnly: false }).element.name, 'active-surface');
});

test('real file-input resolver retains hidden enabled portal controls and original selector fallback priority', () => {
  const h = inputResolverHarness([
    { name: 'lower-rank', hidden: true, strategies: [3] },
    { name: 'original-rank', hidden: true, strategies: [0] }
  ]);
  assert.equal(h.resolver.resolve('fileInput').element.name, 'original-rank');
});

test('real file-input resolver reports no control when every candidate is unavailable', () => {
  const h = inputResolverHarness([{ name: 'disabled', disabled: true }, { name: 'detached', disconnected: true }]);
  assert.equal(h.resolver.resolve('fileInput', { visibleOnly: false }).element, null);
  assert.equal(inputResolverHarness().resolver.resolve('fileInput').element, null);
});

// Run the actual adapter, including its real waitForDomCondition and predicate
// rejection handling. The fake file input changes only the observed page UI.
function uploadHarness({ quotaAfter = Infinity, refusal = null, singleInput = false, silentlyDrop = false,
  remountOnInput = false, remountOnChange = false, inputOnly = false } = {}) {
  const page = { count: 0, dispatches: 0, batches: 0, issue: null, events: [] };
  let virtualNow = Date.now();
  class VirtualDate extends Date { static now() { return virtualNow; } }
  const input = {
    multiple: !singleInput, isConnected: true, files: [],
    dispatchEvent(event) {
      page.events.push({ type: event.type, connected: this.isConnected });
      if (event.type === 'input' && remountOnInput) {
        this.isConnected = false;
        currentInput = { multiple: !singleInput, isConnected: true, files: [] };
        return;
      }
      if (event.type !== (inputOnly ? 'input' : 'change') || !this.isConnected) return;
      page.dispatches += 1;
      page.batches += 1;
      if (refusal) page.issue = refusal;
      else if (page.batches > quotaAfter) page.issue = { text: 'File upload limit reached. Try again in 3 hours.', uploadLimit: true, storageLimit: false };
      else if (!silentlyDrop) page.count += this.files.length;
      if (remountOnChange) {
        this.isConnected = false;
        currentInput = { multiple: !singleInput, isConnected: true, files: [] };
      }
    }
  };
  let currentInput = input;
  const resolver = {
    resolve: () => ({ element: currentInput, selector: '#upload' }),
    uploadError: () => page.issue,
    attachmentTiles: () => Array(page.count).fill({}),
    assistantTurns: () => []
  };
  class DataTransfer {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  }
  const window = { __WATCH_AUTOMATION_ENABLED__: true, WatchSelectorResolver: resolver };
  const context = vm.createContext({ window, document: { documentElement: {} },
    Date: silentlyDrop ? VirtualDate : Date, Blob, File, Event, DataTransfer, DOMException,
    fetch: async () => ({ blob: async () => new Blob(['fake-image'], { type: 'image/png' }) }),
    MutationObserver: class { observe() {} },
    queueMicrotask,
    setInterval: silentlyDrop ? ((callback) => setTimeout(() => { virtualNow += 90001; callback(); }, 0)) : setInterval,
    clearInterval: silentlyDrop ? clearTimeout : clearInterval,
    setTimeout, clearTimeout
  });
  vm.runInContext(quotaSource, context);
  vm.runInContext(adapterSource, context);
  return { adapter: window.WatchChatGPTAdapter, page };
}

const files = [
  { name: 'reference.png', dataUrl: 'data:image/png;base64,AA==' },
  { name: 'watch.png', dataUrl: 'data:image/png;base64,AA==' }
];

test('actual batch upload succeeds 43 times then immediately returns upload quota on the next batch', async () => {
  const h = uploadHarness({ quotaAfter: 43 });
  for (let completed = 0; completed < 43; completed += 1) {
    h.page.count = 0;
    assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  }
  h.page.count = 0;
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => {
    assert.equal(error.code, 'UPLOAD_LIMIT');
    assert.equal(error.autoResume, true);
    assert.equal(error.message, 'File upload limit reached. Try again in 3 hours.');
    assert.ok(error.resumeAtMs > Date.now() + 3 * 60 * 60 * 1000);
    return true;
  });
  assert.equal(h.page.batches, 44);
});

test('actual single/sequential uploads propagate quota, refusal and network errors immediately', async () => {
  for (const singleInput of [false, true]) {
    for (const [issue, code] of [
      [{ text: 'File upload limit reached.', uploadLimit: true }, 'UPLOAD_LIMIT'],
      [{ text: 'Failed to upload unsupported image.', uploadLimit: false }, 'UPLOAD_REJECTED'],
      [{ text: 'Failed to upload: network connection lost.', uploadLimit: false }, 'NETWORK']
    ]) {
      const h = uploadHarness({ refusal: issue, singleInput });
      await assert.rejects(h.adapter.uploadFiles({ files: singleInput ? files : files.slice(0, 1), debugOverlay: false }), (error) => error.code === code);
      assert.equal(h.page.dispatches, 1);
    }
  }
});

test('actual storage quota has no automatic deadline and aborted uploads do not dispatch', async () => {
  const h = uploadHarness({ refusal: { text: 'File upload storage limit reached.', uploadLimit: true, storageLimit: true } });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => {
    assert.equal(error.code, 'UPLOAD_LIMIT');
    assert.equal(error.autoResume, false);
    assert.equal(error.resumeAtMs, null);
    return true;
  });
  const stopped = uploadHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(stopped.adapter.uploadFiles({ files, debugOverlay: false, signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(stopped.page.dispatches, 0);
});

test('an actual silently dropped upload remains TIMEOUT without inventing a quota notification', async () => {
  const h = uploadHarness({ silentlyDrop: true });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => {
    assert.equal(error.message, 'Timeout waiting for attachment batch 2 (90000ms)');
    assert.equal(error.code, undefined);
    assert.equal(classifyAutomationError(error), AUTOMATION_ERROR_CLASSES.TIMEOUT);
    assert.equal(error.resumeAtMs, undefined);
    return true;
  });
  assert.equal(h.page.issue, null);
  assert.equal(h.page.dispatches, 1);
});

test('diagnostics retain the failed upload counts with the DOM recorder disabled and after the page changes', async () => {
  const h = uploadHarness({ silentlyDrop: true });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }));
  h.page.count = 1;
  const report = h.adapter.dryRunReport();
  assert.equal(report.attachmentCount, 1, 'current page state can differ from the failure');
  assert.equal(report.lastUpload.expectedCount, 2);
  assert.equal(report.lastUpload.actualCount, 0, 'the original failure retains its observed count');
  assert.equal(report.lastUpload.inputConnected, true);
  assert.equal(report.lastUpload.selector, '#upload');
  assert.equal(report.lastUpload.type, 'upload-dispatch-failed');
  assert.equal(report.lastUpload.error, 'Timeout waiting for attachment batch 2 (90000ms)');
  assert.doesNotMatch(JSON.stringify(report.lastUpload), /data:image|reference\.png|watch\.png|base64/);
});

test('change receives files before an input handler can remount the composer', async () => {
  for (const batch of [false, true]) {
    const h = uploadHarness({ remountOnInput: true });
    const selected = batch ? files : files.slice(0, 1);
    assert.equal((await h.adapter.uploadFiles({ files: selected, debugOverlay: false })).count, selected.length);
    assert.deepEqual(h.page.events.map((event) => event.type), ['change', 'input']);
    assert.equal(h.page.dispatches, 1, 'the selected files are submitted exactly once');
    assert.ok(h.page.events.every((event) => event.connected));
  }
});

test('change remount skips the obsolete input event without uploading files a second time', async () => {
  const h = uploadHarness({ remountOnChange: true });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  assert.deepEqual(h.page.events.map((event) => event.type), ['change']);
  assert.equal(h.page.dispatches, 1);
});

test('a stable input-only upload handler retains compatibility', async () => {
  const h = uploadHarness({ inputOnly: true });
  assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
  assert.deepEqual(h.page.events.map((event) => event.type), ['change', 'input']);
  assert.equal(h.page.dispatches, 1);
});

test('a stalled-batch watchdog does not compete with upload quota or upload cooldown recovery', () => {
  const since = new Date(now - 20 * 60000).toISOString();
  const run = { state: 'RUNNING', slots: {
    0: { slotId: 0, entryId: 'watch-a', tabId: 1, generationSubmittedAt: since, status: 'OBSERVING', noResponseSince: since },
    1: { slotId: 1, entryId: 'watch-b', tabId: 2, generationSubmittedAt: since, status: 'OBSERVING', lastCheckState: 'ERROR' }
  } };
  assert.ok(findStalledBatchRecoveryCandidate(run, now));
  for (const field of ['uploadCooldownActive', 'uploadLimitDetected', 'uploadManualPause']) {
    assert.equal(findStalledBatchRecoveryCandidate({ ...run, [field]: true }, now), null);
  }
});

