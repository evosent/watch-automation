import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const adapter = await readFile(new URL('../extension/chatgpt-adapter.js', import.meta.url), 'utf8');

function declaration(name) {
  const start = adapter.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing adapter function ${name}`);
  const tail = adapter.slice(start);
  const closing = /^  \}/m.exec(tail);
  assert.ok(closing, `Missing end of ${name}`);
  return tail.slice(0, closing.index + closing[0].length);
}

function harness({ mode = 'work', labels = ['Чат', 'Работа'], attribute = 'aria-selected',
  absent = false, ambiguous = false, clickChangesMode = true, pathname = '/', turns = false,
  text = '', attachments = 0, newChatMode = 'chat', highlightSwitchesToWork = false,
  highlightSwitchesToChat = false, highlightAddsPrompt = false } = {}) {
  const clicks = [];
  const body = {};
  const location = { pathname };
  const composer = { textContent: text, value: '' };
  const page = { turns, attachments };
  let pair = [];
  let extra = [];
  const setMode = (value) => {
    for (const current of [pair, extra]) current.forEach((node, index) => {
      node.attrs[attribute] = String(value === (index === 0 ? 'chat' : 'work'));
    });
  };
  const makePair = () => {
    const group = { parentElement: body, querySelectorAll: () => [...pair, ...extra] };
    return labels.map((label, index) => ({
      textContent: label,
      tagName: 'BUTTON',
      parentElement: group,
      attrs: {},
      getAttribute(name) { return this.attrs[name] ?? null; },
      click() { clicks.push(index === 0 ? 'chat' : 'work'); if (clickChangesMode) setMode(index === 0 ? 'chat' : 'work'); }
    }));
  };
  pair = makePair();
  if (ambiguous) extra = makePair();
  setMode(mode);
  const send = {
    tagName: 'BUTTON',
    disabled: false,
    getAttribute: () => null,
    click: () => clicks.push('send')
  };
  const newChat = { tagName: 'BUTTON', attrs: {}, getAttribute: () => null, click() {
    clicks.push('new-chat');
    location.pathname = '/';
    page.turns = false;
    composer.textContent = '';
    composer.value = '';
    page.attachments = 0;
    setMode(newChatMode);
  } };
  const resolver = {
    visible: () => true,
    resolve: (name) => ({ element: name === 'composer' ? composer : name === 'newChat' ? newChat : null, selector: name }),
    attachmentTiles: () => Array(page.attachments).fill({}),
    assistantTurns: () => [], userTurns: () => [],
    stopGeneratingButton: () => null,
    composerSendButton: () => ({ element: send }),
    composerSurface: () => null
  };
  const context = vm.createContext({
    Date, location, RegExp,
    document: {
      body,
      querySelectorAll: () => absent ? [] : [...pair, ...extra],
      querySelector: (selector) => selector === '[data-turn]' && page.turns ? {} : null
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 20)' }),
    R: () => resolver,
    O: () => ({ highlightTarget: async () => {
      if (highlightSwitchesToWork) setMode('work');
      if (highlightSwitchesToChat) setMode('chat');
      if (highlightAddsPrompt) composer.textContent = 'new prepared prompt';
    } }),
    recordAdapterAction() {},
    waitForDomCondition: async ({ predicate, name, signal }) => {
      if (signal?.aborted) throw new Error('Aborted');
      const value = predicate();
      if (!value) throw new Error(`Timeout waiting for ${name}`);
      return value;
    },
    waitForComposerReadyForSend: async () => send,
    documentElement: {},
    URL
  });
  vm.runInContext(`let chatModePreparation = null;\n${[
    'safeClick', 'chatModeState', 'assertChatMode', 'ensureChatMode', 'ensureNewChat', 'clickSendPrompt'
  ].map(declaration).join('\n')}`, context);
  return { context, clicks, setMode, location, composer, page };
}

test('fresh managed landing page switches Work to Chat before preparing', async () => {
  const h = harness({ mode: 'work' });
  const ready = await h.context.ensureNewChat({ debugOverlay: false });
  assert.equal(ready.alreadyNew, true);
  assert.equal(h.context.chatModeState().mode, 'chat');
  assert.deepEqual(h.clicks, ['chat']);
});

test('a mode switch that occurs during UI highlighting is respected without toggling back', async () => {
  const h = harness({ mode: 'work', highlightSwitchesToChat: true });
  await h.context.ensureNewChat({ debugOverlay: true });
  assert.equal(h.context.chatModeState().mode, 'chat');
  assert.deepEqual(h.clicks, []);
});

test('a draft appearing during UI highlighting prevents a mode switch and preserves the draft', async () => {
  const h = harness({ mode: 'work', highlightAddsPrompt: true });
  await assert.rejects(h.context.ensureNewChat({ debugOverlay: true }), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.composer.textContent, 'new prepared prompt');
});

test('known Chat and legacy classic layouts permit new chat and physical Send', async () => {
  const chat = harness({ mode: 'chat' });
  await chat.context.ensureNewChat({ debugOverlay: false });
  await chat.context.clickSendPrompt({ debugOverlay: false });
  assert.deepEqual(chat.clicks, ['send']);
  const classic = harness({ absent: true });
  await classic.context.ensureNewChat({ debugOverlay: false });
  await classic.context.clickSendPrompt({ debugOverlay: false });
  assert.deepEqual(classic.clicks, ['send']);
});

test('Work mode blocks new-chat navigation in an existing prepared conversation', async () => {
  const h = harness({ pathname: '/c/saved', turns: true, text: 'Prepared prompt', attachments: 2, mode: 'work' });
  await assert.rejects(h.context.ensureNewChat({ debugOverlay: false }), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.location.pathname, '/c/saved');
  assert.equal(h.composer.textContent, 'Prepared prompt');
  assert.equal(h.page.attachments, 2);
});

test('an ambiguous or unknown mode fails closed before any Send click', async () => {
  for (const options of [{ mode: 'unknown' }, { ambiguous: true }]) {
    const h = harness(options);
    await assert.rejects(h.context.clickSendPrompt({ debugOverlay: false }), { code: 'CHAT_MODE_REQUIRED' });
    assert.deepEqual(h.clicks, []);
  }
});

test('mode is rechecked after async overlay work immediately before physical Send', async () => {
  const h = harness({ mode: 'chat', highlightSwitchesToWork: true });
  await assert.rejects(h.context.clickSendPrompt({ debugOverlay: true }), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
});

test('mode is rechecked after async overlay work immediately before new-chat navigation', async () => {
  const h = harness({ mode: 'chat', pathname: '/c/saved', turns: true, highlightSwitchesToWork: true });
  await assert.rejects(h.context.ensureNewChat({ debugOverlay: true }), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.location.pathname, '/c/saved');
});
