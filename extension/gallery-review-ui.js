import { CARD_FIELDS, validateCardChanges } from './gallery-quality-utils.js';
import { factsSeriesPolicy } from './gallery-utils.js';
import { buildCardWorkbook } from './card-workbook.js';
import { cardQualityIssues, renderCardQuality } from './gallery-quality-ui.js';

const labels = { opening: 'Подключаю вкладку ChatGPT…', starting: 'Подготовка…', preparing: 'Прикрепляю изображение и промпт…', submitted: 'Генерируется новая версия…', extracting: 'Читаю спецификацию новой версии…', downloading: 'Сохраняю новую версию…', ready: 'Новая версия сохранена', accepted: 'Версия стала основной', rejected: 'Версия отклонена', cancelled: 'Редактирование отменено', error: 'Редактирование не завершено' };
const isActive = job => job && !['ready', 'accepted', 'rejected', 'cancelled', 'error'].includes(job.stage);
export function initGalleryReview({ selected, current, allRecords, reload, renderViewer, showError, showToast, download, escapeHtml, selectVersion }) {
  const $ = id => document.getElementById(id);
  let editingId = '', busy = false, deliveryBusy = false, lastJob = null, jobSequence = 0;
  const drafts = new Map(), errors = new Map();
  const send = async (type, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило');
    return response.value;
  };
  const act = async task => {
    if (busy) return; busy = true;
    document.querySelectorAll('[data-review-action]').forEach(button => { button.disabled = true; });
    try { await task(); } catch (error) {
      const record = selected();
      if ($('viewer').open && record) errors.set(record.generationId, error.message || String(error));
      else showError(error);
    } finally {
      busy = false;
      if ($('viewer').open) await renderViewer();
      renderJobStatus();
    }
  };
  function jobText(job) {
    return `${labels[job.stage] || job.stage}${job.error ? `: ${job.error}` : ''}`;
  }
  function renderJobStatus() {
    // State changes must re-enable the controls already mounted in the modal.
    // Rebuilding the entire viewer here would discard focus and typed drafts.
    for (const button of $('viewerFacts').querySelectorAll('[data-review-action]')) {
      button.disabled = busy || (['edit', 'cancel-form', 'generate', 'accept', 'reject-version'].includes(button.dataset.reviewAction) && Boolean(isActive(lastJob)));
    }
    const sameCard = $('viewer').open && selected()?.sourceId === lastJob?.base?.sourceId;
    const visible = lastJob && !['accepted', 'rejected', 'cancelled'].includes(lastJob.stage);
    $('cardEditStatus').hidden = !visible || sameCard;
    if (lastJob) {
      $('cardEditStatusText').textContent = `${lastJob.base?.modelName || ''}: ${jobText(lastJob)}`;
      $('cardEditCancel').hidden = !isActive(lastJob);
      $('cardEditOpen').hidden = lastJob.stage !== 'ready';
      $('cardEditOpen').onclick = () => selectVersion(lastJob.base.sourceId, lastJob.id);
    }
    const inline = $('cardEditInlineStatus');
    if (!inline) return;
    inline.hidden = !visible || !sameCard;
    if (!sameCard || !lastJob) return;
    inline.querySelector('[data-edit-status-text]').textContent = jobText(lastJob);
    inline.classList.toggle('has-error', lastJob.stage === 'error');
    const cancel = inline.querySelector('[data-review-action="cancel-job"]');
    cancel.hidden = !isActive(lastJob); cancel.disabled = busy;
    const open = inline.querySelector('[data-review-action="open-result"]');
    open.hidden = lastJob.stage !== 'ready' || selected()?.generationId === lastJob.id;
    open.disabled = busy;
  }
  async function refreshJob() {
    const sequence = ++jobSequence;
    const job = await send('GET_CARD_EDIT');
    if (sequence === jobSequence) { lastJob = job; renderJobStatus(); }
  }
  function render(record, accepted) {
    const container = $('viewerFacts');
    const fields = CARD_FIELDS.filter(([key]) => key !== 'titleSeries' || factsSeriesPolicy(record.facts, record.modelName) !== 'forbidden');
    const editor = editingId === record.generationId;
    const editable = record.reviewStatus !== 'rejected' && Boolean(record.facts);
    const same = record.generationId === accepted.generationId;
    const values = drafts.get(record.generationId) || record.facts;
    const readFields = () => ({ ...record.facts, ...Object.fromEntries([...container.querySelectorAll('[data-card-field]')].map(input => [input.dataset.cardField, input.value])) });
    const header = container.querySelector('.facts-title');
    const tools = document.createElement('div'); tools.className = 'spec-edit-tools';
    tools.innerHTML = editable ? `<button type="button" class="spec-edit-toggle" data-review-action="${editor ? 'cancel-form' : 'edit'}" ${busy || isActive(lastJob) ? 'disabled' : ''}>${editor ? 'Отменить изменения' : 'Редактировать спецификацию'}</button>` : '';
    if (header) header.after(tools);
    if (editor) {
      container.classList.add('is-editing');
      for (const [key, label] of fields) {
        if (['titleBrand', 'titleModel'].includes(key)) continue;
        const cell = container.querySelector(`[data-fact-value="${key}"]`);
        if (!cell) continue;
        const input = document.createElement('textarea');
        input.dataset.cardField = key; input.setAttribute('aria-label', label);
        input.rows = 1; input.maxLength = 400; input.value = values?.[key] || '';
        cell.replaceChildren(input);
        const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.max(40, input.scrollHeight + 2)}px`; };
        fit(); input.addEventListener('input', fit);
      }
    } else container.classList.remove('is-editing');
    const panel = document.createElement('section'); panel.className = 'spec-edit-actions';
    panel.innerHTML = `${editor ? '<button type="button" class="button" data-review-action="generate" hidden>Отправить на перегенерацию</button><p class="review-note">Изменятся указанные надписи. Результат сохранится новой версией этих часов.</p>' : ''}
      <p class="spec-edit-error" role="alert" ${errors.has(record.generationId) ? '' : 'hidden'}>${escapeHtml(errors.get(record.generationId) || '')}</p>
      <div id="cardEditInlineStatus" class="spec-edit-status" role="status" hidden><span data-edit-status-text></span><div class="review-buttons"><button type="button" data-review-action="open-result" hidden>Открыть новую версию</button><button type="button" data-review-action="cancel-job" hidden>Отменить</button></div></div>`;
    const grid = container.querySelector('.facts-grid');
    if (grid) grid.after(panel); else container.appendChild(panel);
    const updateSubmit = () => {
      const button = panel.querySelector('[data-review-action="generate"]');
      if (!button) return;
      const input = readFields(), printed = record.imageTextMatchesFacts === false ? record.originalPrintedFacts || record.facts : record.facts;
      const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
      button.hidden = !fields.some(([key]) => clean(input[key]) !== clean(printed?.[key]));
      button.disabled = busy || Boolean(isActive(lastJob));
    };
    for (const input of container.querySelectorAll('[data-card-field]')) input.addEventListener('input', () => {
      drafts.set(record.generationId, readFields()); errors.delete(record.generationId);
      panel.querySelector('.spec-edit-error').hidden = true; updateSubmit();
    });
    updateSubmit();
    const qualityRecords = allRecords().map(row => row.sourceId === record.sourceId ? record : row);
    const issues = cardQualityIssues(record, qualityRecords);
    const details = document.createElement('section'); details.className = 'review-workbench';
    details.innerHTML = `${renderCardQuality(record, qualityRecords, escapeHtml)}
      ${record.editChanges?.length ? `<details class="quality-issues"><summary>Изменённые надписи</summary>${record.editChanges.map(change => `<p>${escapeHtml(change.label)}: ${escapeHtml(change.before)} → ${escapeHtml(change.after)}<br>На новом изображении: ${escapeHtml(record.facts?.[change.key] || '—')}</p>`).join('')}</details>` : ''}
      ${!same ? `<details class="quality-issues"><summary>Отличия от основной версии</summary>${fields.filter(([key]) => record.facts?.[key] !== accepted.facts?.[key]).map(([key, label]) => `<p>${label}: ${escapeHtml(accepted.facts?.[key] || '—')} → ${escapeHtml(record.facts?.[key] || '—')}</p>`).join('') || '<p>Текстовые поля совпадают</p>'}</details>` : ''}
      ${editable && !editor ? `<div class="review-buttons">${same && record.reviewStatus === 'accepted' ? '<span class="review-note">Карточка принята</span>' : `<button type="button" data-review-action="accept">${same ? 'Подтвердить карточку' : 'Сделать основной версией'}</button>`}${!same ? '<button type="button" data-review-action="reject-version">Отклонить версию</button>' : ''}</div><p class="review-note">Принятие версии не закрывает отдельные замечания проверки.</p>` : ''}`;
    container.appendChild(details);
    for (const button of container.querySelectorAll('[data-quality-open-source][data-quality-open-generation]')) {
      button.addEventListener('click', () => selectVersion(button.dataset.qualityOpenSource, button.dataset.qualityOpenGeneration));
    }
    for (const button of container.querySelectorAll('[data-review-action]')) {
      button.disabled ||= busy;
      button.addEventListener('click', () => {
        const action = button.dataset.reviewAction;
        if (busy) return;
        errors.delete(record.generationId);
        if (action === 'edit' || action === 'cancel-form') {
          editingId = action === 'edit' ? record.generationId : '';
          if (action === 'cancel-form') drafts.delete(record.generationId);
          void renderViewer().catch(showError); return;
        }
        if (action === 'open-result') { selectVersion(lastJob.base.sourceId, lastJob.id); return; }
        void act(async () => {
          if (action === 'cancel-job') { await send('CANCEL_CARD_EDIT'); await refreshJob(); }
          else if (action === 'quality-confirm' || action === 'quality-reopen') {
            const index = Number(button.dataset.qualityDecision);
            const issue = Number.isInteger(index) ? issues[index] : null;
            if (!issue || issue.sourceId !== record.sourceId || issue.generationId !== record.generationId) return;
            await send('REVIEW_CARD_ISSUE', {
              generationId: record.generationId,
              expectedAcceptedId: accepted.generationId,
              issueId: issue.id,
              fingerprint: issue.fingerprint,
              decision: action === 'quality-confirm' ? 'confirm' : 'reopen'
            });
            await reload();
          }
          else if (action === 'accept' || action === 'reject-version') {
            await send('REVIEW_CARD_VERSION', { generationId: record.generationId, expectedAcceptedId: accepted.generationId, decision: action === 'accept' ? 'accept' : 'reject', reviewComment: record.reviewComment || '' });
            await reload();
          } else if (action === 'generate') {
            const fields = readFields(); drafts.set(record.generationId, fields);
            validateCardChanges(record, fields);
            await send('START_CARD_EDIT', { generationId: record.generationId, expectedAcceptedId: accepted.generationId, fields });
            editingId = ''; drafts.delete(record.generationId); await refreshJob();
          }
        });
      });
    }
    renderJobStatus();
  }
  $('cardEditCancel').addEventListener('click', () => void act(async () => { await send('CANCEL_CARD_EDIT'); await refreshJob(); }));
  $('viewer').addEventListener('close', renderJobStatus);
  $('exportFactsXlsx').addEventListener('click', () => {
    try {
      const rows = allRecords({ scope: $('exportScope').value });
      download(`watch-cards-${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([buildCardWorkbook(rows, { auditRecords: allRecords() })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      showToast(`Excel: ${rows.length} карточек`);
    } catch (error) { showError(error); }
  });
  $('exportCustomer').addEventListener('click', () => {
    if (deliveryBusy) return;
    void (async () => {
      deliveryBusy = true; $('exportCustomer').disabled = true;
      try {
        const info = await send('GET_RESULTS_TRANSFER_INFO');
        const identity = info.identity;
        const url = (route, id) => `http://127.0.0.1:17321/results-transfer/${route}?${new URLSearchParams({ ...identity, id })}`;
        const job = await send('EXPORT_CUSTOMER_PACKAGE', { generationIds: allRecords({ scope: $('exportScope').value }).map(r => r.generationId) });
        const deadline = Date.now() + 30 * 60000;
        while (Date.now() < deadline) {
          const response = await fetch(url('status', job.id), { signal: AbortSignal.timeout(30000) }), result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || 'Не удалось получить состояние выгрузки');
          if (result.value.phase === 'error') throw new Error(result.value.error);
          if (result.value.phase === 'ready') {
            const downloadId = await chrome.downloads.download({ url: url('archive', job.id), filename: `WatchAutomation-customer-${new Date().toISOString().slice(0, 10)}.zip`, saveAs: true });
            showToast(`Архив заказчику: ${result.value.count} карточек, скачивание ${downloadId}`); return;
          }
          $('exportCustomer').textContent = `Собираю ${result.value.processed || 0}/${result.value.total}`;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Выгрузка превысила 30 минут');
      } catch (error) { showError(error); }
      finally { deliveryBusy = false; $('exportCustomer').disabled = false; $('exportCustomer').textContent = 'Архив заказчику'; }
    })();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cardEditJob) {
      ++jobSequence; lastJob = changes.cardEditJob.newValue || null; renderJobStatus();
      if (lastJob?.stage === 'error' && $('viewer').open
        && selected()?.generationId === lastJob.base?.generationId && !editingId && lastJob.fields) {
        editingId = lastJob.base.generationId; drafts.set(editingId, lastJob.fields);
        void renderViewer().catch(showError);
      }
      if (lastJob?.stage === 'ready') {
        const job = lastJob;
        void reload().then(() => {
          if ($('viewer').open && selected()?.sourceId === job.base.sourceId && !editingId) return selectVersion(job.base.sourceId, job.id);
        }).catch(showError);
      }
    }
  });
  void refreshJob().catch(showError);
  return { render, get editing() { return editingId === selected()?.generationId; } };
}
