(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  if (window.__watchDomRecorderInstalled) return;
  window.__watchDomRecorderInstalled = true;

  const DOM_DIAGNOSTICS_MODES = Object.freeze({ OFF: 'off', ERRORS: 'errors', FULL: 'full' });
  const MAX_OUTBOX = 250;
  const MAX_MUTATIONS_PER_BATCH = 60;
  const MAX_SEMANTIC_ELEMENTS = 120;
  const MUTATION_DEBOUNCE_MS = 500;
  const SNAPSHOT_INTERVAL_MS = 15000;
  const RETRY_DELAY_MS = 5000;
  const INTERESTING_ATTRIBUTES = [
    'aria-label', 'aria-live', 'aria-busy', 'aria-disabled', 'disabled', 'hidden',
    'data-state', 'data-status', 'data-testid', 'role', 'src', 'alt', 'href', 'class', 'style'
  ];
  const ERROR_PATTERN = /(ошиб|сбой|не\s+удал|не\s+удалось|что-то\s+пошло|failed|error|unable|could\s+not|too\s+many|rate\s*limit|слишком\s+много\s+запросов|временно\s+ограничен)/i;

  const sessionId = `dom-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  let sequence = 0;
  let pageContext = {};
  let pendingMutations = [];
  let outbox = [];
  let mutationTimer = null;
  let sendTimer = null;
  let sending = false;
  let retryAfter = 0;
  let lastSnapshotAt = 0;
  let lastStateHash = '';
  let lastEventHash = '';
  let lastHref = location.href;
  let lastPhase = 'PAGE_MOUNTING';
  let mode = DOM_DIAGNOSTICS_MODES.OFF;
  let observer = null;
  let periodicTimer = null;
  let pageShowHandler = null;
  let visibilityChangeHandler = null;
  let beforeUnloadHandler = null;

  function compactText(value, max = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function redactText(value, max = 240) {
    let text = compactText(value, max * 2);
    text = text
      .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[API_KEY]')
      .replace(/\b[A-Za-z0-9_-]{96,}\b/g, '[LONG_TOKEN]');
    return text.slice(0, max);
  }

  function publicUrl(value = location.href) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return null;
      if (url.protocol === 'blob:') return `blob:${hashString(value).slice(0, 16)}`;
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return String(value || '').split('?')[0].split('#')[0].slice(0, 500);
    }
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function visible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0
      && rect.width > 0
      && rect.height > 0;
  }

  function stablePath(element) {
    if (!(element instanceof Element)) return null;
    const testId = element.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId.replaceAll('"', '\\"')}"]`;
    const id = element.getAttribute('id');
    if (id) return `#${id}`;
    const path = [];
    let current = element;
    let depth = 0;
    while (current instanceof Element && depth < 6) {
      const tag = current.tagName.toLowerCase();
      const role = current.getAttribute('role');
      const aria = current.getAttribute('aria-label');
      let part = tag;
      if (role) part += `[role="${role.replaceAll('"', '\\"')}"]`;
      else if (aria) part += `[aria-label="${compactText(aria, 80).replaceAll('"', '\\"')}"]`;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${Math.max(1, siblings.indexOf(current) + 1)})`;
      path.unshift(part);
      current = current.parentElement;
      depth += 1;
    }
    return path.join(' > ').slice(0, 500);
  }

  function safeAttribute(element, name, max = 240) {
    const value = element.getAttribute(name);
    return value ? redactText(value, max) : null;
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    const descriptor = {
      tag: element.tagName.toLowerCase(),
      path: stablePath(element),
      testId: safeAttribute(element, 'data-testid', 120),
      id: safeAttribute(element, 'id', 120),
      role: safeAttribute(element, 'role', 80),
      ariaLabel: safeAttribute(element, 'aria-label', 200),
      ariaLive: safeAttribute(element, 'aria-live', 80),
      ariaBusy: safeAttribute(element, 'aria-busy', 40),
      ariaDisabled: safeAttribute(element, 'aria-disabled', 40),
      disabled: element.hasAttribute('disabled'),
      hidden: element.hasAttribute('hidden'),
      text: redactText(element.innerText || element.textContent, 260),
      alt: safeAttribute(element, 'alt', 200),
      href: element instanceof HTMLAnchorElement ? publicUrl(element.href) : null,
      src: element instanceof HTMLImageElement ? publicUrl(element.currentSrc || element.src) : null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      descriptor.inputType = element.type || 'textarea';
      descriptor.placeholder = safeAttribute(element, 'placeholder', 200);
      descriptor.valuePresent = Boolean(element.value);
    }
    return descriptor;
  }

  function sanitizeClone(clone) {
    clone.querySelectorAll('script,style,noscript').forEach((item) => item.remove());
    clone.querySelectorAll('input,textarea').forEach((item) => {
      item.setAttribute('value', '');
      item.textContent = '';
    });
    clone.querySelectorAll('[src],[href]').forEach((item) => {
      for (const attribute of ['src', 'href']) {
        if (!item.hasAttribute(attribute)) continue;
        const safe = publicUrl(item.getAttribute(attribute));
        if (safe) item.setAttribute(attribute, safe);
        else item.removeAttribute(attribute);
      }
    });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) node.nodeValue = redactText(node.nodeValue, 400);
    return clone;
  }

  function serializeElement(element) {
    if (!(element instanceof Element)) return null;
    const clone = sanitizeClone(element.cloneNode(true));
    return clone.outerHTML.slice(0, 3500);
  }

  function pageSignals() {
    const candidates = [...document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live="assertive"], [aria-modal="true"]')]
      .filter(visible)
      .map((element) => redactText(element.innerText || element.textContent, 500))
      .filter(Boolean);
    return {
      rateLimit: candidates.find((text) => /(too\s+many|rate\s*limit|слишком\s+много\s+запросов|слишком\s+часто|временно\s+ограничен)/i.test(text)) || null,
      errors: candidates.filter((text) => ERROR_PATTERN.test(text)).slice(0, 12)
    };
  }

  function semanticPhase() {
    const signals = pageSignals();
    if (signals.rateLimit) return 'RATE_LIMIT_DIALOG';
    if (signals.errors.length) return 'ERROR_VISIBLE';

    const assistantTurns = [...document.querySelectorAll('[data-turn="assistant"]')];
    const userTurns = [...document.querySelectorAll('[data-turn="user"]')];
    const latestAssistant = assistantTurns[assistantTurns.length - 1] || null;
    const images = latestAssistant ? [...latestAssistant.querySelectorAll([
      'img[alt^="Сформированное изображение"]',
      'img[alt^="Generated image"]',
      '[id^="image-"] img:not([aria-hidden="true"])'
    ].join(', '))].filter((element) => (element.currentSrc || element.src)) : [];
    if (images.length) return 'IMAGE_PRESENT';

    const stopGenerating = [...document.querySelectorAll('[data-testid*="stop"], button[aria-label*="Останов"], button[aria-label*="Stop"]')].some(visible);
    if (stopGenerating) return 'GENERATING';

    if (latestAssistant) {
      const settled = Boolean(latestAssistant.querySelector('[data-testid="copy-turn-action-button"], [aria-label="Действия с ответом"]'));
      return settled ? 'ASSISTANT_SETTLED_NO_IMAGE' : 'ASSISTANT_RESPONDING';
    }
    if (userTurns.length) return 'PROMPT_SENT';

    const attachmentLike = [...document.querySelectorAll('[role="group"][aria-label]')].some((element) => visible(element) && element.querySelector('img'));
    if (attachmentLike) return 'ATTACHMENTS_READY';
    const composer = document.querySelector('#prompt-textarea[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea');
    if (composer) return 'READY_FOR_INPUT';
    return 'PAGE_MOUNTING';
  }

  function sanitizedDocumentHtml(maxLength = 60000) {
    const clone = document.documentElement?.cloneNode(true);
    if (!clone) return '';
    return `<!doctype html>\n${sanitizeClone(clone).outerHTML}`.slice(0, maxLength);
  }

  function semanticSnapshot(reason = 'snapshot', { includeHtml = false } = {}) {
    const candidates = [...document.querySelectorAll(
      'button,a,input,textarea,select,img,[role],[data-testid],[data-turn],[aria-live],[aria-busy]'
    )]
      .filter(visible)
      .slice(0, MAX_SEMANTIC_ELEMENTS)
      .map(describeElement)
      .filter(Boolean);
    const snapshot = {
      reason,
      href: publicUrl(),
      title: redactText(document.title, 240),
      readyState: document.readyState,
      visibility: document.visibilityState,
      phase: semanticPhase(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyText: redactText(document.body?.innerText, 3000),
      elements: candidates,
      signals: pageSignals()
    };
    if (includeHtml) snapshot.html = sanitizedDocumentHtml();
    snapshot.stateHash = hashString(JSON.stringify(snapshot));
    return snapshot;
  }

  function mutationDescriptor(record) {
    const target = record.target instanceof Element ? record.target : record.target?.parentElement;
    const changed = {
      type: record.type,
      target: describeElement(target),
      attributeName: record.attributeName || null
    };
    if (record.type === 'attributes' && target && INTERESTING_ATTRIBUTES.includes(record.attributeName)) {
      changed.newValue = record.attributeName === 'src' || record.attributeName === 'href'
        ? publicUrl(target.getAttribute(record.attributeName) || '')
        : record.attributeName === 'class'
          ? redactText(target.className, 500)
          : record.attributeName === 'style'
            ? redactText(target.getAttribute('style'), 500)
            : safeAttribute(target, record.attributeName, 260);
    }
    if (record.type === 'characterData') changed.text = redactText(record.target?.nodeValue, 300);
    if (record.type === 'childList') {
      changed.added = [...record.addedNodes].filter((node) => node instanceof Element).slice(0, 6).map(describeElement).filter(Boolean);
      changed.removed = [...record.removedNodes].filter((node) => node instanceof Element).slice(0, 6).map(describeElement).filter(Boolean);
      changed.addedCount = record.addedNodes.length;
      changed.removedCount = record.removedNodes.length;
    }
    return changed;
  }

  function enqueue(event) {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
    outbox.push(event);
    if (outbox.length > MAX_OUTBOX) outbox = outbox.slice(-MAX_OUTBOX);
    scheduleSend();
  }

  function scheduleSend(delay = 0) {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
    if (sendTimer) return;
    const wait = Math.max(delay, retryAfter - Date.now(), 0);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      sendOutbox().catch(() => {});
    }, wait);
  }

  async function sendOutbox() {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) {
      outbox = [];
      return;
    }
    if (sending || !outbox.length || Date.now() < retryAfter) {
      if (outbox.length && !sending) scheduleSend(Math.max(1000, retryAfter - Date.now()));
      return;
    }
    sending = true;
    const batch = outbox.splice(0, 24);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DOM_OBSERVATION_BATCH',
        observations: batch
      });
      if (response?.ok === false) throw new Error(response.error || 'DOM observation rejected');
      retryAfter = 0;
    } catch (_) {
      outbox = [...batch, ...outbox].slice(-MAX_OUTBOX);
      retryAfter = Date.now() + RETRY_DELAY_MS;
    } finally {
      sending = false;
      if (outbox.length) scheduleSend();
    }
  }

  function recordObservation(eventType, payload = {}, { snapshot = null, force = false } = {}) {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return null;
    const state = snapshot || semanticSnapshot(eventType);
    const stateHash = state.stateHash || hashString(JSON.stringify(state));
    const signature = hashString(JSON.stringify({ eventType, payload, stateHash }));
    if (!force && signature === lastEventHash) return null;
    lastEventHash = signature;
    lastStateHash = stateHash;
    lastSnapshotAt = Date.now();
    const event = {
      schemaVersion: 1,
      sessionId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      eventType,
      href: publicUrl(),
      title: redactText(document.title, 240),
      context: { ...pageContext },
      stateHash,
      phase: state.phase || null,
      ...payload
    };
    if (snapshot) event.semanticSnapshot = snapshot;
    enqueue(event);
    return event;
  }

  function flushMutations() {
    mutationTimer = null;
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) {
      pendingMutations = [];
      return;
    }
    if (!pendingMutations.length) return;
    const records = pendingMutations.splice(0, MAX_MUTATIONS_PER_BATCH);
    const mutations = records.map(mutationDescriptor).filter(Boolean);
    const meaningful = mutations.some((item) => (
      item.type === 'childList'
      || ['aria-busy', 'aria-disabled', 'disabled', 'data-state', 'data-status', 'src', 'href', 'class', 'style'].includes(item.attributeName)
    ));
    const currentHref = location.href;
    const navigationChanged = currentHref !== lastHref;
    lastHref = currentHref;
    const currentPhase = semanticPhase();
    const phaseChanged = currentPhase !== lastPhase;
    lastPhase = currentPhase;
    const includeSnapshot = phaseChanged || navigationChanged || Date.now() - lastSnapshotAt >= 5000;
    const snapshot = includeSnapshot ? semanticSnapshot(navigationChanged ? 'navigation-change' : phaseChanged ? 'phase-change' : 'mutation') : null;
    const stateHash = snapshot?.stateHash || lastStateHash || null;
    const mutationHash = hashString(JSON.stringify({ mutations, stateHash }));
    if (mutationHash === lastEventHash && !meaningful) return;
    lastEventHash = mutationHash;
    if (snapshot) {
      lastStateHash = snapshot.stateHash;
      lastSnapshotAt = Date.now();
    }
    enqueue({
      schemaVersion: 1,
      sessionId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      eventType: 'dom-mutation',
      href: publicUrl(),
      title: redactText(document.title, 240),
      context: { ...pageContext },
      stateHash,
      phase: snapshot?.phase || currentPhase,
      mutations,
      ...(snapshot ? { semanticSnapshot: snapshot } : {})
    });
    if (pendingMutations.length) mutationTimer = setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
  }

  function scheduleMutationFlush() {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
    if (mutationTimer) return;
    mutationTimer = setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
  }

  function setContext(value = {}) {
    pageContext = {
      operationId: value.operationId || null,
      slotId: value.slotId ?? null,
      entryId: value.entryId || null,
      entryName: value.entryName || null
    };
  }

  function recordAction(action = {}) {
    if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return null;
    const snapshot = semanticSnapshot('after-action');
    return recordObservation('automation-action', {
      action: {
        type: action.type || 'unknown',
        name: redactText(action.name || action.label, 240),
        state: redactText(action.state, 120),
        selector: redactText(action.selector, 500),
        details: action.details == null ? null : redactText(JSON.stringify(action.details), 1400)
      }
    }, { snapshot, force: true });
  }

  function getSnapshot(reason = 'requested', options = {}) {
    if (mode === DOM_DIAGNOSTICS_MODES.OFF) return null;
    return semanticSnapshot(reason, { includeHtml: options.includeHtml === true });
  }

  function install() {
    if (observer || mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
    if (!document.documentElement) {
      setTimeout(install, 100);
      return;
    }
    observer = new MutationObserver((records) => {
      pendingMutations.push(...records);
      if (pendingMutations.length > MAX_MUTATIONS_PER_BATCH * 4) {
        pendingMutations = pendingMutations.slice(-MAX_MUTATIONS_PER_BATCH * 4);
      }
      scheduleMutationFlush();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: INTERESTING_ATTRIBUTES.filter((name) => !['class', 'style'].includes(name)),
      characterData: true
    });

    setTimeout(() => {
      if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
      recordObservation('initial', {}, {
        snapshot: semanticSnapshot('initial'),
        force: true
      });
    }, 250);
    periodicTimer = setInterval(() => {
      if (mode !== DOM_DIAGNOSTICS_MODES.FULL) return;
      const currentHref = location.href;
      const navigationChanged = currentHref !== lastHref;
      if (!navigationChanged && Date.now() - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
      lastHref = currentHref;
      const reason = navigationChanged ? 'navigation-change' : 'periodic';
      recordObservation(reason, {}, { snapshot: semanticSnapshot(reason) });
    }, SNAPSHOT_INTERVAL_MS);
    pageShowHandler = () => recordObservation('pageshow', {}, {
      snapshot: semanticSnapshot('pageshow'),
      force: true
    });
    visibilityChangeHandler = () => recordObservation('visibility-change', {
      visibility: document.visibilityState
    }, {
      snapshot: semanticSnapshot('visibility-change'),
      force: true
    });
    beforeUnloadHandler = () => {
      recordObservation('beforeunload', {}, {
        snapshot: semanticSnapshot('beforeunload'),
        force: true
      });
      sendOutbox().catch(() => {});
    };
    window.addEventListener('pageshow', pageShowHandler);
    window.addEventListener('visibilitychange', visibilityChangeHandler);
    window.addEventListener('beforeunload', beforeUnloadHandler);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = null;
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = null;
    if (pageShowHandler) window.removeEventListener('pageshow', pageShowHandler);
    if (visibilityChangeHandler) window.removeEventListener('visibilitychange', visibilityChangeHandler);
    if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
    pageShowHandler = null;
    visibilityChangeHandler = null;
    beforeUnloadHandler = null;
    pendingMutations = [];
    outbox = [];
    sending = false;
  }

  function setMode(value) {
    const next = Object.values(DOM_DIAGNOSTICS_MODES).includes(String(value || '').toLowerCase())
      ? String(value).toLowerCase()
      : DOM_DIAGNOSTICS_MODES.OFF;
    if (next === mode) return mode;
    mode = next;
    if (mode === DOM_DIAGNOSTICS_MODES.FULL) install();
    else stop();
    return mode;
  }

  window.WatchDomRecorder = {
    sessionId,
    setContext,
    setMode,
    mode: () => mode,
    recordAction,
    recordSnapshot: (reason = 'manual') => mode === DOM_DIAGNOSTICS_MODES.FULL
      ? recordObservation(reason, {}, { snapshot: semanticSnapshot(reason, { includeHtml: true }), force: true })
      : null,
    getSnapshot,
    stats: () => ({ sessionId, mode, sequence, queued: outbox.length, lastSnapshotAt, stateHash: lastStateHash })
  };

  Promise.resolve(chrome.storage?.local?.get?.('domDiagnosticsMode') || {})
    .then((stored) => setMode(stored?.domDiagnosticsMode))
    .catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === 'local' && changes.domDiagnosticsMode) setMode(changes.domDiagnosticsMode.newValue);
  });
})();
