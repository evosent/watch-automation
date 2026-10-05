(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  let controller = null;
  let runCache = null;
  const A = () => window.WatchChatGPTAdapter;
  const R = () => window.WatchSelectorResolver;
  const TEXT_ONLY_RESPONSE_GRACE_MS = 120000;
  // In a background tab ChatGPT can mount the authenticated image URL before
  // the browser decodes the bitmap. Waiting forever for naturalWidth leaves
  // a successful generation undownloaded. After a short stable-source grace
  // period we try the page-side fetch/direct download path anyway.
  const IMAGE_CANDIDATE_GRACE_MS = 350;
  const FACTS_COMPOSER_TIMEOUT_MS = 30000;
  const FACTS_SEND_BUTTON_TIMEOUT_MS = 30000;
  const FACTS_ACCEPTANCE_TIMEOUT_MS = 12000;
  const FACTS_ACCEPTANCE_RETRY_TIMEOUT_MS = 15000;
  const FACTS_RESPONSE_TIMEOUT_MS = 900000;

  function context(owner = runCache) {
    return {
      operationId: owner?.operationId,
      slotId: owner?.slotId,
      leaseId: owner?.leaseId || null,
      generationId: owner?.job?.generationId || owner?.factsExtraction?.generationId || null,
      entryId: owner?.entryId,
      entryName: owner?.job?.outputFileName,
      physicalSendAtMs: Number(owner?.physicalSendAtMs || 0),
      chatUrl: currentConversationUrl()
    };
  }

  function pageMessageMatchesOwner(message) {
    return Boolean(runCache) && runCache.operationId === message.operationId
      && (!message.entryId || runCache.entryId === message.entryId)
      && (!message.leaseId || runCache.leaseId === message.leaseId);
  }

  function recordAutomationEvent(action) {
    try { window.WatchDomRecorder?.recordAction(action); } catch (_) {}
  }

  function postRuntimeMessage(message) {
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending?.catch) pending.catch(() => {});
    } catch (_) {}
  }

  async function emitState(patch, owner = runCache) {
    if (owner && runCache !== owner) return;
    const reportedPatch = {
      ...patch,
      generationSubmitted: patch?.generationSubmitted ?? Boolean(owner?.promptSent),
      physicalSendAtMs: Number(patch?.physicalSendAtMs ?? owner?.physicalSendAtMs ?? 0)
    };
    recordAutomationEvent({
      type: 'state',
      state: reportedPatch.state,
      details: {
        step: reportedPatch.step || null,
        attachmentCount: reportedPatch.attachmentCount ?? null,
        downloadId: reportedPatch.downloadId ?? null,
        generationSubmitted: reportedPatch.generationSubmitted,
        physicalSendAtMs: reportedPatch.physicalSendAtMs || null,
        buildId: owner?.buildId || null
      }
    });
    // UI/storage telemetry is deliberately fire-and-forget. Waiting for the
    // service worker to serialize chrome.storage writes used to add seconds
    // between physical page operations across six concurrent workers.
    postRuntimeMessage({ type: 'STATE_EVENT', ...context(owner), patch: reportedPatch });
  }

  async function emitLog(message, extra = {}, owner = runCache) {
    if (owner && runCache !== owner) return;
    recordAutomationEvent({ type: 'log', name: message, details: extra });
    postRuntimeMessage({ type: 'LOG_EVENT', ...context(owner), message, extra });
  }

  function compactText(value, max = 4000) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  // A probe is meaningful when the page moved to a new state, discovered a
  // new assistant turn/image, or reached a terminal download state. Repeated
  // heartbeats for one unchanged GENERATING state must not keep the global
  // no-progress guard alive forever.
  function inspectionProgress(result, { force = false } = {}) {
    if (!runCache || !result) return Boolean(force);
    const signature = JSON.stringify({
      state: result.state || null,
      assistantCount: Number(result.assistantCount || 0),
      imageCandidate: Boolean(result.imageCandidate),
      source: result.src ? publicPageUrl(result.src) : null,
      downloadId: result.downloadId || null
    });
    const changed = signature !== runCache.lastInspectionSignature;
    runCache.lastInspectionSignature = signature;
    return Boolean(force || changed || ['READY', 'DOWNLOADING', 'DOWNLOADED'].includes(result.state));
  }

  function currentConversationUrl() {
    try {
      const url = new URL(location.href);
      if (url.origin !== 'https://chatgpt.com') return null;
      if (!/^\/c\/[^/?#]+/.test(url.pathname)) return null;
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return null;
    }
  }

  function emitFactsStage(stage, meta = {}, extra = {}) {
    if (!runCache) return;
    runCache.factsStageSeq = Number(runCache.factsStageSeq || 0) + 1;
    const now = Date.now();
    postRuntimeMessage({
      type: 'FACTS_STAGE_EVENT',
      ...context(),
      generationId: meta.generationId || runCache.job?.generationId || runCache.factsExtraction?.generationId || null,
      factsJobId: meta.factsJobId || runCache.factsExtraction?.factsJobId || runCache.job?.factsJobId || null,
      outputPath: meta.outputPath || null,
      outputHash: meta.outputHash || null,
      stage,
      stageSeq: runCache.factsStageSeq,
      stageAtMs: now,
      startedAtMs: Number(runCache.factsExtraction?.startedAt || meta.startedAtMs || now),
      modelName: runCache.job?.modelName || null,
      entryName: runCache.job?.outputFileName || null,
      chatUrl: currentConversationUrl(),
      ...extra
    });
  }

  async function requestFactsSendPermit(meta = {}) {
    while (true) {
      const response = await chrome.runtime.sendMessage({
        type: 'REQUEST_FACTS_SEND_PERMIT',
        ...context(),
        factsJobId: meta.factsJobId || runCache?.factsExtraction?.factsJobId || runCache?.job?.factsJobId || null,
        chatUrl: currentConversationUrl()
      });
      if (!response?.ok) throw new Error(response?.error || 'Не удалось получить Send-разрешение для постпроверки');
      if (response?.value?.granted) return response.value;
      const retryAt = Number(response?.value?.retryAt || 0);
      const waitMs = Math.max(500, Math.min(5000, retryAt ? retryAt - Date.now() : 1000));
      emitFactsStage('WAITING_SEND_GATE', meta, { waitUntil: retryAt || Date.now() + waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  function publicPageUrl(value = location.href) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return null;
      if (url.protocol === 'blob:') return `blob:${String(value).slice(0, 64).split('?')[0].split('#')[0]}`;
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return String(value || '').split('?')[0].split('#')[0].slice(0, 500);
    }
  }

  function sanitizedDomSnapshot(maxLength = 180000) {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,style,noscript').forEach((element) => element.remove());
    clone.querySelectorAll('input,textarea').forEach((element) => {
      element.setAttribute('value', '');
      element.textContent = '';
    });
    clone.querySelectorAll('[src],[href]').forEach((element) => {
      for (const attribute of ['src', 'href']) {
        if (!element.hasAttribute(attribute)) continue;
        const safe = publicPageUrl(element.getAttribute(attribute));
        if (safe) element.setAttribute(attribute, safe);
        else element.removeAttribute(attribute);
      }
    });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = String(node.nodeValue || '').trim();
      if (text.length > 500) node.nodeValue = '[LONG_TEXT_REDACTED]';
    }
    return `<!doctype html>\n${clone.outerHTML}`.slice(0, maxLength);
  }

  async function collectDiagnostics(reason) {
    const resolver = window.WatchSelectorResolver;
    const report = A()?.dryRunReport?.() || {};
    const errors = resolver?.visibleErrors?.() || [];
    const latestAssistant = resolver?.latestAssistantTurn?.();
    const latestUser = resolver?.latestUserTurn?.();
    const assistantOutcome = A()?.classifyAssistantOutcome?.(latestAssistant) || null;
    let generation = null;
    try { generation = A()?.inspectGeneratedImage?.({ baselineAssistantCount: runCache?.baselineAssistantCount || 0 }) || null; } catch (_) {}
    const domDiagnosticsMode = window.WatchDomRecorder?.mode?.() || 'off';
    const reasonText = String(reason || 'unknown').toLowerCase();
    const isManual = reasonText === 'manual';
    const isErrorLike = /(error|fail|timeout|rate|limit|text_only|auth|challenge|ошиб|сбой|лимит|не удал)/i.test(reasonText);
    // Full DOM is expensive on ChatGPT. Capture it only for an explicit manual
    // snapshot or a real error, never after every normal automation action.
    const includeHtml = (domDiagnosticsMode === 'full' && (isManual || isErrorLike))
      || (domDiagnosticsMode === 'errors' && isErrorLike);
    return {
      capturedAt: new Date().toISOString(),
      reason: String(reason || 'unknown'),
      href: publicPageUrl(),
      title: document.title,
      report,
      generation,
      assistantOutcome,
      rateLimit: compactText(R()?.rateLimitDialog?.()?.innerText, 1000) || null,
      visibleErrors: errors.map((item) => compactText(item.innerText || item.textContent, 1200)).filter(Boolean).slice(0, 12),
      latestUserText: compactText(latestUser?.innerText || latestUser?.textContent, 8000),
      latestAssistantText: compactText(latestAssistant?.innerText || latestAssistant?.textContent, 8000),
      bodyText: compactText(document.body?.innerText, 4000),
      html: includeHtml ? sanitizedDomSnapshot() : null,
      domRecorder: window.WatchDomRecorder?.getSnapshot?.('diagnostic', { includeHtml: false }) || null,
      domRecorderStats: window.WatchDomRecorder?.stats?.() || null
    };
  }

  async function checkAndDismissRateLimit({ notify = true, dismiss = true } = {}) {
    const dialog = R()?.rateLimitDialog?.() || null;
    if (!dialog) return { detected: false, dismissed: false, text: '' };
    const text = String(dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const detected = { detected: true, dismissed: false, text };
    // Record the incident in the page adapter before any observer can remove
    // the modal. This makes the pending physical Send recoverable even when an
    // audit and the acceptance waiter race each other.
    try { A()?.noteRateLimit?.(detected, 'generation'); } catch (_) {}
    let result = detected;
    if (dismiss) result = R()?.dismissRateLimitDialog?.() || detected;
    if (result.detected && notify) {
      try {
        await chrome.runtime.sendMessage({ type: 'RATE_LIMIT_EVENT', ...context(), rateLimit: result });
      } catch (_) {}
    }
    return result;
  }

  async function emitDiagnostics(reason) {
    const diagnostic = await collectDiagnostics(reason);
    try {
      await chrome.runtime.sendMessage({ type: 'DIAGNOSTICS_EVENT', ...context(), diagnostic });
    } catch (_) {}
    return diagnostic;
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать изображение страницы'));
      reader.readAsDataURL(blob);
    });
  }

  async function imageBlobToPngDataUrl(blob) {
    if (!blob || !String(blob.type || '').toLowerCase().startsWith('image/')) {
      throw new Error(`Ответ страницы не является изображением: ${blob?.type || 'unknown'}`);
    }
    if (String(blob.type).toLowerCase() === 'image/png') return readBlobAsDataUrl(blob);
    if (typeof createImageBitmap !== 'function') return readBlobAsDataUrl(blob);
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D недоступен для преобразования PNG');
      context.drawImage(bitmap, 0, 0);
      const pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Не удалось получить PNG из изображения')), 'image/png');
      });
      return readBlobAsDataUrl(pngBlob);
    } finally {
      bitmap.close?.();
    }
  }

  async function prepareGeneratedImage(generated) {
    const source = String(generated?.src || '');
    if (!source) return { sourceMode: 'direct-url' };
    try {
      const response = await fetch(source, {
        cache: 'no-store',
        credentials: 'include'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await imageBlobToPngDataUrl(blob);
      return { dataUrl, sourceMode: 'page-fetch', byteLength: blob.size };
    } catch (error) {
      await emitLog('Подготовка PNG через страницу не удалась, использую прямой URL', {
        error: error?.message || String(error)
      });
      return { sourceMode: 'direct-url' };
    }
  }

  async function verifyGeneratedPngSource(sourceUrl) {
    const parsedUrl = new URL(String(sourceUrl || ''), location.href);
    const allowedHost = /(^|\.)((chatgpt\.com)|(openai\.com)|(oaiusercontent\.com))$/i.test(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' || !allowedHost) throw new Error('URL исходного изображения не относится к ChatGPT/OpenAI');
    const response = await fetch(parsedUrl.href, { cache: 'no-store', credentials: 'include' });
    if (!response.ok) throw new Error(`Не удалось повторно прочитать PNG: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) {
      return { valid: false, reason: 'source_not_png', bytes: bytes.length };
    }
    const view = new DataView(buffer);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (!width || !height || width < 512 || height < 512) {
      return { valid: false, reason: `image_too_small:${width}x${height}`, width, height, bytes: bytes.length };
    }
    const ratio = width / height;
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return {
      valid: true,
      verified: true,
      verificationMode: 'page-source',
      width,
      height,
      bytes: bytes.length,
      sha256: [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      qualityWarnings: Math.abs(ratio - 0.75) > 0.035 ? [`aspect_ratio:${ratio.toFixed(4)} (ожидается около 3:4)`] : []
    };
  }

  function generatedSourceNeedsPageFetch(source) {
    const value = String(source || '').trim().toLowerCase();
    return value.startsWith('blob:') || value.startsWith('data:');
  }

  function startFactsExtractionFastPath() {
    if (!runCache?.job?.factsPrompt || !runCache?.entryId || !runCache?.operationId) return false;
    const existing = runCache.factsExtraction;
    if (existing && ['starting', 'running', 'done'].includes(existing.state)) return false;
    const factsJobId = runCache.job.factsJobId || `${runCache.operationId}:${runCache.entryId}:facts-v${runCache.job.factsExtractorVersion || 4}`;
    const message = {
      operationId: runCache.operationId,
      entryId: runCache.entryId,
      generationId: runCache.job.generationId || null,
      factsJobId,
      prompt: runCache.job.factsPrompt,
      outputPath: null,
      outputHash: null,
      extractorVersion: runCache.job.factsExtractorVersion || null,
      fastPath: true,
      chatUrl: currentConversationUrl()
    };
    runCache.factsExtraction = {
      factsJobId,
      state: 'running',
      startedAt: Date.now(),
      fastPath: true
    };
    emitFactsStage('QUEUED', message);
    void emitLog('Postprocess facts: fast-path старт сразу после запуска скачивания', {
      entryId: runCache.entryId,
      factsJobId
    });
    void runFactsExtractionDetached(message);
    return true;
  }

  async function requestGeneratedDownload(generated, owner = runCache) {
    if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
    if (!owner?.job) throw new Error('Run cache is not prepared');
    if (owner.downloadId != null) return { downloadId: owner.downloadId };
    if (owner.downloadPromise) return owner.downloadPromise;

    owner.downloadPromise = (async () => {
      const imageDetectedAtMs = Date.now();
      await emitLog('Generated image detected', {
        width: generated.width,
        height: generated.height,
        alt: generated.alt
      }, owner);
      await emitState({ state: 'REQUESTING_DOWNLOAD', step: '9/9' }, owner);
      if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');

      // Postcheck is page-local and does not depend on the file reaching disk.
      // Launch it in parallel with download setup so neither custom output nor
      // Downloads API bookkeeping can delay the specification prompt.
      startFactsExtractionFastPath();

      const source = String(generated?.src || '');
      const downloadMessage = (dataUrl, sourceMode = 'direct-url') => ({
        type: 'DOWNLOAD_GENERATED',
        operationId: owner.operationId,
        slotId: owner.slotId,
        leaseId: owner.leaseId || null,
        entryId: owner.entryId,
        generationId: owner.job?.generationId || null,
        recovery: owner.recovery === true,
        url: source,
        dataUrl: dataUrl || null,
        sourceMode,
        outputFileName: owner.job.outputFileName || null,
        chatUrl: currentConversationUrl()
      });

      let response = null;
      let prepared = null;

      // Fast path: normal ChatGPT HTTPS image URLs go straight to
      // chrome.downloads. The old fetch -> Blob -> base64 round trip copied the
      // whole PNG through the page and extension message bus before a download
      // could even start, which was the dominant source of visible latency.
      if (!generatedSourceNeedsPageFetch(source)) {
        try {
          response = await chrome.runtime.sendMessage(downloadMessage(null, 'direct-url'));
        } catch (error) {
          response = { ok: false, error: error?.message || String(error) };
        }
      }

      // blob:/data: sources cannot be consumed reliably by the service worker.
      // Also keep the former page-fetch path as a fallback if direct download
      // setup was rejected before a download id was created.
      if (!response?.ok) {
        prepared = await prepareGeneratedImage(generated);
        if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
        if (prepared.dataUrl) {
          try {
            response = await chrome.runtime.sendMessage(downloadMessage(prepared.dataUrl, prepared.sourceMode));
          } catch (error) {
            response = { ok: false, error: error?.message || String(error) };
          }
        }
      }

      if (!response?.ok) throw new Error(response?.error || 'Could not save generated image');
      if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');

      if (response.completed === true && response.mode === 'custom') {
        await emitLog('Saved to custom output folder', { outputPath: response.outputPath || null }, owner);
        return { completed: true, mode: 'custom', outputPath: response.outputPath || null };
      }
      owner.downloadId = response.downloadId;
      await emitLog('Download requested', {
        downloadId: response.downloadId,
        sourceMode: response.sourceMode || 'direct-url',
        imageToDownloadRequestMs: Date.now() - imageDetectedAtMs
      }, owner);
      await emitState({ state: 'DOWNLOADING', status: 'RUNNING', downloadId: response.downloadId, progress: true }, owner);
      return { downloadId: response.downloadId, mode: response.mode || 'downloads' };
    })();

    try {
      return await owner.downloadPromise;
    } catch (error) {
      owner.downloadPromise = null;
      owner.downloadId = null;
      throw error;
    }
  }

  async function inspectCurrentGeneration(owner = runCache) {
    if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
    if (!owner?.job) return { state: 'NO_RUN', generationSubmitted: false };
    // A rate-limit modal must not hide a result that already exists behind it.
    // Dismiss and report the shared send gate, then inspect/download the current
    // conversation normally in the same audit pass.
    const rateLimit = await checkAndDismissRateLimit({ dismiss: !owner.sendConfirmationPending });
    if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
    const result = A().inspectGeneratedImage({ baselineAssistantCount: owner.baselineAssistantCount || 0 });
    result.chatUrl = currentConversationUrl();
    if (result.state === 'READY') {
      runCache.imageCandidateSrc = null;
      runCache.imageCandidateSince = 0;
      runCache.imageCandidateAttempts = 0;
      const download = await requestGeneratedDownload(result, owner);
      const next = { ...result, state: 'DOWNLOADING', downloadId: download.downloadId, generationSubmitted: true };
      inspectionProgress(next, { force: true });
      return { ...next, progress: true };
    }

    if (result.state === 'WAITING_IMAGE' && result.imageCandidate) {
      // The response already contains an image element. Its authenticated
      // source may still be loading, so keep observing without a text-only
      // deadline.
      owner.auditSettledWithoutImageAt = 0;
      const source = String(result.src || '');
      const now = Date.now();
      if (source && source !== owner.imageCandidateSrc) {
        owner.imageCandidateSrc = source;
        owner.imageCandidateSince = now;
        owner.imageCandidateAttempts = 0;
      }
      const candidateSince = Number(owner.imageCandidateSince || 0);
      if (source && candidateSince > 0 && now - candidateSince >= IMAGE_CANDIDATE_GRACE_MS) {
        try {
          const download = await requestGeneratedDownload(result, owner);
          const next = { ...result, state: 'DOWNLOADING', downloadId: download.downloadId, generationSubmitted: true };
          inspectionProgress(next, { force: true });
          return { ...next, progress: true };
        } catch (error) {
          if (runCache !== owner) throw error;
          owner.imageCandidateAttempts = Number(owner.imageCandidateAttempts || 0) + 1;
          // Start a fresh grace window for a transient authenticated-request
          // failure. The slot stays observable and later audits can retry.
          runCache.imageCandidateSince = now;
          await emitLog('Кандидат изображения пока не скачан, повторю проверку', {
            error: error?.message || String(error),
            attempt: owner.imageCandidateAttempts
          }, owner);
        }
      }
    } else if (result.state === 'WAITING_IMAGE') {
      const latest = A().latestAssistantTurn?.();
      const responseText = String(result.responseText || latest?.innerText || latest?.textContent || '').trim().slice(0, 12000);
      // An empty settled assistant container is a normal transient state while
      // the image tool mounts. Only real non-empty prose may become TEXT_ONLY.
      if (result.outcome === 'TEXT_ONLY' && responseText.length >= 12) {
        const now = Date.now();
        owner.auditSettledWithoutImageAt ||= now;
        if (now - owner.auditSettledWithoutImageAt > TEXT_ONLY_RESPONSE_GRACE_MS) {
          return {
            state: 'ERROR',
            error: 'TEXT_ONLY_RESPONSE: assistant response finished without generated image',
            errorClass: 'TEXT_ONLY',
            responseText
          };
        }
      } else {
        owner.auditSettledWithoutImageAt = 0;
      }
    } else {
      owner.auditSettledWithoutImageAt = 0;
    }
    const progress = inspectionProgress(result);
    return {
      ...result,
      generationSubmitted: Boolean(owner.promptSent),
      leaseId: owner.leaseId || null,
      physicalSendAtMs: Number(owner.physicalSendAtMs || 0),
      rateLimit: Boolean(rateLimit.detected),
      rateLimitDismissed: Boolean(rateLimit.dismissed),
      rateLimitText: rateLimit.text || null,
      progress
    };
  }

  function validateRunInputs() {
    if (!runCache?.job) throw new Error('Run cache is not prepared');
    const { job, files } = runCache;
    const order = Array.isArray(job.attachmentOrder) && job.attachmentOrder.length
      ? [...job.attachmentOrder]
      : ['template', 'ozonMap', 'storeLogo', 'watchReference'];
    const missingFiles = order.filter((key) => !files?.[key]?.dataUrl || !files?.[key]?.name);
    if (order.length < 2 || order.length > 4 || missingFiles.length) {
      const detail = missingFiles.length ? `; missing: ${missingFiles.join(', ')}` : '';
      const error = new Error(`Invalid input plan (${order.length} files)${detail}`);
      error.code = 'UPLOAD_REJECTED';
      throw error;
    }
    return order;
  }

  async function reportRunError(error, owner = runCache) {
    if (!owner || runCache !== owner) return;
    const stopped = error?.name === 'AbortError' || String(error?.message || '').includes('Aborted');
    if (stopped) return;
    await emitDiagnostics(error.message);
    if (runCache !== owner) return;
    await emitLog('ERROR', { error: error.message, responseText: error.responseText || null }, owner);
    const confirmedSend = Boolean(owner.promptSent || owner.downloadId != null);
    const ambiguousPhysicalSend = Number(owner.physicalSendAtMs || error.sendClickedAtMs || 0) > 0
      && error.rateLimitBeforeAssistant !== true;
    await emitState({
      state: 'ERROR',
      status: 'ERROR',
      error: error.message,
      responseText: error.responseText || null,
      generationSubmitted: confirmedSend || ambiguousPhysicalSend,
      preparedForSubmit: Boolean(owner.preparedForSubmit),
      errorClass: error.code || null,
      rateLimit: error.code === 'RATE_LIMIT',
      rateLimitBeforeAssistant: error.rateLimitBeforeAssistant === true
    }, owner);
  }

  async function prepareRunForSubmit() {
    const owner = runCache;
    const order = validateRunInputs();
    const { job, files } = owner;
    if (owner.promptSent) return { prepared: true, alreadySubmitted: true, attachmentCount: order.length };
    if (owner.preparedForSubmit) return { prepared: true, alreadyPrepared: true, attachmentCount: order.length };

    controller?.abort();
    const runController = new AbortController();
    controller = runController;
    owner.controller = runController;
    const signal = runController.signal;
    const debugOverlay = job.debugOverlay === true;
    try {
      const prepStartedAt = Date.now();
      const prep = await A().ensureNewChat({ debugOverlay, signal });
      if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
      void emitLog('New chat ready', { ...(prep || {}), durationMs: Date.now() - prepStartedAt }, owner);

      const prompt = String(job.prompt || '')
        .replaceAll('[вставь нужную модель часов]', job.modelName)
        .replaceAll('{{MODEL_NAME}}', job.modelName);
      if (!prompt.trim()) throw new Error('Prompt is empty');
      if (prompt.includes('[вставь нужную модель часов]') || prompt.includes('{{MODEL_NAME}}')) throw new Error('Prompt placeholder remained after substitution');

      // Start attachment processing and prompt insertion at the same time.
      // The upload promise may spend seconds waiting for ChatGPT thumbnails;
      // that must not block the text from appearing in the composer.
      const uploadStartedAt = Date.now();
      const uploadPromise = A().uploadFiles({
        files: order.map((key) => files[key]),
        debugOverlay,
        signal
      });
      const promptStartedAt = Date.now();
      const promptPromise = A().setComposerText(prompt, { signal });
      const [result, filled] = await Promise.all([uploadPromise, promptPromise]);
      if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
      const uploadDurationMs = Date.now() - uploadStartedAt;
      void emitLog('Page inputs prepared', {
        uploadMode: result.mode || null,
        attachmentCount: result.count,
        expectedAttachmentCount: order.length,
        uploadDurationMs,
        promptDurationMs: Date.now() - promptStartedAt,
        characters: prompt.length,
        inputMode: job.inputMode || String(order.length),
        attachmentOrder: order,
        promptSelector: filled?.selector || null
      }, owner);

      // Some ChatGPT composer builds re-render after attachment processing.
      // Verify text survived; only reinsert when the upload actually wiped it.
      if (typeof A().composerHasText === 'function' && !A().composerHasText(prompt)) {
        await A().setComposerText(prompt, { signal });
        if (runCache !== owner) throw new DOMException('Aborted', 'AbortError');
        void emitLog('Prompt restored after attachment rerender', { characters: prompt.length }, owner);
      }

      owner.preparedForSubmit = true;
      owner.preparedAt = Date.now();
      owner.lastProgressAt = Date.now();
      void emitState({
        state: 'READY_TO_SEND',
        status: 'RUNNING',
        step: '7/9',
        attachmentCount: result.count,
        preparedForSubmit: true,
        progress: true
      }, owner);
      void emitLog('Page fully prepared; waiting only for global Send gate', {
        attachmentCount: result.count,
        characters: prompt.length,
        totalPrepareDurationMs: Date.now() - prepStartedAt,
        preparedAt: new Date(owner.preparedAt).toISOString()
      }, owner);
      return { prepared: true, attachmentCount: result.count, preparedAtMs: owner.preparedAt };
    } catch (error) {
      if (controller === runController) runController.abort();
      if (runCache !== owner) return { cancelled: true };
      await reportRunError(error, owner);
      throw error;
    }
  }

  async function monitorSubmittedGeneration(sent, signal, owner = runCache) {
    try {
      if (runCache !== owner) return;
      void emitState({ state: 'WAITING_GENERATION', step: '9/9', generationSubmitted: true, progress: true }, owner);
      const generated = await A().waitForGeneratedImage({
        baselineAssistantCount: sent.baselineAssistantCount,
        timeout: runCache?.job?.generationTimeoutMs || 900000,
        debugOverlay: runCache?.job?.debugOverlay === true,
        signal,
        onTimeout: ({ timeoutMs, elapsedMs }) => {
          void emitLog('Генерация ещё не обнаружена; продолжаю наблюдение без повторной отправки', {
            timeoutMs,
            elapsedMs,
            baselineAssistantCount: sent.baselineAssistantCount,
            generationId: runCache?.job?.generationId || null
          });
        }
      });
      if (runCache !== owner) return;
      await requestGeneratedDownload(generated, owner);
    } catch (error) {
      await reportRunError(error, owner);
    }
  }

  async function confirmSendAndMonitor(click, signal, owner = runCache) {
    if (runCache !== owner) return;
    owner.sendConfirmationPending = true;
    try {
      const accepted = await A().waitForPromptAcceptance({
        baselineAssistantCount: click.baselineAssistantCount,
        baselineUserCount: click.baselineUserCount,
        sendClickedAtMs: click.sendClickedAtMs,
        expectedPrompt: owner?.job?.prompt || null,
        signal
      });
      if (runCache !== owner) return;
      owner.baselineAssistantCount = click.baselineAssistantCount;
      owner.promptSent = true;
      owner.preparedForSubmit = false;
      owner.generationSubmittedAt = new Date().toISOString();
      void emitState({
        state: 'PROMPT_SENT',
        step: '8/9',
        generationSubmitted: true,
        submittedAtMs: click.sendClickedAtMs,
        baselineAssistantCount: click.baselineAssistantCount,
        progress: true
      }, owner);
      void emitLog('Prompt accepted by ChatGPT', {
        baselineAssistantCount: click.baselineAssistantCount,
        baselineUserCount: click.baselineUserCount,
        sendClickedAtMs: click.sendClickedAtMs,
        acceptanceDelayMs: Date.now() - click.sendClickedAtMs
      }, owner);
      void monitorSubmittedGeneration({ ...click, ...accepted }, signal, owner);
    } catch (error) {
      if (runCache !== owner) return;
      // A rate-limit rejection occurred after the physical click but before a
      // user turn was created. Keep the fully prepared page reusable so only
      // Send is retried after the shared cooldown.
      if (error?.code === 'RATE_LIMIT' && error.rateLimitBeforeAssistant === true) {
        owner.promptSent = false;
        owner.preparedForSubmit = true;
      }
      await reportRunError(error, owner);
    } finally {
      if (owner) owner.sendConfirmationPending = false;
    }
  }

  async function submitPreparedRun() {
    const owner = runCache;
    validateRunInputs();
    if (!owner?.preparedForSubmit) {
      const error = new Error('Page is not prepared for Send');
      error.code = 'NOT_PREPARED';
      throw error;
    }
    if (owner.promptSent) {
      return {
        submitted: true,
        alreadySubmitted: true,
        sendClickedAtMs: Number(owner.submittedAtMs || Date.parse(owner.generationSubmittedAt || '') || Date.now())
      };
    }
    if (!controller || controller.signal.aborted) controller = new AbortController();
    const signal = controller.signal;
    try {
      const click = await A().clickSendPrompt({ debugOverlay: runCache.job.debugOverlay === true, signal });
      if (runCache !== owner) return { submitted: true, staleLease: true, sendClickedAtMs: click.sendClickedAtMs };
      owner.physicalSendAtMs = Number(click.sendClickedAtMs || Date.now());
      owner.preparedForSubmit = false;
      owner.lastProgressAt = click.sendClickedAtMs;
      owner.submittedAtMs = click.sendClickedAtMs;
      void emitState({ state: 'SENDING', step: '8/9', preparedForSubmit: false, progress: true,
        generationSubmitted: false, physicalSendAtMs: owner.physicalSendAtMs }, owner);
      void emitLog('Send clicked', { ...click }, owner);
      // Do not hold the global Send gate while ChatGPT creates the user turn.
      // Confirmation/rate-limit detection continues asynchronously.
      void confirmSendAndMonitor(click, signal, owner);
      return {
        submitted: true,
        sendClicked: true,
        sendClickedAtMs: click.sendClickedAtMs,
        baselineAssistantCount: click.baselineAssistantCount,
        baselineUserCount: click.baselineUserCount
      };
    } catch (error) {
      if (runCache !== owner) return { cancelled: true };
      if (Number(error.sendClickedAtMs || 0) > 0) owner.physicalSendAtMs = Number(error.sendClickedAtMs);
      await reportRunError(error, owner);
      throw error;
    }
  }

  async function executeRun() {
    await prepareRunForSubmit();
    return submitPreparedRun();
  }

  async function sendFactsResultWithRetry(payload) {
    const waits = [0, 250, 1000, 3000];
    let lastError = null;
    for (const waitMs of waits) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'FACTS_EXTRACTION_RESULT', ...payload });
        if (response?.ok !== false) return response;
        lastError = new Error(response?.error || 'Facts result was rejected');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not deliver facts result');
  }

  async function extractFactsFromLastImage(prompt, meta = {}) {
    if (!runCache?.job) throw new Error('Run cache is not prepared for postprocess');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('Postprocess prompt is empty');
    const postController = new AbortController();
    const signal = postController.signal;
    const startedAt = Date.now();
    let promptSubmitted = false;
    let promptAccepted = false;
    let currentStage = 'QUEUED';
    const stage = (name, extra = {}) => {
      currentStage = name;
      emitFactsStage(name, meta, extra);
    };
    try {
      stage('WAITING_COMPOSER');
      void emitLog('Postprocess facts: жду завершения текущего assistant-turn', {
        entryId: runCache.entryId,
        factsJobId: meta.factsJobId || null
      });
      await A().waitForComposerReadyForInput({ timeout: FACTS_COMPOSER_TIMEOUT_MS, signal });

      stage('FILLING_PROMPT');
      const filled = await A().setComposerText(text, { signal });

      // The composer can be re-mounted immediately after image generation. A
      // resilient setComposerText() now verifies the current node, but keep one
      // explicit check here so a future ChatGPT UI change fails at the right
      // stage instead of waiting 30s for a Send button that can never appear.
      if (typeof A().composerHasText === 'function' && !A().composerHasText(text)) {
        const error = new Error('Prompt disappeared from the current composer before Send');
        error.code = 'FACTS_PROMPT_LOST';
        throw error;
      }

      stage('WAITING_SEND');
      await A().waitForComposerReadyForSend({ timeout: FACTS_SEND_BUTTON_TIMEOUT_MS, signal });

      stage('WAITING_SEND_GATE');
      let permit = await requestFactsSendPermit(meta);

      stage('SENDING');
      let click = await A().clickSendPrompt({ debugOverlay: false, signal, timeout: 5000 });
      promptSubmitted = true;
      stage('SEND_CLICKED', { sendClickedAtMs: click.sendClickedAtMs });
      stage('WAITING_ACCEPTANCE', { sendClickedAtMs: click.sendClickedAtMs });

      let submitted;
      try {
        submitted = await A().waitForPromptAcceptance({
          ...click,
          expectedPrompt: text,
          timeout: FACTS_ACCEPTANCE_TIMEOUT_MS,
          signal,
          rateLimitScope: 'postprocess'
        });
      } catch (firstError) {
        // A no-op click is safe to retry only when the exact prompt is still
        // sitting in the CURRENT composer and ChatGPT is idle. If the composer
        // was consumed we must never double-submit the OCR request.
        const promptStillPresent = typeof A().composerHasText === 'function' && A().composerHasText(text);
        const idle = !R().stopGeneratingButton();
        const isRateLimit = firstError?.code === 'RATE_LIMIT';
        if (!isRateLimit && promptStillPresent && idle) {
          stage('RETRYING_SEND', { error: firstError?.message || String(firstError) });
          await A().waitForComposerReadyForSend({ timeout: 5000, signal });
          permit = await requestFactsSendPermit(meta);
          stage('SENDING');
          click = await A().clickSendPrompt({ debugOverlay: false, signal, timeout: 5000 });
          stage('SEND_CLICKED', { sendClickedAtMs: click.sendClickedAtMs, retry: true });
          stage('WAITING_ACCEPTANCE', { sendClickedAtMs: click.sendClickedAtMs, retry: true });
          submitted = await A().waitForPromptAcceptance({
            ...click,
            expectedPrompt: text,
            timeout: FACTS_ACCEPTANCE_RETRY_TIMEOUT_MS,
            signal,
            rateLimitScope: 'postprocess'
          });
        } else {
          throw firstError;
        }
      }
      promptAccepted = true;
      stage('PROMPT_ACCEPTED', {
        userTurnId: submitted.userTurnId || null,
        baselineAssistantCount: Number(submitted.baselineAssistantCount || 0),
        baselineUserCount: Number(submitted.baselineUserCount || 0)
      });
      runCache.factsExtraction = {
        ...(runCache.factsExtraction || {}),
        state: 'running',
        promptAccepted: true,
        userTurnId: submitted.userTurnId || null,
        baselineAssistantCount: submitted.baselineAssistantCount,
        baselineUserCount: submitted.baselineUserCount,
        sendClickedAtMs: submitted.sendClickedAtMs,
        acceptanceMode: submitted.acceptanceMode || null,
        waitingResponseAt: Date.now()
      };
      stage('WAITING_RESPONSE_START');
      void emitLog('Postprocess facts: Send принят', {
        entryId: runCache.entryId,
        factsJobId: meta.factsJobId || null,
        delayFromPostprocessStartMs: Date.now() - startedAt,
        sendGateWaitMs: Number(permit?.waitMs || 0),
        sendClickedAtMs: submitted.sendClickedAtMs,
        acceptanceMode: submitted.acceptanceMode || null
      });
      let responseProgressPhase = null;
      const settled = await A().waitForSettledAssistantText({
        baselineAssistantCount: submitted.baselineAssistantCount,
        afterUserTurnId: submitted.userTurnId || null,
        timeout: FACTS_RESPONSE_TIMEOUT_MS,
        signal,
        rateLimitScope: 'postprocess',
        requireCompleteFactsJson: true,
        onProgress: (progress) => {
          const phase = progress?.phase || null;
          if (!phase || phase === responseProgressPhase) return;
          responseProgressPhase = phase;
          if (phase === 'waiting-assistant') {
            stage('WAITING_MODEL_RESPONSE');
          } else if (phase === 'assistant-started') {
            stage('RECEIVING_RESPONSE', {
              assistantTurnId: progress?.assistantTurnId || null,
              modelSlug: progress?.modelSlug || null
            });
          }
        }
      });
      stage('PARSING');
      void emitLog('Postprocess facts: ответ получен', {
        entryId: runCache.entryId,
        durationMs: Date.now() - startedAt,
        characters: String(settled?.text || '').length,
        promptCharacters: text.length,
        composerCharacters: filled?.length || null,
        sendClickedAtMs: submitted.sendClickedAtMs,
        completion: settled?.completion || null,
        acceptanceMode: submitted.acceptanceMode || null
      });
      return {
        text: String(settled?.text || ''),
        assistantCount: Number(settled?.assistantCount || 0),
        durationMs: Date.now() - startedAt,
        sendClickedAtMs: submitted.sendClickedAtMs,
        completion: settled?.completion || null,
        promptSubmitted,
        promptAccepted
      };
    } catch (error) {
      error.promptSubmitted = promptSubmitted || error.promptSubmitted === true;
      error.promptAccepted = promptAccepted || error.promptAccepted === true;
      error.factsStage = error.factsStage || currentStage;
      if (!error.code) error.code = `FACTS_${currentStage}_FAILED`;
      throw error;
    }
  }

  async function runFactsExtractionDetached(message) {
    const base = {
      operationId: message.operationId,
      entryId: message.entryId,
      generationId: message.generationId || runCache?.job?.generationId || null,
      factsJobId: message.factsJobId || null,
      outputPath: message.outputPath || null,
      outputHash: message.outputHash || null,
      extractorVersion: message.extractorVersion || null,
      fastPath: message.fastPath === true,
      chatUrl: currentConversationUrl() || message.chatUrl || null
    };
    try {
      const value = await extractFactsFromLastImage(message.prompt, base);
      runCache.factsExtraction = { ...(runCache.factsExtraction || {}), state: 'done', finishedAt: Date.now() };
      await sendFactsResultWithRetry({ ...base, ...value });
    } catch (error) {
      let responseProbe = null;
      try {
        responseProbe = A().inspectFactsResponse?.({
          baselineAssistantCount: Number(runCache?.factsExtraction?.baselineAssistantCount || 0),
          afterUserTurnId: runCache?.factsExtraction?.userTurnId || null
        }) || null;
      } catch (_) {}
      if (/Timeout waiting for settled assistant text/i.test(String(error?.message || ''))
        && responseProbe?.complete === true && String(responseProbe.text || '').trim()) {
        runCache.factsExtraction = { ...(runCache.factsExtraction || {}), state: 'done', finishedAt: Date.now() };
        emitFactsStage('PARSING', base, { completion: 'final-timeout-dom-probe' });
        try {
          await sendFactsResultWithRetry({
            ...base,
            text: String(responseProbe.text),
            assistantCount: Number(responseProbe.assistantCount || 0),
            durationMs: Number(runCache.factsExtraction?.startedAt)
              ? Date.now() - Number(runCache.factsExtraction.startedAt)
              : null,
            completion: 'facts-json-final-timeout-probe'
          });
          return;
        } catch (deliveryError) {
          responseProbe.deliveryError = deliveryError?.message || String(deliveryError);
        }
      }
      runCache.factsExtraction = { ...(runCache.factsExtraction || {}), state: 'error', finishedAt: Date.now(), error: error.message };
      const visibleError = error?.factsStage ? `[${error.factsStage}] ${error.message}` : error.message;
      emitFactsStage(error?.code === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'ERROR', base, { error: visibleError });
      await sendFactsResultWithRetry({
        ...base,
        error: {
          message: error.message,
          code: error.code || null,
          responseText: error.responseText || null,
          rateLimitBeforeAssistant: error.rateLimitBeforeAssistant === true,
          promptSubmitted: error.promptSubmitted === true,
          promptAccepted: error.promptAccepted === true,
          factsStage: error.factsStage || null,
          responseDiagnostics: responseProbe ? {
            state: responseProbe.state || null,
            complete: responseProbe.complete === true,
            characters: Number(responseProbe.characters || 0),
            assistantCount: Number(responseProbe.assistantCount || 0),
            userTurnFound: responseProbe.userTurnFound === true,
            assistantTurnFound: responseProbe.assistantTurnFound === true,
            assistantTurnId: responseProbe.assistantTurnId || null,
            factsUserTurnId: responseProbe.factsUserTurnId || null,
            visibilityState: responseProbe.visibilityState || document.visibilityState || null,
            lastDomInspectionAt: responseProbe.lastDomInspectionAt || null,
            deliveryError: responseProbe.deliveryError || null
          } : null
        }
      }).catch(() => {});
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'VERIFY_GENERATED_PNG_SOURCE') {
      if (!runCache || runCache.operationId !== message.operationId || runCache.entryId !== message.entryId) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch while verifying downloaded PNG source' } });
        return;
      }
      verifyGeneratedPngSource(message.url)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) => sendResponse({ ok: false, error: { message: error?.message || String(error) } }));
      return true;
    }
    if (message.type === 'PING') {
      sendResponse({ ok: true, value: { href: publicPageUrl(), ready: !!window.WatchChatGPTAdapter, buildId: runCache?.buildId || null } });
      return;
    }
    if (message.type === 'BOOTSTRAP_AUTOMATION_TAB') {
      const startedAt = Date.now();
      A().waitForComposerReadyForInput({ timeout: Number(message.timeoutMs || 60000) })
        .then(() => sendResponse({ ok: true, value: {
          composerReady: true,
          visibilityState: document.visibilityState || null,
          href: publicPageUrl(),
          durationMs: Date.now() - startedAt
        } }))
        .catch((error) => sendResponse({ ok: false, error: { message: error?.message || String(error) } }));
      return true;
    }
    if (message.type === 'STOP') {
      if (message.leaseId && !pageMessageMatchesOwner(message)) {
        sendResponse({ ok: true, staleLease: true });
        return;
      }
      controller?.abort();
      controller = null;
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'RESET_DOWNLOAD') {
      if (!runCache || runCache.operationId !== message.operationId || runCache.entryId !== message.entryId) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch while resetting download' } });
        return;
      }
      runCache.downloadPromise = null;
      runCache.downloadId = null;
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'CHECK_RATE_LIMIT') {
      checkAndDismissRateLimit({ notify: true, dismiss: message.forceDismiss === true || !runCache?.sendConfirmationPending })
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) => sendResponse({ ok: false, error: { message: error.message } }));
      return true;
    }
    if (message.type === 'PREPARE_PAGE_RUN') {
      controller?.abort();
      controller = new AbortController();
      runCache = {
        operationId: message.operationId,
        slotId: message.slotId,
        leaseId: message.leaseId || null,
        entryId: message.entryId,
        job: message.job,
        recovery: message.recovery === true,
        buildId: message.buildId || message.job?.buildId || null,
        promptSent: message.recovery === true,
        preparedForSubmit: false,
        preparedAt: null,
        submittedAtMs: null,
        physicalSendAtMs: null,
        generationSubmittedAt: null,
        sendConfirmationPending: false,
        lastProgressAt: Date.now(),
        files: {},
        baselineAssistantCount: 0,
        downloadPromise: null,
        downloadId: null,
        auditSettledWithoutImageAt: 0,
        imageCandidateSrc: null,
        imageCandidateSince: 0,
        imageCandidateAttempts: 0,
        lastInspectionSignature: '',
        factsExtraction: null,
        factsStageSeq: 0
      };
      window.WatchDomRecorder?.setContext?.(context());
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'CACHE_FILES') {
      if (!pageMessageMatchesOwner(message)) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch while caching files' } });
        return;
      }
      const incoming = message.files && typeof message.files === 'object' ? message.files : {};
      for (const [key, file] of Object.entries(incoming)) {
        if (file?.dataUrl && file?.name) runCache.files[key] = file;
      }
      sendResponse({ ok: true, value: { keys: Object.keys(incoming) } });
      return;
    }
    if (message.type === 'CACHE_FILE') {
      if (!pageMessageMatchesOwner(message)) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch while caching file' } });
        return;
      }
      runCache.files[message.key] = message.file;
      sendResponse({ ok: true, value: { key: message.key, name: message.file.name, size: message.file.size } });
      return;
    }
    if (message.type === 'PREPARE_PAGE_CONTENT') {
      if (!pageMessageMatchesOwner(message)) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch before preparation' } });
        return;
      }
      recordAutomationEvent({ type: 'prepare-page-content', state: 'PREPARING', details: { operationId: message.operationId } });
      prepareRunForSubmit()
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) => sendResponse({ ok: false, error: { message: error.message, code: error.code || null, responseText: error.responseText || null } }));
      return true;
    }
    if (message.type === 'SUBMIT_PAGE_RUN') {
      if (!pageMessageMatchesOwner(message)) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch before submit' } });
        return;
      }
      recordAutomationEvent({ type: 'submit-page-run', state: 'SENDING', details: { operationId: message.operationId } });
      submitPreparedRun()
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) => sendResponse({ ok: false, error: { message: error.message, code: error.code || null, responseText: error.responseText || null } }));
      return true;
    }
    if (message.type === 'EXECUTE_PAGE_RUN') {
      if (!runCache || runCache.operationId !== message.operationId) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch before execution' } });
        return;
      }
      // Compatibility path for an older worker: prepare everything first, then submit.
      executeRun()
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) => sendResponse({ ok: false, error: { message: error.message, code: error.code || null } }));
      return true;
    }
    if (message.type === 'START_FACTS_EXTRACTION' || message.type === 'EXTRACT_GENERATION_FACTS') {
      if (!runCache || runCache.operationId !== message.operationId || runCache.entryId !== message.entryId) {
        sendResponse({ ok: false, error: { message: 'Operation mismatch during postprocess facts extraction' } });
        return;
      }
      const sameJob = runCache.factsExtraction?.factsJobId
        && message.factsJobId
        && runCache.factsExtraction.factsJobId === message.factsJobId;
      const extractionAlreadyActive = sameJob && runCache.factsExtraction
        && ['starting', 'running', 'done'].includes(runCache.factsExtraction.state);
      // A failed fast-path may be restarted by verified-file finalization with
      // the SAME factsJobId. Only a currently active/completed job is a
      // duplicate; state=error is intentionally restartable.
      if (extractionAlreadyActive) {
        sendResponse({ ok: true, value: {
          accepted: true,
          duplicate: true,
          state: runCache.factsExtraction.state,
          factsJobId: runCache.factsExtraction.factsJobId || message.factsJobId || null
        } });
        return;
      }
      runCache.factsExtraction = {
        generationId: message.generationId || runCache.job?.generationId || null,
        factsJobId: message.factsJobId || runCache.job?.factsJobId || `${message.entryId}:${Date.now()}`,
        state: 'starting',
        startedAt: Date.now()
      };
      // Ack synchronously. The service worker is free immediately; the page
      // owns the long ChatGPT wait and later emits FACTS_EXTRACTION_RESULT.
      sendResponse({ ok: true, value: { accepted: true, detached: true } });
      emitFactsStage('QUEUED', message);
      runCache.factsExtraction.state = 'running';
      void runFactsExtractionDetached(message);
      return;
    }
    if (message.type === 'PULSE_FACTS_EXTRACTION') {
      if (!runCache || runCache.operationId !== message.operationId || runCache.entryId !== message.entryId) {
        if (message.recover !== true) {
          sendResponse({ ok: false, error: { message: 'Operation mismatch during facts pulse' } });
          return;
        }
        runCache = {
          operationId: message.operationId,
          slotId: message.slotId,
          entryId: message.entryId,
          job: {
            generationId: message.generationId || null,
            factsJobId: message.factsJobId || null,
            modelName: message.modelName || null,
            outputFileName: message.outputFileName || null
          },
          recovery: true,
          factsStageSeq: 0,
          factsExtraction: {
            generationId: message.generationId || null,
            factsJobId: message.factsJobId || null,
            state: 'running',
            startedAt: Date.now(),
            baselineAssistantCount: Number(message.baselineAssistantCount || 0),
            baselineUserCount: Number(message.baselineUserCount || 0),
            userTurnId: message.userTurnId || null
          }
        };
      }
      const facts = runCache.factsExtraction || null;
      if (!facts || (message.factsJobId && facts.factsJobId && message.factsJobId !== facts.factsJobId)) {
        sendResponse({ ok: true, value: { state: facts?.state || 'missing', complete: false, visibilityState: document.visibilityState || null } });
        return;
      }
      try {
        const probe = A().inspectFactsResponse?.({
          baselineAssistantCount: Number(facts.baselineAssistantCount || 0),
          afterUserTurnId: facts.userTurnId || null
        }) || { state: 'unavailable', complete: false };
        sendResponse({ ok: true, value: {
          ...probe,
          generationId: facts.generationId || runCache.job?.generationId || null,
          factsState: facts.state || null,
          userTurnId: facts.userTurnId || null,
          sendClickedAtMs: facts.sendClickedAtMs || null,
          durationMs: facts.startedAt ? Date.now() - Number(facts.startedAt) : null
        } });
      } catch (error) {
        sendResponse({ ok: false, error: { message: error.message || String(error) } });
      }
      return;
    }
    if (message.type === 'CHECK_GENERATION') {
      const owner = runCache;
      const cachedGenerationId = String(owner?.job?.generationId || '');
      const requestedGenerationId = String(message.generationId || '');
      const identityMismatch = !owner
        || owner.operationId !== message.operationId
        || owner.entryId !== message.entryId
        || (requestedGenerationId && cachedGenerationId && cachedGenerationId !== requestedGenerationId)
        || (message.leaseId && owner.leaseId && owner.leaseId !== message.leaseId);
      if (identityMismatch) {
        // Legacy persisted OBSERVING slots may have no submission timestamp
        // even though their real page context was lost during an update. This
        // recovery mode may inspect the existing page for one exact worker
        // lease; it never prepares files or clicks Send. The worker only uses
        // it for slots with no persisted conversation/assistant/send evidence.
        const unsubmittedObservation = message.recoverUnsubmitted === true
          && Boolean(message.leaseId)
          && !Number(message.submittedAtMs || 0)
          && !message.chatUrl;
        const submittedObservationOnly = message.recoverObservationOnly === true
          && Boolean(message.leaseId)
          && !Number(message.submittedAtMs || 0);
        if (unsubmittedObservation || submittedObservationOnly) {
          runCache = {
            operationId: message.operationId,
            slotId: Number(message.slotId),
            leaseId: String(message.leaseId),
            entryId: message.entryId,
            job: {
              generationId: requestedGenerationId || null,
              outputFileName: message.outputFileName || null,
              modelName: message.modelName || null
            },
            recovery: true,
            promptSent: submittedObservationOnly,
            preparedForSubmit: false,
            physicalSendAtMs: 0,
            baselineAssistantCount: Number(message.baselineAssistantCount || 0),
            files: {},
            downloadPromise: null,
            downloadId: null,
            auditSettledWithoutImageAt: 0,
            imageCandidateSrc: null,
            imageCandidateSince: 0,
            imageCandidateAttempts: 0,
            lastInspectionSignature: '',
            factsExtraction: null,
            factsStageSeq: 0
          };
          window.WatchDomRecorder?.setContext?.(context());
        } else {
        // A content-script reinjection clears its in-memory cache. Recover only
        // observation for a generation that the worker has durably recorded as
        // submitted and still owns by lease + immutable generation identity.
        // This path never prepares attachments or clicks Send.
        const submittedAtMs = Number(message.submittedAtMs || 0);
        if (message.recover !== true || !requestedGenerationId || !message.leaseId
          || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0
          || !message.operationId || !message.entryId || !Number.isInteger(Number(message.slotId))) {
          sendResponse({ ok: false, error: { message: 'Operation mismatch while checking generation' } });
          return;
        }
        runCache = {
          operationId: message.operationId,
          slotId: Number(message.slotId),
          leaseId: String(message.leaseId),
          entryId: message.entryId,
          job: {
            generationId: requestedGenerationId,
            outputFileName: message.outputFileName || null,
            modelName: message.modelName || null
          },
          recovery: true,
          promptSent: true,
          preparedForSubmit: false,
          submittedAtMs,
          physicalSendAtMs: submittedAtMs,
          generationSubmittedAt: new Date(submittedAtMs).toISOString(),
          baselineAssistantCount: Number(message.baselineAssistantCount || 0),
          files: {},
          downloadPromise: null,
          downloadId: null,
          auditSettledWithoutImageAt: 0,
          imageCandidateSrc: null,
          imageCandidateSince: 0,
          imageCandidateAttempts: 0,
          lastInspectionSignature: '',
          factsExtraction: null,
          factsStageSeq: 0
        };
        window.WatchDomRecorder?.setContext?.(context());
        recordAutomationEvent({ type: 'generation-context-recovered', state: 'OBSERVING', details: {
          operationId: message.operationId,
          slotId: Number(message.slotId),
          entryId: message.entryId,
          generationId: requestedGenerationId
        } });
        }
      }
      const probeOwner = runCache;
      inspectCurrentGeneration(probeOwner)
        .then((value) => {
          if (runCache !== probeOwner) {
            sendResponse({ ok: false, error: { message: 'Operation lease changed during generation check' } });
            return;
          }
          sendResponse({ ok: true, value: {
            ...value,
            leaseId: probeOwner.leaseId || null,
            generationSubmitted: Boolean(probeOwner.promptSent),
            physicalSendAtMs: Number(probeOwner.physicalSendAtMs || 0),
            chatUrl: currentConversationUrl()
          } });
        })
        .catch((error) => sendResponse({ ok: false, error: { message: error.message, responseText: error.responseText || null } }));
      return true;
    }
    if (message.type === 'DRY_RUN') {
      controller?.abort();
      controller = new AbortController();
      (async () => {
        try {
          await A().ensureNewChat({ debugOverlay: true, signal: controller.signal });
          const report = A().dryRunReport();
          await A().visualizeDryRun(report);
          sendResponse({ ok: true, value: report });
        } catch (error) {
          await emitDiagnostics(error.message);
          sendResponse({ ok: false, error: { message: error.message, stack: error.stack } });
        }
      })();
      return true;
    }
    if (message.type === 'CAPTURE_DIAGNOSTICS') {
      collectDiagnostics(message.reason || 'manual').then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: { message: error.message } }));
      return true;
    }
    if (message.type === 'SET_DOM_DIAGNOSTICS') {
      const mode = window.WatchDomRecorder?.setMode?.(message.mode) || 'off';
      sendResponse({ ok: true, value: { mode } });
      return;
    }
    if (message.type === 'DIAGNOSTICS') {
      collectDiagnostics('manual').then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: { message: error.message } }));
      return true;
    }
  });
})();
