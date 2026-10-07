(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  const visible = (el) => {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };

  const firstVisible = (selector, root = document) => [...root.querySelectorAll(selector)].find(visible) || null;

  const strategies = {
    newChat: [
      ['data-testid', '[data-testid="create-new-chat-button"]', 0.98],
      ['aria-label-ru', 'a[aria-label="Новый чат"]', 0.90],
      ['href-root', 'a[href="/"][data-sidebar-item="true"]', 0.68]
    ],
    composer: [
      ['id', '#prompt-textarea[contenteditable="true"]', 0.99],
      ['aria-role', '[role="textbox"][contenteditable="true"][aria-label*="ChatGPT"]', 0.93],
      ['contenteditable', '[data-composer-body] [contenteditable="true"]', 0.85]
    ],
    composerPlus: [
      ['data-testid', '[data-testid="composer-plus-btn"]', 0.99],
      ['id', '#composer-plus-btn', 0.97],
      ['aria-ru', 'button[aria-label="Добавить файлы и другое"]', 0.91]
    ],
    fileInput: [
      ['data-testid', 'input[data-testid="upload-photos-input"][type="file"]', 0.99],
      ['id', 'input#upload-photos[type="file"]', 0.98],
      ['photo-upload', 'input#upload-files[data-photo-upload-enabled="true"][type="file"]', 0.91],
      ['accept-image', 'input[type="file"][accept^="image/"]', 0.75],
      ['upload-files-id', 'input#upload-files[type="file"]', 0.90]
    ],
    send: [
      ['id', '#composer-submit-button', 1.00],
      ['data-testid', '[data-testid="send-button"]', 0.99],
      ['aria-ru', 'button[aria-label="Отправить промпт"]', 0.95],
      ['submit', 'form button[type="submit"]', 0.72]
    ]
  };

  const emptyResolution = () => ({ element: null, strategy: null, selector: null, confidence: 0 });
  const attr = (element, name) => String(element?.getAttribute?.(name) || '').trim();
  const unavailableInput = (element) => element.disabled === true || element.matches?.(':disabled')
    || attr(element, 'aria-disabled') === 'true';
  const inputSurface = (composer) => composer?.closest('[data-composer-surface="true"]')
    || composer?.closest('form') || composer?.parentElement || null;
  const NON_ATTACHMENT_CONTEXT = /(?:avatar|profile|account|import|restore|settings|аватар|профил|аккаунт|импорт|настройк)/i;
  const UPLOAD_INPUT_LABEL = /^(?:(?:upload|attach|add|choose|select)\s+(?:files?|photos?|images?)(?:\s+and\s+more)?|(?:загрузить|прикрепить|добавить|выбрать)\s+(?:файл(?:ы)?|фотографи[июи]|фото|изображени[ея])(?:\s+и\s+(?:другое|ещё|еще))?)$/i;
  const COMPOSER_PLUS_LABEL = /^(?:add\s+(?:files?|photos?|attachments?)(?:\s+(?:and\s+(?:more|photos)|or\s+photos))?|add\s+photos\s+(?:and|&)\s+files|attach\s+files?|добавить\s+(?:файлы|фото|вложения)(?:\s+и\s+(?:другое|ещё|еще|файлы|фото))?|прикрепить\s+файлы)$/i;

  function imageAccept(accept) {
    return accept.split(',').some((token) => /^(?:image\/[a-z0-9.+*-]+|\*\/\*|\.(?:png|jpe?g|jpe|gif|webp|bmp|avif|heic|heif|tiff?|ico|svg))$/i.test(token.trim()));
  }

  function fileInputCandidates(root = document) {
    const byElement = new Map();
    for (const [strategy, selector, confidence] of strategies.fileInput) {
      for (const element of root.querySelectorAll(selector)) {
        if (!byElement.has(element)) byElement.set(element, { element, strategy, selector, confidence });
      }
    }
    for (const element of root.querySelectorAll('input[type="file"]')) {
      if (!byElement.has(element)) byElement.set(element, {
        element, strategy: 'composer-file-input', selector: 'input[type="file"]', confidence: 0.70
      });
    }
    const composer = resolve('composer', { root }).element;
    const surface = inputSurface(composer);
    const candidates = [...byElement.values()].map((candidate) => {
      const { element, strategy } = candidate;
      const reasons = [];
      const inActiveComposer = Boolean(surface?.contains?.(element));
      const owner = element.closest?.('[data-composer-surface="true"]') || element.closest?.('form');
      const owningForm = element.closest?.('form');
      const activeForm = composer?.closest?.('form');
      const accept = attr(element, 'accept');
      const identity = ['id', 'data-testid', 'name', 'aria-label', 'title'].map((name) => attr(element, name)).join(' ');
      const identifiedUpload = ['data-testid', 'id', 'photo-upload', 'upload-files-id'].includes(strategy)
        || /^(?:upload|attach)-(?:photos?|images?|files?)(?:-input)?$/i.test(attr(element, 'data-testid'))
        || UPLOAD_INPUT_LABEL.test(attr(element, 'aria-label')) || UPLOAD_INPUT_LABEL.test(attr(element, 'title'));
      const supportsImages = imageAccept(accept) || (!accept && strategy === 'accept-image');
      if (element.isConnected === false) reasons.push('disconnected');
      if (unavailableInput(element)) reasons.push('disabled');
      if (NON_ATTACHMENT_CONTEXT.test(identity)) reasons.push('unrelated-file-purpose');
      const excludedSelector = '[data-turn], [data-message-author-role], [data-testid^="conversation-turn"], nav, aside, [role="navigation"], [data-watch-automation-overlay]';
      const excludedOwner = element.closest?.(excludedSelector);
      if (excludedOwner?.matches?.(excludedSelector)) reasons.push('outside-attachment-ui');
      // Hidden inputs in the active composer or a known upload portal are
      // expected. A matching control inside an old composer/form is stale.
      if (owner && !inActiveComposer) reasons.push('inactive-or-unrelated-surface');
      if (owningForm && activeForm && owningForm !== activeForm) reasons.push('inactive-composer-form');
      for (let ancestor = element.parentElement, depth = 0; ancestor && depth < 6; ancestor = ancestor.parentElement, depth++) {
        const contextIdentity = ['id', 'data-testid', 'aria-label'].map((name) => attr(ancestor, name)).join(' ');
        if (NON_ATTACHMENT_CONTEXT.test(contextIdentity)) { reasons.push('unrelated-file-surface'); break; }
      }
      if (accept && !supportsImages) reasons.push('accept-excludes-images');
      if (!inActiveComposer && !identifiedUpload) reasons.push('unidentified-portal');
      return { ...candidate, inActiveComposer, identifiedUpload, supportsImages,
        rejectionReasons: [...new Set(reasons)], eligible: reasons.length === 0 };
    });
    const eligible = candidates.filter((candidate) => candidate.eligible);
    const selected = eligible.find((candidate) => candidate.inActiveComposer) || eligible[0] || null;
    return { composer, surface, candidates, selected };
  }

  function fileInputDiagnostics({ root = document, maxCandidates = 20 } = {}) {
    const report = fileInputCandidates(root);
    const limit = Math.min(20, Math.max(1, Number(maxCandidates) || 20));
    return {
      composerFound: Boolean(report.composer), composerSurfaceFound: Boolean(report.surface),
      totalCandidates: report.candidates.length, truncated: report.candidates.length > limit,
      candidates: report.candidates.slice(0, limit).map((candidate, index) => {
        const element = candidate.element;
        // Never serialize a file value, filenames, files, markup or contents.
        const attributes = Object.fromEntries(['id', 'type', 'accept', 'data-testid', 'data-photo-upload-enabled', 'aria-disabled']
          .map((name) => [name, attr(element, name).slice(0, 160) || null]));
        return { index, attributes, disabled: unavailableInput(element), multiple: element.multiple === true,
          connected: element.isConnected !== false, visible: visible(element),
          inActiveComposer: candidate.inActiveComposer, identifiedUpload: candidate.identifiedUpload,
          supportsImages: candidate.supportsImages, eligible: candidate.eligible,
          selected: candidate === report.selected, strategy: candidate.strategy,
          rejectionReasons: candidate.rejectionReasons };
      })
    };
  }

  function resolveComposerPlus({ visibleOnly = true, root = document } = {}) {
    const composer = resolve('composer', { root }).element;
    const surface = inputSurface(composer);
    if (!surface) return emptyResolution();
    const activeForm = composer?.closest?.('form');
    const usable = (node) => {
      const owningForm = node.closest?.('form');
      return node.isConnected !== false && !unavailableInput(node) && (!visibleOnly || visible(node))
        && !(owningForm && activeForm && owningForm !== activeForm);
    };
    for (const [strategy, selector, confidence] of strategies.composerPlus) {
      const element = [...surface.querySelectorAll(selector)]
        .find(usable);
      if (element) return { element, strategy, selector, confidence };
    }
    const element = [...surface.querySelectorAll('button, [role="button"]')].find((node) => (
      usable(node)
      && [attr(node, 'aria-label'), attr(node, 'title'), String(node.innerText || node.textContent || '').trim()]
        .some((label) => COMPOSER_PLUS_LABEL.test(label))
    ));
    return element ? { element, strategy: 'composer-attachment-label', selector: 'button, [role="button"]', confidence: 0.87 } : emptyResolution();
  }

  function resolve(name, { visibleOnly = true, root = document } = {}) {
    const list = strategies[name] || [];
    if (name === 'fileInput') {
      const selected = fileInputCandidates(root).selected;
      return selected ? { element: selected.element, strategy: selected.strategy, selector: selected.selector, confidence: selected.confidence } : emptyResolution();
    }
    if (name === 'composerPlus') return resolveComposerPlus({ visibleOnly, root });
    for (const [strategy, selector, confidence] of list) {
      const el = visibleOnly ? firstVisible(selector, root) : root.querySelector(selector);
      if (el) return { element: el, strategy, selector, confidence };
    }
    return emptyResolution();
  }

  function conversationTurns(role) {
    const direct = [...document.querySelectorAll(`[data-turn="${role}"]`)];
    if (direct.length) return direct;

    // ChatGPT has used several turn containers. Keep the role anchored to
    // message metadata or its accessible heading, never to sidebar text.
    const attributed = [...document.querySelectorAll(`[data-message-author-role="${role}"]`)]
      .map((node) => node.closest('[data-testid^="conversation-turn"], article') || node);
    if (attributed.length) return [...new Set(attributed)];

    const headingPattern = role === 'assistant'
      ? /^(?:ChatGPT сказал|ChatGPT said|Assistant)\s*:?$/i
      : /^(?:Вы сказали|You said)\s*:?$/i;
    const headings = [...document.querySelectorAll('h3, h4, h5, [role="heading"]')]
      .filter((node) => headingPattern.test(String(node.textContent || '').trim()));
    return [...new Set(headings.map((node) => (
      node.closest('[data-testid^="conversation-turn"], article') || node.parentElement?.parentElement
    )).filter(Boolean))];
  }

  function assistantTurns() {
    return conversationTurns('assistant');
  }

  function userTurns() {
    return conversationTurns('user');
  }

  function latestAssistantTurn() {
    const turns = assistantTurns();
    return turns[turns.length - 1] || null;
  }

  function latestUserTurn() {
    const turns = userTurns();
    return turns[turns.length - 1] || null;
  }

  function generatedImage(turn = latestAssistantTurn()) {
    const namedImages = 'img[alt^="Сгенерированное изображение"], img[alt^="Сформированное изображение"], img[alt^="Generated image"]';
    const labeledButtons = 'button[aria-label^="Сгенерированное изображение"] img, button[aria-label^="Generated image"] img';
    const local = turn ? [
      ...turn.querySelectorAll(namedImages),
      ...turn.querySelectorAll(labeledButtons),
      ...turn.querySelectorAll('[id^="image-"] img:not([aria-hidden="true"])')
    ] : [];
    // An image can be visible before a recognizable assistant container
    // exists. This also recovers already-generated images in paused chats.
    const candidates = local.length ? local : [
      ...document.querySelectorAll(namedImages),
      ...document.querySelectorAll(labeledButtons)
    ];
    const usable = candidates.filter((img) => {
      const rect = img.getBoundingClientRect();
      const source = img.currentSrc || img.src;
      const intrinsic = img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256;
      const declared = Number(img.getAttribute('width')) >= 256 && Number(img.getAttribute('height')) >= 256;
      const laidOut = rect.width > 100 && rect.height > 100;
      // Фоновые вкладки иногда ещё не получили layout-размер изображения.
      // При загруженном источнике и достаточном intrinsic/declared размере
      // картинка всё равно пригодна для скачивания.
      return !!source && (laidOut || intrinsic || declared);
    });
    usable.sort((a, b) => {
      const aArea = Math.max(a.getBoundingClientRect().width * a.getBoundingClientRect().height, a.naturalWidth * a.naturalHeight);
      const bArea = Math.max(b.getBoundingClientRect().width * b.getBoundingClientRect().height, b.naturalWidth * b.naturalHeight);
      return bArea - aArea;
    });
    return usable[0] || null;
  }

  function attachmentTiles() {
    const composer = resolve('composer').element;
    if (!composer) return [];
    const surface = composer.closest('[data-composer-surface="true"]') || composer.closest('form') || composer.parentElement;
    if (!surface) return [];
    // ChatGPT also renders image previews as plain img elements above the form.
    // Walk only the composer's own ancestors; chat turns and navigation never
    // count as pending attachments.
    let container = surface;
    let tiles = [];
    for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
      const groups = [...container.querySelectorAll('[role="group"][aria-label]')].filter((el) => {
        const label = el.getAttribute('aria-label') || '';
        return label && !!el.querySelector('img, button[aria-label*="изображение"], button[aria-label*="image"]');
      });
      const previews = [...container.querySelectorAll('img')].filter((img) => {
        if (!img.isConnected || img.closest('[data-turn], nav, aside, [role="navigation"]')) return false;
        if (!img.currentSrc && !img.src) return false;
        const rect = img.getBoundingClientRect();
        return (rect.width >= 40 && rect.height >= 40)
          || (img.naturalWidth >= 40 && img.naturalHeight >= 40);
      });
      tiles = groups.length >= previews.length ? groups : previews;
      if (tiles.length && container.matches('main, [role="main"]')) break;
      if (container.matches('main, [role="main"], body')) break;
    }
    return tiles;
  }

  function hasResponseActions(turn) {
    if (!turn) return false;
    return !!turn.querySelector('[data-testid="copy-turn-action-button"], [aria-label="Действия с ответом"]');
  }

  function composerSurface(composer = resolve('composer').element) {
    return composer
      ? (composer.closest('form') || composer.closest('[data-composer-surface="true"]') || composer.parentElement)
      : null;
  }

  function composerSendButton() {
    const composer = resolve('composer').element;
    const surface = composerSurface(composer);
    if (!surface) return { element: null, strategy: null, selector: null, confidence: 0 };
    return resolve('send', { visibleOnly: true, root: surface });
  }

  function stopGeneratingButton() {
    // Only explicit generation-stop controls inside the composer are
    // authoritative. A broad data-testid wildcard also catches unrelated
    // voice/audio controls in some ChatGPT builds and can block postprocess
    // forever even though the image generation already finished.
    const surface = composerSurface();
    if (!surface) return null;
    const candidates = [
      'button[data-testid="stop-button"]',
      'button[data-testid="stop-generating-button"]',
      'button[aria-label="Остановить создание"]',
      'button[aria-label="Остановить генерацию"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]'
    ];
    for (const selector of candidates) {
      const el = firstVisible(selector, surface);
      if (el) return el;
    }
    return null;
  }

  const RATE_LIMIT_PATTERN = /(слишком\s+много\s+запросов|слишком\s+часто|временно\s+ограничен|too\s+many\s+requests|rate\s*limit|temporarily\s+restricted)/i;

  function isRateLimitText(text) {
    return RATE_LIMIT_PATTERN.test(text) || globalThis.WatchQuotaUtils?.isImageLimitText(text) === true;
  }

  function rateLimitDialogs(root = document) {
    const scoped = root === document ? document : root;
    const primary = [...scoped.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-testid*="modal" i]')];
    const fallback = [...scoped.querySelectorAll('div, section, main, aside, dialog')].filter((element) => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length >= 20 && text.length <= 500 && isRateLimitText(text);
    });
    const candidates = [...primary, ...fallback];
    return [...new Set(candidates)]
      .filter((element) => visible(element))
      .filter((element) => !element.closest('[data-turn], [data-message-author-role], [data-testid^="conversation-turn"], [contenteditable="true"], [data-watch-automation-overlay]'))
      .filter((element) => !element.querySelector('[data-turn], [data-message-author-role], [data-testid^="conversation-turn"]'))
      .filter((element) => isRateLimitText((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()))
      .sort((a, b) => {
        const hasResetTime = (element) => /(?:попробуйте\s+снова\s+в|try\s+again\s+at)\s*\d{1,2}:\d{2}/i
          .test(element.innerText || element.textContent || '');
        if (hasResetTime(a) !== hasResetTime(b)) return hasResetTime(b) ? 1 : -1;
        return (a.innerText || '').length - (b.innerText || '').length;
      });
  }

  function rateLimitDialog(root = document) {
    return rateLimitDialogs(root)[0] || null;
  }

  function dismissRateLimitDialog(root = document) {
    const dialog = rateLimitDialog(root);
    if (!dialog) return { detected: false, dismissed: false, text: '' };
    const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const buttonMatches = (element) => {
      const label = `${element.innerText || element.textContent || ''} ${element.getAttribute('aria-label') || ''}`.trim();
      return /^(понятно|ok|okay|got\s+it|close|закрыть)$/i.test(label) || /понятно|got\s+it/i.test(label);
    };
    const button = [...dialog.querySelectorAll('button, [role="button"]')].find(buttonMatches)
      || [...document.querySelectorAll('button, [role="button"]')].find((element) => visible(element) && buttonMatches(element));
    if (button) button.click();
    return { detected: true, dismissed: Boolean(button), text };
  }

  const HISTORY_LOAD_PATTERN = /(?:не\s+удалось|не\s+получилось|невозможно)\s+(?:загрузить|получить)\s+(?:историю|список\s+(?:чатов|разговоров))|(?:unable|failed|could\s+not)\s+to\s+load\s+(?:(?:chat|conversation)\s+)?history/i;
  function isHistoryLoadErrorText(text) { return HISTORY_LOAD_PATTERN.test(text); }

  function visibleHistoryLoadError(root = document) {
    const excluded = '[data-turn], [data-message-author-role], [data-testid^="conversation-turn"], [contenteditable="true"], [data-watch-automation-overlay]';
    const uiSelector = '[role="alert"], [role="status"], [role="dialog"], [aria-live], [data-testid*="error" i]';
    const candidates = [...root.querySelectorAll(uiSelector)];
    for (const button of root.querySelectorAll('button, [role="button"]')) {
      let parentHidden = false;
      for (let node = button; node; node = node.parentElement) {
        if (!visible(node)) { parentHidden = true; break; }
      }
      if (parentHidden || button.closest(excluded) || ![button.innerText || button.textContent || '', button.getAttribute('aria-label') || '']
        .some(label => /^(?:повторить|retry|try\s+again)$/i.test(String(label).trim()))) continue;
      let parent = button.parentElement;
      for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) candidates.push(parent);
    }
    return [...new Set(candidates)].filter(element => visible(element))
      .filter(element => !element.closest(excluded))
      .filter(element => !element.querySelector(excluded))
      .filter(element => {
        const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length <= 2000 && isHistoryLoadErrorText(text);
      }).sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length)[0] || null;
  }

  function uploadError(root = document) {
    const quota = globalThis.WatchQuotaUtils;
    if (!quota) return null;
    const uiSelector = '[role="alert"], [role="status"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [aria-live], [data-testid*="toast" i], [data-testid*="error" i], [data-testid*="upload" i]';
    const composer = resolve('composer').element;
    const surface = composer?.closest('[data-composer-surface="true"]') || composer?.closest('form') || composer?.parentElement;
    const nearComposer = surface ? [...surface.querySelectorAll('div, span, p')] : [];
    const candidates = [...new Set([...root.querySelectorAll(uiSelector), ...nearComposer])];
    const rejected = /(?:upload[^.]{0,100}(?:failed|error|reject|unable)|(?:failed|unable|could\s+not)[^.]{0,50}upload|(?:unsupported|invalid|too\s+large)[^.]{0,30}(?:file|image)|(?:file|image)[^.]{0,30}(?:too\s+large|unsupported|invalid)|(?:не\s+удалось|ошибка|отклон)[^.]{0,50}(?:загруз|файл|вложен)|(?:файл|изображен)[^.]{0,50}(?:слишком\s+больш|не\s+поддерж|недопустим))/i;
    const results = [];
    for (const element of candidates) {
      if (!visible(element)) continue;
      // Prompts, assistant prose and our debugging overlay are source text,
      // never evidence that ChatGPT refused an upload.
      if (element.closest('[data-turn], [data-message-author-role], [data-testid^="conversation-turn"], [contenteditable="true"], [data-watch-automation-overlay]')) continue;
      if (element.querySelector('[data-turn], [data-message-author-role], [data-testid^="conversation-turn"]')) continue;
      const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2000) continue;
      const storageLimit = quota.isStorageLimitText(text);
      const uploadLimit = storageLimit || quota.isUploadLimitText(text);
      // Loading the sidebar's chat history is independent of file uploads.
      // Russian "не удалось загрузить" alone must not abort a healthy composer.
      const rejectionText = text.replace(new RegExp(HISTORY_LOAD_PATTERN.source, 'gi'), '')
        .replace(/не\s+удалось\s+загрузить\s+этот\s+разговор\s+chatgpt/gi, '');
      if (!uploadLimit && !rejected.test(rejectionText)) continue;
      results.push({ text, uploadLimit, storageLimit, element });
    }
    results.sort((a, b) => Number(b.uploadLimit) - Number(a.uploadLimit) || a.text.length - b.text.length);
    return results[0] || null;
  }

  function uploadLimitDialog(root = document) {
    const error = uploadError(root);
    return error?.uploadLimit ? error.element : null;
  }

  function visibleErrors(root = document) {
    const retryOnlyPattern = /^(повторить|retry|try\s+again|попробовать\s+ещё\s+раз|попробовать\s+еще\s+раз)$/i;
    const errorTextPattern = /(ошиб|не\s+удал|что-то\s+пошло\s+не\s+так|сбой|failed|error|unable|could\s+not|попробуйте\s+ещё\s+раз|попробуйте\s+еще\s+раз|временно\s+недоступ|запрос\s+не\s+выполн|генерац.*не\s+удал)/i;
    const latest = root === document ? latestAssistantTurn() : root;
    const scopedRoots = latest ? [latest] : [root];
    const candidates = scopedRoots.flatMap((scope) => [
      ...scope.querySelectorAll('[role="alert"]'),
      ...scope.querySelectorAll('[data-testid*="error" i], [data-testid*="failed" i]'),
      ...scope.querySelectorAll('[aria-live="assertive"]')
    ]);
    const dialogs = root === document
      ? [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      : [];
    return [...new Set([...candidates, ...dialogs])]
      .filter((element) => {
        if (!visible(element)) return false;
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || retryOnlyPattern.test(text)) return false;
        if (isHistoryLoadErrorText(text) && !isRateLimitText(text)
          && globalThis.WatchQuotaUtils?.isUploadLimitText(text) !== true
          && globalThis.WatchQuotaUtils?.isStorageLimitText(text) !== true) {
          const otherText = text.replace(new RegExp(HISTORY_LOAD_PATTERN.source, 'gi'), '')
            .replace(/повторить|retry|try\s+again|попроб(?:овать|уйте)\s+ещ[её]\s+раз/gi, '').trim();
          if (!errorTextPattern.test(otherText)) return false;
        }
        const testId = element.getAttribute('data-testid') || '';
        return isRateLimitText(text) || errorTextPattern.test(text) || /error|failed/i.test(testId);
      });
  }

  function visibleConversationLoadError(root = document) {
    const isErrorText = (value) => /не\s+удалось\s+загрузить\s+этот\s+разговор\s+chatgpt/i
      .test(String(value || '').replace(/\s+/g, ' ').trim());
    const isRetry = (element) => {
      const label = `${element.innerText || element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
        .replace(/\s+/g, ' ').trim();
      return /^(?:повторить|retry)$/i.test(label);
    };
    const retryButtons = [...root.querySelectorAll('button, [role="button"]')]
      .filter((element) => visible(element) && isRetry(element));
    for (const button of retryButtons) {
      let candidate = button;
      for (let depth = 0; candidate && depth < 9; depth += 1, candidate = candidate.parentElement) {
        if (!visible(candidate)) continue;
        const text = (candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 3000) continue;
        if (isErrorText(text) && [...candidate.querySelectorAll('button, [role="button"]')].some(isRetry)) {
          return candidate;
        }
      }
    }
    return null;
  }

  window.WatchSelectorResolver = {
    visible,
    resolve,
    fileInputDiagnostics,
    assistantTurns,
    userTurns,
    latestAssistantTurn,
    latestUserTurn,
    generatedImage,
    attachmentTiles,
    hasResponseActions,
    composerSurface,
    composerSendButton,
    stopGeneratingButton,
    rateLimitDialog,
    rateLimitDialogs,
    dismissRateLimitDialog,
    uploadError,
    uploadLimitDialog,
    visibleErrors,
    visibleConversationLoadError,
    visibleHistoryLoadError,
    strategies
  };
})();
