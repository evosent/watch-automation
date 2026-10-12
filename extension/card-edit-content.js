(() => {
  // Receive the worker's explicit boot even after ChatGPT stripped URL markers.
  if (window.__WATCH_CARD_EDIT_RECEIVER__) return;
  window.__WATCH_CARD_EDIT_RECEIVER__ = true;
  let job = null, controller = null, runningId = null;
  const send = async (type, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ type, id: job?.id, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Расширение не ответило');
    return result.value;
  };
  const dataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'CARD_EDIT_START') {
      const ready = Boolean(window.WatchChatGPTAdapter);
      reply({ ok: true, value: { ready, id: runningId } });
      if (ready) void execute(message.id);
    } else if (message.type === 'CARD_EDIT_PING') {
      reply({ ok: true, value: { id: runningId, claimed: Boolean(job), running: Boolean(controller && !controller.signal.aborted) } });
    } else if (message.type === 'CANCEL_CARD_EDIT' && message.id === runningId) controller?.abort();
  });
  async function stage(value) {
    if ((await send('CARD_EDIT_STAGE', { stage: value }))?.stage !== value) {
      throw new Error('Задача редактирования больше не активна');
    }
  }
  async function execute(id) {
    if (!id || runningId || !window.WatchChatGPTAdapter) return;
    runningId = id;
    let deadline;
    try {
      controller = new AbortController(); const signal = controller.signal;
      job = await send('CARD_EDIT_CLAIM', { requestedId: id });
      signal.throwIfAborted();
      if (!job) return;
      deadline = setTimeout(() => controller.abort(), Math.max(1, job.deadline - Date.now()));
      const adapter = window.WatchChatGPTAdapter;
      await adapter.ensureChatMode({ signal });
      await adapter.waitForComposerReadyForInput({ signal, timeout: 45000 });
      await adapter.uploadFiles({ files: [job.file], debugOverlay: false, signal });
      signal.throwIfAborted();
      // Release base64 reference immediately after upload.
      job.file = null;
      await adapter.setComposerText(job.prompt, { signal });
      await adapter.waitForComposerReadyForSend({ signal, timeout: 45000 });
      // Lock permission immediately before the physical click. A second boot
      // or reload cannot claim this job again after crossing this boundary.
      await stage('submitted');
      const sent = await adapter.sendPrompt({ debugOverlay: false, signal });
      const image = await adapter.waitForGeneratedImage({ baselineAssistantCount: sent.baselineAssistantCount, debugOverlay: false, signal });
      const response = await fetch(image.src, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Не удалось прочитать отредактированный PNG');
      const blob = await response.blob();
      if (blob.size > 32 * 1024 * 1024) throw new Error('Результат превышает 32 МБ');
      const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (signature.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('ChatGPT вернул файл в формате, отличном от PNG');
      await stage('extracting');
      await adapter.waitForComposerReadyForInput({ signal, timeout: 45000 });
      await adapter.setComposerText(job.factsPrompt, { signal });
      const factsSent = await adapter.sendPrompt({ debugOverlay: false, signal, rateLimitScope: 'postprocess' });
      const text = await adapter.waitForSettledAssistantText({ baselineAssistantCount: factsSent.baselineAssistantCount,
        afterUserTurnId: factsSent.userTurnId || null, requireCompleteFactsJson: true, timeout: 180000, signal });
      const conversation = location.href.match(/^https:\/\/chatgpt\.com\/c\/[^/?#]+/)?.[0];
      await send('CARD_EDIT_RESULT', { dataUrl: await dataUrl(new Blob([blob], { type: 'image/png' })), rawFacts: typeof text === 'string' ? text : text.text, chatUrl: conversation });
    } catch (error) {
      await send('CARD_EDIT_ERROR', { id, error: error.name === 'AbortError' ? 'Редактирование отменено или истекло время ожидания' : error.message }).catch(() => {});
    } finally {
      if (deadline) clearTimeout(deadline);
      controller = null;
      // Keep a claimed job latched, including failed sends with uncertain
      // acceptance. Only a failed unclaimed boot can safely try again.
      if (!job) runningId = null;
    }
  }
  // The worker boots only after durably saving tabId, eliminating create races.
})();
