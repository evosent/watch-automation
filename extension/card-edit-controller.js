import { getGenerationRevision, getModelCatalog } from './idb.js';
import { stageCardRevision, reviewCardRevision, completeCardRevision } from './card-review-db.js';
import { validateCardChanges, buildCardEditPrompt } from './gallery-quality-utils.js';
import { sanitizeFilename } from './queue-utils.js';

export const CARD_EDIT_JOB_KEY = 'cardEditJob';
const ALARM = 'watch-card-edit-deadline';
const active = job => job && !['ready', 'error', 'cancelled', 'accepted', 'rejected'].includes(job.stage);
const pngData = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

export function createCardEditController({ lock, buildFactsPrompt, normalizeFacts, refreshAccounting, runIsActive }) {
  const save = job => {
    if (job.events?.at(-1)?.stage !== job.stage) job.events = [...(job.events || []), { stage: job.stage, at: new Date().toISOString(), error: job.error || null }].slice(-64);
    return chrome.storage.local.set({ [CARD_EDIT_JOB_KEY]: job });
  };
  const current = async () => (await chrome.storage.local.get(CARD_EDIT_JOB_KEY))[CARD_EDIT_JOB_KEY];
  async function idle() {
    const { run, resultsImportJournal, manualExtensionUpdateLock } = await chrome.storage.local.get(['run', 'resultsImportJournal', 'manualExtensionUpdateLock']);
    if (runIsActive(run)) throw new Error('Заверши текущий прогон перед редактированием карточек');
    if (resultsImportJournal || manualExtensionUpdateLock?.active) throw new Error('Дождись завершения импорта или обновления расширения');
  }
  async function proof(record) {
    if (String(record.outputPath).startsWith('custom://')) throw new Error('Редактирование и передача заказчику сейчас доступны для PNG в папке WatchAutomation в Загрузках');
    const query = new URLSearchParams({ path: record.outputPath, expectedHash: record.outputHash });
    const response = await fetch(`http://127.0.0.1:17321/output-verify?${query}`, { signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok || value.valid !== true || value.sha256 !== record.outputHash || Number(value.bytes) <= 0) throw new Error('Точный PNG отсутствует или изменился');
    return { verified: true, exists: true, isFile: true, generationId: record.generationId, sourceId: record.sourceId,
      outputPath: record.outputPath, outputHash: record.outputHash, sizeBytes: Number(value.sizeBytes || value.bytes),
      width: Number(value.width || 0), height: Number(value.height || 0), verifiedAt: new Date().toISOString() };
  }
  async function base(message) {
    const record = await getGenerationRevision(String(message.generationId || ''));
    if (!completeCardRevision(record) || record.reviewStatus === 'rejected') throw new Error('Эта версия недоступна для исправления');
    const model = await getModelCatalog(record.sourceId);
    if (!model?.latestReadyGenerationId) throw new Error('Текущая версия модели отсутствует');
    if (message.expectedAcceptedId !== model.latestReadyGenerationId) throw new Error('Текущая версия изменилась. Обнови галерею');
    return { record, model };
  }
  function revision(job, facts, artifact) {
    const now = new Date().toISOString();
    return { ...job.base, ...artifact, generationId: job.id, factsJobId: `review-${job.id}`,
      facts: { ...facts, sourceId: job.base.sourceId, generationId: job.id, factsJobId: `review-${job.id}`,
        outputPath: artifact.outputPath, outputHash: artifact.outputHash, chatUrl: artifact.chatUrl || job.base.chatUrl || null, status: 'ok' },
      factsStatus: 'ok', status: 'READY', reviewStatus: 'pending', operationId: job.id,
      parentGenerationId: job.base.generationId, editChanges: job.changes, revisionKind: job.kind,
      originalPrintedFacts: job.kind === 'manual_facts' ? job.base.originalPrintedFacts || job.base.facts : null,
      imageTextMatchesFacts: job.kind !== 'manual_facts', generatedAt: now, completedAt: now, createdAt: now,
      supersededBySessionRestartId: null, identityQuarantined: false, factsManualReviewRequired: false };
  }
  async function start(message, kind) {
    return lock(async () => {
      await idle(); const previous = await current();
      if (active(previous) || previous?.stage === 'ready') throw new Error('Сначала заверши или отклони предыдущее редактирование');
      const { record, model } = await base(message), { fields, changes } = validateCardChanges(record, message.fields);
      const sourceProof = await proof(record);
      const job = { id: crypto.randomUUID(), kind, base: { ...record, outputWidth: sourceProof.width || record.outputWidth, outputHeight: sourceProof.height || record.outputHeight }, expectedAcceptedId: model.latestReadyGenerationId,
        fields, changes, stage: 'starting', startedAt: new Date().toISOString(), deadline: Date.now() + 20 * 60000 };
      await save(job);
      if (kind === 'manual_facts') {
        try {
          const facts = normalizeFacts(record, JSON.stringify({ ...fields, uncertain: [] }), { generationId: job.id, outputPath: record.outputPath, outputHash: record.outputHash, chatUrl: record.chatUrl });
          const revised = revision(job, { ...facts, factsSource: 'manual' }, record);
          const checked = await proof(revised);
          await stageCardRevision(revised, checked);
          job.stage = 'ready'; await save(job); return job;
        } catch (error) { job.stage = 'error'; job.error = error.message; await save(job); throw error; }
      }
      try {
        const tab = await chrome.tabs.create({ url: `https://chatgpt.com/?watch_automation=1&watch_card_edit=${job.id}`, active: true });
        job.tabId = tab.id; job.stage = 'opening'; await save(job);
        await chrome.alarms.create(ALARM, { when: job.deadline });
        // Content script asks for its own payload when the new page is ready.
        return { id: job.id, stage: job.stage, tabId: tab.id };
      } catch (error) { job.stage = 'error'; job.error = error.message; await save(job); throw error; }
    });
  }
  async function fail(id, error) {
    return lock(async () => {
      const job = await current(); if (!job || job.id !== id || !active(job)) return;
      job.stage = 'error'; job.error = String(error); await save(job); await chrome.alarms.clear(ALARM);
    });
  }
  async function finalizeDownload(job) {
    const [download] = await chrome.downloads.search({ id: job.downloadId });
    if (!download || download.state !== 'complete') return;
    const artifact = { ...job.base, generationId: job.id, sourceId: job.base.sourceId, outputPath: download.filename,
      outputHash: job.outputHash, outputFileName: download.filename.split(/[\\/]/).pop(), chatUrl: job.chatUrl };
    const checked = await proof(artifact);
    if ((job.base.outputWidth && checked.width && job.base.outputWidth !== checked.width)
      || (job.base.outputHeight && checked.height && job.base.outputHeight !== checked.height)) throw new Error('ChatGPT изменил размеры PNG. Исходная карточка сохранена');
    artifact.outputWidth = checked.width || job.base.outputWidth;
    artifact.outputHeight = checked.height || job.base.outputHeight;
    const facts = normalizeFacts(job.base, job.rawFacts, { generationId: job.id, outputHash: job.outputHash, outputPath: download.filename, chatUrl: job.chatUrl });
    const candidate = revision(job, facts, artifact);
    await stageCardRevision(candidate, checked);
    job.stage = 'ready'; job.outputPath = download.filename; await save(job); await chrome.alarms.clear(ALARM);
  }
  async function page(message, sender) {
    return lock(async () => {
      const job = await current(); if (!job || job.tabId !== sender?.tab?.id) return null;
      if (message.type === 'CARD_EDIT_CLAIM') {
        if (job.stage !== 'opening' || message.requestedId !== job.id) return null;
        job.stage = 'preparing'; await save(job);
        const response = await fetch(`http://127.0.0.1:17321/output-file?${new URLSearchParams({ path: job.base.outputPath, expectedHash: job.base.outputHash })}`, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Не удалось прочитать исходный PNG');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024) throw new Error('PNG превышает 32 МБ');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== job.base.outputHash) throw new Error('Контрольная сумма исходного PNG изменилась');
        let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { id: job.id, deadline: job.deadline, file: { name: 'card-to-edit.png', dataUrl: `data:image/png;base64,${btoa(binary)}` },
          prompt: buildCardEditPrompt(job.base, job.changes), factsPrompt: buildFactsPrompt(job.base) };
      }
      if (message.id !== job.id || !active(job)) return null;
      if (message.type === 'CARD_EDIT_STAGE') {
        const stages = { preparing: ['submitted'], submitted: ['extracting'], extracting: [] };
        if (stages[job.stage]?.includes(message.stage)) { job.stage = message.stage; await save(job); }
        return { stage: job.stage };
      }
      if (message.type === 'CARD_EDIT_RESULT') {
        if (job.downloadId) return { downloadId: job.downloadId };
        if (!['submitted', 'extracting'].includes(job.stage) || !pngData.test(message.dataUrl || '') || message.dataUrl.length > 48 * 1024 * 1024) throw new Error('Некорректный результат редактирования');
        const bytes = Uint8Array.from(atob(message.dataUrl.split(',')[1]), c => c.charCodeAt(0));
        if (bytes.subarray(0, 8).join(',') !== '137,80,78,71,13,10,26,10') throw new Error('Результат не является PNG');
        job.outputHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        job.rawFacts = String(message.rawFacts || '').slice(0, 64000);
        if (!/^https:\/\/chatgpt\.com\/c\/[^/?#]+$/.test(message.chatUrl || '')) throw new Error('Чат результата не определён');
        job.chatUrl = message.chatUrl;
        // Validate OCR JSON before writing a file. Desired facts never stand in
        // for what was actually printed in the generated output.
        normalizeFacts(job.base, job.rawFacts, { generationId: job.id, outputHash: job.outputHash, chatUrl: job.chatUrl });
        const filename = `WatchAutomation/${sanitizeFilename(job.base.groupId)}/${sanitizeFilename(job.base.facts.titleModel)}__edit_${job.id}.png`;
        job.stage = 'downloading';
        job.downloadId = await chrome.downloads.download({ url: message.dataUrl, filename, conflictAction: 'uniquify', saveAs: false });
        await save(job); await finalizeDownload(job); return { downloadId: job.downloadId };
      }
      return null;
    });
  }
  return {
    active,
    async busy() { const job = await current(); return active(job) || job?.stage === 'ready'; },
    async handle(message, sender) {
      if (message.type === 'GET_CARD_EDIT') return current();
      if (message.type === 'START_CARD_EDIT') return start(message, 'image_edit');
      if (message.type === 'SAVE_CARD_FACTS') return start(message, 'manual_facts');
      if (message.type === 'CANCEL_CARD_EDIT') {
        const job = await lock(async () => {
          const latest = await current(); if (!active(latest)) return null;
          latest.stage = 'cancelled'; await save(latest); await chrome.alarms.clear(ALARM); return latest;
        });
        if (!job) return current();
        if (job.downloadId && chrome.downloads.cancel) await chrome.downloads.cancel(job.downloadId).catch(() => {});
        if (job.tabId) await chrome.tabs.sendMessage(job.tabId, { type: 'CANCEL_CARD_EDIT', id: job.id }).catch(() => {});
        return job;
      }
      if (message.type === 'REVIEW_CARD_VERSION') return lock(async () => {
        await idle(); const record = await getGenerationRevision(message.generationId);
        const checked = message.decision === 'accept' ? await proof(record) : null;
        const result = await reviewCardRevision(message.generationId, message.decision, message.expectedAcceptedId, checked, String(message.reviewComment || '').slice(0, 2000));
        if (!result.changed) throw new Error(`Версия не изменена: ${result.reason}`);
        const job = await current(); if (job?.id === message.generationId) { job.stage = message.decision === 'accept' ? 'accepted' : 'rejected'; await save(job); }
        return result;
      });
      if (message.type === 'CARD_EDIT_ERROR') {
        const job = await current(); if (job?.id === message.id && job.tabId === sender?.tab?.id) await fail(job.id, message.error);
        return null;
      }
      try { return await page(message, sender); }
      catch (error) {
        const job = await current(); if (job?.tabId === sender?.tab?.id) await fail(job.id, error.message);
        throw error;
      }
    },
    async onAlarm(alarm) { if (alarm.name !== ALARM) return; const job = await current(); if (active(job)) await fail(job.id, 'Истекло 20 минут. Исходная карточка сохранена; повторная отправка промпта отключена'); },
    async onDownload(delta) {
      const job = await current(); if (!active(job) || job.downloadId !== delta.id) return;
      if (delta.error) return fail(job.id, delta.error.current);
      if (delta.state?.current === 'complete') {
        try { await lock(async () => { const latest = await current(); if (latest?.id === job.id && active(latest)) await finalizeDownload(latest); }); }
        catch (error) { await fail(job.id, error.message); }
        await refreshAccounting();
      }
    },
    async onTabRemoved(tabId) { const job = await current(); if (active(job) && job.tabId === tabId) await fail(job.id, 'Вкладка редактирования закрыта. Исходная карточка сохранена'); },
    async reconcile() {
      const job = await current(); if (!active(job)) return;
      if (job.deadline <= Date.now()) return fail(job.id, 'Редактирование прервано по таймеру');
      if (job.stage === 'downloading') {
        try { await lock(async () => { const latest = await current(); if (latest?.id === job.id && active(latest)) await finalizeDownload(latest); }); }
        catch (error) { return fail(job.id, error.message); }
      } else {
        const tab = await chrome.tabs.get(job.tabId).catch(() => null);
        if (!tab) return fail(job.id, 'Вкладка редактирования недоступна');
      }
      if (active(await current())) await chrome.alarms.create(ALARM, { when: job.deadline });
    }
  };
}
