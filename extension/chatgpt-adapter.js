(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  const R = () => window.WatchSelectorResolver;
  const O = () => window.WatchAutomationOverlay;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Once an assistant turn is fully settled with response actions and no image/tool
  // candidate, genuine image generation normally declares itself before this grace
  // window expires. Terminal text-only outcomes are classified immediately.
  const TEXT_ONLY_RESPONSE_GRACE_MS = 120000;
  let lastInspectionSignature = '';
  // Rate-limit dialogs can be detected/dismissed by the worker audit before
  // the Send-acceptance waiter observes them. Keep a short page-local latch so
  // the physical Send is still classified as RATE_LIMIT instead of timing out
  // two minutes later as an unrelated failure.
  let lastRateLimitSignal = null;
  let domPulseObserver = null;
  let domPulseQueued = false;
  const domPulseListeners = new Set();

  function emitDomPulse() {
    if (domPulseQueued) return;
    domPulseQueued = true;
    queueMicrotask(() => {
      domPulseQueued = false;
      for (const listener of [...domPulseListeners]) {
        try { listener(); } catch (_) {}
      }
    });
  }

  function ensureDomPulseObserver() {
    if (domPulseObserver || !document.documentElement) return;
    domPulseObserver = new MutationObserver(emitDomPulse);
    domPulseObserver.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true
    });
  }

  function subscribeDomPulse(listener) {
    ensureDomPulseObserver();
    domPulseListeners.add(listener);
    return () => domPulseListeners.delete(listener);
  }

  function turnText(turn, max = 12000) {
    const value = String(turn?.innerText || turn?.textContent || '').replace(/\s+/g, ' ').trim();
    return value.slice(0, max);
  }

  function factsTextsForTurn(turn) {
    if (!turn) return [];
    const focused = [...turn.querySelectorAll('pre code, pre, code')]
      .map((node) => String(node?.innerText || node?.textContent || '').trim())
      .filter(Boolean);
    const full = String(turn?.innerText || turn?.textContent || '').replace(/\s+/g, ' ').trim();
    if (full) {
      focused.push(full);
      if (full.length > 64000) focused.push(full.slice(-64000));
    }
    return [...new Set(focused)];
  }

  function isCompleteFactsResponse(text) {
    return globalThis.WatchFactsUtils?.isCompleteFactsResponse?.(text) === true;
  }

  function completeFactsTurn(turns = []) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const texts = factsTextsForTurn(turn);
      const text = globalThis.WatchFactsUtils?.findCompleteFactsResponse?.(texts)
        || texts.find((candidate) => isCompleteFactsResponse(candidate))
        || null;
      if (text) return { turn, text };
    }
    return null;
  }

  function classifyAssistantOutcome(turn = R().latestAssistantTurn()) {
    const text = turnText(turn);
    if (!text) return { kind: 'EMPTY', code: null, terminal: false, text: '' };
    const lower = text.toLowerCase();
    const tests = [
      {
        kind: 'MODEL_REFUSAL', code: 'MODEL_REFUSAL', terminal: true,
        pattern: /(не могу (?:помочь|выполнить|создать|сгенерировать)|не могу выполнить этот запрос|не могу помочь с этим|i can(?:not|'t) (?:help|comply|assist|create|generate)|i'm unable to (?:help|comply|assist)|policy (?:does not|doesn't) allow)/i
      },
      {
        kind: 'TOOL_UNAVAILABLE', code: 'TOOL_UNAVAILABLE', terminal: true,
        pattern: /(не удалось (?:создать|сгенерировать) изображение|генерац[^.]{0,80}(?:недоступ|не удалось|сбой)|инструмент[^.]{0,80}(?:недоступ|ошиб)|failed to generate (?:the )?image|image generation[^.]{0,80}(?:unavailable|failed)|tool[^.]{0,80}(?:unavailable|failed))/i
      },
      {
        kind: 'CLARIFICATION_REQUIRED', code: 'CLARIFICATION_REQUIRED', terminal: true,
        pattern: /(?:уточнит|уточни|пришлите|пришли|загрузите|загрузи|нужен (?:ещ[её] )?(?:файл|референс|пример)|какой (?:именно|вариант)|could you (?:clarify|upload|provide)|please (?:clarify|upload|provide)|i need (?:more|an? additional) (?:information|reference|image))/i
      }
    ];
    for (const test of tests) {
      if (test.pattern.test(lower)) return { ...test, text };
    }
    return { kind: 'TEXT_ONLY', code: 'TEXT_ONLY', terminal: false, text };
  }

  let lastUploadObservation = null;
  let lastUploadInputObservation = null;
  let uploadMenuOpenedByAdapter = null;
  function recordAdapterAction(action) {
    if (/^upload-/.test(String(action?.type || ''))) {
      const details = action.details || {};
      const observation = ['upload-dispatch', 'upload-input-missing'].includes(action.type) ? {} : { ...(lastUploadObservation || {}) };
      for (const key of ['stage', 'selector', 'inputConnected', 'multiple', 'expectedCount', 'baselineCount', 'actualCount', 'error', 'elapsedMs', 'menuOpened', 'reason', 'inputCandidates']) {
        if (details[key] !== undefined) observation[key] = typeof details[key] === 'string'
          ? details[key].slice(0, 1600) : details[key];
      }
      lastUploadObservation = {
        ...observation, type: action.type, at: new Date().toISOString()
      };
      if (/^upload-input-/.test(action.type)) lastUploadInputObservation = { ...lastUploadObservation };
    }
    try { window.WatchDomRecorder?.recordAction(action); } catch (_) {}
  }

  function reportInspection(result) {
    const signature = JSON.stringify({
      state: result?.state,
      error: result?.error || null,
      assistantCount: result?.assistantCount || 0,
      settled: result?.settled || false,
      imageCandidate: result?.imageCandidate || false
    });
    if (signature !== lastInspectionSignature) {
      lastInspectionSignature = signature;
      recordAdapterAction({
        type: 'generation-check',
        state: result?.state,
        details: {
          assistantCount: result?.assistantCount || 0,
          settled: Boolean(result?.settled),
          imageCandidate: Boolean(result?.imageCandidate),
          error: result?.error || null
        }
      });
    }
    return result;
  }

  function noteRateLimit(result, scope = 'generation') {
    if (!result?.detected) return null;
    lastRateLimitSignal = {
      at: Date.now(),
      scope: String(scope || 'generation'),
      text: String(result?.text || 'Слишком много запросов'),
      result: { ...(result || {}), scope: String(scope || 'generation') }
    };
    return lastRateLimitSignal;
  }

  function recentRateLimitForSend(sendClickedAtMs, scope = 'generation', maxAgeMs = 30000) {
    const signal = lastRateLimitSignal;
    if (!signal) return null;
    if (signal.scope !== String(scope || 'generation')) return null;
    const clickedAt = Number(sendClickedAtMs || 0);
    if (clickedAt && signal.at + 1000 < clickedAt) return null;
    if (Date.now() - signal.at > maxAgeMs) return null;
    return signal.result;
  }

  async function notifyRateLimit(result, scope = 'generation') {
    noteRateLimit(result, scope);
    try {
      await chrome.runtime.sendMessage({
        type: 'RATE_LIMIT_EVENT',
        scope,
        rateLimit: { ...(result || {}), scope }
      });
    } catch (_) {}
  }

  function rateLimitError(result, { beforeAssistant = false } = {}) {
    const error = new Error(`RATE_LIMIT: ${result?.text || 'Слишком много запросов'}`);
    error.code = 'RATE_LIMIT';
    error.rateLimitBeforeAssistant = beforeAssistant;
    error.responseText = result?.text || '';
    return error;
  }

  async function waitForDomCondition({ predicate, timeout = 30000, name = 'condition', pollFallbackMs = 750, signal, preparationPage = false } = {}) {
    const start = Date.now();
    let historyBlockedSince = null;
    let timer;
    let unsubscribe = () => {};
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { unsubscribe(); if (timer) clearInterval(timer); signal?.removeEventListener('abort', onAbort); };
      const done = (value) => { if (finished) return; finished = true; cleanup(); resolve(value); };
      const fail = (err) => { if (finished) return; finished = true; cleanup(); reject(err); };
      const check = () => {
        if (Date.now() - start > timeout) return fail(new Error(`Timeout waiting for ${name} (${timeout}ms)`));
        try {
          // History warnings belong to preparation. A disabled composer after
          // Send is normal and must not hide proof that the prompt was accepted.
          if (preparationPage) {
            try {
              assertPreparationPageReady();
              historyBlockedSince = null;
            } catch (error) {
              if (error?.code !== 'HISTORY_LOAD_ERROR') throw error;
              // Allow a short composer remount before classifying the page as
              // unavailable; explicit file/storage quotas still fail at once.
              if (historyBlockedSince === null) historyBlockedSince = Date.now();
              if (Date.now() - historyBlockedSince < 2000) return;
              throw error;
            }
          }
          const value = predicate(); if (value) done(value);
        } catch (e) { fail(e); }
      };
      const onAbort = () => fail(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      unsubscribe = subscribeDomPulse(check);
      timer = setInterval(check, Math.max(500, pollFallbackMs));
      check();
    });
  }

  async function safeClick(element, label, debugOverlay = true, beforeClick = null) {
    if (!R().visible(element)) throw new Error(`Target not visible: ${label}`);
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error(`Target disabled: ${label}`);
    if (debugOverlay) await O().highlightTarget(element, { label });
    // Callers may provide a safety check that must be evaluated after any
    // asynchronous highlighting and immediately before the physical click.
    if (beforeClick?.() === false) return { clicked: false };
    recordAdapterAction({
      type: 'click',
      name: label,
      selector: element.getAttribute('data-testid') || element.id || element.getAttribute('aria-label') || element.tagName.toLowerCase()
    });
    element.click();
  }

  function chatModeState() {
    const selector = 'button, [role="tab"], [role="radio"], [role="button"], a';
    const label = (node) => String(node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const controls = [...document.querySelectorAll(selector)].filter((node) => R().visible(node));
    const chats = controls.filter((node) => /^(Чат|Chat)$/i.test(label(node)));
    const works = controls.filter((node) => /^(Работа|Work)$/i.test(label(node)));
    const pairs = [];
    for (const chat of chats) {
      let parent = chat.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 3; depth++, parent = parent.parentElement) {
        const siblings = [...parent.querySelectorAll(selector)].filter((node) => R().visible(node));
        const work = works.find((node) => siblings.includes(node));
        // Restrict matching to the two-option switch, never arbitrary sidebar
        // links or words inside messages and project lists.
        if (work && siblings.length === 2) { pairs.push({ chat, work }); break; }
      }
    }
    // Older ChatGPT layouts have no mode switch. If a Work control exists
    // without an unambiguous Chat/Work pair, fail closed.
    if (!pairs.length) return { mode: works.length ? 'unknown' : 'classic' };
    if (pairs.length !== 1) return { mode: 'unknown' };
    const { chat, work } = pairs[0];
    const active = (node) => {
      for (const attribute of ['aria-selected', 'aria-pressed', 'aria-checked', 'data-selected', 'data-active']) {
        const value = node.getAttribute(attribute);
        if (value === 'true' || value === 'false') return value === 'true';
      }
      const state = node.getAttribute('data-state');
      if (['active', 'checked', 'on'].includes(state)) return true;
      if (['inactive', 'unchecked', 'off'].includes(state)) return false;
      const current = node.getAttribute('aria-current');
      if (current && current !== 'false') return true;
      return null;
    };
    let chatActive = active(chat), workActive = active(work);
    if (chatActive === null && workActive === null) {
      // Some builds use an opaque selected pill and a transparent other tab.
      const transparent = (node) => /^(transparent|rgba\([^)]*,\s*0\)|rgb\([^)]*\/\s*0\))$/.test(getComputedStyle(node).backgroundColor);
      const chatClear = transparent(chat), workClear = transparent(work);
      if (chatClear !== workClear) { chatActive = !chatClear; workActive = !workClear; }
    }
    const mode = chatActive === true && workActive !== true ? 'chat'
      : workActive === true && chatActive !== true ? 'work' : 'unknown';
    return { mode, chat, work };
  }

  function assertChatMode() {
    const state = chatModeState();
    if (state.mode === 'chat' || state.mode === 'classic') return state;
    const error = new Error('Генерация работает только в режиме «Чат». Выберите «Чат» вместо «Работа» и повторите запуск.');
    error.code = 'CHAT_MODE_REQUIRED';
    throw error;
  }

  let chatModePreparation = null;
  function ensureChatMode({ debugOverlay = false, signal } = {}) {
    if (chatModePreparation) return chatModePreparation;
    chatModePreparation = (async () => {
      await waitForDomCondition({ name: 'ChatGPT composer', timeout: 60000, signal, preparationPage: true, predicate: () => R().resolve('composer').element });
      const state = chatModeState();
      if (state.mode === 'chat' || state.mode === 'classic') return state;
      // Changing modes can discard a saved conversation or prepared inputs.
      const composer = R().resolve('composer').element;
      if (!state.chat || /^\/c\//.test(location.pathname) || document.querySelector('[data-turn]')
        || String(composer?.textContent || composer?.value || '').trim()
        || R().attachmentTiles?.().length) return assertChatMode();
      await safeClick(state.chat, 'Выбрать режим Чат', debugOverlay, () => {
        const current = chatModeState();
        if (current.mode === 'chat') return false;
        const currentComposer = R().resolve('composer').element;
        const pageStillEmpty = current.chat && !/^\/c\//.test(location.pathname)
          && !document.querySelector('[data-turn]')
          && !String(currentComposer?.textContent || currentComposer?.value || '').trim()
          && !R().attachmentTiles?.().length;
        if (!pageStillEmpty) return assertChatMode();
        return true;
      });
      await waitForDomCondition({ name: 'режим Чат', timeout: 10000, signal, preparationPage: true, predicate: () => chatModeState().mode === 'chat' });
      return assertChatMode();
    })().finally(() => { chatModePreparation = null; });
    return chatModePreparation;
  }

  async function ensureNewChat({ debugOverlay = true, signal } = {}) {
    await waitForDomCondition({ name: 'ChatGPT composer', timeout: 60000, signal, preparationPage: true, predicate: () => R().resolve('composer').element });
    const hasTurns = document.querySelector('[data-turn]');
    const inConversationPath = /^\/c\//.test(location.pathname);
    if (!hasTurns && !inConversationPath) {
      await ensureChatMode({ debugOverlay, signal });
      return { alreadyNew: true };
    }
    // Do not navigate away from a prepared conversation while Work is active
    // or the mode control cannot be identified with confidence.
    assertChatMode();
    const found = R().resolve('newChat');
    if (!found.element) throw new Error('New Chat button not found');
    await safeClick(found.element, 'Click: New Chat', debugOverlay, assertChatMode);
    await waitForDomCondition({ name: 'empty new chat', timeout: 30000, signal, preparationPage: true, predicate: () => R().resolve('composer').element && !document.querySelector('[data-turn]') });
    await ensureChatMode({ debugOverlay, signal });
    return { alreadyNew: false, selector: found.selector };
  }

  function assertPreparationPageReady() {
    const historyError = R().visibleHistoryLoadError?.();
    if (!historyError) return;
    const uploadIssue = R().uploadError?.();
    if (uploadIssue?.uploadLimit) throw uploadIssueError(uploadIssue);
    const composer = R().resolve('composer').element;
    if (composer && composer.isConnected !== false && composer.disabled !== true
      && composer.getAttribute?.('aria-disabled') !== 'true') return;
    const error = new Error(String(historyError.innerText || historyError.textContent || 'Не удалось загрузить историю').replace(/\s+/g, ' ').trim().slice(0, 1600));
    error.code = 'HISTORY_LOAD_ERROR';
    error.responseText = error.message;
    throw error;
  }

  function uploadIssueError(issue) {
    const error = new Error(issue.text);
    error.responseText = issue.text;
    if (issue.uploadLimit) {
      error.code = 'UPLOAD_LIMIT';
      error.autoResume = issue.storageLimit !== true;
      error.resumeAtMs = issue.storageLimit ? null : globalThis.WatchQuotaUtils?.uploadLimitResumeAt(issue.text);
      error.storageLimit = issue.storageLimit === true;
    } else {
      error.code = /network|connection|offline|сеть|соединен/i.test(issue.text) ? 'NETWORK' : 'UPLOAD_REJECTED';
    }
    return error;
  }

  function assertUploadAllowed({ checkPage = true } = {}) {
    const issue = R().uploadError?.();
    if (issue) throw uploadIssueError(issue);
    if (checkPage) assertPreparationPageReady();
  }

  function uploadInputDiagnostics() {
    try { return R().fileInputDiagnostics?.({ maxCandidates: 20 }) || null; }
    catch (_) { return null; }
  }

  function uploadMenuExpanded(button) {
    return button?.getAttribute?.('aria-expanded') === 'true'
      || button?.getAttribute?.('data-state') === 'open';
  }

  // Modern composers may mount the hidden file input only after their Add
  // menu opens. Wait for an ordinary remount first, then open that exact menu
  // once. Never click a menu item that would launch the native file picker.
  async function ensureUploadInput({ debugOverlay = true, signal } = {}) {
    const startedAt = Date.now();
    let menuOpened = false;
    const current = () => {
      const found = R().resolve('fileInput', { visibleOnly: false });
      const input = found.element;
      return input && input.isConnected !== false && input.disabled !== true
        && input.getAttribute?.('aria-disabled') !== 'true' ? found : null;
    };
    const record = (type, details = {}) => recordAdapterAction({ type, details: {
      stage: 'input-preparation', elapsedMs: Date.now() - startedAt, menuOpened,
      inputCandidates: uploadInputDiagnostics(), ...details
    } });
    const wait = async (timeout, name) => {
      try {
        return await waitForDomCondition({ timeout, name, signal, preparationPage: true,
          predicate: () => { assertUploadAllowed({ checkPage: false }); return current(); }
        });
      } catch (error) {
        if (error.message === `Timeout waiting for ${name} (${timeout}ms)`) return null;
        throw error;
      }
    };
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      assertUploadAllowed();
      const ready = current();
      if (ready) return ready;
      record('upload-input-missing');
      let found = await wait(2000, 'upload input remount');
      if (!found) {
        const plus = R().resolve('composerPlus').element;
        if (plus && plus.isConnected !== false && R().visible(plus)
          && !plus.disabled && plus.getAttribute?.('aria-disabled') !== 'true'
          && !uploadMenuExpanded(plus)) {
          let clicked = false;
          await safeClick(plus, 'Открыть меню прикрепления', debugOverlay, () => {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            assertUploadAllowed();
            assertChatMode();
            if (current() || uploadMenuExpanded(plus)
              || R().resolve('composerPlus').element !== plus || plus.isConnected === false) return false;
            clicked = true;
            return true;
          });
          if (clicked) {
            menuOpened = true;
            uploadMenuOpenedByAdapter = plus;
            record('upload-input-menu-opened');
          }
        }
        found = await wait(10000, 'upload input after Add menu');
      }
      if (!found) {
        const error = new Error('Не найдено поле прикрепления фотографий после ожидания и проверки меню. Страница ChatGPT изменилась или не готова к загрузке.');
        error.code = 'DOM_CHANGED';
        throw error;
      }
      record('upload-input-recovered', { selector: found.selector || null,
        inputConnected: true, multiple: found.element.multiple === true });
      return found;
    } catch (error) {
      record('upload-input-failed', { reason: error.name === 'AbortError' ? 'AbortError' : error.code || error.name,
        error: error.message || String(error) });
      throw error;
    }
  }

  function closeOwnedUploadMenu() {
    const plus = uploadMenuOpenedByAdapter;
    uploadMenuOpenedByAdapter = null;
    // File selection normally closes the menu itself. Close only the same
    // still-open Add menu we opened, never another dialog or a native picker.
    if (!plus || plus.isConnected === false || !uploadMenuExpanded(plus)
      || R().resolve('composerPlus').element !== plus || !R().visible(plus)
      || plus.disabled || plus.getAttribute?.('aria-disabled') === 'true') return;
    try {
      plus.click();
      recordAdapterAction({ type: 'upload-input-menu-closed', details: { stage: 'after-dispatch', menuOpened: false } });
    } catch (error) {
      // Selection already happened: failure to tidy the menu cannot justify
      // selecting the files a second time.
      recordAdapterAction({ type: 'upload-input-menu-close-failed', details: {
        stage: 'after-dispatch', error: error.message || String(error)
      } });
    }
  }

  function dispatchUploadFiles(input, files) {
    if (input.isConnected === false || input.disabled === true
      || R().resolve('fileInput', { visibleOnly: false }).element !== input) {
      const error = new Error('Поле прикрепления фотографий изменилось перед загрузкой.');
      error.code = 'DOM_CHANGED';
      recordAdapterAction({ type: 'upload-input-failed', details: {
        stage: 'before-dispatch', reason: error.code, error: error.message,
        inputCandidates: uploadInputDiagnostics()
      } });
      throw error;
    }
    input.files = files;
    // File selection is handled by change. An input listener may synchronously
    // remount the composer, so sending input first could strand change on a
    // detached node and leave the page with no attachments.
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    // Preserve input-only compatibility only while the same input still owns
    // this upload. Never dispatch the files again to a replacement element.
    if (input.isConnected !== false && R().resolve('fileInput', { visibleOnly: false }).element === input) {
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
  }

  async function uploadFile({ dataUrl, name, type, expectedCount, debugOverlay = true, signal }) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    assertUploadAllowed();
    await ensureUploadInput({ debugOverlay, signal });
    const plus = R().resolve('composerPlus').element;
    if (debugOverlay && plus) await O().highlightTarget(plus, { label: `Upload #${expectedCount}: ${name}` });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = await (await fetch(dataUrl, { signal })).blob();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const file = new File([blob], name, { type: type || blob.type || 'image/png', lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    // ChatGPT may replace the composer while the overlay or blob is being
    // prepared. Dispatch only to the resolver's current, connected input.
    const currentInputInfo = await ensureUploadInput({ debugOverlay, signal });
    const input = currentInputInfo.element;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    assertUploadAllowed();
    const dispatchDetails = {
      stage: 'dispatch', selector: currentInputInfo.selector || null,
      inputConnected: input.isConnected !== false, multiple: input.multiple === true,
      expectedCount, baselineCount: R().attachmentTiles().length
    };
    recordAdapterAction({ type: 'upload-dispatch', details: dispatchDetails });
    dispatchUploadFiles(input, dt.files);
    closeOwnedUploadMenu();
    let tiles;
    try {
      tiles = await waitForDomCondition({
        name: `attachment count ${expectedCount}`, timeout: 60000, signal, preparationPage: true,
        predicate: () => {
          assertUploadAllowed({ checkPage: false });
          const xs = R().attachmentTiles();
          return xs.length >= expectedCount ? xs : null;
        }
      });
    } catch (error) {
      recordAdapterAction({ type: 'upload-dispatch-failed', details: {
        ...dispatchDetails, stage: signal?.aborted ? 'aborted-wait' : 'attachment-wait',
        actualCount: R().attachmentTiles().length, error: error?.message || String(error)
      } });
      throw error;
    }
    recordAdapterAction({ type: 'upload-file', name, details: { expectedCount, actualCount: tiles.length } });
    return { count: tiles.length, selector: currentInputInfo.selector };
  }

  async function uploadFiles({ files = [], debugOverlay = true, signal } = {}) {
    const list = Array.isArray(files) ? files.filter((file) => file?.dataUrl && file?.name) : [];
    if (!list.length) throw new Error('No files provided for upload');
    if (list.length === 1) {
      return uploadFile({ ...list[0], expectedCount: 1, debugOverlay, signal });
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    assertUploadAllowed();
    const inputInfo = await ensureUploadInput({ debugOverlay, signal });

    // ChatGPT's input accepts multiple files. One DataTransfer/change event
    // avoids waiting for four separate thumbnail-processing cycles. Older
    // builds or alternate UIs may expose a single-file input, so retain the
    // stable sequential fallback for those pages.
    if (inputInfo.element.multiple !== true) {
      const perFile = [];
      let count = R().attachmentTiles().length;
      for (const file of list) {
        const startedAt = Date.now();
        const result = await uploadFile({
          ...file,
          expectedCount: count + 1,
          debugOverlay,
          signal
        });
        count = result.count;
        perFile.push({ ...result, durationMs: Date.now() - startedAt });
      }
      return { count, selector: inputInfo.selector, mode: 'sequential', perFile };
    }

    const baselineCount = R().attachmentTiles().length;
    const plus = R().resolve('composerPlus').element;
    if (debugOverlay && plus) await O().highlightTarget(plus, { label: `Upload batch: ${list.length} files` });
    const startedAt = Date.now();
    const dataTransfer = new DataTransfer();
    for (const fileData of list) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const blob = await (await fetch(fileData.dataUrl, { signal })).blob();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      dataTransfer.items.add(new File(
        [blob],
        fileData.name,
        { type: fileData.type || blob.type || 'image/png', lastModified: Date.now() }
      ));
    }
    const freshInputInfo = await ensureUploadInput({ debugOverlay, signal });
    const input = freshInputInfo.element;
    if (input.multiple !== true) {
      const perFile = [];
      let count = baselineCount;
      for (const file of list) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const startedAt = Date.now();
        const result = await uploadFile({ ...file, expectedCount: count + 1, debugOverlay, signal });
        count = result.count;
        perFile.push({ ...result, durationMs: Date.now() - startedAt });
      }
      return { count, selector: freshInputInfo.selector, mode: 'sequential', perFile };
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    assertUploadAllowed();
    const dispatchDetails = {
      stage: 'dispatch', selector: freshInputInfo.selector || null,
      inputConnected: input.isConnected !== false, multiple: input.multiple === true,
      baselineCount, expectedCount: list.length
    };
    recordAdapterAction({ type: 'upload-dispatch', name: list.map((file) => file.name).join(', '), details: dispatchDetails });
    dispatchUploadFiles(input, dataTransfer.files);
    closeOwnedUploadMenu();
    let tiles;
    try {
      tiles = await waitForDomCondition({
        name: `attachment batch ${list.length}`,
        timeout: 90000,
        signal,
        preparationPage: true,
        predicate: () => {
          assertUploadAllowed({ checkPage: false });
          const xs = R().attachmentTiles();
          return xs.length >= baselineCount + list.length ? xs : null;
        }
      });
    } catch (error) {
      recordAdapterAction({ type: 'upload-dispatch-failed', details: {
        ...dispatchDetails, stage: signal?.aborted ? 'aborted-batch-wait' : 'attachment-batch-wait',
        actualCount: R().attachmentTiles().length, error: error?.message || String(error)
      } });
      throw error;
    }
    dispatchDetails.actualCount = tiles.length;
    const durationMs = Date.now() - startedAt;
    recordAdapterAction({
      type: 'upload-files-batch',
      name: list.map((file) => file.name).join(', '),
      details: { ...dispatchDetails, stage: 'dispatched', durationMs }
    });
    return { count: tiles.length, selector: freshInputInfo.selector, mode: 'batch', durationMs };
  }

  function normalizePromptText(text) {
    return String(text || '').replace(/\r\n/g, '\n');
  }

  function composerTextValue(editor) {
    return normalizePromptText(editor?.innerText || editor?.textContent || '').trim();
  }

  function composerContainsExpected(editor, expected) {
    const canonical = (value) => normalizePromptText(value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const current = canonical(editor?.innerText || editor?.textContent || '');
    const value = canonical(expected);
    if (!value) return current.length === 0;
    if (current === value) return true;
    if (current.length < Math.floor(value.length * 0.94)) return false;
    const edge = Math.min(160, value.length);
    return current.startsWith(value.slice(0, edge)) && current.endsWith(value.slice(-edge));
  }

  function fillComposerElement(editor, value) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('delete', false); } catch (_) {}
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch (_) {}
    if (!ok || !composerContainsExpected(editor, value)) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    }
  }

  async function setComposerText(text, { signal } = {}) {
    const value = normalizePromptText(text);
    const deadline = Date.now() + 10000;
    let attempts = 0;
    let lastSelector = null;

    // Image generation frequently re-mounts the composer exactly when the
    // result becomes visible. Writing into the old detached contenteditable
    // looks successful if we inspect that stale node, but ChatGPT never sees
    // the text and therefore never creates a Send button. Always verify the
    // CURRENT resolver node and re-apply the text after a re-mount.
    while (Date.now() < deadline && attempts < 4) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const info = R().resolve('composer');
      const editor = info.element;
      lastSelector = info.selector || lastSelector;
      if (!editor || !editor.isConnected || !R().visible(editor)) {
        await sleep(120);
        continue;
      }
      attempts += 1;
      fillComposerElement(editor, value);

      const settleUntil = Math.min(deadline, Date.now() + 1400);
      let stableNode = null;
      let stableSince = 0;
      while (Date.now() < settleUntil) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const fresh = R().resolve('composer').element;
        if (fresh && fresh.isConnected && R().visible(fresh) && composerContainsExpected(fresh, value)) {
          if (fresh !== stableNode) {
            stableNode = fresh;
            stableSince = Date.now();
          }
          // Require the same current composer to retain the prompt briefly.
          // This catches the common post-image re-render without adding a
          // noticeable fixed delay in the normal path.
          if (Date.now() - stableSince >= 180) {
            recordAdapterAction({ type: 'fill-composer', details: { length: value.length, attempts, remounted: fresh !== editor } });
            return { selector: info.selector || lastSelector, length: value.length, attempts };
          }
        } else {
          stableNode = null;
          stableSince = 0;
        }
        await sleep(70);
      }
    }

    const current = R().resolve('composer').element;
    const error = new Error('Composer text did not persist on the current ChatGPT editor');
    error.code = 'COMPOSER_TEXT_NOT_PERSISTED';
    error.responseText = composerTextValue(current).slice(0, 1000);
    throw error;
  }

  function isActualSendButton(element) {
    if (!element || !R().visible(element)) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    const semantic = [
      element.getAttribute('data-testid') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ').toLowerCase();
    // ChatGPT can reuse the composer submit control while the current answer
    // is still running. Never treat a Stop/Cancel control as Send.
    if (/(stop|cancel|abort|остан|прерват|отмен)/i.test(semantic)) return false;
    return true;
  }

  function isComposerReadyForInput(element) {
    if (!element || !R().visible(element)) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    const editable = element.getAttribute('contenteditable');
    return editable === null || editable === '' || editable === 'true';
  }

  async function waitForComposerReadyForInput({ timeout = 180000, signal, preparationPage = false } = {}) {
    let stableComposer = null;
    let stableSince = 0;
    return waitForDomCondition({
      name: 'composer ready for next input',
      timeout,
      signal,
      preparationPage,
      pollFallbackMs: 250,
      predicate: () => {
        if (R().stopGeneratingButton()) {
          stableComposer = null;
          stableSince = 0;
          return null;
        }
        const composer = R().resolve('composer').element;
        if (!isComposerReadyForInput(composer)) {
          stableComposer = null;
          stableSince = 0;
          return null;
        }
        if (composer !== stableComposer) {
          stableComposer = composer;
          stableSince = Date.now();
          return null;
        }
        // The assistant can drop the Stop button a few mutations before the
        // composer itself is re-mounted. A short identity-stability check is
        // enough to avoid writing into the outgoing node.
        return Date.now() - stableSince >= 180 ? composer : null;
      }
    });
  }

  async function waitForComposerReadyForSend({ timeout = 180000, signal } = {}) {
    return waitForDomCondition({
      name: 'composer ready for Send',
      timeout,
      signal,
      pollFallbackMs: 250,
      predicate: () => {
        if (R().stopGeneratingButton()) return null;
        const candidate = R().composerSendButton?.().element || R().resolve('send', { root: R().composerSurface?.() || document }).element;
        return isActualSendButton(candidate) ? candidate : null;
      }
    });
  }

  async function clickSendPrompt({ debugOverlay = true, signal, timeout = 180000 } = {}) {
    const send = await waitForComposerReadyForSend({ timeout, signal });
    // Capture baselines only after the previous answer has fully yielded the
    // composer, immediately before the real Send click.
    const baselineAssistantCount = R().assistantTurns().length;
    const baselineUserCount = R().userTurns().length;
    await safeClick(send, 'Click: Send', debugOverlay, assertChatMode);
    const sendClickedAtMs = Date.now();
    recordAdapterAction({ type: 'send-click', state: 'CLICKED', details: { baselineAssistantCount, baselineUserCount, sendClickedAtMs } });
    return { baselineAssistantCount, baselineUserCount, sendClickedAtMs };
  }

  async function waitForPromptAcceptance({ baselineAssistantCount = 0, baselineUserCount = 0, sendClickedAtMs = 0, timeout = 120000, signal, rateLimitScope = 'generation', expectedPrompt = null } = {}) {
    const startedAt = Date.now();
    const accepted = await waitForDomCondition({
      name: 'new user turn or accepted composer submit',
      timeout,
      signal,
      pollFallbackMs: 250,
      predicate: () => {
        const currentTurns = R().userTurns();
        if (currentTurns.length > baselineUserCount) {
          const acceptedTurn = currentTurns[currentTurns.length - 1] || null;
          return {
            mode: 'user-turn',
            userTurns: currentTurns.length,
            userTurnId: turnId(acceptedTurn)
          };
        }
        const rateLimit = R().dismissRateLimitDialog?.();
        if (rateLimit?.detected) {
          void notifyRateLimit(rateLimit, rateLimitScope);
          throw rateLimitError(rateLimit, { beforeAssistant: true });
        }
        const latchedRateLimit = recentRateLimitForSend(sendClickedAtMs, rateLimitScope);
        if (latchedRateLimit) throw rateLimitError(latchedRateLimit, { beforeAssistant: true });

        // ChatGPT occasionally changes the turn DOM before/after the message
        // list selector catches up. If the exact prompt has been consumed from
        // the CURRENT composer after our click, the submit was accepted even
        // if [data-turn=user] has not mounted yet. This avoids a false 30s
        // timeout while the assistant is already answering.
        if (expectedPrompt) {
          const composer = R().resolve('composer').element;
          const stillContainsPrompt = composerContainsExpected(composer, expectedPrompt);
          const currentText = composerTextValue(composer);
          const elapsed = Date.now() - Math.max(startedAt, Number(sendClickedAtMs || 0));
          if (!stillContainsPrompt && currentText.length === 0 && elapsed >= 350) {
            return { mode: 'composer-consumed', userTurns: currentTurns.length };
          }
        }
        return null;
      }
    });
    recordAdapterAction({ type: 'send-prompt', state: 'ACCEPTED', details: { baselineAssistantCount, baselineUserCount, acceptanceMode: accepted.mode } });
    return {
      baselineAssistantCount,
      baselineUserCount,
      userTurns: accepted.userTurns,
      sendClickedAtMs,
      acceptanceMode: accepted.mode,
      userTurnId: accepted.userTurnId || null
    };
  }

  async function sendPrompt({ debugOverlay = true, signal, rateLimitScope = 'generation' } = {}) {
    const click = await clickSendPrompt({ debugOverlay, signal });
    try {
      const accepted = await waitForPromptAcceptance({ ...click, signal, rateLimitScope });
      return { ...click, ...accepted };
    } catch (error) {
      // The physical Send click already happened even if ChatGPT never mounted
      // the new user turn before the acceptance timeout. Callers must not send
      // the same prompt a second time in that situation.
      error.promptSubmitted = true;
      error.sendClickedAtMs = click.sendClickedAtMs;
      throw error;
    }
  }

  function turnId(turn) {
    return String(turn?.getAttribute?.('data-turn-id') || turn?.getAttribute?.('data-turn-id-container') || '').trim() || null;
  }

  function assistantTurnsAfterUserTurn(userTurnId) {
    const id = String(userTurnId || '').trim();
    if (!id) return [];
    const user = R().userTurns().find((turn) => turnId(turn) === id) || null;
    if (!user) return [];
    return R().assistantTurns().filter((turn) => Boolean(user.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING));
  }

  function latestFactsUserTurn() {
    const turns = R().userTurns();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const text = String(turn?.innerText || turn?.textContent || '');
      if (text.includes('Рассмотри ТОЛЬКО последнее сгенерированное изображение')
        && text.includes('"titleBrand"')
        && text.includes('"uncertain"')) return turn;
    }
    return null;
  }

  function inspectFactsResponse({ baselineAssistantCount = 0, afterUserTurnId = null } = {}) {
    const allTurns = R().assistantTurns();
    const explicitUserTurn = afterUserTurnId
      ? R().userTurns().find((turn) => turnId(turn) === String(afterUserTurnId)) || null
      : null;
    const recoveryUserTurn = explicitUserTurn || (!afterUserTurnId ? latestFactsUserTurn() : null);
    const userTurnFound = Boolean(recoveryUserTurn);
    const targetedTurns = recoveryUserTurn
      ? allTurns.filter((turn) => Boolean(recoveryUserTurn.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING))
      : [];
    const candidates = recoveryUserTurn ? targetedTurns : allTurns.slice(Math.max(0, baselineAssistantCount));
    if (!candidates.length) {
      return {
        state: 'waiting-assistant',
        complete: false,
        assistantCount: allTurns.length,
        userTurnFound,
        assistantTurnFound: false,
        lastDomInspectionAt: new Date().toISOString(),
        visibilityState: document.visibilityState || null
      };
    }
    const completed = completeFactsTurn(candidates);
    const latest = completed?.turn || candidates[candidates.length - 1];
    const text = completed?.text || turnText(latest, 64000);
    const complete = Boolean(completed);
    return {
      state: complete ? 'complete' : 'streaming',
      complete,
      text,
      characters: text.length,
      assistantCount: allTurns.length,
      userTurnFound,
      assistantTurnFound: true,
      lastDomInspectionAt: new Date().toISOString(),
      assistantTurnId: turnId(latest),
      factsUserTurnId: turnId(recoveryUserTurn),
      modelSlug: latest.querySelector?.('[data-message-model-slug]')?.getAttribute?.('data-message-model-slug') || null,
      responseActions: Boolean(R().hasResponseActions(latest)),
      stopVisible: Boolean(R().stopGeneratingButton()),
      visibilityState: document.visibilityState || null
    };
  }

  async function waitForSettledAssistantText({
    baselineAssistantCount = 0,
    afterUserTurnId = null,
    timeout = 120000,
    signal,
    rateLimitScope = 'postprocess',
    requireCompleteFactsJson = false,
    onProgress = null
  } = {}) {
    let lastText = '';
    let stableSince = 0;
    let responseStarted = false;
    const RESPONSE_ACTION_STABLE_MS = 1200;
    const notifyProgress = (payload) => {
      try { if (typeof onProgress === 'function') onProgress(payload); } catch (_) {}
    };

    // Use one deadline for both "wait until an assistant turn exists" and
    // "wait until that turn settles". The old implementation could spend the
    // timeout twice and, more importantly, identified replies only by a global
    // assistant count. A specific OCR request is now anchored to the exact user
    // turn that submitted it whenever that turn id is available.
    return waitForDomCondition({
      name: 'settled assistant text',
      timeout,
      signal,
      pollFallbackMs: 350,
      predicate: () => {
        const rateLimit = R().dismissRateLimitDialog?.();
        if (rateLimit?.detected) {
          void notifyRateLimit(rateLimit, rateLimitScope);
          const targeted = afterUserTurnId ? assistantTurnsAfterUserTurn(afterUserTurnId) : [];
          const accepted = targeted.length > 0 || R().assistantTurns().length > baselineAssistantCount;
          if (!accepted) throw rateLimitError(rateLimit, { beforeAssistant: true });
        }

        const allTurns = R().assistantTurns();
        const explicitUserTurn = afterUserTurnId
          ? R().userTurns().find((turn) => turnId(turn) === String(afterUserTurnId)) || null
          : null;
        const factsUserTurn = explicitUserTurn || latestFactsUserTurn();
        const targetedTurns = factsUserTurn
          ? allTurns.filter((turn) => Boolean(factsUserTurn.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING))
          : [];
        const candidates = factsUserTurn ? targetedTurns : allTurns.slice(Math.max(0, baselineAssistantCount));
        if (!candidates.length) {
          if (!responseStarted) notifyProgress({ phase: 'waiting-assistant' });
          return null;
        }

        const completed = requireCompleteFactsJson ? completeFactsTurn(candidates) : null;
        const latest = completed?.turn || candidates[candidates.length - 1];
        const text = completed?.text || turnText(latest, 64000);
        if (!responseStarted) {
          responseStarted = true;
          notifyProgress({
            phase: 'assistant-started',
            assistantTurnId: turnId(latest),
            modelSlug: latest.querySelector?.('[data-message-model-slug]')?.getAttribute?.('data-message-model-slug') || null
          });
        }
        if (!text) return null;

        const now = Date.now();
        if (text !== lastText) {
          lastText = text;
          stableSince = now;
        }

        if (requireCompleteFactsJson) {
          // For OCR facts, the JSON envelope itself is authoritative. Return as
          // soon as all required fields are present; do not wait for action
          // buttons or for the composer Stop control to disappear.
          if (completed) {
            return {
              text,
              assistantCount: allTurns.length,
              assistantTurnId: turnId(latest),
              completion: 'facts-json-complete'
            };
          }

          // IMPORTANT: never classify a merely quiet partial stream as final.
          // Real diagnostics showed ChatGPT pausing for 15-45 seconds after
          // emitting only '{"titleBrand":...' and then continuing later. The
          // old long-stable fallback caused FACTS_JSON_INCOMPLETE/PARSE on a
          // response that eventually became valid. Only explicit final response
          // actions may prove that a malformed answer is actually finished.
          const quietMs = stableSince ? now - stableSince : 0;
          if (!R().stopGeneratingButton() && R().hasResponseActions(latest) && quietMs >= RESPONSE_ACTION_STABLE_MS) {
            return {
              text,
              assistantCount: allTurns.length,
              assistantTurnId: turnId(latest),
              completion: 'response-actions-incomplete'
            };
          }
          return null;
        }

        if (R().stopGeneratingButton()) return null;
        if (R().hasResponseActions(latest) || (stableSince && now - stableSince >= 900)) {
          return { text, assistantCount: allTurns.length, assistantTurnId: turnId(latest) };
        }
        return null;
      }
    });
  }

  function inspectGeneratedImage({ baselineAssistantCount = 0 } = {}) {
    const rateLimit = R().rateLimitDialog?.();
    const turns = R().assistantTurns();
    const userCount = R().userTurns().length;
    const latest = R().latestAssistantTurn();
    const img = R().generatedImage(latest);
    if (img && img.complete && (img.naturalWidth > 0 || Number(img.getAttribute('width')) >= 256)) {
      return reportInspection({
        state: 'READY',
        assistantCount: turns.length,
        userCount,
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth || Number(img.getAttribute('width')) || 0,
        height: img.naturalHeight || Number(img.getAttribute('height')) || 0
      });
    }

    // The image element may already be mounted while its authenticated source
    // is still loading. Preserve the live-generation state and keep polling.
    if (img && (img.currentSrc || img.src)) {
      return reportInspection({
        state: 'WAITING_IMAGE',
        assistantCount: turns.length,
        userCount,
        settled: false,
        imageCandidate: true,
        // Keep the authenticated source when a background tab has mounted
        // the image element but has not decoded it yet. The page-side fetch
        // can still retrieve this source and hand it to chrome.downloads.
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth || Number(img.getAttribute('width')) || 0,
        height: img.naturalHeight || Number(img.getAttribute('height')) || 0,
        declaredWidth: Number(img.getAttribute('width')) || 0,
        declaredHeight: Number(img.getAttribute('height')) || 0
      });
    }

    const conversationLoadError = R().visibleConversationLoadError?.();
    if (conversationLoadError) {
      const text = (conversationLoadError.innerText || conversationLoadError.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 3000);
      return reportInspection({
        state: 'CONVERSATION_LOAD_ERROR',
        errorClass: 'CONVERSATION_LOAD_ERROR',
        error: text || 'Не удалось загрузить этот разговор ChatGPT',
        responseText: text,
        assistantCount: turns.length,
        userCount
      });
    }

    if (turns.length <= baselineAssistantCount) {
      return reportInspection({ state: 'WAITING_ASSISTANT', assistantCount: turns.length, userCount });
    }

    // A modal must never mask a usable image. Only surface the rate limit
    // after checking both READY and mounted-image states above.
    if (rateLimit) {
      return reportInspection({
        state: 'RATE_LIMIT_PAUSE',
        rateLimit: true,
        assistantCount: turns.length,
        userCount,
        error: (rateLimit.innerText || rateLimit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
      });
    }

    const uiErrors = R().visibleErrors?.() || [];
    if (uiErrors.length) {
      const text = uiErrors
        .map((item) => (item.innerText || item.textContent || '').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 12000);
      return reportInspection({ state: 'ERROR', error: `CHATGPT_UI_ERROR: ${text || 'visible error element'}`, responseText: text, assistantCount: turns.length, userCount });
    }

    const stop = R().stopGeneratingButton();
    const settled = !stop && R().hasResponseActions(latest);
    const outcome = settled ? classifyAssistantOutcome(latest) : { kind: 'GENERATING', code: null, terminal: false, text: '' };
    if (settled && outcome.terminal) {
      return reportInspection({
        state: 'ERROR',
        error: `${outcome.code}: ${outcome.text.slice(0, 500)}`,
        errorClass: outcome.code,
        responseText: outcome.text,
        assistantCount: turns.length,
        userCount,
        settled: true
      });
    }
    return reportInspection({
      state: settled ? 'WAITING_IMAGE' : 'GENERATING',
      assistantCount: turns.length,
      userCount,
      settled,
      responseText: settled ? outcome.text : '',
      outcome: outcome.kind
    });
  }

  async function waitForGeneratedImage({ baselineAssistantCount = 0, timeout = 900000, debugOverlay = true, signal, onTimeout = null } = {}) {
    const started = Date.now();
    let settledWithoutImageAt = 0;
    let mountedSource = '';
    let mountedSince = 0;
    let timeoutReported = false;
    const mountedSourceGraceMs = 350;
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const elapsedMs = Date.now() - started;
      if (!timeoutReported && Number(timeout) > 0 && elapsedMs >= Number(timeout)) {
        timeoutReported = true;
        try { onTimeout?.({ timeoutMs: Number(timeout), elapsedMs }); } catch (_) {}
      }
      const rateLimit = R().dismissRateLimitDialog?.();
      if (rateLimit?.detected) {
        // The prompt has already been accepted at this point. Close the modal,
        // notify the worker so it pauses future sends, and continue observing
        // this conversation. Aborting here used to strand generated images.
        await notifyRateLimit(rateLimit);
      }
      const latest = R().assistantTurns().length > baselineAssistantCount
        ? R().latestAssistantTurn()
        : null;
      const img = R().generatedImage(latest);
      const imageCandidate = img && (img.currentSrc || img.src);

      // As soon as the final image element has a decoded bitmap, the URL is
      // already usable. The former unconditional 1.8s sleep only added latency.
      if (img && imageCandidate && img.complete && img.naturalWidth > 0) {
        if (debugOverlay) await O().highlightTarget(img, { label: 'Generated image ready' });
        return {
          src: imageCandidate,
          alt: img.alt || '',
          width: img.naturalWidth || Number(img.getAttribute('width')) || 0,
          height: img.naturalHeight || Number(img.getAttribute('height')) || 0
        };
      }

      // Background tabs may mount the authenticated image URL long before
      // Chrome decodes it. A stable source is sufficient for chrome.downloads
      // and should not wait 10+ seconds for naturalWidth.
      if (imageCandidate) {
        const source = String(imageCandidate);
        if (source !== mountedSource) {
          mountedSource = source;
          mountedSince = Date.now();
        } else if (mountedSince && Date.now() - mountedSince >= mountedSourceGraceMs) {
          return {
            src: source,
            alt: img?.alt || '',
            width: img?.naturalWidth || Number(img?.getAttribute?.('width')) || 0,
            height: img?.naturalHeight || Number(img?.getAttribute?.('height')) || 0,
            mountedOnly: true
          };
        }
      } else {
        mountedSource = '';
        mountedSince = 0;
      }

      const uiErrors = R().visibleErrors?.() || [];
      if (uiErrors.length && !imageCandidate) {
        const text = uiErrors.map((item) => (item.innerText || item.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 12000);
        const err = new Error(`CHATGPT_UI_ERROR: ${text || 'visible error element'}`);
        err.responseText = text;
        throw err;
      }
      const stop = R().stopGeneratingButton();
      if (!stop && R().hasResponseActions(latest) && !imageCandidate) {
        const outcome = classifyAssistantOutcome(latest);
        if (outcome.terminal) {
          const err = new Error(`${outcome.code}: ${outcome.text.slice(0, 500)}`);
          err.code = outcome.code;
          err.responseText = outcome.text;
          err.generationSubmitted = true;
          throw err;
        }
        // ChatGPT can mount an empty assistant shell (including response
        // actions) before the image tool/result itself appears. An empty turn
        // is not a text-only response and must never start the text-only timer.
        if (outcome.kind === 'TEXT_ONLY' && outcome.text.trim().length >= 12) {
          if (!settledWithoutImageAt) settledWithoutImageAt = Date.now();
          if (Date.now() - settledWithoutImageAt > TEXT_ONLY_RESPONSE_GRACE_MS) {
            const err = new Error('TEXT_ONLY_RESPONSE: assistant response finished without generated image');
            err.code = 'TEXT_ONLY';
            err.responseText = outcome.text;
            err.generationSubmitted = true;
            throw err;
          }
        } else {
          settledWithoutImageAt = 0;
        }
      } else {
        settledWithoutImageAt = 0;
      }
      // A generation can legitimately take longer than the configured
      // observation window. Treat that value as a warning threshold, not as
      // proof that the submitted request failed. The service worker continues
      // its independent DOM probes as well; the slower page poll reduces work
      // while keeping late results recoverable.
      await sleep(1000);
    }
  }

  function dryRunReport() {
    const names = ['newChat', 'composer', 'composerPlus', 'fileInput', 'send'];
    const report = {};
    for (const name of names) {
      const item = R().resolve(name, { visibleOnly: name !== 'fileInput' && name !== 'send' });
      report[name] = { found: !!item.element, strategy: item.strategy, selector: item.selector, confidence: item.confidence };
    }
    report.attachmentCount = R().attachmentTiles().length;
    report.assistantTurns = R().assistantTurns().length;
    report.lastUpload = lastUploadObservation ? { ...lastUploadObservation } : null;
    report.uploadInputRecovery = lastUploadInputObservation ? { ...lastUploadInputObservation } : null;
    report.fileInputDiagnostics = uploadInputDiagnostics();
    const historyError = R().visibleHistoryLoadError?.();
    report.historyWarning = historyError
      ? String(historyError.innerText || historyError.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600) : null;
    return report;
  }

  async function visualizeDryRun(report) {
    for (const [name, data] of Object.entries(report)) {
      if (!data || !data.found || !['newChat','composer','composerPlus','send'].includes(name)) continue;
      const item = R().resolve(name, { visibleOnly: true });
      if (item.element) await O().highlightTarget(item.element, { label: `Dry Run: ${name}` });
    }
  }


  function composerHasText(expected) {
    const editor = R().resolve('composer').element;
    return composerContainsExpected(editor, expected);
  }

  window.WatchChatGPTAdapter = {
    waitForDomCondition, safeClick, ensureNewChat, ensureChatMode, assertChatMode, chatModeState, assertPreparationPageReady, ensureUploadInput, uploadFile, uploadFiles, setComposerText, composerHasText,
    waitForComposerReadyForInput, waitForComposerReadyForSend, clickSendPrompt, waitForPromptAcceptance, sendPrompt, waitForSettledAssistantText, inspectFactsResponse,
    inspectGeneratedImage, waitForGeneratedImage, classifyAssistantOutcome, noteRateLimit,
    latestAssistantTurn: () => R().latestAssistantTurn(),
    latestUserTurn: () => R().latestUserTurn?.() || R().userTurns().at(-1) || null,
    dryRunReport, visualizeDryRun
  };
  // Only the managed empty landing page may switch modes automatically.
  // Saved conversations and any prepared inputs are verified without edits.
  if (typeof location !== 'undefined' && location.pathname === '/' && new URL(location.href).searchParams.get('watch_automation') === '1') {
    ensureChatMode().catch((error) => recordAdapterAction({ type: 'chat-mode', state: 'ERROR', details: { error: error.message } }));
  }
})();
