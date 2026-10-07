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
  assert.ok(closing, `Missing closing brace for ${name}`);
  return tail.slice(0, closing.index + closing[0].length);
}

// Exercise production mode detection and preparation using a tiny DOM surface.
// Waiting is synchronous here: a click must actually update the fake page state.
function harness({ mode = 'work', labels = ['Чат', 'Работа'], attribute = 'aria-selected',
  css = false, absent = false, ambiguous = false, clickChangesMode = true,
  pathname = '/', turns = false, text = '', attachments = 0, newChatMode = 'work' } = {}) {
  const clicks = [];
  const body = {};
  const location = { pathname };
  const composer = { textContent: text };
  const page = { turns, attachments };
  const makePair = () => {
    const group = { parentElement: body, querySelectorAll: () => pair };
    const pair = labels.map((label, index) => ({
      textContent: label,
      parentElement: group,
      attrs: {},
      backgroundColor: 'transparent',
      getAttribute(name) { return this.attrs[name] ?? null; },
      click() {
        clicks.push(index === 0 ? 'chat' : 'work');
        if (clickChangesMode) setMode(index === 0 ? 'chat' : 'work');
      }
    }));
    return pair;
  };
  const pair = makePair();
  const extra = ambiguous ? makePair() : [];
  function setMode(value) {
    for (const current of [pair, extra]) current.forEach((node, index) => {
      const active = value === (index === 0 ? 'chat' : 'work');
      if (!css) node.attrs[attribute] = String(active);
      node.backgroundColor = active ? 'rgb(26, 26, 26)' : 'rgba(0, 0, 0, 0)';
    });
  }
  setMode(mode);
  const send = { click: () => clicks.push('send') };
  const newChat = { click() {
    clicks.push('new-chat');
    location.pathname = '/';
    page.turns = false;
    composer.textContent = '';
    page.attachments = 0;
    setMode(newChatMode);
  } };
  const resolver = {
    visible: () => true,
    resolve: (name) => ({ element: name === 'composer' ? composer : name === 'newChat' ? newChat : null, selector: name }),
    attachmentTiles: () => Array(page.attachments).fill({}),
    assistantTurns: () => [], userTurns: () => []
  };
  const context = vm.createContext({
    Date, location,
    document: { body,
      querySelectorAll: () => absent ? [] : [...pair, ...extra],
      querySelector: (selector) => selector === '[data-turn]' && page.turns ? {} : null
    },
    getComputedStyle: (node) => ({ backgroundColor: node.backgroundColor }),
    R: () => resolver,
    safeClick: async (node, _label, _overlay, beforeClick) => {
      if (beforeClick?.() === false) return { clicked: false };
      node.click();
      return { clicked: true };
    },
    waitForDomCondition: async ({ predicate, name, signal }) => {
      if (signal?.aborted) throw new Error('Aborted');
      const value = predicate();
      if (!value) throw new Error(`Timeout waiting for ${name}`);
      return value;
    },
    waitForComposerReadyForSend: async () => send,
    recordAdapterAction() {}
  });
  vm.runInContext(`let chatModePreparation = null;\n${[
    'chatModeState', 'assertChatMode', 'ensureChatMode', 'ensureNewChat', 'clickSendPrompt'
  ].map(declaration).join('\n')}`, context);
  return { context, clicks, pair, setMode, location, composer, page };
}

test('empty Work landing page switches to Chat before reporting new-chat readiness', async () => {
  const h = harness();
  const ready = await h.context.ensureNewChat();
  assert.equal(ready.alreadyNew, true);
  assert.deepEqual(h.clicks, ['chat']);
  assert.equal(h.context.chatModeState().mode, 'chat');
});

test('Chat landing page is already ready without an extra mode click', async () => {
  const h = harness({ mode: 'chat' });
  await h.context.ensureNewChat();
  await h.context.ensureChatMode();
  assert.deepEqual(h.clicks, []);
});

test('new conversation navigation rechecks and switches a restored Work preference', async () => {
  const h = harness({ mode: 'chat', pathname: '/c/saved', turns: true });
  const ready = await h.context.ensureNewChat();
  assert.equal(ready.alreadyNew, false);
  assert.deepEqual(h.clicks, ['new-chat', 'chat']);
  assert.equal(h.context.assertChatMode().mode, 'chat');
});

test('failed Work-to-Chat transition never reaches Send', async () => {
  const h = harness({ clickChangesMode: false });
  await assert.rejects(h.context.ensureNewChat(), /Timeout.*Чат/);
  await assert.rejects(h.context.clickSendPrompt(), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, ['chat']);
});

test('switching to Work after preparation blocks physical Send', async () => {
  const h = harness({ mode: 'chat' });
  await h.context.ensureNewChat();
  h.composer.textContent = 'Prepared generation prompt';
  h.page.attachments = 2;
  h.setMode('work');
  await assert.rejects(h.context.clickSendPrompt(), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.composer.textContent, 'Prepared generation prompt');
  assert.equal(h.page.attachments, 2);
});

test('Chat permits the physical send for generation or specifications', async () => {
  const h = harness({ mode: 'chat', pathname: '/c/specifications', turns: true, text: 'Extract specifications' });
  const sent = await h.context.clickSendPrompt();
  assert.ok(sent.sendClickedAtMs > 0);
  assert.deepEqual(h.clicks, ['send']);
  assert.equal(h.location.pathname, '/c/specifications');
});

test('Work checks preserve saved conversations and prepared inputs without clicking', async () => {
  for (const options of [{ pathname: '/c/saved' }, { turns: true }, { text: 'Prepared prompt' }, { attachments: 2 }]) {
    const h = harness(options);
    await assert.rejects(h.context.ensureChatMode(), { code: 'CHAT_MODE_REQUIRED' });
    assert.deepEqual(h.clicks, [], JSON.stringify(options));
    assert.equal(h.location.pathname, options.pathname || '/');
    assert.equal(h.composer.textContent, options.text || '');
    assert.equal(h.page.attachments, options.attachments || 0);
  }
});

test('multiple matching mode switches are ambiguous and never clicked', async () => {
  const h = harness({ ambiguous: true });
  assert.equal(h.context.chatModeState().mode, 'unknown');
  await assert.rejects(h.context.ensureChatMode(), { code: 'CHAT_MODE_REQUIRED' });
  await assert.rejects(h.context.clickSendPrompt(), { code: 'CHAT_MODE_REQUIRED' });
  assert.deepEqual(h.clicks, []);
});

test('classic ChatGPT without the Chat/Work switch remains usable', async () => {
  const h = harness({ absent: true });
  assert.equal(h.context.chatModeState().mode, 'classic');
  await h.context.ensureNewChat();
  await h.context.clickSendPrompt();
  assert.deepEqual(h.clicks, ['send']);
});

test('Russian and English aria-selected mode switches detect both states', () => {
  for (const labels of [['Чат', 'Работа'], ['Chat', 'Work']]) {
    const h = harness({ labels });
    assert.equal(h.context.chatModeState().mode, 'work');
    h.setMode('chat');
    assert.equal(h.context.assertChatMode().mode, 'chat');
  }
});

test('opaque selected pill and transparent other tab provide CSS fallback', () => {
  const h = harness({ css: true });
  assert.equal(h.context.chatModeState().mode, 'work');
  h.setMode('chat');
  assert.equal(h.context.chatModeState().mode, 'chat');
  h.pair[1].backgroundColor = 'transparent';
  assert.equal(h.context.chatModeState().mode, 'chat');
  h.pair[1].backgroundColor = 'rgb(0 0 0 / 0)';
  assert.equal(h.context.chatModeState().mode, 'chat');
  h.pair[0].backgroundColor = h.pair[1].backgroundColor;
  assert.equal(h.context.chatModeState().mode, 'unknown');
  assert.throws(() => h.context.assertChatMode(), { code: 'CHAT_MODE_REQUIRED' });
});

