import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { classifyAutomationError } from '../extension/reliability-utils.js';

const quotaSource = await readFile(new URL('../extension/quota-utils.js', import.meta.url), 'utf8');
const resolverSource = await readFile(new URL('../extension/selector-resolver.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../extension/chatgpt-adapter.js', import.meta.url), 'utf8');
const historyRu = 'Не удалось загрузить историю';
const historyEn = 'Unable to load history';

// A small tree-backed DOM, with real selector matching for the selectors used
// by the production resolver. No browser or account state is involved.
function page({ text = historyRu, withComposer = true, bannerPlace = 'sidebar', hidden = false,
  refusalAfterDispatch = null, hasAssistant = false, onDispatch = null } = {}) {
  class Element {
    constructor(tag = 'div', attributes = {}, ownText = '') {
      this.tagName = tag.toUpperCase(); this.attributes = attributes; this.ownText = ownText;
      this.children = []; this.parentElement = null; this.isConnected = true; this.hidden = false;
    }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
    get innerText() { return [this.ownText, ...this.children.map((child) => child.innerText)].filter(Boolean).join(' '); }
    get textContent() { return this.innerText; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden) return { width: 0, height: 0 };
      }
      return { width: 100, height: 60 };
    }
    matches(selectors) {
      return selectors.split(',').some((raw) => {
        const selector = raw.trim();
        if (selector === ':disabled') return this.disabled === true;
        const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const id = /#([\w-]+)/.exec(selector)?.[1];
        if (id && this.getAttribute('id') !== id) return false;
        for (const match of selector.matchAll(/\[([\w-]+)([*^$]?=)?(?:"([^"]*)")?(\s+i)?\]/g)) {
          const actual = this.getAttribute(match[1]);
          if (actual == null) return false;
          if (!match[2]) continue;
          const value = match[4] ? String(actual).toLowerCase() : String(actual);
          const expected = match[4] ? match[3].toLowerCase() : match[3];
          if (match[2] === '=' && value !== expected) return false;
          if (match[2] === '*=' && !value.includes(expected)) return false;
          if (match[2] === '^=' && !value.startsWith(expected)) return false;
          if (match[2] === '$=' && !value.endsWith(expected)) return false;
        }
        return Boolean(tag || id || selector.startsWith('['));
      });
    }
    descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
    contains(node) { return node === this || this.descendants().includes(node); }
    querySelectorAll(selector) { return this.descendants().filter((node) => node.isConnected && node.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    click() {}
    dispatchEvent(event) {
      if (this.tagName !== 'INPUT' || event.type !== 'change') return true;
      calls.dispatches++;
      if (onDispatch?.({ composer, form, banner }) === false) return true;
      if (refusalAfterDispatch) banner.ownText = refusalAfterDispatch;
      else for (const file of this.files) {
        const preview = new Element('img', { alt: file.name });
        preview.src = 'data:image/png;base64,AA=='; preview.naturalWidth = preview.naturalHeight = 100;
        form.append(preview);
      }
      return true;
    }
  }
  const calls = { dispatches: 0 };
  const html = new Element('html'), body = new Element('body'), sidebar = new Element('aside'), main = new Element('main');
  html.append(body); body.append(sidebar, main);
  const form = new Element('form', { 'data-composer-surface': 'true' }); main.append(form);
  const composer = new Element('div', { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' });
  const input = new Element('input', { type: 'file', 'data-testid': 'upload-photos-input' }); input.multiple = true;
  if (withComposer) form.append(composer);
  form.append(input);
  const banner = new Element('div', { role: 'alert', 'data-testid': 'history-error' }, text);
  banner.hidden = hidden;
  const retry = new Element('button', {}, 'Повторить'); banner.append(retry);
  if (bannerPlace === 'sidebar') sidebar.append(banner);
  else if (bannerPlace === 'composer') form.append(banner);
  else if (bannerPlace === 'prompt') composer.append(banner);
  else if (bannerPlace === 'assistant') main.append(new Element('article', { 'data-turn': 'assistant' }).append(banner));
  else main.append(banner);
  if (hasAssistant && bannerPlace !== 'assistant') main.append(new Element('article', { 'data-turn': 'assistant' }, 'Fake answer'));
  const document = {
    body, documentElement: html,
    querySelectorAll: (selector) => [html, ...html.descendants()].filter((node) => node.isConnected && node.matches(selector)),
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  class DataTransfer { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } }
  const context = vm.createContext({ window, document, Element, Date, Blob, File, Event, DataTransfer, DOMException, URL,
    location: { pathname: '/', href: 'https://chatgpt.com/' },
    getComputedStyle: (node) => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
    fetch: async () => ({ blob: async () => new Blob(['fake-image'], { type: 'image/png' }) }),
    MutationObserver: class { observe() {} }, queueMicrotask, setInterval, clearInterval, setTimeout, clearTimeout
  });
  vm.runInContext(quotaSource, context);
  vm.runInContext(resolverSource, context);
  vm.runInContext(adapterSource, context);
  return { resolver: window.WatchSelectorResolver, adapter: window.WatchChatGPTAdapter, calls, banner, composer, form, sidebar };
}

const files = [
  { name: 'fake-reference.png', dataUrl: 'data:image/png;base64,AA==' },
  { name: 'fake-product.png', dataUrl: 'data:image/png;base64,AA==' }
];

test('history loading, saved conversation loading and file refusal have distinct classifications', () => {
  for (const text of [historyRu, historyEn, 'Failed to load chat history']) {
    assert.equal(classifyAutomationError(text), 'HISTORY_LOAD_ERROR');
  }
  assert.equal(classifyAutomationError('Не удалось загрузить этот разговор ChatGPT'), 'CONVERSATION_LOAD_ERROR');
  assert.equal(classifyAutomationError('UPLOAD_REJECTED: Не удалось загрузить файл'), 'UPLOAD_REJECTED');
});

for (const text of [historyRu, historyEn]) {
  test(`real resolver distinguishes a sidebar history warning from an upload error (${text})`, () => {
    const h = page({ text });
    assert.equal(typeof h.resolver.visibleHistoryLoadError, 'function');
    assert.ok(h.resolver.visibleHistoryLoadError());
    assert.equal(h.resolver.visibleConversationLoadError(), null);
    assert.equal(h.resolver.uploadError(), null);
    assert.equal(h.resolver.visibleErrors().length, 0);
  });

  test(`actual upload completes with a functional composer despite sidebar history warning (${text})`, async () => {
    const h = page({ text });
    assert.equal((await h.adapter.uploadFiles({ files, debugOverlay: false })).count, 2);
    assert.equal(h.calls.dispatches, 1);
  });

  test(`actual preparation rejects a blocking history failure immediately (${text})`, () => {
    const h = page({ text, withComposer: false, bannerPlace: 'main' });
    assert.equal(typeof h.adapter.assertPreparationPageReady, 'function');
    assert.throws(() => h.adapter.assertPreparationPageReady(), (error) => {
      assert.equal(error.code, 'HISTORY_LOAD_ERROR');
      assert.match(error.message, /history|историю/i);
      return true;
    });
    assert.equal(h.calls.dispatches, 0);
  });
}

test('an ordinary upload refusal still rejects the actual batch immediately', async () => {
  const h = page({ text: '', bannerPlace: 'composer', refusalAfterDispatch: 'Не удалось загрузить файл: неподдерживаемый формат' });
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'UPLOAD_REJECTED');
  assert.equal(h.calls.dispatches, 1);
});

test('a specific saved conversation loading failure remains detectable', () => {
  const h = page({ text: 'Не удалось загрузить этот разговор ChatGPT', withComposer: false, bannerPlace: 'main' });
  assert.ok(h.resolver.visibleConversationLoadError());
  assert.equal(h.resolver.visibleHistoryLoadError?.(), null);
});

test('quoted history errors in assistant prose or prompts and hidden warnings are not UI history failures', () => {
  for (const options of [{ bannerPlace: 'assistant' }, { bannerPlace: 'prompt' }, { hidden: true }]) {
    const h = page(options);
    assert.equal(typeof h.resolver.visibleHistoryLoadError, 'function');
    assert.equal(h.resolver.visibleHistoryLoadError(), null);
    assert.equal(h.resolver.uploadError(), null);
  }
});

test('a history warning under a hidden sidebar ancestor is not a visible UI failure', () => {
  const h = page({ withComposer: false });
  h.sidebar.hidden = true;
  assert.equal(h.resolver.visibleHistoryLoadError(), null);
  assert.equal(h.resolver.uploadError(), null);
  assert.doesNotThrow(() => h.adapter.assertPreparationPageReady());
});

for (const state of ['disabled', 'aria-disabled', 'hidden', 'disconnected', 'hidden-form']) {
  test(`history failure with a ${state} composer stops the actual preparation wait after bounded grace`, async () => {
    const h = page();
    if (state === 'disabled') h.composer.disabled = true;
    if (state === 'aria-disabled') h.composer.attributes['aria-disabled'] = 'true';
    if (state === 'hidden') h.composer.hidden = true;
    if (state === 'disconnected') h.composer.isConnected = false;
    if (state === 'hidden-form') h.form.hidden = true;
    let predicates = 0;
    const started = Date.now();
    await assert.rejects(h.adapter.waitForDomCondition({
      name: 'test preparation condition', timeout: 90000, preparationPage: true,
      predicate: () => { predicates++; return null; }
    }), (error) => error.code === 'HISTORY_LOAD_ERROR');
    assert.equal(predicates, 0);
    assert.ok(Date.now() - started < 5000, 'the history grace should end before the long condition timeout');
  });
}

test('a history failure appearing after upload dispatch escapes the actual attachment wait after bounded grace', async () => {
  const h = page({ text: '', onDispatch: ({ banner, composer }) => {
    banner.ownText = historyRu;
    composer.disabled = true;
    return false;
  } });
  const started = Date.now();
  await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'HISTORY_LOAD_ERROR');
  assert.equal(h.calls.dispatches, 1);
  assert.ok(Date.now() - started < 5000, 'attachment wait should reject before its 90-second deadline');
});

for (const [quotaText, storageLimit] of [
  ['You have reached your file uploads limit. Try again in 3 hours.', false],
  ['Storage quota exceeded. File uploads are unavailable.', true]
]) {
  for (const workingComposer of [true, false]) {
    test(`explicit ${storageLimit ? 'storage' : 'upload'} quota is preserved alongside history failure with ${workingComposer ? 'working' : 'blocked'} composer`, async () => {
      const text = `${historyRu}. ${quotaText}`;
      const h = page({ text, withComposer: workingComposer });
      const issue = h.resolver.uploadError();
      assert.equal(issue?.uploadLimit, true);
      assert.equal(issue?.storageLimit, storageLimit);
      await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => {
        assert.equal(error.code, 'UPLOAD_LIMIT');
        assert.equal(error.autoResume, !storageLimit);
        assert.equal(error.storageLimit, storageLimit);
        if (storageLimit) assert.equal(error.resumeAtMs, null);
        else assert.ok(Number.isFinite(error.resumeAtMs));
        return true;
      });
      assert.equal(h.calls.dispatches, 0);
    });
  }
}

test('a mixed history and genuine generation error dialog is not hidden from actual inspection', () => {
  const h = page({ text: `${historyRu}. Image generation failed.`, hasAssistant: true });
  h.banner.attributes.role = 'dialog';
  assert.equal(h.resolver.visibleErrors().length, 1);
  const inspection = h.adapter.inspectGeneratedImage();
  assert.equal(inspection.state, 'ERROR');
  assert.match(inspection.responseText, /Image generation failed/);
});

for (const workingComposer of [true, false]) {
  test(`an actual file rejection alongside history failure remains an upload rejection with ${workingComposer ? 'working' : 'blocked'} composer`, async () => {
    const h = page({ text: `${historyRu}. Не удалось загрузить файл: неподдерживаемый формат.`, withComposer: workingComposer });
    assert.equal(h.resolver.uploadError()?.uploadLimit, false);
    await assert.rejects(h.adapter.uploadFiles({ files, debugOverlay: false }), (error) => error.code === 'UPLOAD_REJECTED');
    assert.equal(h.calls.dispatches, 0);
  });
}

test('a sidebar history warning cannot erase an already accepted user turn while the composer is disabled', async () => {
  const h = page();
  const userTurn = new h.composer.constructor('article', { 'data-turn': 'user', 'data-message-id': 'fake-accepted-turn' }, 'Fake accepted prompt');
  h.form.parentElement.append(userTurn);
  h.composer.disabled = true;
  const accepted = await h.adapter.waitForPromptAcceptance({ baselineUserCount: 0, timeout: 90000 });
  assert.equal(accepted.acceptanceMode, 'user-turn');
  assert.equal(accepted.userTurns, 1);
});

test('a pure history warning with a retry instruction is not a generation error', () => {
  const h = page({ text: 'Не удалось загрузить историю чатов. Попробуйте ещё раз.' });
  assert.ok(h.resolver.visibleHistoryLoadError());
  assert.equal(h.resolver.uploadError(), null);
  assert.equal(h.resolver.visibleErrors().length, 0);
});

test('a sidebar history warning tolerates a composer remount during actual new-chat preparation', async () => {
  const h = page();
  h.composer.isConnected = false;
  queueMicrotask(() => { h.composer.isConnected = true; });
  const prepared = await h.adapter.ensureNewChat({ debugOverlay: false });
  assert.equal(prepared.alreadyNew, true);
  assert.equal(h.calls.dispatches, 0);
});

test('the actual bootstrap composer-readiness wait opts into bounded history recovery', async () => {
  const h = page({ withComposer: false });
  const started = Date.now();
  await assert.rejects(h.adapter.waitForComposerReadyForInput({
    timeout: 8000, preparationPage: true
  }), (error) => error.code === 'HISTORY_LOAD_ERROR');
  assert.ok(Date.now() - started < 5000, 'bootstrap should reject before its initial 8-second timeout');
});

for (const storageLimit of [true, false]) {
  test(`explicit ${storageLimit ? 'storage' : 'upload'} quota takes priority without grace in the actual preparation wait`, async () => {
    const text = `${historyRu}. ${storageLimit ? 'Storage quota exceeded.' : 'File uploads limit reached. Try again in 3 hours.'}`;
    const h = page({ text, withComposer: false });
    let predicates = 0;
    const started = Date.now();
    await assert.rejects(h.adapter.waitForDomCondition({
      name: 'bootstrap quota check', timeout: 90000, preparationPage: true,
      predicate: () => { predicates++; return null; }
    }), (error) => {
      assert.equal(error.code, 'UPLOAD_LIMIT');
      assert.equal(error.autoResume, !storageLimit);
      if (storageLimit) assert.equal(error.resumeAtMs, null);
      else assert.ok(Number.isFinite(error.resumeAtMs));
      return true;
    });
    assert.equal(predicates, 0);
    assert.ok(Date.now() - started < 1000, 'explicit quota must not wait for the history grace');
  });
}

test('mixed Russian history and genuine generation failures do not become file-upload rejections', () => {
  for (const generationText of ['Не удалось создать изображение.', 'Ошибка генерации изображения.']) {
    const h = page({ text: `${historyRu}. ${generationText}`, hasAssistant: true });
    h.banner.attributes.role = 'dialog';
    assert.ok(h.resolver.visibleHistoryLoadError());
    assert.equal(h.resolver.uploadError(), null);
    assert.equal(h.resolver.visibleErrors().length, 1);
    const inspection = h.adapter.inspectGeneratedImage();
    assert.equal(inspection.state, 'ERROR');
    assert.ok(inspection.responseText.includes(generationText));
  }
});

