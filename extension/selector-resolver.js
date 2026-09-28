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
      ['accept-image', 'input[type="file"][accept^="image/"]', 0.75]
    ],
    send: [
      ['id', '#composer-submit-button', 1.00],
      ['data-testid', '[data-testid="send-button"]', 0.99],
      ['aria-ru', 'button[aria-label="Отправить промпт"]', 0.95],
      ['submit', 'form button[type="submit"]', 0.72]
    ]
  };

  function resolve(name, { visibleOnly = true, root = document } = {}) {
    const list = strategies[name] || [];
    for (const [strategy, selector, confidence] of list) {
      const el = visibleOnly ? firstVisible(selector, root) : root.querySelector(selector);
      if (el) return { element: el, strategy, selector, confidence };
    }
    return { element: null, strategy: null, selector: null, confidence: 0 };
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

  const RATE_LIMIT_PATTERN = /(слишком\s+много\s+запросов|слишком\s+часто|временно\s+ограничен|too\s+many\s+requests|rate\s*limit|temporarily\s+restricted|лимит\s+(?:создания|генерации)\s+изображений|лимит\s+запросов\s+на\s+генерацию\s+изображений|image\s+generation\s+limit)/i;

  function rateLimitDialogs(root = document) {
    const scoped = root === document ? document : root;
    const primary = [...scoped.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-testid*="modal" i]')];
    const fallback = [...scoped.querySelectorAll('div, section, main, aside, dialog')].filter((element) => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length >= 20 && text.length <= 500 && RATE_LIMIT_PATTERN.test(text);
    });
    const candidates = [...primary, ...fallback];
    return [...new Set(candidates)]
      .filter((element) => visible(element))
      .filter((element) => RATE_LIMIT_PATTERN.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()))
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
        const testId = element.getAttribute('data-testid') || '';
        return RATE_LIMIT_PATTERN.test(text) || errorTextPattern.test(text) || /error|failed/i.test(testId);
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
    visibleErrors,
    visibleConversationLoadError,
    strategies
  };
})();
