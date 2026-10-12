import { CARD_FIELDS, validateCardChanges, auditCardRecords } from './gallery-quality-utils.js';
import { factsSeriesPolicy } from './gallery-utils.js';
import { buildCardWorkbook } from './card-workbook.js';

const labels = { opening: 'Открываю чат', starting: 'Подготовка', preparing: 'Прикрепляю PNG и промпт', submitted: 'Генерация исправленной версии', extracting: 'Читаю текст результата', downloading: 'Сохраняю точный PNG', ready: 'Новая версия сохранена. Открой её и сравни перед принятием', accepted: 'Версия принята', rejected: 'Версия отклонена', cancelled: 'Редактирование отменено', error: 'Ошибка редактирования' };
export function initGalleryReview({ selected, current, allRecords, reload, renderViewer, showError, showToast, download, escapeHtml, selectVersion }) {
  const $ = id => document.getElementById(id);
  let editingId = '', busy = false, deliveryBusy = false;
  const drafts = new Map();
  const send = async (type, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило');
    return response.value;
  };
  const act = async task => {
    if (busy) return; busy = true;
    document.querySelectorAll('[data-review-action]').forEach(button => { button.disabled = true; });
    try { await task(); } catch (error) { showError(error); }
    finally { busy = false; if ($('viewer').open) await renderViewer(); }
  };
  async function refreshJob() {
    const job = await send('GET_CARD_EDIT');
    const panel = $('cardEditStatus');
    panel.hidden = !job;
    if (!job) return;
    $('cardEditStatusText').textContent = `${job.base?.modelName || ''}: ${labels[job.stage] || job.stage}${job.error ? ` — ${job.error}` : ''}`;
    $('cardEditCancel').hidden = ['ready', 'accepted', 'rejected', 'cancelled', 'error'].includes(job.stage);
    $('cardEditOpen').hidden = job.stage !== 'ready';
    $('cardEditOpen').onclick = () => { selectVersion(job.base.sourceId, job.id); };
  }
  function render(record, accepted) {
    const issues = auditCardRecords(allRecords().map(row => row.sourceId === record.sourceId ? record : row)).filter(issue => issue.sourceId === record.sourceId);
    const panel = document.createElement('section'); panel.className = 'review-workbench';
    const editable = record.reviewStatus !== 'rejected';
    const editor = editingId === record.generationId;
    const fields = CARD_FIELDS.filter(([key]) => key !== 'titleSeries' || factsSeriesPolicy(record.facts, record.modelName) !== 'forbidden');
    const same = record.generationId === accepted.generationId;
    const values = drafts.get(record.generationId) || record.facts;
    panel.innerHTML = `<h3>Проверка и исправления</h3>
      <p class="review-note">${same ? 'Текущая версия' : 'Историческая версия'}${record.reviewStatus === 'pending' ? ' · ожидает принятия' : record.reviewStatus === 'rejected' ? ' · отклонена' : record.reviewStatus === 'accepted' ? ' · проверена' : ' · ещё не проверена вручную'}</p>
      ${record.imageTextMatchesFacts === false ? '<p class="quality-critical">Данные исправлены вручную. Надписи PNG ещё требуют исправления.</p>' : ''}
      ${issues.length ? `<details class="quality-issues"><summary>Замечания: ${issues.length}</summary>${issues.map(i => `<p>${escapeHtml(i.reason)}${i.related.length ? `<br>${escapeHtml(i.related.join('; '))}` : ''}</p>`).join('')}</details>` : ''}
      ${record.editChanges?.length ? `<details class="quality-issues"><summary>Заказанные замены</summary>${record.editChanges.map(change => `<p>${escapeHtml(change.label)}: ${escapeHtml(change.before)} → ${escapeHtml(change.after)}<br>В новой спецификации: ${escapeHtml(record.facts?.[change.key] || '—')}</p>`).join('')}</details>` : ''}
      ${!same ? `<details class="quality-issues"><summary>Различия с текущей версией</summary>${fields.filter(([key]) => record.facts?.[key] !== accepted.facts?.[key]).map(([key, label]) => `<p>${label}: ${escapeHtml(accepted.facts?.[key] || '—')} → ${escapeHtml(record.facts?.[key] || '—')}</p>`).join('') || '<p>Текстовые поля совпадают</p>'}</details>` : ''}
      ${editable ? `<label class="review-comment">Комментарий проверяющего<textarea data-review-comment rows="2" maxlength="2000">${escapeHtml(record.reviewComment || '')}</textarea></label>` : ''}
      ${editor ? `<form class="card-editor">${fields.map(([key, label]) => `<label>${label}<textarea data-card-field="${key}" rows="2" ${['titleBrand', 'titleModel'].includes(key) ? 'readonly' : ''}>${escapeHtml(values?.[key] || '')}</textarea></label>`).join('')}
        <p class="review-note">Сохранение данных оставит существующий PNG. Исправление изображения передаст выбранный PNG и список замен в новый чат.</p>
        <div class="review-buttons"><button type="button" data-review-action="save">Сохранить характеристики</button><button type="button" data-review-action="generate">Исправить текст на изображении</button><button type="button" data-review-action="cancel-form">Отмена</button></div></form>` : `<div class="review-buttons">${editable ? '<button type="button" data-review-action="edit">Редактировать поля</button><button type="button" data-review-action="accept">Принять версию</button>' : ''}${!same && editable ? '<button type="button" data-review-action="reject-version">Отклонить версию</button>' : ''}</div>`}`;
    panel.addEventListener('click', event => {
      const action = event.target.closest('[data-review-action]')?.dataset.reviewAction;
      if (!action || busy) return;
      if (action === 'edit' || action === 'cancel-form') { editingId = action === 'edit' ? record.generationId : ''; void renderViewer(); return; }
      void act(async () => {
        if (action === 'accept' || action === 'reject-version') {
          if (action === 'accept' && !window.confirm('Подтвердить выбранную версию как текущую? Проверь изображение, цифры и спецификацию.')) return;
          await send('REVIEW_CARD_VERSION', { generationId: record.generationId, expectedAcceptedId: accepted.generationId, decision: action === 'accept' ? 'accept' : 'reject', reviewComment: panel.querySelector('[data-review-comment]')?.value || '' });
          editingId = ''; await reload(); showToast(action === 'accept' ? 'Версия принята' : 'Версия отклонена');
        } else if (action === 'save' || action === 'generate') {
          const fields = Object.fromEntries([...panel.querySelectorAll('[data-card-field]')].map(input => [input.dataset.cardField, input.value]));
          validateCardChanges(record, fields);
          const job = await send(action === 'save' ? 'SAVE_CARD_FACTS' : 'START_CARD_EDIT', { generationId: record.generationId, expectedAcceptedId: accepted.generationId, fields });
          editingId = ''; await reload(); await refreshJob();
          if (job.stage === 'ready') selectVersion(record.sourceId, job.id);
          showToast(action === 'save' ? 'Создана ручная версия данных. Проверь и прими её' : 'Открыта вкладка исправления карточки');
        }
      });
    });
    panel.addEventListener('input', () => {
      drafts.set(record.generationId, Object.fromEntries([...panel.querySelectorAll('[data-card-field]')].map(input => [input.dataset.cardField, input.value])));
    });
    $('viewerFacts').appendChild(panel);
  }
  $('cardEditCancel').addEventListener('click', () => void act(async () => { await send('CANCEL_CARD_EDIT'); await refreshJob(); }));
  $('exportFactsXlsx').addEventListener('click', () => {
    try {
      const rows = allRecords({ scope: $('exportScope').value });
      download(`watch-cards-${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([buildCardWorkbook(rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
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
      void refreshJob().catch(showError);
      if (changes.cardEditJob.newValue?.stage === 'ready') void reload().then(() => { if ($('viewer').open) return renderViewer(); }).catch(showError);
    }
  });
  void refreshJob().catch(showError);
  return { render, get editing() { return Boolean(editingId); } };
}
