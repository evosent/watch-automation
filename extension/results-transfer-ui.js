const BASE = 'http://127.0.0.1:17321/results-transfer/';

export function initResultsTransfer({ reload }) {
  const $ = (id) => document.getElementById(id);
  let identity = null;
  let importId = null;
  let pendingId = null;
  let busy = false;
  const message = (text, error = false) => {
    $('resultsTransferStatus').textContent = text;
    $('resultsTransferStatus').classList.toggle('error', error);
  };
  const send = async (type, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило. Открой галерею заново.');
    return response.value;
  };
  const url = (route, id = '') => `${BASE}${route}?${new URLSearchParams({ ...identity, id })}`;
  const request = async (route, { id = '', method = 'GET', body } = {}) => {
    const response = await fetch(url(route, id), { method, body, cache: 'no-store',
      signal: AbortSignal.timeout(route === 'import' ? 10 * 60000 : 30000) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Ошибка передачи результатов');
    return payload.value;
  };
  const poll = async (id, phase) => {
    const deadline = Date.now() + 30 * 60000;
    while (Date.now() < deadline) {
      const job = await request('status', { id });
      if (job.phase === 'error') throw new Error(job.error || 'Не удалось обработать архив');
      if (job.phase === phase) return job;
      message(`${job.kind === 'export' ? 'Собираю архив' : job.phase === 'installing' ? 'Устанавливаю фотографии' : 'Проверяю архив'}… ${job.processed || 0}${job.total ? ` из ${job.total}` : ''}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Обработка архива заняла больше 30 минут. Открой передачу результатов повторно.');
  };
  const setBusy = (value) => {
    busy = value;
    ['resultsExport', 'resultsImportCheck', 'resultsImportApply', 'resultsImportResume', 'resultsTransferClose',
      'resultsExportScope', 'resultsImportFile'].forEach((id) => { $(id).disabled = value; });
  };
  const act = async (task) => {
    if (busy) return;
    setBusy(true);
    try { await task(); } catch (error) { message(error.message, true); }
    finally { setBusy(false); }
  };
  const installAndMerge = async (id) => {
    await send('CLAIM_RESULTS_IMPORT', { id });
    pendingId = id; $('resultsImportResume').hidden = false;
    await request('install', { id, method: 'POST' });
    await poll(id, 'installed');
    message('Объединяю результаты с вашей базой…');
    const summary = await send('COMMIT_RESULTS_IMPORT', { id });
    $('resultsImportApply').hidden = true; $('resultsImportResume').hidden = true;
    pendingId = null;
    message(`Импорт завершён: новых результатов ${summary.newResults}, уже известных ${summary.duplicates}, разных версий ${summary.conflicts}.${summary.incompatibleInputs ? ` Для ${summary.incompatibleInputs} результатов исходное фото отличается — прогресс этих моделей сохранён отдельно.` : ''}`);
    await reload();
  };
  $('resultsTransferOpen').addEventListener('click', () => {
    $('resultsTransferDialog').showModal();
    void act(async () => {
      message('Читаю сохранённые результаты…');
      const info = await send('GET_RESULTS_TRANSFER_INFO'); identity = info.identity;
      const health = await fetch('http://127.0.0.1:17321/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then((response) => response.json());
      if (Number(health.apiVersion) < 11) throw new Error('Перезапусти приложение через START_AUTOGENERATION, чтобы включить передачу результатов.');
      $('resultsExportScope').replaceChildren(new Option(`Все сохранённые результаты (${info.count})`, ''));
      for (const run of info.runs) {
        const date = new Date(run.date);
        $('resultsExportScope').append(new Option(`Прогон ${Number.isNaN(date.getTime()) ? run.id : date.toLocaleString('ru-RU')} · ${run.count} фото`, run.id));
      }
      importId = info.pendingId;
      pendingId = info.pendingId;
      $('resultsImportResume').hidden = !importId;
      $('resultsImportApply').hidden = true;
      message(info.pendingId ? 'Сохранился незавершённый импорт. Нажми «Завершить импорт».'
        : info.active ? 'Прогон активен. Экспорт доступен; для импорта заверши или сбрось прогон.'
          : 'Выбери прогон для экспорта или архив результатов другого пользователя.');
    });
  });
  $('resultsTransferClose').addEventListener('click', () => $('resultsTransferDialog').close());
  $('resultsTransferDialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  $('resultsExport').addEventListener('click', () => void act(async () => {
    const job = await send('EXPORT_RESULTS_PACKAGE', { operationId: $('resultsExportScope').value });
    const ready = await poll(job.id, 'ready');
    await chrome.downloads.download({ url: url('archive', job.id), saveAs: true,
      filename: `WatchAutomation-results-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` });
    message(`Архив готов: ${ready.count} результатов для ${ready.models} моделей.${ready.skipped.length ? ` Пропущено ${ready.skipped.length}: ${ready.skipped.slice(0, 5).map((item) => `${item.modelName} — ${item.reason}`).join('; ')}` : ''}`);
  }));
  $('resultsImportFile').addEventListener('change', () => { importId = null; $('resultsImportApply').hidden = true; });
  $('resultsImportCheck').addEventListener('click', () => void act(async () => {
    const file = $('resultsImportFile').files?.[0];
    if (!file || !/\.zip$/i.test(file.name)) throw new Error('Выбери ZIP-архив результатов');
    if (file.size > 1024 * 1024 * 1024) throw new Error('Максимальный размер архива — 1 ГБ');
    message('Загружаю архив в локальный сервис…');
    const job = await request('import', { method: 'POST', body: file });
    await poll(job.id, 'ready'); importId = job.id;
    const preview = await send('PREVIEW_RESULTS_IMPORT', { id: job.id });
    message(`В архиве ${preview.total} результатов для ${preview.models} моделей. Новых: ${preview.newResults}. Уже есть: ${preview.duplicates}. Другие версии: ${preview.conflicts}. Без спецификации: ${preview.withoutFacts}.${preview.rejected ? ` Ранее отмеченные браком результаты (${preview.rejected}) сохранят свой статус.` : ''}\nСуществующие фотографии и прогресс сохранятся. Разные версии будут доступны в базе; ваша текущая версия останется основной.`);
    $('resultsImportApply').hidden = false;
  }));
  $('resultsImportApply').addEventListener('click', () => void act(() => installAndMerge(importId)));
  $('resultsImportResume').addEventListener('click', () => void act(() => installAndMerge(pendingId)));
}
