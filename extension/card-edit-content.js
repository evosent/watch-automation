(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  const marker = new URL(location.href).searchParams.get('watch_card_edit');
  if (!marker) return;
  let job = null, controller = null;
  const send = async (type, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ type, id: job?.id, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Расширение не ответило');
    return result.value;
  };
  const dataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'CANCEL_CARD_EDIT' && message.id === job?.id) controller?.abort();
  });
  async function execute() {
    for (let attempt = 0; attempt < 15; attempt++) {
      job = await send('CARD_EDIT_CLAIM', { requestedId: marker });
      if (job) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!job) return;
    controller = new AbortController(); const signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(), Math.max(1, job.deadline - Date.now()));
    try {
      const adapter = window.WatchChatGPTAdapter;
      await adapter.ensureChatMode({ signal });
      await adapter.waitForComposerReadyForInput({ signal, timeout: 45000 });
      await adapter.uploadFiles({ files: [job.file], debugOverlay: false, signal });
      // Release base64 reference immediately after upload.
      job.file = null;
      await adapter.setComposerText(job.prompt, { signal });
      await adapter.waitForComposerReadyForSend({ signal, timeout: 45000 });
      if ((await send('CARD_EDIT_STAGE', { stage: 'submitted' }))?.stage !== 'submitted') throw new Error('Задача редактирования больше не активна');
      const sent = await adapter.sendPrompt({ debugOverlay: false, signal });
      const image = await adapter.waitForGeneratedImage({ baselineAssistantCount: sent.baselineAssistantCount, debugOverlay: false, signal });
      const response = await fetch(image.src, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Не удалось прочитать отредактированный PNG');
      const blob = await response.blob();
      if (blob.size > 32 * 1024 * 1024) throw new Error('Результат превышает 32 МБ');
      const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (signature.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('ChatGPT вернул файл в формате, отличном от PNG');
      if ((await send('CARD_EDIT_STAGE', { stage: 'extracting' }))?.stage !== 'extracting') throw new Error('Задача редактирования больше не активна');
      await adapter.waitForComposerReadyForInput({ signal, timeout: 45000 });
      await adapter.setComposerText(job.factsPrompt, { signal });
      const factsSent = await adapter.sendPrompt({ debugOverlay: false, signal, rateLimitScope: 'postprocess' });
      const text = await adapter.waitForSettledAssistantText({ baselineAssistantCount: factsSent.baselineAssistantCount,
        requireCompleteFactsJson: true, timeout: 180000, signal });
      const conversation = location.href.match(/^https:\/\/chatgpt\.com\/c\/[^/?#]+/)?.[0];
      await send('CARD_EDIT_RESULT', { dataUrl: await dataUrl(new Blob([blob], { type: 'image/png' })), rawFacts: typeof text === 'string' ? text : text.text, chatUrl: conversation });
    } catch (error) {
      await send('CARD_EDIT_ERROR', { error: error.name === 'AbortError' ? 'Редактирование отменено или истекло время ожидания' : error.message }).catch(() => {});
    } finally { clearTimeout(deadline); }
  }
  // Claim is tied by the worker to one tab. Other generation tabs receive null.
  execute().catch(error => send('CARD_EDIT_ERROR', { id: marker, error: error.message }).catch(() => {}));
})();
