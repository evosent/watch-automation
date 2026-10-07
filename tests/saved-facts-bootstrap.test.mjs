import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');

function implementation(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `function ${name} exists`);
  const tail = source.slice(start.index + start[0].length);
  const next = /^  (?:async )?function \w+\(/m.exec(tail);
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}

function bindingHarness({ href = 'https://chatgpt.com/c/chat-1?model=gpt-image', imageSrc = 'https://images.oaiusercontent.com/generated.png',
  verification = { valid: true, sha256: 'a'.repeat(64), width: 1024, height: 1365 }, loadError = null } = {}) {
  const calls = { verifiedSources: [] };
  const image = imageSrc ? { currentSrc: imageSrc, src: imageSrc } : null;
  const turn = { id: 'assistant-turn-7', getAttribute: () => 'conversation-turn-7' };
  const context = vm.createContext({
    URL,
    location: { href },
    R: () => ({
      visibleConversationLoadError: () => loadError,
      latestAssistantTurn: () => turn,
      generatedImage: () => image
    }),
    A: () => ({ inspectGeneratedImage: () => ({ state: imageSrc ? 'READY' : 'TEXT_ONLY', src: imageSrc || null }) }),
    verifyGeneratedPngSource: async value => {
      calls.verifiedSources.push(value);
      if (verification instanceof Error) throw verification;
      return verification;
    }
  });
  vm.runInContext([
    implementation('normalizedChatConversationUrl'),
    implementation('currentConversationUrl'),
    implementation('assertSavedFactsImageBinding')
  ].join('\n'), context);
  return { context, calls };
}

const HASH = 'a'.repeat(64);
const baseBinding = { generationId: 'gen-1', outputHash: HASH, chatUrl: 'https://chatgpt.com/c/chat-1' };

test('saved facts binding accepts only the exact saved PNG in its immutable ChatGPT conversation', async () => {
  const h = bindingHarness();
  const result = await h.context.assertSavedFactsImageBinding(baseBinding);
  assert.equal(result.verified, true);
  assert.equal(result.outputHash, HASH);
  assert.equal(result.chatUrl, 'https://chatgpt.com/c/chat-1');
  assert.equal(result.assistantTurnId, 'conversation-turn-7');
  assert.deepEqual(h.calls.verifiedSources, ['https://images.oaiusercontent.com/generated.png']);
});

test('a chat URL mismatch blocks before fetching an image', async () => {
  const h = bindingHarness({ href: 'https://chatgpt.com/c/other-chat' });
  await assert.rejects(h.context.assertSavedFactsImageBinding(baseBinding), error => {
    assert.equal(error.code, 'SAVED_IMAGE_BINDING_MISMATCH');
    assert.equal(error.factsStage, 'IMAGE_BINDING');
    assert.equal(error.promptSubmitted, false);
    return true;
  });
  assert.equal(h.calls.verifiedSources.length, 0);
});

test('missing image, hash mismatch, and inaccessible image are structured verification blocks', async t => {
  await t.test('missing latest image', async () => {
    const h = bindingHarness({ imageSrc: '' });
    await assert.rejects(h.context.assertSavedFactsImageBinding(baseBinding), error => error.code === 'SAVED_IMAGE_BINDING_UNVERIFIABLE');
    assert.equal(h.calls.verifiedSources.length, 0);
  });
  await t.test('different PNG checksum', async () => {
    const h = bindingHarness({ verification: { valid: true, sha256: 'b'.repeat(64), width: 1024, height: 1365 } });
    await assert.rejects(h.context.assertSavedFactsImageBinding(baseBinding), error => {
      assert.equal(error.code, 'SAVED_IMAGE_BINDING_MISMATCH');
      assert.equal(error.responseDiagnostics.reason, 'output_hash_mismatch');
      return true;
    });
  });
  await t.test('permission or fetch error', async () => {
    const h = bindingHarness({ verification: new Error('HTTP 403') });
    await assert.rejects(h.context.assertSavedFactsImageBinding(baseBinding), error => {
      assert.equal(error.code, 'SAVED_IMAGE_BINDING_UNVERIFIABLE');
      assert.equal(error.responseDiagnostics.reason, 'image_fetch_failed');
      return true;
    });
  });
});

function extractionHarness({ failBindingAt = 1 } = {}) {
  const calls = { stages: [], bindings: 0, prompts: [], sendClicks: 0, steps: [] };
  const adapter = {
    waitForComposerReadyForInput: async () => calls.steps.push('composer-ready'),
    assertChatMode: () => calls.steps.push('chat-mode'),
    setComposerText: async text => { calls.prompts.push(text); calls.steps.push(text ? 'fill-prompt' : 'clear-prompt'); return { length: text.length }; },
    composerHasText: text => calls.prompts.at(-1) === text,
    waitForComposerReadyForSend: async () => calls.steps.push('send-ready'),
    clickSendPrompt: async () => { calls.sendClicks++; calls.steps.push('send-click'); return { sendClickedAtMs: 1 }; },
    waitForPromptAcceptance: async () => ({ userTurnId: 'user-new', baselineAssistantCount: 2, baselineUserCount: 2, sendClickedAtMs: 1 }),
    waitForSettledAssistantText: async () => ({ text: '{"titleModel":"Model"}', assistantCount: 3, completion: 'done' })
  };
  const owner = { operationId: 'op-1', entryId: 'sku-1', job: { generationId: 'gen-1' }, factsExtraction: { startedAt: 1 } };
  const context = vm.createContext({
    AbortController,
    DOMException,
    Date,
    FACTS_COMPOSER_TIMEOUT_MS: 30000,
    FACTS_SEND_BUTTON_TIMEOUT_MS: 30000,
    FACTS_ACCEPTANCE_TIMEOUT_MS: 12000,
    FACTS_ACCEPTANCE_RETRY_TIMEOUT_MS: 15000,
    FACTS_RESPONSE_TIMEOUT_MS: 900000,
    runCache: owner,
    factsController: null,
    A: () => adapter,
    R: () => ({ stopGeneratingButton: () => null }),
    assertSavedFactsImageBinding: async () => {
      calls.bindings++;
      calls.steps.push(`binding-${calls.bindings}`);
      if (calls.bindings === failBindingAt) {
        const error = new Error('Saved image mismatch');
        error.code = 'SAVED_IMAGE_BINDING_MISMATCH';
        error.factsStage = 'IMAGE_BINDING';
        throw error;
      }
      return { verified: true };
    },
    emitFactsStage: stage => calls.stages.push(stage),
    emitLog: async () => {},
    requestFactsSendPermit: async () => { calls.steps.push('send-permit'); return { granted: true }; },
    sleep: async () => {}
  });
  vm.runInContext(implementation('extractFactsFromLastImage'), context);
  return { context, calls };
}

test('an image-binding failure sends no specification prompt', async () => {
  const h = extractionHarness({ failBindingAt: 1 });
  await assert.rejects(h.context.extractFactsFromLastImage('read the saved image', {
    savedImageBindingRequired: true, outputHash: HASH, chatUrl: baseBinding.chatUrl
  }), error => error.code === 'SAVED_IMAGE_BINDING_MISMATCH');
  assert.equal(h.calls.bindings, 1);
  assert.deepEqual(h.calls.prompts, []);
  assert.equal(h.calls.sendClicks, 0);
  assert.deepEqual(h.calls.steps, ['binding-1']);
});

test('the saved image is checked again after send-gate waiting and before Send', async () => {
  const h = extractionHarness({ failBindingAt: 2 });
  await assert.rejects(h.context.extractFactsFromLastImage('read the saved image', {
    savedImageBindingRequired: true, outputHash: HASH, chatUrl: baseBinding.chatUrl
  }), error => error.code === 'SAVED_IMAGE_BINDING_MISMATCH');
  assert.equal(h.calls.bindings, 2);
  assert.equal(h.calls.sendClicks, 0);
  assert.deepEqual(h.calls.prompts, ['read the saved image', ''], 'remove the unsent prompt when the binding changed');
  assert.ok(h.calls.steps.indexOf('binding-2') < h.calls.steps.indexOf('send-click') || !h.calls.steps.includes('send-click'));
});

function handlerHarness({ existingRunCache = null } = {}) {
  const calls = { started: [], response: null };
  const context = vm.createContext({
    Date,
    URL,
    location: { href: baseBinding.chatUrl },
    runCache: existingRunCache,
    R: () => ({ assistantTurns: () => [{}, {}], userTurns: () => [{}] }),
    window: { WatchDomRecorder: { setContext: () => {} } },
    context: () => ({}),
    emitFactsStage: () => {},
    runFactsExtractionDetached: message => { calls.started.push(message); },
    sendResponse: value => { calls.response = value; }
  });
  vm.runInContext(implementation('normalizedChatConversationUrl'), context);
  const start = source.indexOf("    if (message.type === 'BOOTSTRAP_SAVED_FACTS') {");
  const end = source.indexOf("    if (message.type === 'PREPARE_PAGE_RUN') {", start);
  assert.ok(start >= 0 && end > start, 'bootstrap listener is present before normal generation preparation');
  vm.runInContext(`function handle(message, sendResponse) { ${source.slice(start, end)} }`, context);
  return { context, calls };
}

const savedFactsMessage = {
  type: 'BOOTSTRAP_SAVED_FACTS', operationId: 'op-1', slotId: 0, leaseId: 'lease-1',
  entryId: 'sku-1', generationId: 'gen-1', factsJobId: 'facts-1',
  factsPrompt: 'Read the product image and return facts.', modelName: 'Casio MTP-VD201',
  outputFileName: 'Casio MTP-VD201.png', outputPath: 'in_sale_good/Casio MTP-VD201.png',
  outputHash: HASH, chatUrl: baseBinding.chatUrl
};

test('BOOTSTRAP_SAVED_FACTS starts a facts-only cache with no generation prompt or file upload', () => {
  const h = handlerHarness();
  h.context.handle(savedFactsMessage, value => { h.calls.response = value; });
  assert.equal(h.calls.response.ok, true);
  assert.equal(h.calls.response.value.bindingPending, true);
  assert.equal(h.calls.started.length, 1);
  assert.equal(h.calls.started[0].savedImageBindingRequired, true);
  assert.equal(h.calls.started[0].prompt, savedFactsMessage.factsPrompt);
  assert.equal(h.context.runCache.job.generationId, 'gen-1');
  assert.equal(h.context.runCache.job.prompt, undefined);
  assert.deepEqual(Object.keys(h.context.runCache).includes('files'), false);
});

test('BOOTSTRAP_SAVED_FACTS rejects malformed hashes and another live run owner', () => {
  const invalid = handlerHarness();
  invalid.context.handle({ ...savedFactsMessage, outputHash: 'bad' }, value => { invalid.calls.response = value; });
  assert.equal(invalid.calls.response.ok, false);
  assert.equal(invalid.calls.response.error.code, 'SAVED_FACTS_TASK_INVALID');
  assert.equal(invalid.calls.started.length, 0);

  const busy = handlerHarness({ existingRunCache: { operationId: 'another-op', entryId: 'sku-2' } });
  busy.context.handle(savedFactsMessage, value => { busy.calls.response = value; });
  assert.equal(busy.calls.response.ok, false);
  assert.equal(busy.calls.response.error.code, 'SAVED_FACTS_TAB_BUSY');
  assert.equal(busy.calls.started.length, 0);
});
