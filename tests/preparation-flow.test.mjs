import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AUTOMATION_ERROR_CLASSES, SLOT_PHASES } from '../extension/reliability-utils.js';

const workerSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
function implementation(source, name, indent = '') {
  const start = new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start);
  const next = new RegExp(`^${indent}(?:async )?function \\w+\\(`, 'm')
    .exec(source.slice(start.index + start[0].length));
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}

function bootstrap(replies) {
  const calls = { messages: [], activated: [], readiness: [] };
  const context = vm.createContext({ Date, AUTOMATION_ERROR_CLASSES,
    chrome: { tabs: { get: async id => ({ id, windowId: 9 }), query: async () => [{ id: 102 }],
      update: async id => calls.activated.push(id) } },
    protectAutomationTab: async () => {},
    waitTabReady: async (...args) => calls.readiness.push(args),
    sendTabMessage: async (tabId, message, timeout) => { calls.messages.push({ tabId, message, timeout }); return replies.shift(); },
    appendLog: async () => {}
  });
  vm.runInContext(implementation(workerSource, 'bootstrapAutomationTab'), context);
  return { context, calls };
}

function pageBootstrap(adapter) {
  const start = contentSource.indexOf("    if (message.type === 'BOOTSTRAP_AUTOMATION_TAB') {");
  const end = contentSource.indexOf("    if (message.type === 'STOP') {", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ Date, A: () => adapter,
    document: { visibilityState: 'hidden' }, publicPageUrl: () => 'https://chatgpt.com/' });
  vm.runInContext(`function handle(message, sendResponse) { ${contentSource.slice(start, end)} }`, context);
  return new Promise(resolve => context.handle({ type: 'BOOTSTRAP_AUTOMATION_TAB', timeoutMs: 8000 }, resolve));
}

test('the actual page bootstrap opts into preparation checks and returns readiness', async () => {
  const reply = await pageBootstrap({ waitForComposerReadyForInput: async options => {
    assert.equal(options.preparationPage, true);
    assert.equal(options.timeout, 8000);
  } });
  assert.equal(reply.ok, true);
  assert.equal(reply.value.composerReady, true);
});

for (const [code, autoResume, resumeAtMs] of [
  ['HISTORY_LOAD_ERROR', undefined, undefined],
  ['UPLOAD_LIMIT', true, 123456789], ['UPLOAD_LIMIT', false, null]
]) {
  test(`the actual page bootstrap preserves ${code} ${String(autoResume)} metadata for the worker`, async () => {
    const reply = await pageBootstrap({ waitForComposerReadyForInput: async () => {
      const error = new Error('Fake page failure');
      Object.assign(error, { code, autoResume, resumeAtMs });
      throw error;
    } });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, code);
    assert.equal(reply.error.autoResume, autoResume);
    assert.equal(reply.error.resumeAtMs, resumeAtMs);
  });
}

test('a typed blocking history error skips the extra minute of foreground bootstrap waiting', async () => {
  const h = bootstrap([{ ok: false, error: { code: 'HISTORY_LOAD_ERROR', message: 'Не удалось загрузить историю' } }]);
  await assert.rejects(h.context.bootstrapAutomationTab(101, 9), error => error.code === 'HISTORY_LOAD_ERROR');
  assert.equal(h.calls.messages.length, 1);
  assert.deepEqual(h.calls.activated, []);
});

for (const autoResume of [true, false]) {
  test(`bootstrap preserves ${autoResume ? 'temporary upload' : 'storage'} quota and skips foreground retries`, async () => {
    const resumeAtMs = autoResume ? Date.now() + 10800000 : null;
    const h = bootstrap([{ ok: false, error: {
      code: 'UPLOAD_LIMIT', message: 'Fake quota', autoResume, resumeAtMs
    } }]);
    await assert.rejects(h.context.bootstrapAutomationTab(101, 9), error => {
      assert.equal(error.code, 'UPLOAD_LIMIT');
      assert.equal(error.autoResume, autoResume);
      assert.equal(error.resumeAtMs, resumeAtMs);
      return true;
    });
    assert.equal(h.calls.messages.length, 1);
    assert.deepEqual(h.calls.activated, []);
  });
}

test('a page that mounts only after activation retains its existing foreground fallback', async () => {
  const h = bootstrap([{ ok: true, value: { composerReady: false } }, { ok: true, value: { composerReady: true } }]);
  assert.equal((await h.context.bootstrapAutomationTab(101, 9)).composerReady, true);
  assert.equal(h.calls.messages.length, 2);
  assert.deepEqual(h.calls.activated, [101, 102]);
});

test('a history error appearing in the foreground fallback retains its classification', async () => {
  const h = bootstrap([{ ok: true, value: { composerReady: false } },
    { ok: false, error: { code: 'HISTORY_LOAD_ERROR', message: 'Unable to load history' } }]);
  await assert.rejects(h.context.bootstrapAutomationTab(101, 9), error => error.code === 'HISTORY_LOAD_ERROR');
  assert.deepEqual(h.calls.activated, [101, 102]);
});

test('a normal empty-chat audit preserves the active upload phase without claiming generation has started', () => {
  const context = vm.createContext({ SLOT_PHASES });
  vm.runInContext(implementation(workerSource, 'phaseForProbeState'), context);
  for (const state of ['WAITING_ASSISTANT', 'WAITING_GENERATION', 'WAITING_IMAGE']) {
    assert.equal(context.phaseForProbeState(state, { generationSubmitted: false, currentPhase: 'UPLOADING' }), 'UPLOADING');
  }
  assert.equal(context.phaseForProbeState('WAITING_ASSISTANT', {
    generationSubmitted: false, currentPhase: 'UPLOADING', preparedForSubmit: true }), 'WAITING_LAUNCH');
  assert.equal(context.phaseForProbeState('WAITING_GENERATION', {
    generationSubmitted: true, currentPhase: 'UPLOADING' }), 'GENERATING');
});

function preparation({ newChatFails = false } = {}) {
  let resolveChat, resolveUpload;
  const newChat = new Promise(resolve => { resolveChat = resolve; });
  const upload = new Promise(resolve => { resolveUpload = resolve; });
  const calls = { states: [], errors: [], upload: 0, prompt: [] };
  const owner = { promptSent: false, preparedForSubmit: false, job: {
    modelName: 'Fake watch', prompt: 'Render {{MODEL_NAME}}', inputMode: '2'
  }, files: { template: { name: 'fake-template' }, watchReference: { name: 'fake-product' } } };
  const adapter = {
    ensureNewChat: async () => {
      if (newChatFails) { const error = new Error('Не удалось загрузить историю'); error.code = 'HISTORY_LOAD_ERROR'; throw error; }
      return newChat;
    },
    uploadFiles: async () => { calls.upload++; return upload; },
    setComposerText: async prompt => { calls.prompt.push(prompt); return { selector: 'fake-composer' }; },
    composerHasText: () => true
  };
  const context = vm.createContext({ runCache: owner, controller: null, AbortController, DOMException, Date,
    A: () => adapter, validateRunInputs: () => ['template', 'watchReference'],
    emitState: async patch => calls.states.push({ ...patch }), emitLog: async () => {},
    reportRunError: async error => calls.errors.push(error.code)
  });
  vm.runInContext(implementation(contentSource, 'prepareRunForSubmit', '  '), context);
  return { context, owner, calls, resolveChat, resolveUpload };
}

test('preparation reports chat opening and pending uploads before READY_TO_SEND, without sending a prompt', async () => {
  const h = preparation();
  const task = h.context.prepareRunForSubmit();
  assert.deepEqual(h.calls.states.map(item => item.state), ['CREATING_NEW_CHAT']);
  h.resolveChat({ alreadyNew: true });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  assert.deepEqual(h.calls.states.map(item => item.state), ['CREATING_NEW_CHAT', 'UPLOADING_ATTACHMENTS']);
  assert.equal(h.owner.preparedForSubmit, false);
  assert.equal(h.calls.upload, 1);
  assert.deepEqual(h.calls.prompt, ['Render Fake watch']);
  h.resolveUpload({ count: 2, mode: 'batch' });
  assert.equal((await task).prepared, true);
  assert.equal(h.calls.states.at(-1).state, 'READY_TO_SEND');
  assert.equal(h.owner.preparedForSubmit, true);
  assert.equal(h.owner.promptSent, false);
});

test('a preparation page load failure is reported before any files or prompt are inserted', async () => {
  const h = preparation({ newChatFails: true });
  await assert.rejects(h.context.prepareRunForSubmit(), error => error.code === 'HISTORY_LOAD_ERROR');
  assert.deepEqual(h.calls.errors, ['HISTORY_LOAD_ERROR']);
  assert.equal(h.calls.upload, 0);
  assert.deepEqual(h.calls.prompt, []);
  assert.equal(h.owner.preparedForSubmit, false);
});

