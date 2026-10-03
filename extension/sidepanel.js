import {
  QUEUE_GROUP_IDS,
  QUEUE_GROUPS,
  REGENERATION_QUEUE_ID,
  applyGenerationHistory,
  applyGenerationMemory,
  brandIdFromModelName,
  classifyWatchPath,
  chooseSourceVariant,
  filterFromQueueGroup,
  filteredWatchEntries,
  fingerprintForFile,
  generationMemoryRecordFromEntry,
  groupIdForWatchFilter,
  isImageFileName,
  mergeScannedGroups,
  modelCatalogRecordsFromGroups,
  queueGroupsFromCatalog,
  queuePartPlan,
  queueEntriesForPart,
  normalizeRelativePath,
  normalizeRunLimit,
  normalizeWatchFilter,
  normalizeWorkerCount,
  RUN_PART_SIZE,
  GENERATION_MEMORY_STATUS_LABELS,
  GENERATION_MEMORY_STATUSES,
  parseFilterSelectionId,
  queueCounts,
  referenceDescriptorForPath,
  sourceIdFor,
  sourceVariantIdFor,
  watchFilterLabel,
  WATCH_BRAND_FILTERS
} from './queue-utils.js';
import {
  getAsset, getAssetKeys, replaceAssets, replaceModelCatalog, getAllModelCatalog, adoptLegacyGenerationRevisions,
  getOutputDirectoryHandle, putOutputDirectoryHandle, listRunDiagnostics, getRunDiagnostic
} from './idb.js';
import { buildInputPlan, normalizeInputMode, DEFAULT_INPUT_MODE } from './input-plan.js';
import { selectFactsProgressForSlot } from './facts-progress-utils.js';
import {
  DEFAULT_GENERATION_JITTER_SECONDS,
  DEFAULT_GENERATION_PAUSE_MINUTES,
  DEFAULT_RATE_LIMIT_IGNORE_MINUTES,
  normalizeGenerationJitterSeconds,
  normalizeGenerationPauseMinutes,
  normalizeRateLimitIgnoreMinutes
} from './reliability-utils.js';

const $ = (id) => document.getElementById(id);
const referenceFiles = new Map();
const watchFiles = new Map();
const payloadCache = new Map();
let folderSelections = { references: null, watches: null };
let outputDestination = { mode: 'downloads', folderName: null, permission: 'unknown' };
let outputDirectoryHandle = null;
let queue = { version: 1, groups: Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []])), refs: {}, repairQueue: [] };
let runtime = { state: 'IDLE', workerCount: 4, slots: [] };
let promptText = '';
let generationMemory = { version: 1, items: {} };
let lastPreflight = null;
let lastMemoryRenderKey = '';
let diagnosticsObservedOperationId = '';
let diagnosticsObservedRunState = 'IDLE';
let desiredRunPart = '';
let desiredRunPartSignature = '';
let currentLaunchPartPlan = null;
let currentLaunchSelectionExact = false;
let extensionUpdateStatus = { phase: 'idle', message: 'Проверка запускается вручную из этого раздела.' };
let extensionUpdatePollTimer = null;
let extensionUpdatePollInFlight = false;
let referenceSyncInFlight = false;
const EXTENSION_UPDATE_ACTIVE_PHASES = new Set(['checking', 'downloading', 'validating', 'ready', 'applying', 'syncing-references']);
const DOM_DIAGNOSTICS_MODE_LABELS = {
  off: 'Постоянный сбор выключен.',
  errors: 'DOM сохраняется только при ошибках и зависании.',
  full: 'Полный журнал DOM включён и может замедлять браузер.'
};
let domDiagnosticsMode = 'off';
const DEFAULT_RATE_LIMIT_PAUSE_MINUTES = 3;
const MIN_RATE_LIMIT_PAUSE_MINUTES = 1;
const MAX_RATE_LIMIT_PAUSE_MINUTES = 30;
// UI workspace v2: keep the daily workflow compact by separating launch,
// catalogue and maintenance into independent views. This state is local to
// the side panel and never changes automation/runtime state.
const UI_VIEW_STORAGE_KEY = 'watchAutomation.uiView.v2';
const UI_DISCLOSURE_STORAGE_KEY = 'watchAutomation.disclosures.v2';
const UI_VIEWS = new Set(['run', 'models', 'service']);

function setWorkspaceView(view, { persist = true } = {}) {
  const next = UI_VIEWS.has(String(view)) ? String(view) : 'run';
  document.querySelectorAll('[data-workspace-view]').forEach((node) => {
    node.hidden = node.dataset.workspaceView !== next;
  });
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    const active = button.dataset.workspaceTab === next;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (persist) {
    try { localStorage.setItem(UI_VIEW_STORAGE_KEY, next); } catch (_) {}
  }
}

function disclosureState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_DISCLOSURE_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function initWorkspaceUi() {
  let initialView = 'run';
  try { initialView = localStorage.getItem(UI_VIEW_STORAGE_KEY) || 'run'; } catch (_) {}
  setWorkspaceView(initialView, { persist: false });

  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceTab));
  });

  const saved = disclosureState();
  document.querySelectorAll('details[id]').forEach((details) => {
    if (Object.prototype.hasOwnProperty.call(saved, details.id)) details.open = Boolean(saved[details.id]);
    details.addEventListener('toggle', () => {
      const next = disclosureState();
      next[details.id] = details.open;
      try { localStorage.setItem(UI_DISCLOSURE_STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
    });
  });
}
let feedbackActionHandler = null;
let feedbackTimer = null;

function normalizeRateLimitPauseMinutes(value, fallback = DEFAULT_RATE_LIMIT_PAUSE_MINUTES) {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_RATE_LIMIT_PAUSE_MINUTES;
  const resolved = Number.isFinite(numeric) && numeric > 0 ? numeric : safeFallback;
  return Math.min(MAX_RATE_LIMIT_PAUSE_MINUTES, Math.max(MIN_RATE_LIMIT_PAUSE_MINUTES, Math.round(resolved)));
}

function normalizeDomDiagnosticsMode(value) {
  const mode = String(value || '').toLowerCase();
  return ['off', 'errors', 'full'].includes(mode) ? mode : 'off';
}

function updateDomDiagnosticsStatus(message = null) {
  const select = $('domDiagnosticsMode');
  const status = $('domDiagnosticsStatus');
  if (select) select.value = domDiagnosticsMode;
  if (status) status.textContent = message || DOM_DIAGNOSTICS_MODE_LABELS[domDiagnosticsMode] || DOM_DIAGNOSTICS_MODE_LABELS.off;
}

function clearFeedback() {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = null;
  feedbackActionHandler = null;
  const panel = $('feedback');
  if (!panel) return;
  panel.hidden = true;
  panel.className = 'feedback';
  const text = $('feedbackText');
  if (text) text.textContent = '';
  const action = $('feedbackAction');
  if (action) {
    action.hidden = true;
    action.textContent = '';
  }
}

function showFeedback(message, options = {}) {
  const panel = $('feedback');
  const text = $('feedbackText');
  if (!panel || !text) return;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = null;
  const type = options.type || 'error';
  panel.className = `feedback is-${type}`;
  text.textContent = String(message || '');
  panel.hidden = false;
  feedbackActionHandler = typeof options.onAction === 'function' ? options.onAction : null;
  const action = $('feedbackAction');
  if (action) {
    action.hidden = !feedbackActionHandler;
    action.textContent = feedbackActionHandler ? (options.actionLabel || 'Выполнить') : '';
  }
  if (options.autoHide) {
    feedbackTimer = setTimeout(() => clearFeedback(), Number(options.autoHideMs || 6000));
  }
}

function requestInlineConfirmation(message, actionLabel, callback) {
  showFeedback(message, {
    type: 'info',
    actionLabel,
    onAction: async () => {
      const button = $('feedbackAction');
      if (button) button.disabled = true;
      // Close the confirmation before running the operation. Any failure is
      // rendered as a new inline error message by showError().
      clearFeedback();
      try {
        await callback();
      } catch (error) {
        showError(error);
      } finally {
        if (button) button.disabled = false;
      }
    }
  });
}

function filterFromInputs() {
  const groupId = String($('runGroupFilter')?.value || 'all');
  const groupFilter = QUEUE_GROUP_IDS.includes(groupId)
    ? filterFromQueueGroup(groupId)
    : { saleStatus: 'all', quality: 'all' };
  return normalizeWatchFilter({
    ...groupFilter,
    brand: $('runBrandFilter')?.value
  });
}

function memoryFilterState() {
  const status = String($('memoryStatusFilter')?.value || 'all');
  return {
    search: String($('memorySearch')?.value || '').trim(),
    group: QUEUE_GROUP_IDS.includes(String($('memoryGroupFilter')?.value || ''))
      ? String($('memoryGroupFilter').value)
      : 'all',
    brand: WATCH_BRAND_FILTERS.some((item) => item.id === String($('memoryBrandFilter')?.value || ''))
      ? String($('memoryBrandFilter').value)
      : 'all',
    status: ['all', ...Object.values(GENERATION_MEMORY_STATUSES)].includes(status) ? status : 'all'
  };
}

function setFilterInputs(filterValue = {}, memoryFilters = {}) {
  const filter = normalizeWatchFilter(filterValue);
  const groupId = `${filter.saleStatus}_${filter.quality}`;
  const group = QUEUE_GROUP_IDS.includes(groupId) ? groupId : '';
  const brand = filter.brand !== 'all' ? filter.brand : '';
  if ($('runGroupFilter')) $('runGroupFilter').value = group;
  if ($('runBrandFilter')) $('runBrandFilter').value = brand;
  const catalogGroup = QUEUE_GROUP_IDS.includes(String(memoryFilters.group || ''))
    ? String(memoryFilters.group)
    : 'all';
  const catalogBrand = WATCH_BRAND_FILTERS.some((item) => item.id === String(memoryFilters.brand || ''))
    ? String(memoryFilters.brand)
    : 'all';
  if ($('memoryGroupFilter')) $('memoryGroupFilter').value = catalogGroup;
  if ($('memoryBrandFilter')) $('memoryBrandFilter').value = catalogBrand;
  if ($('memorySearch') && memoryFilters.search != null) {
    $('memorySearch').value = String(memoryFilters.search || '');
  }
  if ($('memoryStatusFilter')) {
    const status = String(memoryFilters.status || 'all');
    $('memoryStatusFilter').value = ['all', ...Object.values(GENERATION_MEMORY_STATUSES)].includes(status)
      ? status
      : 'all';
  }
}

function filterEntries(filterValue = filterFromInputs()) {
  return filteredWatchEntries(queue.groups, filterValue);
}

function normalizedRepairQueueItems(queueValue = queue) {
  return Array.isArray(queueValue?.repairQueue) ? queueValue.repairQueue : [];
}

function repairQueueSourceIds(queueValue = queue) {
  return new Set(normalizedRepairQueueItems(queueValue)
    .filter((item) => typeof item === 'string' || item?.status !== 'completed')
    .map((item) => typeof item === 'string' ? item : item?.sourceId)
    .filter(Boolean)
    .map(String));
}

function launchQueueMode() {
  const value = String($('runQueueMode')?.value || '');
  return ['regular', REGENERATION_QUEUE_ID].includes(value) ? value : '';
}

function launchSelectionIsExact() {
  const groupId = String($('runGroupFilter')?.value || '');
  const brand = String($('runBrandFilter')?.value || '');
  return ['regular', REGENERATION_QUEUE_ID].includes(launchQueueMode())
    && QUEUE_GROUP_IDS.includes(groupId)
    && WATCH_BRAND_FILTERS.some((item) => item.id === brand && item.id !== 'all');
}

function launchQueueCandidates() {
  if (!launchSelectionIsExact()) return [];
  const repairs = repairQueueSourceIds();
  const filtered = filterEntries();
  if (launchQueueMode() === REGENERATION_QUEUE_ID) {
    return filtered.filter((entry) => repairs.has(String(entry.sourceId)));
  }
  return filtered;
}

function launchQueuePartPlan() {
  if (!launchSelectionIsExact()) return null;
  const filter = filterFromInputs();
  const context = `${launchQueueMode()}|${filter.saleStatus}|${filter.quality}|${filter.brand}`;
  return queuePartPlan(launchQueueCandidates(), RUN_PART_SIZE, context);
}

function launchQueueEntries(plan = launchQueuePartPlan()) {
  const partNumber = Number($('runPart')?.value || 0);
  const selectedEntries = queueEntriesForPart(plan, partNumber);
  if (!selectedEntries.length) return [];
  const repairs = repairQueueSourceIds();
  if (launchQueueMode() === REGENERATION_QUEUE_ID) {
    return selectedEntries.filter((entry) => repairs.has(String(entry.sourceId)) && entry.status !== 'running');
  }
  return selectedEntries.filter((entry) => !repairs.has(String(entry.sourceId)) && !['done', 'running'].includes(entry.status));
}

function resetRunPartSelection() {
  desiredRunPart = '';
  desiredRunPartSignature = '';
  const select = $('runPart');
  if (!select) return;
  select.dataset.partitionSignature = '';
  select.value = '';
}

function updateLaunchQueueSummary() {
  const node = $('launchQueueSummary');
  if (!node) return;
  const select = $('runPart');
  const selectionExact = launchSelectionIsExact();
  const plan = selectionExact ? launchQueuePartPlan() : null;
  currentLaunchPartPlan = plan;
  currentLaunchSelectionExact = selectionExact;
  if (select) {
    const previousPart = String(select.value || '');
    const previousSignature = String(select.dataset.partitionSignature || '');
    const keepPrevious = Boolean(plan && previousPart && previousSignature === plan.signature);
    const restoreSaved = Boolean(plan && desiredRunPart && desiredRunPartSignature === plan.signature);
    select.replaceChildren(new Option(
      selectionExact ? (plan?.partCount ? 'Выберите часть' : 'Очередь пуста') : 'Сначала задайте фильтры',
      ''
    ));
    if (plan) {
      for (const part of plan.parts) {
        select.add(new Option(`Часть ${part.partNumber} из ${plan.partCount} · ${part.count} моделей`, String(part.partNumber)));
      }
      const wanted = keepPrevious ? previousPart : (restoreSaved ? desiredRunPart : '');
      if (wanted && plan.parts.some((part) => String(part.partNumber) === wanted)) select.value = wanted;
      select.dataset.partitionSignature = plan.signature;
      if (!restoreSaved && desiredRunPart) {
        desiredRunPart = '';
        desiredRunPartSignature = '';
      }
    } else {
      select.dataset.partitionSignature = '';
      select.value = '';
    }
  }
  const count = launchQueueEntries(plan).length;
  if (!selectionExact) {
    node.textContent = 'Выберите очередь, точную категорию и один бренд';
    return;
  }
  if (!plan?.total) {
    node.textContent = launchQueueMode() === REGENERATION_QUEUE_ID
      ? 'В очереди брака нет подходящих моделей'
      : 'По этим фильтрам моделей нет';
    return;
  }
  const selectedNumber = Number(select?.value || 0);
  const selectedPart = plan.parts.find((part) => part.partNumber === selectedNumber);
  const tail = selectedPart ? ` · часть ${selectedPart.partNumber}/${plan.partCount} · к запуску ${count}` : ` · ${plan.partCount} частей`;
  node.textContent = `${plan.total} моделей${tail} · ${filterLabel()}`;
}

function filterLabel(filterValue = filterFromInputs()) {
  return watchFilterLabel(filterValue);
}

function populateBrandFilter() {
  const runBrand = $('runBrandFilter');
  if (runBrand) {
    runBrand.replaceChildren(new Option('Выберите один бренд', ''));
    for (const item of WATCH_BRAND_FILTERS.filter((item) => item.id !== 'all')) {
      runBrand.add(new Option(item.label, item.id));
    }
  }
  const memoryBrand = $('memoryBrandFilter');
  if (memoryBrand) {
    memoryBrand.replaceChildren();
    for (const item of WATCH_BRAND_FILTERS) {
      memoryBrand.add(new Option(item.label, item.id));
    }
  }
}

const FACTS_STAGE_LABELS = Object.freeze({
  QUEUED: 'постпроверка поставлена в очередь',
  WAITING_COMPOSER: 'ждёт завершения генерации',
  FILLING_PROMPT: 'вставляет промпт характеристик',
  WAITING_SEND: 'ждёт готовности кнопки Send',
  WAITING_SEND_BUTTON: 'ждёт кнопку Send',
  WAITING_SEND_GATE: 'ждёт общий Send-интервал',
  SENDING: 'нажимает Send для постпроверки',
  SENDING_PROMPT: 'нажимает Send',
  SEND_CLICKED: 'Send нажат',
  WAITING_ACCEPTANCE: 'проверяет отправку промпта',
  PROMPT_ACCEPTED: 'промпт постпроверки принят',
  RETRYING_SEND: 'повторяет Send после холостого клика',
  WAITING_RESPONSE_START: 'ждёт начало ответа ChatGPT',
  WAITING_RESPONSE: 'готовит ожидание ответа',
  WAITING_MODEL_RESPONSE: 'промпт отправлен · ждёт начало ответа ChatGPT',
  RECEIVING_RESPONSE: 'ChatGPT отвечает · ждёт полный JSON',
  STREAMING_RESPONSE: 'ChatGPT отвечает · ждёт полный JSON',
  PARSING: 'проверяет полный JSON',
  RESPONSE_RECEIVED: 'ответ характеристик получен',
  SAVING: 'сохраняет характеристики',
  PERSISTING: 'записывает ревизию на диск',
  SAVED: 'характеристики сохранены',
  RATE_LIMIT: 'лимит запросов постпроверки',
  ERROR: 'ошибка постпроверки'
});

const RUN_STATE_LABELS = {
  IDLE: 'ГОТОВО',
  STARTING: 'ЗАПУСКАЮСЬ',
  RUNNING: 'РАБОТАЕТ',
  DRAINING: 'ДОЖИДАЮСЬ РЕЗУЛЬТАТЫ',
  RECONCILING: 'СВЕРЯЮ СОСТОЯНИЕ',
  PAUSED: 'ПАУЗА',
  STOPPED: 'ОСТАНОВЛЕНО',
  DONE: 'ЗАВЕРШЕНО',
  ERROR: 'ОШИБКА'
};

const SLOT_STATE_LABELS = {
  IDLE: 'свободна',
  PREPARING: 'подготавливает слот',
  STARTING: 'открывает чат',
  UPLOADING: 'загружает входные данные',
  UPLOADING_ATTACHMENTS: 'загружает референсы',
  ATTACHMENTS_READY: 'референсы загружены',
  WAITING_LAUNCH: 'ждёт Send-интервал',
  READY_TO_SEND: 'полностью готова · ждёт Send',
  PROMPT_SENT: 'промпт отправлен',
  CREATING_NEW_CHAT: 'создаёт чат',
  UPLOADING_TEMPLATE: 'загружает шаблон',
  UPLOADING_OZONMAP: 'загружает карту Ozon',
  UPLOADING_STORELOGO: 'загружает логотип',
  UPLOADING_WATCHREFERENCE: 'загружает часы',
  FILLING_PROMPT: 'вставляет промпт',
  SENDING: 'запускает генерацию',
  IMAGE_FOUND: 'изображение найдено',
  GENERATING: 'ждёт генерацию',
  WAITING_GENERATION: 'проверяет изображение',
  REQUESTING_DOWNLOAD: 'готовит скачивание',
  DOWNLOADING: 'скачивает результат',
  VERIFYING_FILE: 'проверяет PNG',
  DONE: 'готово',
  RETRY_BACKOFF: 'ожидает повтор',
  RATE_LIMIT_PAUSE: 'ждёт снятия лимита',
  TAB_LOST: 'вкладка потеряна',
  NEEDS_ATTENTION: 'нужна проверка',
  RECOVERING: 'переподключает страницу',
  OBSERVING: 'повторно проверяет',
  PAUSED: 'на паузе',
  STOPPED: 'остановлена'
};

const CHECK_STATE_LABELS = {
  READY: 'изображение найдено',
  WAITING_ASSISTANT: 'ждёт ответ',
  GENERATING: 'генерация идёт',
  WAITING_IMAGE: 'ждёт изображение',
  DOWNLOADING: 'скачивание идёт',
  DOWNLOADED: 'скачано',
  NO_RESPONSE: 'нет ответа вкладки',
  ERROR: 'ошибка страницы',
  RATE_LIMIT_PAUSE: 'ограничение запросов'
};

function filePath(file) {
  return normalizeRelativePath(file.webkitRelativePath || file.name);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`Не удалось прочитать ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function payloadForFile(file, cacheKey = null) {
  if (cacheKey && payloadCache.has(cacheKey)) return payloadCache.get(cacheKey);
  const dataUrl = await readFileAsDataUrl(file);
  const payload = { name: file.name, type: file.type || 'image/png', size: file.size, dataUrl };
  if (cacheKey) payloadCache.set(cacheKey, payload);
  return payload;
}

function folderPathHint(files, marker) {
  const markerName = String(marker).toLowerCase();
  const candidate = files.map((file) => filePath(file)).find((value) => (
    value.split('/').some((part) => part.toLowerCase() === markerName)
  ));
  // `webkitdirectory` reports paths relative to the directory the user picked.
  // If they pick `in_sale` directly, the expected root marker is absent; show
  // the reported folder name instead of leaving the UI at "папка не выбрана".
  if (!candidate) {
    const first = filePath(files[0]).split('/').filter(Boolean);
    return first.length > 1 ? first[0] : '';
  }
  const parts = candidate.split('/').filter(Boolean);
  const markerIndex = parts.findIndex((part) => part.toLowerCase() === markerName);
  return markerIndex >= 0 ? parts.slice(0, markerIndex + 1).join('/') : parts[0] || '';
}

function describeFolderSelection(files, marker, fileCount = files.length) {
  return {
    pathHint: folderPathHint(files, marker),
    fileCount: Number(fileCount || 0),
    selectedFileCount: files.length,
    recognizedFileCount: Number(fileCount || 0),
    savedAt: new Date().toISOString()
  };
}

async function sha256File(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !crypto?.subtle) return null;
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashScannedWatchFiles(groups, concurrency = 4) {
  const items = QUEUE_GROUP_IDS.flatMap((groupId) => groups[groupId] || []);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      item.sourceHash = await sha256File(item.file).catch(() => null);
    }
  });
  await Promise.all(workers);
}

function fileFromAsset(record) {
  if (!record?.blob) throw new Error(`Сохранённый файл недоступен: ${record?.key || 'неизвестный ключ'}`);
  return new File([record.blob], record.name || 'input.png', {
    type: record.type || record.blob.type || 'image/png',
    lastModified: Number(record.lastModified || Date.now())
  });
}

async function fileForInput(key, file) {
  if (!file?.storedKey) return file;
  const record = await getAsset(file.storedKey || key);
  if (!record) throw new Error(`Сохранённый файл недоступен: ${file.name || key}`);
  return fileFromAsset(record);
}

async function restorePersistedInputs() {
  referenceFiles.clear();
  watchFiles.clear();
  payloadCache.clear();
  const [referenceKeys, watchKeys, catalog] = await Promise.all([
    getAssetKeys('ref:'), getAssetKeys('watch:'), getAllModelCatalog().catch(() => [])
  ]);
  for (const assetKey of referenceKeys) {
    const key = String(assetKey).slice('ref:'.length);
    const metadata = queue.refs?.[key] || {};
    referenceFiles.set(key, {
      storedKey: String(assetKey),
      name: metadata.name || key,
      type: 'image/png',
      size: Number(metadata.size || 0)
    });
  }
  const entries = catalog.length
    ? catalog
    : QUEUE_GROUP_IDS.flatMap((groupId) => queue.groups?.[groupId] || []);
  for (const model of entries) {
    const variants = model.variants?.length ? model.variants : [model];
    for (const variant of variants) {
      const sourceVariantId = String(variant.sourceVariantId || variant.variantId || variant.inputSourceId || '');
      const storedKey = String(variant.assetKey || `watch:${sourceVariantId}`);
      if (!sourceVariantId || !watchKeys.includes(storedKey)) continue;
      watchFiles.set(sourceVariantId, {
        storedKey,
        name: variant.fileName || model.modelName || 'watch.png',
        type: 'image/png',
        size: Number(variant.size || 0)
      });
    }
  }
}

function emptyGroups() {
  return Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []]));
}

async function loadBundledPrompt(storedJob = {}) {
  try {
    const response = await fetch(chrome.runtime.getURL('Base Prompt v5.txt'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    promptText = await response.text();
    $('prompt').value = promptText;
    await chrome.storage.local.set({ job: { ...storedJob, prompt: promptText } });
  } catch (_) {
    promptText = storedJob.prompt || '';
    $('prompt').value = promptText;
  }
}

function hydrateGenerationMemoryFromQueue() {
  const items = { ...(generationMemory?.items || {}) };
  let added = false;
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of queue.groups?.[groupId] || []) {
      if (!entry?.sourceId || items[entry.sourceId]) continue;
      items[entry.sourceId] = generationMemoryRecordFromEntry(entry, {
        sourcePresent: true,
        statusSource: 'automatic'
      });
      added = true;
    }
  }
  if (added) generationMemory = { ...generationMemory, items };
  return added;
}

async function loadQueue() {
  const stored = await chrome.storage.local.get(['queue', 'run', 'job', 'history', 'generationMemory', 'folderSelections', 'lastPreflight', 'domDiagnosticsMode', 'outputDestination']);
  const savedJob = stored.job ? { ...stored.job } : null;
  // Coverage mode was a temporary debug switch. Remove an old value so it
  // cannot silently change the meaning of the Start button after an update.
  if (savedJob) delete savedJob.coverageMode;
  if (stored.queue?.groups) queue = stored.queue;
  generationMemory = stored.generationMemory || { version: 1, items: {} };
  let history = stored.history || { items: {}, ignored: {} };
  let catalog = await getAllModelCatalog({ includeRemoved: true }).catch(() => []);
  const oldEntries = QUEUE_GROUP_IDS.flatMap((groupId) => stored.queue?.groups?.[groupId] || []);
  if (!catalog.length && oldEntries.length) {
    catalog = modelCatalogRecordsFromGroups(stored.queue.groups);
    await replaceModelCatalog(catalog);
    const aliases = {};
    for (const entry of oldEntries) {
      const skuKey = sourceIdFor(entry.groupId || 'in_sale_good', entry.relativePath || entry.fileName, entry.modelName || entry.fileName);
      if (entry.sourceId && entry.sourceId !== skuKey) aliases[String(entry.sourceId)] = skuKey;
    }
    const memoryItems = { ...(generationMemory.items || {}) };
    const historyItems = { ...(history.items || {}) };
    const ignored = { ...(history.ignored || {}) };
    for (const model of catalog) {
      const selected = chooseSourceVariant(model.variants || [], {});
      const selectedVariantId = String(selected?.sourceVariantId || selected?.variantId || '');
      const selectedLegacyEntry = oldEntries.find((entry) => String(entry?.sourceVariantId || entry?.inputSourceId || '') === selectedVariantId)
        || oldEntries.find((entry) => aliases[String(entry?.sourceId || '')] === String(model.skuKey));
      const oldId = String(selectedLegacyEntry?.sourceId || selectedVariantId);
      if (oldId && memoryItems[oldId] && !memoryItems[model.skuKey]) {
        memoryItems[model.skuKey] = { ...memoryItems[oldId], sourceId: model.skuKey, sourcePresent: true,
          sourceVariantId: selectedVariantId || memoryItems[oldId].sourceVariantId || null,
          legacySourceIds: [...new Set([...(memoryItems[oldId].legacySourceIds || []), oldId])] };
      }
      if (oldId && historyItems[oldId] && !historyItems[model.skuKey]) historyItems[model.skuKey] = { ...historyItems[oldId], sourceId: model.skuKey };
    }
    for (const [oldId, skuKey] of Object.entries(aliases)) {
      if (memoryItems[oldId]) memoryItems[oldId] = { ...memoryItems[oldId], sourcePresent: false, migratedToSkuKey: skuKey };
      if (ignored[oldId]) { ignored[skuKey] = true; delete ignored[oldId]; }
    }
    generationMemory = { ...generationMemory, items: memoryItems };
    history = { ...history, items: historyItems, ignored };
    await adoptLegacyGenerationRevisions(aliases).catch(() => {});
    queue = { ...queue, repairQueue: (queue.repairQueue || []).map((item) => {
      const oldId = String(typeof item === 'string' ? item : item?.sourceId || '');
      const sourceId = aliases[oldId] || oldId;
      return typeof item === 'string' ? { sourceId, queuedAt: new Date().toISOString(), generationId: null }
        : { ...item, sourceId };
    }).filter((item) => item.sourceId) };
    queue.groups = queueGroupsFromCatalog(catalog, stored.queue.groups);
    const run = stored.run ? { ...stored.run } : null;
    if (run) {
      const mapId = (id) => aliases[String(id)] || String(id || '');
      run.pendingIds = (run.pendingIds || []).map(mapId);
      run.plannedIds = (run.plannedIds || []).map(mapId);
      run.repairQueueClaims = Object.fromEntries(Object.entries(run.repairQueueClaims || {}).map(([id, value]) => [mapId(id), value]));
      for (const slot of Object.values(run.slots || {})) if (slot?.entryId) slot.entryId = mapId(slot.entryId);
      for (const owner of Object.values(run.postprocessTabs || {})) if (owner?.entryId) owner.entryId = mapId(owner.entryId);
      for (const progress of Object.values(run.factsProgress || {})) if (progress?.entryId) progress.entryId = mapId(progress.entryId);
    }
    await chrome.storage.local.set({ queue, run, history, generationMemory });
  } else if (catalog.length) {
    queue = { ...queue, groups: queueGroupsFromCatalog(catalog, queue.groups) };
  }
  lastPreflight = stored.lastPreflight || null;
  folderSelections = {
    references: stored.folderSelections?.references || null,
    watches: stored.folderSelections?.watches || null
  };
  outputDestination = {
    mode: stored.outputDestination?.mode === 'custom' ? 'custom' : 'downloads',
    folderName: stored.outputDestination?.folderName || null,
    permission: stored.outputDestination?.permission || 'unknown'
  };
  outputDirectoryHandle = await getOutputDirectoryHandle().catch(() => null);
  if (outputDirectoryHandle?.name && !outputDestination.folderName) outputDestination.folderName = outputDirectoryHandle.name;
  domDiagnosticsMode = normalizeDomDiagnosticsMode(stored.domDiagnosticsMode);
  if ($('domDiagnosticsMode')) $('domDiagnosticsMode').value = domDiagnosticsMode;
  updateDomDiagnosticsStatus();
  applyGenerationHistory(queue.groups, history);
  applyGenerationMemory(queue.groups, generationMemory);
  if (savedJob) {
    promptText = savedJob.prompt || '';
    $('prompt').value = promptText;
    setFilterInputs(
      savedJob.filters
      || parseFilterSelectionId(savedJob.queueGroup)
      || filterFromQueueGroup(savedJob.queueGroup || ''),
      savedJob.memoryFilters || {}
    );
    if ($('runQueueMode')) $('runQueueMode').value = ['regular', REGENERATION_QUEUE_ID].includes(savedJob.runQueueMode) ? savedJob.runQueueMode : '';
    desiredRunPart = Number.isSafeInteger(Number(savedJob.runPart)) && Number(savedJob.runPart) > 0
      ? String(Number(savedJob.runPart))
      : '';
    desiredRunPartSignature = String(savedJob.runPartSignature || '');
    $('runLimit').value = String(Math.min(RUN_PART_SIZE, normalizeRunLimit(savedJob.runLimit, RUN_PART_SIZE) || RUN_PART_SIZE));
    $('workerCount').value = String(normalizeWorkerCount(savedJob.workerCount, 4));
    if ($('inputMode')) $('inputMode').value = normalizeInputMode(savedJob.inputMode, DEFAULT_INPUT_MODE);
    $('rateLimitPauseMinutes').value = String(normalizeRateLimitPauseMinutes(savedJob.rateLimitPauseMinutes));
    $('rateLimitIgnoreMinutes').value = String(normalizeRateLimitIgnoreMinutes(savedJob.rateLimitIgnoreMinutes));
    $('generationPauseMinutes').value = String(normalizeGenerationPauseMinutes(savedJob.generationPauseMinutes));
    $('generationJitterSeconds').value = String(normalizeGenerationJitterSeconds(savedJob.generationJitterSeconds));
  } else {
    setFilterInputs({ saleStatus: 'all', quality: 'all', brand: 'all' });
    if ($('runQueueMode')) $('runQueueMode').value = '';
    $('runLimit').value = String(RUN_PART_SIZE);
    if ($('inputMode')) $('inputMode').value = DEFAULT_INPUT_MODE;
    $('rateLimitPauseMinutes').value = String(DEFAULT_RATE_LIMIT_PAUSE_MINUTES);
    $('rateLimitIgnoreMinutes').value = String(DEFAULT_RATE_LIMIT_IGNORE_MINUTES);
    $('generationPauseMinutes').value = String(DEFAULT_GENERATION_PAUSE_MINUTES);
    $('generationJitterSeconds').value = String(DEFAULT_GENERATION_JITTER_SECONDS);
  }
  await loadBundledPrompt(savedJob || {});
  $('generationPauseMinutes').disabled = false;
  $('generationJitterSeconds').disabled = false;
  await restorePersistedInputs();
  const memoryHydrated = hydrateGenerationMemoryFromQueue();
  if (memoryHydrated) await chrome.storage.local.set({ generationMemory });
  await chrome.storage.local.set({ queue });
  renderAll();
  await refreshRuntime();
}

async function persistQueue() {
  queue = { ...queue, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ queue });
  renderAll();
}

async function saveDraft() {
  const stored = await chrome.storage.local.get('job');
  const { coverageMode: _legacyCoverageMode, ...previous } = stored.job || {};
  const filter = filterFromInputs();
  const runLimit = Math.min(RUN_PART_SIZE, normalizeRunLimit($('runLimit').value, RUN_PART_SIZE));
  const workerCount = normalizeWorkerCount($('workerCount').value, 4);
  const rateLimitPauseMinutes = normalizeRateLimitPauseMinutes($('rateLimitPauseMinutes')?.value);
  const rateLimitIgnoreMinutes = normalizeRateLimitIgnoreMinutes($('rateLimitIgnoreMinutes')?.value);
  const generationPauseMinutes = normalizeGenerationPauseMinutes($('generationPauseMinutes')?.value);
  const generationJitterSeconds = normalizeGenerationJitterSeconds($('generationJitterSeconds')?.value);
  const inputMode = normalizeInputMode($('inputMode')?.value, DEFAULT_INPUT_MODE);
  const runQueueMode = launchQueueMode();
  await chrome.storage.local.set({
    job: {
      ...previous,
      prompt: promptText || previous.prompt || $('prompt').value || '',
      queueGroup: groupIdForWatchFilter(filter),
      filters: filter,
      runQueueMode,
      runPart: $('runPart')?.value ? Number($('runPart').value) : null,
      runPartSignature: $('runPart')?.value ? String($('runPart')?.dataset.partitionSignature || '') : '',
      memoryFilters: memoryFilterState(),
      runLimit: runLimit > 0 ? runLimit : RUN_PART_SIZE,
      workerCount,
      inputMode,
      rateLimitPauseMinutes,
      rateLimitIgnoreMinutes,
      generationPauseMinutes,
      generationJitterSeconds,
      debugOverlay: false,
      generationTimeoutMs: previous.generationTimeoutMs || 900000
    }
  });
}

async function scanReferenceFolder() {
  const files = [...($('refFolder').files || [])];
  if (!files.length) throw new Error('Папка референсов не содержит доступных файлов. Выбери папку ещё раз.');
  referenceFiles.clear();
  payloadCache.clear();
  for (const file of files) {
    const descriptor = referenceDescriptorForPath(filePath(file));
    if (descriptor) referenceFiles.set(descriptor.storageKey, file);
  }
  if (!referenceFiles.size) {
    folderSelections = {
      ...folderSelections,
      references: {
        ...describeFolderSelection(files, 'input-ref-images', 0),
        storageStatus: 'error'
      }
    };
    await chrome.storage.local.set({ folderSelections });
    renderAll();
    throw new Error('В выбранной папке не найдены распознаваемые референсы. Выбери корень input-ref-images.');
  }
  const referenceSelection = {
    ...describeFolderSelection(files, 'input-ref-images', referenceFiles.size),
    storageStatus: 'saving'
  };
  folderSelections = { ...folderSelections, references: referenceSelection };
  await chrome.storage.local.set({ folderSelections });
  renderAll();
  await replaceAssets('ref:', [...referenceFiles.entries()].map(([key, file]) => ({
    key: `ref:${key}`,
    file,
    relativePath: filePath(file)
  })));
  folderSelections = {
    ...folderSelections,
    references: { ...referenceSelection, storageStatus: 'ready', savedAt: new Date().toISOString() }
  };
  const referenceMetadataEntries = [];
  for (const [key, file] of referenceFiles.entries()) {
    referenceMetadataEntries.push([key, {
      name: file.name,
      size: file.size,
      lastModified: Number(file.lastModified || 0),
      fingerprint: fingerprintForFile(file),
      contentHash: await sha256File(file)
    }]);
  }
  queue = {
    ...queue,
    refs: Object.fromEntries(referenceMetadataEntries)
  };
  await chrome.storage.local.set({ folderSelections });
  await persistQueue();
}

async function scanWatchFolder() {
  const files = [...($('watchFolder').files || [])];
  if (!files.length) throw new Error('Папка с часами не содержит доступных файлов. Выбери папку ещё раз.');
  const nextWatchFiles = new Map();
  const scanned = emptyGroups();
  for (const file of files) {
    if (!isImageFileName(file.name)) continue;
    const relativePath = filePath(file);
    const groupId = classifyWatchPath(relativePath);
    if (!groupId) continue;
    const sourceVariantId = sourceVariantIdFor(groupId, relativePath);
    nextWatchFiles.set(sourceVariantId, file);
    scanned[groupId].push({ file, relativePath });
  }
  for (const groupId of QUEUE_GROUP_IDS) {
    scanned[groupId].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'ru'));
  }
  if (!nextWatchFiles.size) {
    const selection = {
      ...describeFolderSelection(files, 'input-watches-images', 0),
      storageStatus: 'error'
    };
    folderSelections = { ...folderSelections, watches: selection };
    await chrome.storage.local.set({ folderSelections });
    renderAll();
    throw new Error('В выбранной папке не найдены часы. Выбери корень input-watches-images с папками in_sale и not_in_sale.');
  }
  const watchPathNode = $('watchFolderPath');
  if (watchPathNode) watchPathNode.textContent = `Проверяю SHA-256: ${nextWatchFiles.size} файлов`;
  await hashScannedWatchFiles(scanned);
  const watchSelection = {
    ...describeFolderSelection(files, 'input-watches-images', nextWatchFiles.size),
    storageStatus: 'saving'
  };
  folderSelections = { ...folderSelections, watches: watchSelection };
  await chrome.storage.local.set({ folderSelections });
  renderAll();
  try {
    await replaceAssets('watch:', [...nextWatchFiles.entries()].map(([sourceVariantId, file]) => ({
    key: `watch:${sourceVariantId}`,
    file,
    relativePath: filePath(file)
    })));
  } catch (error) {
    folderSelections = {
      ...folderSelections,
      watches: { ...watchSelection, storageStatus: 'error', error: error?.message || String(error) }
    };
    await chrome.storage.local.set({ folderSelections });
    renderAll();
    throw new Error(`Не удалось сохранить фото часов в локальную память: ${error?.message || error}`);
  }
  watchFiles.clear();
  for (const [sourceId, file] of nextWatchFiles) watchFiles.set(sourceId, file);
  const stored = await chrome.storage.local.get(['history', 'generationMemory']);
  queue = { ...queue, groups: mergeScannedGroups(scanned, queue.groups) };
  await replaceModelCatalog(modelCatalogRecordsFromGroups(queue.groups));
  folderSelections = {
    ...folderSelections,
    watches: { ...watchSelection, storageStatus: 'ready', savedAt: new Date().toISOString() }
  };
  await chrome.storage.local.set({ folderSelections });
  applyGenerationHistory(queue.groups, stored.history);
  generationMemory = stored.generationMemory || generationMemory;
  const memoryHydrated = hydrateGenerationMemoryFromQueue();
  applyGenerationMemory(queue.groups, generationMemory);
  if (memoryHydrated) await chrome.storage.local.set({ generationMemory });
  await persistQueue();
  // The worker creates/merges durable memory records. Refresh immediately so
  // the list is visible as soon as the folder picker finishes.
  await refreshRuntime();
}

async function outputDirectoryPermission(handle = outputDirectoryHandle) {
  if (!handle?.queryPermission) return handle ? 'unknown' : 'missing';
  try { return await handle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'unknown'; }
}

async function refreshOutputDestinationUi() {
  const custom = outputDestination.mode === 'custom';
  if (custom && !outputDirectoryHandle) outputDirectoryHandle = await getOutputDirectoryHandle().catch(() => null);
  const permission = custom ? await outputDirectoryPermission() : 'granted';
  if (custom) outputDestination.permission = permission;
  const chip = $('outputModeChip');
  const path = $('outputFolderPath');
  const grant = $('grantOutputFolder');
  if (chip) chip.textContent = custom ? 'Своя папка' : 'Downloads';
  if (path) {
    if (!custom) path.textContent = 'Downloads/WatchAutomation';
    else if (!outputDirectoryHandle) path.textContent = 'папка недоступна — выбери заново';
    else path.textContent = `${outputDirectoryHandle.name} · ${permission === 'granted' ? 'прямая запись' : 'нужно разрешение на запись'}`;
  }
  if (grant) grant.hidden = !custom || !outputDirectoryHandle || permission === 'granted';
}

async function chooseOutputDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error('Эта версия Chrome не поддерживает прямой выбор папки результатов');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'watchautomation-output' });
  if (!handle) return;
  let permission = handle.queryPermission
    ? await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'unknown')
    : 'granted';
  if (permission !== 'granted' && handle.requestPermission) {
    permission = await handle.requestPermission({ mode: 'readwrite' }).catch(() => permission);
  }
  await putOutputDirectoryHandle(handle);
  outputDirectoryHandle = handle;
  outputDestination = { mode: 'custom', folderName: handle.name || 'выбранная папка', permission };
  await chrome.storage.local.set({ outputDestination });
  await refreshOutputDestinationUi();
  showFeedback(`Результаты будут сохраняться напрямую в «${outputDestination.folderName}»`, { type: 'success', autoHide: true });
}

async function grantOutputDirectory() {
  outputDirectoryHandle = outputDirectoryHandle || await getOutputDirectoryHandle().catch(() => null);
  if (!outputDirectoryHandle) throw new Error('Выбранная папка не найдена. Выбери её заново.');
  const permission = outputDirectoryHandle.requestPermission
    ? await outputDirectoryHandle.requestPermission({ mode: 'readwrite' })
    : await outputDirectoryPermission(outputDirectoryHandle);
  outputDestination = { mode: 'custom', folderName: outputDirectoryHandle.name || outputDestination.folderName, permission };
  await chrome.storage.local.set({ outputDestination });
  await refreshOutputDestinationUi();
  if (permission !== 'granted') throw new Error('Chrome не дал разрешение на запись в выбранную папку');
  showFeedback('Доступ к папке результатов восстановлен', { type: 'success', autoHide: true });
}

async function useDownloadsOutput() {
  outputDestination = { ...outputDestination, mode: 'downloads', permission: 'granted' };
  await chrome.storage.local.set({ outputDestination });
  await refreshOutputDestinationUi();
  showFeedback('Результаты снова будут сохраняться в Downloads/WatchAutomation', { type: 'success', autoHide: true });
}

function renderAll() {
  refreshOutputDestinationUi().catch(() => {});
  const counts = queueCounts(queue.groups);
  const referenceKeys = new Set([
    ...referenceFiles.keys(),
    ...Object.keys(queue.refs || {})
  ]);
  const brandIds = [...referenceKeys]
    .filter((key) => String(key).startsWith('template:'))
    .map((key) => String(key).slice('template:'.length));
  const brandTemplateIds = [...new Set(brandIds)];
  const commonTemplate = referenceKeys.has('template');
  const commonOzonMap = referenceKeys.has('ozonMap');
  const commonLogo = referenceKeys.has('storeLogo');
  const refFolder = folderSelections.references?.pathHint || 'не выбрана';
  const watchFolder = folderSelections.watches?.pathHint || 'не выбрана';
  const watchStorageStatus = folderSelections.watches?.storageStatus;
  const tableScope = visibleMemoryRecords().filter((record) => record.sourcePresent !== false);
  const tableReady = tableScope.filter((record) => record.status === GENERATION_MEMORY_STATUSES.READY).length;
  $('refCount').textContent = brandTemplateIds.length
    ? `${brandTemplateIds.length} бр. баз`
    : (commonTemplate && commonOzonMap ? 'общие' : '0 наборов');
  $('watchCount').textContent = `${tableReady}/${tableScope.length}`;
  $('refFolderPath').textContent = refFolder;
  $('watchFolderPath').textContent = watchStorageStatus === 'saving'
    ? `${watchFolder} · сохраняется…`
    : watchStorageStatus === 'error'
      ? `${watchFolder} · ошибка сохранения`
      : watchFolder;
  const referenceSummary = [
    commonTemplate && commonOzonMap ? 'общие OK' : 'общие нет',
    brandTemplateIds.length ? `${brandTemplateIds.length} бренд. баз` : 'брендов нет',
    commonLogo ? 'лого OK' : 'лого нет',
    `${tableScope.length} моделей`
  ].join(' · ');
  $('folderStatus').textContent = referenceSummary;
  const historyTotal = Object.values(counts).reduce((sum, item) => sum + item.done, 0);
  $('historyStatus').textContent = `В истории: ${historyTotal}`;
  $('promptStatus').textContent = promptText.trim() ? 'готов' : 'ошибка';
  renderGenerationMemory();
  renderSlotGrid();
  renderPreflight(lastPreflight);
  updateLaunchQueueSummary();
  updateActionButtons();
}

function renderPreflight(result) {
  const node = $('preflightSummary');
  if (!node) return;
  if (!result) {
    node.className = 'preflight-summary';
    node.textContent = 'Перед стартом выполню проверку файлов, референсов и watcher.';
    const dock = $('dockCopy');
    if (dock) dock.textContent = 'Проверка перед стартом выполняется автоматически';
    return;
  }
  const failed = (result.checks || []).filter((check) => check.blocking && !check.ok);
  const warnings = (result.checks || []).filter((check) => !check.blocking && !check.ok);
  node.className = `preflight-summary ${failed.length ? 'is-error' : 'is-ok'}`;
  node.textContent = failed.length
    ? `Проверка остановлена: ${failed.map((check) => check.label).join(', ')}`
    : `Проверка OK · ${result.candidates || 0} моделей${result.runPart ? ` · часть ${result.runPart}/${result.runPartCount}` : ''}${warnings.length ? ` · предупреждение: ${warnings.map((check) => check.label).join(', ')}` : ''}`;
  const dock = $('dockCopy');
  if (dock) dock.textContent = failed.length
    ? `Нужно исправить: ${failed.map((check) => check.label).join(', ')}`
    : `Готово к запуску · ${result.candidates || 0} моделей`;
}

async function saveJob({ requireQueue = false } = {}) {
  const filter = filterFromInputs();
  const queueGroup = groupIdForWatchFilter(filter);
  const runLimit = Math.min(RUN_PART_SIZE, normalizeRunLimit($('runLimit').value, RUN_PART_SIZE));
  const workerCount = normalizeWorkerCount($('workerCount').value, 4);
  const rateLimitPauseMinutes = normalizeRateLimitPauseMinutes($('rateLimitPauseMinutes')?.value);
  const rateLimitIgnoreMinutes = normalizeRateLimitIgnoreMinutes($('rateLimitIgnoreMinutes')?.value);
  const generationPauseMinutes = normalizeGenerationPauseMinutes($('generationPauseMinutes')?.value);
  const generationJitterSeconds = normalizeGenerationJitterSeconds($('generationJitterSeconds')?.value);
  const inputMode = normalizeInputMode($('inputMode')?.value, DEFAULT_INPUT_MODE);
  const runQueueMode = launchQueueMode();
  const inputPlan = buildInputPlan(inputMode);
  if (!promptText.trim()) throw new Error('Промпт Base Prompt v5.txt не загружен');
  if (!['regular', REGENERATION_QUEUE_ID].includes(runQueueMode)) throw new Error('Выбери список запуска');
  if (!QUEUE_GROUP_IDS.includes(String($('runGroupFilter')?.value || ''))) throw new Error('Выбери точный статус и качество модели');
  if (!WATCH_BRAND_FILTERS.some((item) => item.id === String($('runBrandFilter')?.value || '') && item.id !== 'all')) {
    throw new Error('Выбери один конкретный бренд');
  }
  if (runLimit < 1) throw new Error('Укажи количество фото от 1 до 100');
  const partPlan = launchQueuePartPlan();
  const runPart = Number($('runPart')?.value || 0);
  const selectedPart = partPlan?.parts?.find((part) => part.partNumber === runPart);
  if (!selectedPart || String($('runPart')?.dataset.partitionSignature || '') !== partPlan.signature) {
    throw new Error('Выбери часть очереди. Если список изменился, выбери часть заново.');
  }
  if (requireQueue && !selectedPart.count) {
    throw new Error(runQueueMode === REGENERATION_QUEUE_ID
      ? 'В очереди перегенерации брака пока нет моделей'
      : 'В выбранной обычной очереди нет моделей');
  }
  const referenceKeys = new Set([
    ...referenceFiles.keys(),
    ...Object.keys(queue.refs || {})
  ]);
  const templateKeys = [...referenceKeys].filter((key) => key === 'template' || String(key).startsWith('template:'));
  if (!templateKeys.length) throw new Error('Не найден главный шаблон карточки (Base или брендовый шаблон).');
  if (inputPlan.hasOzonMap) {
    const ozonKeys = [...referenceKeys].filter((key) => key === 'ozonMap' || String(key).startsWith('ozonMap:'));
    if (!ozonKeys.length) throw new Error('Для выбранного режима нужен референс Ozon blind zones.');
  }
  if (inputPlan.hasStoreLogo && !referenceKeys.has('storeLogo')) {
    throw new Error('Для режима 4 файла нужен общий референс 3. Logo Black.png.');
  }
  const stored = await chrome.storage.local.get('job');
  const { coverageMode: _legacyCoverageMode, ...previous } = stored.job || {};
  await chrome.storage.local.set({
    job: {
      ...previous,
      prompt: promptText,
      queueGroup,
      filters: filter,
      runQueueMode,
      runPart,
      runPartSignature: partPlan.signature,
      runPartCount: partPlan.partCount,
      memoryFilters: memoryFilterState(),
      runLimit,
      workerCount,
      inputMode,
      rateLimitPauseMinutes,
      rateLimitIgnoreMinutes,
      generationPauseMinutes,
      generationJitterSeconds,
      debugOverlay: false,
      generationTimeoutMs: 900000
    }
  });
}

async function requestRuntime() {
  return chrome.runtime.sendMessage({ type: 'GET_RUNTIME' }).catch(() => null);
}

async function requestRuntimeFast() {
  return chrome.runtime.sendMessage({ type: 'GET_RUNTIME_FAST' }).catch(() => null);
}

async function refreshRuntimeFast() {
  const response = await requestRuntimeFast();
  if (!response?.ok) return;
  const value = response.value || {};
  runtime = { ...runtime, ...(value.runtime || {}), run: value.run ?? null };
  refreshRunDiagnosticsAtBoundary();
  const pause = ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(runtime.state) ? countdown(runtime.rateLimitPauseUntil) : '';
  renderHealth(pause);
  renderRunStatus(pause);
  renderSlotGrid();
  if (Array.isArray(value.logs)) renderLogs(value.logs);
  updateActionButtons();
}

function shortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function elapsedShort(value) {
  const at = Number(value || 0);
  if (!at) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function countdown(until) {
  const remaining = Math.max(0, Number(until || 0) - Date.now());
  if (!remaining) return '';
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${seconds} с`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function renderRunStatus(pause = countdown(runtime.rateLimitPauseUntil)) {
  const state = String(runtime.state || 'IDLE').toUpperCase();
  const stateLabel = RUN_STATE_LABELS[state] || runtime.status || state;
  const stalledBatchStage = String(runtime.stalledBatchRecovery?.stage || '').toUpperCase();
  const stalledBatchWait = stalledBatchStage === 'WAITING' ? countdown(runtime.stalledBatchRecovery?.dueAt) : '';
  const recoveryStage = String(runtime.conversationRecovery?.stage || '').toUpperCase();
  const conversationWait = recoveryStage === 'WAITING' ? countdown(runtime.conversationRecovery?.dueAt) : '';
  let badgeLabel = stateLabel;
  if (stalledBatchStage === 'CLOSING') badgeLabel = 'ЗАКРЫВАЮ ВКЛАДКИ';
  else if (stalledBatchStage === 'WAITING') badgeLabel = `ОТДЫХ · ${stalledBatchWait || 'скоро'}`;
  else if (stalledBatchStage === 'RESTARTING') badgeLabel = 'ВОЗОБНОВЛЯЮ ПРОГОН';
  else if (stalledBatchStage === 'FAILED') badgeLabel = 'АВТОВОССТАНОВЛЕНИЕ ОСТАНОВЛЕНО';
  else if (recoveryStage === 'INSPECTING') badgeLabel = 'ПРОВЕРЯЮ ЧАТЫ';
  else if (recoveryStage === 'WAITING') badgeLabel = `ВОССТАНОВЛЕНИЕ · ${conversationWait || 'скоро'}`;
  else if (recoveryStage === 'REOPENING') badgeLabel = 'ВОССТАНОВЛЕНИЕ ЧАТОВ';
  else if (recoveryStage === 'FAILED') badgeLabel = 'ВОССТАНОВЛЕНИЕ ОСТАНОВЛЕНО';
  else if (runtime.status === 'RATE_LIMIT_PAUSE' && pause) badgeLabel = `ПАУЗА ЗАПУСКА · ${pause}`;
  else if (runtime.status === 'RUNNING_WITH_ERRORS') badgeLabel = 'РАБОТАЕТ · ЕСТЬ ОШИБКА';
  else if (runtime.status === 'DONE_WITH_FACTS_ERRORS') badgeLabel = 'ЗАВЕРШЕНО · ОШИБКИ OCR';
  $('stateBadge').textContent = badgeLabel;
  let actionText = runtime.currentAction || (state === 'IDLE' ? 'Ожидание запуска.' : 'Состояние обновляется.');
  if (stalledBatchStage === 'CLOSING') {
    actionText = runtime.currentAction || 'Закрываю зависшие рабочие вкладки; завершённые PNG и прогресс сохранены.';
  } else if (stalledBatchStage === 'WAITING') {
    actionText = `${runtime.currentAction || `Незавершённые модели вернутся в очередь через 5 минут.`} · осталось ${stalledBatchWait || 'меньше секунды'}`;
  } else if (stalledBatchStage === 'RESTARTING') {
    actionText = runtime.currentAction || 'Пятиминутный отдых завершён. Восстанавливаю рабочие вкладки…';
  } else if (stalledBatchStage === 'FAILED') {
    actionText = runtime.currentAction || runtime.stalledBatchRecovery?.error || 'Автоматическое восстановление не завершилось; прогресс сохранён.';
  } else if (recoveryStage === 'INSPECTING') {
    actionText = runtime.currentAction || 'Приостанавливаю новые отправки и проверяю сохранённые разговоры ChatGPT…';
  } else if (recoveryStage === 'WAITING') {
    actionText = `${runtime.currentAction || 'Разговоры ChatGPT будут открыты повторно.'} · осталось ${conversationWait || 'меньше секунды'}`;
  } else if (recoveryStage === 'REOPENING') {
    actionText = runtime.currentAction || 'Повторно открываю сохранённые разговоры ChatGPT…';
  } else if (recoveryStage === 'FAILED') {
    actionText = runtime.currentAction || runtime.conversationRecovery?.error || 'Восстановление остановлено; очередь сохранена.';
  } else if (pause) {
    actionText = state === 'PAUSED'
      ? `${runtime.currentAction || 'Лимит изображений: очередь ожидает восстановления.'} · осталось ${pause}`
      : `Отправка новых промптов приостановлена · ${pause}. Готовые результаты продолжают скачиваться.`;
  }
  $('currentAction').textContent = actionText;

  const hasSavedRun = Boolean(runtime.operationId || (runtime.startedAt && ['DONE', 'STOPPED'].includes(state)));
  const total = Math.max(0, Math.floor(Number(hasSavedRun
    ? runtime.runTotal
    : $('runLimit')?.value) || 0));
  const completed = Math.min(total, Math.max(0, Math.floor(Number(hasSavedRun ? runtime.runCompleted : 0) || 0)));
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  $('runProgressCount').textContent = `${completed} из ${total}`;
  $('runProgressPercent').textContent = `${percent}%`;
  $('runProgressTrack').setAttribute('aria-valuemax', String(total || 1));
  $('runProgressTrack').setAttribute('aria-valuenow', String(completed));
  $('runProgressTrack').setAttribute('aria-valuetext', `${completed} из ${total}`);
  $('runProgressBar').style.width = `${percent}%`;

  const startedAt = state === 'IDLE' ? NaN : Date.parse(runtime.startedAt || '');
  const finishedAt = Date.parse(runtime.finishedAt || '');
  const terminal = ['DONE', 'STOPPED'].includes(state);
  const endAt = terminal && Number.isFinite(finishedAt)
    ? finishedAt
    : (terminal && Number(runtime.updatedAt) > 0 ? Number(runtime.updatedAt) : Date.now());
  const elapsedMs = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, endAt - startedAt) : null;
  $('runElapsed').textContent = elapsedMs == null ? '—' : formatDuration(elapsedMs);
  $('runAverage').textContent = completed > 0 && elapsedMs != null
    ? `${formatDuration(elapsedMs / completed)} / фото`
    : '—';
}

function compact(value, max = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slotVisualState(slot) {
  if (!slot) return 'idle';
  if (slot.status === 'IDLE' || !slot.entryId) return 'idle';
  const phase = String(slot.phase || slot.status || '').toUpperCase();
  if (slot.finalCheckPending || slot.failed || ['OBSERVING', 'IMAGE_FOUND', 'VERIFYING_FILE'].includes(phase)) return 'observing';
  if (phase === 'DONE' || slot.status === 'DONE') return 'done';
  if (slot.status === 'ERROR' || slot.status === 'PAUSED' || slot.lastCheckState === 'ERROR'
    || ['TAB_LOST', 'NEEDS_ATTENTION', 'RETRY_BACKOFF'].includes(phase)) return 'error';
  if (slot.status === 'RECOVERING' || phase === 'RATE_LIMIT_PAUSE') return 'observing';
  return 'running';
}

function slotAction(slot) {
  if (!slot) return 'Откроется при запуске';
  const ratePause = countdown(runtime.rateLimitPauseUntil);
  const launchWait = countdown(slot.launchWaitUntil);
  if (slot.finalCheckPending) return launchWait ? `Результат проверяется · следующий запуск через ${launchWait}` : 'Проверяю результат после сбоя';
  // The global cooldown blocks only slots that have not submitted a prompt.
  // Keep already-running slots visually honest: they may still finish and
  // download while the next launch is waiting.
  if (ratePause && String(slot.phase || '').toUpperCase() === 'RATE_LIMIT_PAUSE') {
    return `Отправка ждёт лимит · ${ratePause}`;
  }
  if (launchWait) return `Следующий запуск через ${launchWait}`;
  if (slot.status === 'IDLE') return 'Свободна';
  if (slot.status === 'DONE') return 'Результат скачан';
  const phase = String(slot.phase || '').toUpperCase();
  const state = SLOT_STATE_LABELS[phase] || SLOT_STATE_LABELS[slot.status] || slot.phase || slot.status || 'ожидание';
  const check = slot.lastCheckState ? CHECK_STATE_LABELS[slot.lastCheckState] : '';
  return check && !state.includes(check) ? `${state} · ${check}` : state;
}

function renderSlotGrid() {
  const hasCurrentRun = Boolean(runtime.run && !['IDLE', 'DONE', 'STOPPED'].includes(runtime.state));
  const configured = normalizeWorkerCount(hasCurrentRun ? runtime.workerCount : $('workerCount').value, 4);
  const runtimeSlots = hasCurrentRun && Array.isArray(runtime.slots) ? runtime.slots : [];
  const count = Math.max(configured, runtimeSlots.length);
  const slots = new Map(runtimeSlots.map((slot) => [Number(slot.slotId), slot]));
  const factsJobs = Array.isArray(runtime.factsJobs) ? runtime.factsJobs : [];
  const activeFactsCount = factsJobs.filter((job) => !['SAVED', 'ERROR'].includes(String(job?.stage || '').toUpperCase())).length;
  $('slotSummary').textContent = `${runtimeSlots.filter((slot) => slot.entryId && slot.status !== 'IDLE').length}/${count} занято${activeFactsCount ? ` · ${activeFactsCount} постпроверка` : ''}`;
  $('slotGrid').replaceChildren();
  for (let index = 0; index < count; index += 1) {
    const slot = slots.get(index);
    const card = document.createElement('article');
    card.className = 'slot-card';
    card.dataset.state = slotVisualState(slot);

    const head = document.createElement('div');
    head.className = 'slot-head';
    const identity = document.createElement('div');
    identity.className = 'slot-identity';
    const indicator = document.createElement('span');
    indicator.className = `slot-indicator is-${slotVisualState(slot)}`;
    indicator.setAttribute('aria-hidden', 'true');
    const number = document.createElement('span');
    number.className = 'slot-number';
    number.textContent = `Вкладка ${index + 1}`;
    identity.append(indicator, number);
    const state = document.createElement('span');
    state.className = 'slot-state';
    const phase = String(slot?.phase || slot?.status || '').toUpperCase();
    state.textContent = slot
      ? (slot.finalCheckPending ? 'НАБЛЮДЕНИЕ' : (SLOT_STATE_LABELS[phase] || SLOT_STATE_LABELS[slot.status] || slot.phase || slot.status || 'ОЖИДАНИЕ')).toUpperCase()
      : 'ГОТОВА';
    head.append(identity, state);

    const file = document.createElement('div');
    file.className = 'slot-file';
    file.title = slot?.entryName || '';
    file.textContent = slot?.entryName ? compact(slot.entryName, 48) : 'Свободный слот';

    const action = document.createElement('div');
    action.className = 'slot-action';
    action.textContent = slotAction(slot);

    const meta = document.createElement('div');
    meta.className = 'slot-meta';
    const metaParts = [];
    if (slot?.entryId) {
      if (slot.lastCheckAt) metaParts.push(`проверка ${shortTime(slot.lastCheckAt)}`);
      if (slot.tabId) metaParts.push(`чат #${slot.tabId}`);
      if (slot.attempt > 1) metaParts.push(`попытка ${slot.attempt}`);
      if (slot.lastProgressAt && slot.lastCheckAt && slot.lastProgressAt !== slot.lastCheckAt) metaParts.push(`прогресс ${shortTime(slot.lastProgressAt)}`);
      if (slot.lastCheckError) metaParts.push(compact(slot.lastCheckError, 72));
    }
    meta.textContent = metaParts.join(' · ') || 'ожидание задания';

    const facts = hasCurrentRun && slot?.entryId
      ? selectFactsProgressForSlot({ ...slot, slotId: index }, factsJobs)
      : null;
    const factsLine = document.createElement('div');
    factsLine.className = 'slot-facts';
    if (facts) {
      const stage = String(facts.stage || 'QUEUED').toUpperCase();
      factsLine.dataset.stage = stage;
      const label = FACTS_STAGE_LABELS[stage] || stage.toLowerCase();
      const age = ['SAVED', 'ERROR'].includes(stage) ? '' : elapsedShort(facts.stageAtMs);
      const source = compact(facts.modelName || facts.entryName || '', 34);
      const errorText = stage === 'ERROR' && facts.error ? compact(facts.error, 72) : '';
      factsLine.textContent = `Спецификация · ${label}${age ? ` · ${age}` : ''}${errorText ? ` · ${errorText}` : (source ? ` · ${source}` : '')}`;
      factsLine.title = [facts.modelName || facts.entryName || '', label, facts.error || ''].filter(Boolean).join(' · ');
    } else {
      factsLine.textContent = 'Спецификация · ещё не запущена';
      factsLine.dataset.stage = 'IDLE';
    }

    card.append(head, file, action, factsLine, meta);
    $('slotGrid').append(card);
  }
}

function renderLogs(logs = []) {
  const items = Array.isArray(logs) ? logs.slice(-12) : [];
  $('logs').textContent = items.length
    ? items.map((item) => {
      const slot = Number.isFinite(Number(item.slotId)) ? ` [${Number(item.slotId) + 1}]` : '';
      return `${shortTime(item.ts)}${slot} ${compact(item.message, 180)}`;
    }).join('\n')
    : 'Пока пусто.';
}

function memoryStatusText(status) {
  return GENERATION_MEMORY_STATUS_LABELS[status] || GENERATION_MEMORY_STATUS_LABELS.not_ready;
}

function memoryRecords() {
  const entries = new Map(QUEUE_GROUP_IDS.flatMap((groupId) => queue.groups?.[groupId] || [])
    .filter((entry) => entry?.sourceId)
    .map((entry) => [String(entry.sourceId), entry]));
  return [...entries].map(([sourceId, entry]) => generationMemory?.items?.[sourceId]
    || generationMemoryRecordFromEntry(entry, { sourcePresent: true, statusSource: 'automatic' }))
    .sort((a, b) => String(a.modelName || a.fileName || '').localeCompare(String(b.modelName || b.fileName || ''), 'ru'));
}

function memoryRecordMatches(record, state = memoryFilterState()) {
  const haystack = `${record?.modelName || ''} ${record?.fileName || ''} ${record?.relativePath || ''}`.toLowerCase();
  return (!state.search || haystack.includes(state.search.toLowerCase()))
    && (state.group === 'all' || record?.groupId === state.group)
    && (state.brand === 'all' || brandIdFromModelName(record?.modelName || record?.fileName) === state.brand)
    && (state.status === 'all' || record?.status === state.status);
}

function visibleMemoryRecords(records = memoryRecords(), state = memoryFilterState()) {
  return records.filter((record) => memoryRecordMatches(record, state));
}

function updateMemorySummary(records, visible) {
  const counts = {
    ready: records.filter((record) => record.status === 'ready').length,
    running: records.filter((record) => record.status === 'running').length,
    imageSaved: records.filter((record) => record.status === 'image_saved').length,
    factsPending: records.filter((record) => record.status === 'facts_pending').length,
    not_ready: records.filter((record) => record.status === 'not_ready').length
  };
  const visibleCount = visible.filter((record) => record.sourcePresent !== false).length;
  if ($('memoryStats')) $('memoryStats').textContent = `Всего ${records.length} · Готово ${counts.ready} · Фото сохранено ${counts.imageSaved} · OCR ${counts.factsPending} · В работе ${counts.running} · Не готово ${counts.not_ready} · видно ${visibleCount}`;
  if ($('memoryVisibleCount')) $('memoryVisibleCount').textContent = `Показано ${visible.length}/${records.length}`;
  const groupFilter = $('memoryGroupFilter');
  if (groupFilter) {
    const allOption = groupFilter.querySelector('option[value="all"]');
    if (allOption) allOption.textContent = `Все списки · ${records.length}`;
    for (const groupId of QUEUE_GROUP_IDS) {
      const option = groupFilter.querySelector(`option[value="${groupId}"]`);
      if (!option) continue;
      const total = records.filter((record) => record.groupId === groupId).length;
      option.textContent = `${QUEUE_GROUPS[groupId].label} · ${total}`;
    }
  }
  const brandFilter = $('memoryBrandFilter');
  if (brandFilter) {
    const allOption = brandFilter.querySelector('option[value="all"]');
    if (allOption) allOption.textContent = `Все бренды · ${records.length}`;
    for (const brand of WATCH_BRAND_FILTERS.filter((item) => item.id !== 'all')) {
      const option = brandFilter.querySelector(`option[value="${brand.id}"]`);
      if (!option) continue;
      const total = records.filter((record) => brandIdFromModelName(record.modelName || record.fileName) === brand.id).length;
      option.textContent = `${brand.label} · ${total}`;
    }
  }
}

function renderGenerationMemory() {
  const list = $('memoryList');
  if (!list) return;
  const records = memoryRecords();
  const memoryFilters = memoryFilterState();
  const repairs = repairQueueSourceIds();
  const renderKey = `${JSON.stringify(memoryFilters)}|${records.map((record) => `${record.sourceId}:${record.status}:${record.sourcePresent}:${repairs.has(String(record.sourceId))}:${record.updatedAt || ''}:${record.lastError || ''}:${record.errorClass || ''}:${record.outputWidth || ''}x${record.outputHeight || ''}`).join(';')}`;
  if (renderKey === lastMemoryRenderKey) return;
  lastMemoryRenderKey = renderKey;
  const visible = visibleMemoryRecords(records, memoryFilters);
  updateMemorySummary(records, visible);
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = records.length
      ? 'Текущие фильтры не нашли моделей.'
      : 'Выбери папку input-watches-images — все модели появятся здесь автоматически.';
    list.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of visible) {
    const row = document.createElement('div');
    row.className = 'memory-row';
    row.dataset.status = record.status || 'not_ready';

    const copy = document.createElement('div');
    copy.className = 'memory-copy';
    const name = document.createElement('div');
    name.className = 'memory-name';
    name.textContent = record.modelName || record.fileName || 'Без названия';
    name.title = record.fileName || '';
    const source = document.createElement('div');
    source.className = 'memory-source';
    const sourceGroup = QUEUE_GROUPS[record.groupId]?.label || 'Список не определён';
    source.textContent = `${sourceGroup} · ${record.sourcePresent === false
      ? 'исходный файл отсутствует'
      : compact(record.relativePath || record.fileName || '', 58)}`;
    source.title = `${sourceGroup} · ${record.relativePath || ''}`;
    copy.append(name, source);

    const details = document.createElement('div');
    details.className = 'memory-details';
    const statusText = record.status === 'ready'
      ? (record.generatedAt
        ? `готово ${shortTime(record.generatedAt)}${record.outputWidth && record.outputHeight ? ` · ${record.outputWidth}×${record.outputHeight}` : ''}`
        : 'готово')
      : record.status === 'image_saved'
        ? `фото сохранено${record.generatedAt ? ` ${shortTime(record.generatedAt)}` : ''} · ждёт спецификацию`
        : record.status === 'facts_pending'
          ? 'получение спецификации'
      : (record.lastError
        ? `${record.errorClass ? `${record.errorClass} · ` : ''}${compact(record.lastError, 44)}`
        : memoryStatusText(record.status));
    details.textContent = repairs.has(String(record.sourceId)) ? `${statusText} · брак в очереди` : statusText;
    details.title = record.lastError || record.outputPath || (repairs.has(String(record.sourceId)) ? 'Добавлена в отдельную очередь перегенерации брака' : '');
    row.append(copy, details);
    fragment.append(row);
  }
  list.append(fragment);
  list.scrollTop = scrollTop;
}

function updateActionButtons() {
  const canContinue = runtime.state === 'PAUSED' && runtime.run;
  const stalledBatchStage = String(runtime.stalledBatchRecovery?.stage || '').toUpperCase();
  const stalledBatchBusy = ['CLOSING', 'WAITING', 'RESTARTING'].includes(stalledBatchStage);
  const stalledBatchCountdown = countdown(runtime.stalledBatchRecovery?.dueAt);
  const conversationRecoveryStage = String(runtime.conversationRecovery?.stage || '').toUpperCase();
  const conversationRecoveryBusy = ['INSPECTING', 'WAITING', 'REOPENING'].includes(conversationRecoveryStage);
  const recoveryCountdown = countdown(runtime.conversationRecovery?.dueAt);
  const waitingImageLimit = canContinue && runtime.imageLimitDetected === true
    && Number(runtime.rateLimitPauseUntil || 0) > Date.now();
  const isRunning = ['RUNNING', 'STARTING', 'DRAINING'].includes(runtime.state);
  const isReconciling = runtime.state === 'RECONCILING';
  const launchPlan = currentLaunchPartPlan;
  const selectedLaunchPart = launchPlan?.parts?.find((part) => part.partNumber === Number($('runPart')?.value || 0));
  const launchSelectionReady = currentLaunchSelectionExact
    && Boolean(selectedLaunchPart)
    && String($('runPart')?.dataset.partitionSignature || '') === String(launchPlan?.signature || '');
  let startLabel = canContinue ? 'ПРОДОЛЖИТЬ' : 'СТАРТ';
  if (actionBusy) startLabel = 'ПРОВЕРКА…';
  else if (stalledBatchStage === 'CLOSING') startLabel = 'ЗАКРЫВАЮ ВКЛАДКИ…';
  else if (stalledBatchStage === 'WAITING') startLabel = `ОТДЫХ · ${stalledBatchCountdown || '5:00'}`;
  else if (stalledBatchStage === 'RESTARTING') startLabel = 'ВОЗОБНОВЛЯЮ…';
  else if (conversationRecoveryStage === 'INSPECTING') startLabel = 'ПРОВЕРЯЮ ЧАТЫ…';
  else if (conversationRecoveryStage === 'WAITING') startLabel = `ВОССТАНОВЛЕНИЕ ${recoveryCountdown ? `· ${recoveryCountdown}` : ''}`.trim();
  else if (conversationRecoveryStage === 'REOPENING') startLabel = 'ОТКРЫВАЮ ЧАТЫ…';
  else if (waitingImageLimit) startLabel = 'ОЖИДАНИЕ ЛИМИТА';
  $('start').querySelector('span:last-child').textContent = startLabel;
  $('start').disabled = isRunning || isReconciling || actionBusy || waitingImageLimit || conversationRecoveryBusy || stalledBatchBusy
    || ['applying', 'syncing-references'].includes(extensionUpdateStatus.phase)
    || (!canContinue && !launchSelectionReady);
  $('pauseRun').disabled = !isRunning || isReconciling || actionBusy;
  const stopButton = $('stop');
  const stopLabel = stopButton?.querySelector('span:last-child');
  const stopIcon = stopButton?.querySelector('.button-icon');
  const resetInsteadOfStop = Boolean(runtime.stopBlocked);
  if (stopLabel) stopLabel.textContent = resetInsteadOfStop ? 'СБРОС' : 'СТОП';
  if (stopIcon) stopIcon.textContent = resetInsteadOfStop ? '↻' : '■';
  if (stopButton) {
    stopButton.title = resetInsteadOfStop
      ? 'Сверить готовые PNG и вернуть незавершённые генерации в очередь'
      : 'Остановить прогон';
    stopButton.disabled = !(isRunning || canContinue || resetInsteadOfStop) || isReconciling || actionBusy || conversationRecoveryBusy;
  }
  if ($('resetRunRescan')) $('resetRunRescan').disabled = actionBusy;
  if ($('exportDiagnostics')) $('exportDiagnostics').disabled = actionBusy;
  const updateButton = $('updateExtension');
  if (updateButton) {
    const updateBusy = EXTENSION_UPDATE_ACTIVE_PHASES.has(extensionUpdateStatus.phase);
    updateButton.disabled = updateBusy || isRunning || isReconciling || actionBusy || Boolean(canContinue);
    updateButton.textContent = extensionUpdateStatus.phase === 'applying'
      ? 'Устанавливаю обновление…'
      : extensionUpdateStatus.phase === 'syncing-references'
        ? 'Синхронизирую референсы…'
      : updateBusy
        ? (extensionUpdateStatus.phase === 'ready' ? 'Ожидаю свободные вкладки…' : 'Проверяю и скачиваю…')
        : 'Проверить и обновить';
  }
  const controlsLocked = isRunning || isReconciling || actionBusy || Boolean(canContinue);
  $('workerCount').disabled = controlsLocked;
  ['runQueueMode', 'runGroupFilter', 'runBrandFilter', 'runPart', 'runLimit', 'inputMode', 'rateLimitPauseMinutes'].forEach((id) => {
    if ($(id)) $(id).disabled = controlsLocked;
  });
}

let actionBusy = false;

function renderHealth(pause = countdown(runtime.rateLimitPauseUntil)) {
  const active = ['RUNNING', 'STARTING', 'DRAINING', 'RECONCILING'].includes(runtime.state);
  const warning = runtime.status === 'RUNNING_WITH_ERRORS'
    || runtime.status === 'PAUSED_ON_ERROR'
    || runtime.status === 'DONE_WITH_FACTS_ERRORS'
    || String(runtime.stalledBatchRecovery?.stage || '').toUpperCase() === 'FAILED'
    || runtime.state === 'ERROR'
    || Boolean(runtime.error);
  const rateLimited = Boolean(pause) || runtime.status === 'RATE_LIMIT_PAUSE';
  const statusSignal = $('statusSignal');
  const pauseSignal = $('pauseSignal');
  statusSignal.className = `health-signal ${warning ? 'is-warn' : (active ? 'is-live' : 'is-ready')}`;
  pauseSignal.className = `health-signal ${rateLimited ? 'is-paused' : 'is-ready'}`;
  $('status').textContent = warning ? 'WARN' : 'OK';
  $('pauseStatus').textContent = pause || (rateLimited ? 'WAIT' : 'OK');
}

async function refreshRuntime() {
  const response = await requestRuntime();
  if (!response?.ok) return;
  const value = response.value || {};
  runtime = { ...runtime, ...(value.runtime || {}), run: value.run || null };
  if (value.domDiagnosticsMode != null) {
    domDiagnosticsMode = normalizeDomDiagnosticsMode(value.domDiagnosticsMode);
    updateDomDiagnosticsStatus();
  }
  if (value.lastPreflight) {
    lastPreflight = value.lastPreflight;
    renderPreflight(lastPreflight);
  }
  if (value.generationMemory) generationMemory = value.generationMemory;
  if (value.queue?.groups) {
    queue = value.queue;
    applyGenerationHistory(queue.groups, value.history);
    applyGenerationMemory(queue.groups, generationMemory);
    renderAll();
  } else {
    renderGenerationMemory();
  }
  if (runtime.workerCount && runtime.run && !['IDLE', 'DONE'].includes(runtime.state)) {
    $('workerCount').value = String(normalizeWorkerCount(runtime.workerCount, 4));
  }
  if (runtime.inputMode && runtime.run && !['IDLE', 'DONE'].includes(runtime.state) && $('inputMode')) {
    $('inputMode').value = normalizeInputMode(runtime.inputMode, DEFAULT_INPUT_MODE);
  }
  if (runtime.rateLimitPauseMinutes && runtime.run && !['IDLE', 'DONE'].includes(runtime.state)) {
    $('rateLimitPauseMinutes').value = String(normalizeRateLimitPauseMinutes(runtime.rateLimitPauseMinutes));
  }
  const pause = ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(runtime.state) ? countdown(runtime.rateLimitPauseUntil) : '';
  renderHealth(pause);
  renderRunStatus(pause);
  renderSlotGrid();
  const appliedFilter = normalizeWatchFilter(runtime.filter || filterFromInputs());
  const appliedEntries = filterEntries(appliedFilter);
  const selected = {
    total: appliedEntries.length,
    done: appliedEntries.filter((entry) => entry.status === 'done').length
  };
  $('meta').textContent = [
    `Фильтр: ${runtime.filterLabel || filterLabel(appliedFilter)}`,
    Number(runtime.runPart || 0) > 0 ? `Часть очереди: ${runtime.runPart}/${runtime.runPartCount || '—'} · назначено ${runtime.runPartCandidateCount || 0}` : '',
    `Прогон: ${runtime.runCompleted ?? 0}/${runtime.runTotal ?? '—'} · осталось ${runtime.runRemaining ?? '—'}`,
    `Выбранный список: ${selected.done}/${selected.total}`,
    runtime.error ? `Ошибка: ${compact(runtime.error, 160)}` : ''
  ].filter(Boolean).join('\n');
  renderLogs(value.logs || []);
  updateActionButtons();
}

async function currentHostWindowId() {
  try {
    const current = await chrome.windows.getCurrent();
    if (current?.id != null) return current.id;
  } catch (_) {}
  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return focused?.id ?? null;
  } catch (_) {
    return null;
  }
}

async function startOrResume() {
  if (actionBusy) return;
  actionBusy = true;
  updateActionButtons();
  try {
    const continuing = runtime.state === 'PAUSED' && Boolean(runtime.run);
    if (continuing) {
      const response = await chrome.runtime.sendMessage({ type: 'RUN_REQUEST', intent: 'resume', preferredWindowId: await currentHostWindowId() });
      if (!response?.ok) throw new Error(response?.error || 'Продолжение не выполнено');
      await refreshRuntime();
      return;
    }

    await saveJob({ requireQueue: true });
    const preflightResponse = await chrome.runtime.sendMessage({ type: 'RUN_PREFLIGHT' });
    if (!preflightResponse?.ok) throw new Error(preflightResponse?.error || 'Предварительная проверка не выполнена');
    lastPreflight = preflightResponse.value || null;
    renderPreflight(lastPreflight);
    if (!lastPreflight?.ok) {
      const failed = (lastPreflight.checks || []).filter((check) => check.blocking && !check.ok).map((check) => check.label).join(', ');
      throw new Error(`Предварительная проверка не пройдена: ${failed || 'проверь входные данные'}`);
    }
    const response = await chrome.runtime.sendMessage({
      type: 'RUN_REQUEST',
      intent: 'start',
      preferredWindowId: await currentHostWindowId()
    });
    if (!response?.ok) throw new Error(response?.error || 'Запуск не выполнен');
    await refreshRuntime();
  } finally {
    actionBusy = false;
    updateActionButtons();
  }
}

async function stopRun() {
  if (actionBusy) return;
  actionBusy = true;
  updateActionButtons();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
    if (!response?.ok) {
      await refreshRuntime();
      throw new Error(response?.error || 'Остановка не выполнена');
    }
    await refreshRuntime();
  } finally {
    actionBusy = false;
    updateActionButtons();
  }
}

function stopOrResetRun() {
  if (runtime.stopBlocked) {
    resetRunAndRescanFromUi();
    return Promise.resolve();
  }
  return stopRun();
}

async function pauseRun() {
  if (actionBusy) return;
  actionBusy = true;
  updateActionButtons();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PAUSE_RUN' });
    if (!response?.ok) throw new Error(response?.error || 'Пауза не выполнена');
    await refreshRuntime();
  } finally {
    actionBusy = false;
    updateActionButtons();
  }
}

async function clearHistory(event) {
  event.preventDefault();
  requestInlineConfirmation(
    'Очистить историю и вернуть все модели в статус «Не готово»?',
    'Очистить',
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
      if (!response?.ok) throw new Error(response?.error || 'История не очищена');
      await loadQueue();
      showFeedback('История очищена. Все модели доступны для нового прогона.', {
        type: 'success',
        autoHide: true
      });
    }
  );
}

async function setDomDiagnosticsModeFromUi() {
  const requested = normalizeDomDiagnosticsMode($('domDiagnosticsMode')?.value);
  const response = await chrome.runtime.sendMessage({
    type: 'SET_DOM_DIAGNOSTICS_MODE',
    mode: requested
  });
  if (!response?.ok) throw new Error(response?.error || 'Режим диагностики не изменён');
  domDiagnosticsMode = normalizeDomDiagnosticsMode(response.value?.mode || requested);
  updateDomDiagnosticsStatus();
  showFeedback(domDiagnosticsMode === 'off'
    ? 'Сбор DOM выключен. Рабочие вкладки продолжают работать в обычном режиме.'
    : 'Режим диагностики сохранён.', {
    type: 'success',
    autoHide: true
  });
}

async function clearDomDiagnosticsFromUi() {
  requestInlineConfirmation(
    'Удалить накопленные DOM-состояния и снимки диагностики?',
    'Удалить',
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_DOM_DIAGNOSTICS' });
      if (!response?.ok) throw new Error(response?.error || 'DOM-архив не очищен');
      updateDomDiagnosticsStatus('DOM-архив очищен.');
      showFeedback(response.value?.watcher?.ok === false
        ? 'Локальный watcher недоступен. Буфер расширения очищен; файлы удалятся после запуска watcher.'
        : 'DOM-архив очищен.', {
        type: 'success',
        autoHide: true
      });
    }
  );
}

async function resetRunAndRescanFromUi() {
  requestInlineConfirmation(
    'Сбросить текущую сессию? Расширение быстро проверит уже готовые результаты, закроет только свои рабочие вкладки, очистит временные слоты и заново сверит готовые PNG в Downloads. История готовых файлов не удаляется.',
    'Сбросить и пересканировать',
    async () => {
      if (actionBusy) return;
      actionBusy = true;
      updateActionButtons();
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'RESET_RUN_RESCAN',
          salvageReady: true,
          reason: 'Ручной сброс из панели'
        });
        if (!response?.ok) throw new Error(response?.error || 'Сессию не удалось сбросить');
        await refreshRuntime();
        await loadQueue();
        const value = response.value || {};
        showFeedback(
          `Сессия сброшена. Восстановлено по сохранённым ревизиям: ${value.restoredFromRevisions || 0}. Сброшено временных записей: ${value.resetRecords || 0}.`,
          { type: 'success', autoHide: true, autoHideMs: 9000 }
        );
      } finally {
        actionBusy = false;
        updateActionButtons();
      }
    }
  );
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function runDiagnosticOptionLabel(run) {
  const date = run.startedAt && Number.isFinite(Date.parse(run.startedAt))
    ? new Date(run.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Время неизвестно';
  const state = run.status || run.state || 'UNKNOWN';
  return `${date} · ${state} · ${Number(run.completedCount || 0)}/${Number(run.plannedCount || 0)} · ${Number(run.eventCount || 0)} событий`;
}

async function refreshRunDiagnosticsList() {
  const select = $('runDiagnosticsSelect');
  if (!select) return;
  const selectedId = select.value;
  const runs = await listRunDiagnostics({ limit: 500 });
  select.replaceChildren(new Option(runs.length ? 'Выберите прогон…' : 'Архив прогонов пуст', ''));
  for (const run of runs) select.add(new Option(runDiagnosticOptionLabel(run), run.operationId));
  select.value = runs.some((run) => run.operationId === selectedId)
    ? selectedId
    : (runs[0]?.operationId || '');
  $('exportRunDiagnostics').disabled = !select.value;
  $('runDiagnosticsStatus').textContent = runs.length
    ? `Сохранено прогонов: ${runs.length}. События каждого прогона хранятся отдельно.`
    : 'После запуска здесь появится отдельная диагностика с временной шкалой событий.';
}

function refreshRunDiagnosticsAtBoundary() {
  const operationId = String(runtime.operationId || runtime.run?.operationId || '');
  const state = String(runtime.state || 'IDLE');
  const startedNewRun = Boolean(operationId && operationId !== diagnosticsObservedOperationId);
  const completedRun = Boolean(operationId && ['DONE', 'STOPPED'].includes(state)
    && state !== diagnosticsObservedRunState);
  const resetOrStopped = Boolean(!operationId && diagnosticsObservedOperationId
    && ['IDLE', 'STOPPED', 'RECONCILING'].includes(state));
  diagnosticsObservedOperationId = operationId;
  diagnosticsObservedRunState = state;
  if (startedNewRun || completedRun || resetOrStopped) refreshRunDiagnosticsList().catch(() => {});
}

async function exportSelectedRunDiagnostic() {
  const operationId = $('runDiagnosticsSelect')?.value;
  if (!operationId) throw new Error('Выбери прогон для экспорта');
  const archive = await getRunDiagnostic(operationId);
  if (!archive?.run) throw new Error('Диагностика прогона не найдена. Обнови список и повтори экспорт.');
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || null,
    run: archive.run,
    events: archive.events
  };
  const stamp = String(archive.run.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  downloadJson(`watch-automation-run-${stamp}-${String(operationId).slice(0, 8)}.json`, payload);
  showFeedback(`Диагностика прогона сохранена: ${archive.events.length} событий.`, { type: 'success', autoHide: true });
}

async function exportDiagnosticSnapshot() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_RUNTIME' });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось получить состояние расширения');
  const value = response.value || {};
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || null,
    runtime: value.runtime || null,
    run: value.run || null,
    logs: Array.isArray(value.logs) ? value.logs : [],
    lastPreflight: value.lastPreflight || null,
    domDiagnosticsMode: value.domDiagnosticsMode || null,
    lastDiagnostic: value.lastDiagnostic || null,
    job: value.job || null,
    generationMemorySummary: (() => {
      const items = Object.values(value.generationMemory?.items || {});
      return {
        total: items.length,
        ready: items.filter((item) => item.status === 'ready').length,
        running: items.filter((item) => item.status === 'running').length,
        notReady: items.filter((item) => item.status === 'not_ready').length
      };
    })(),
    activeMemoryItems: Object.values(value.generationMemory?.items || {})
      .filter((item) => item.status === 'running' || item.lastError)
      .slice(-500)
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadJson(`watch-automation-diagnostics-${stamp}.json`, payload);
  showFeedback('Диагностика сохранена в JSON. Папка локального watcher для этого не нужна.', { type: 'success', autoHide: true });
}

async function exportGenerationMemory() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_RUNTIME' }).catch(() => null);
  const value = response?.ok ? (response.value || {}) : {};
  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    generationMemory,
    queue: { groups: queue.groups },
    diagnosticContext: {
      extensionVersion: chrome.runtime.getManifest?.().version || null,
      runtime: value.runtime || null,
      run: value.run || null,
      logs: Array.isArray(value.logs) ? value.logs : [],
      lastPreflight: value.lastPreflight || null
    }
  };
  downloadJson(`watch-automation-memory-${new Date().toISOString().slice(0, 10)}.json`, payload);
  showFeedback('Память экспортирована в JSON вместе с контекстом текущей сессии.', { type: 'success', autoHide: true });
}

async function importGenerationMemory(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const text = await file.text();
  let snapshot;
  try { snapshot = JSON.parse(text); } catch (_) { throw new Error('Файл памяти содержит некорректный JSON'); }
  const items = snapshot?.generationMemory?.items || snapshot?.items;
  if (!items || typeof items !== 'object') throw new Error('В файле нет раздела generationMemory.items');
  const response = await chrome.runtime.sendMessage({
    type: 'IMPORT_GENERATION_MEMORY',
    snapshot: { generationMemory: { version: 1, items } }
  });
  if (!response?.ok) throw new Error(response?.error || 'Память не импортирована');
  await loadQueue();
  showFeedback(`Импортировано записей: ${response.value?.count || 0}.`, { type: 'success', autoHide: true });
}

function showError(error) {
  showFeedback(error?.message || String(error), { type: 'error' });
}

function renderExtensionUpdateStatus(status, { deferred = false, reason = '', applying = false } = {}) {
  extensionUpdateStatus = { ...(status || {}), phase: applying ? 'applying' : (status?.phase || 'idle') };
  const version = $('extensionVersion');
  const message = $('updateStatus');
  if (version) {
    const current = String(status?.currentVersion || chrome.runtime.getManifest?.().version || '—');
    version.textContent = status?.latestVersion && status.latestVersion !== current
      ? `${current} → ${status.latestVersion}`
      : current;
  }
  if (message) {
    message.dataset.state = extensionUpdateStatus.phase;
    if (applying) {
      message.textContent = 'Обновление готово. Устанавливаю код и референсы; входные фото часов остаются на месте.';
    } else if (deferred) {
      message.textContent = `Пакет готов. Установка начнётся после завершения прогона.${reason ? ` ${reason}` : ''}`;
    } else {
      message.textContent = String(status?.message || 'Проверка обновления запускается вручную.');
    }
  }
  updateActionButtons();
}

function scheduleExtensionUpdatePoll(delayMs = 5000) {
  if (extensionUpdatePollTimer) clearTimeout(extensionUpdatePollTimer);
  extensionUpdatePollTimer = setTimeout(() => {
    extensionUpdatePollTimer = null;
    refreshExtensionUpdateStatus().catch(() => {});
  }, delayMs);
}

async function syncUpdatedReferenceAssetsIfNeeded(installed, status = {}) {
  const packageId = String(installed?.packageId || '');
  if (!packageId || referenceSyncInFlight) return false;
  const stored = await chrome.storage.local.get('manualReferenceSyncPackageId');
  if (String(stored.manualReferenceSyncPackageId || '') === packageId) return false;

  referenceSyncInFlight = true;
  renderExtensionUpdateStatus({
    ...status,
    phase: 'syncing-references',
    message: 'Код обновлён. Загружаю свежие референсы в локальную библиотеку расширения…'
  });
  try {
    const listResponse = await fetch('http://127.0.0.1:17321/local-input-files?kind=references', { cache: 'no-store' });
    if (!listResponse.ok) throw new Error(`Локальный сервис референсов ответил HTTP ${listResponse.status}`);
    const listed = await listResponse.json();
    const sourceFiles = (Array.isArray(listed?.files) ? listed.files : [])
      .filter((item) => item?.path && referenceDescriptorForPath(item.path));
    if (!sourceFiles.length) throw new Error('В папке input-ref-images не найдены файлы референсов для этой версии.');

    const nextAssets = [];
    const nextMetadata = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, sourceFiles.length) }, async () => {
      while (cursor < sourceFiles.length) {
        const item = sourceFiles[cursor++];
        const descriptor = referenceDescriptorForPath(item.path);
        const url = `http://127.0.0.1:17321/local-input-file?path=${encodeURIComponent(item.path)}`;
        const fileResponse = await fetch(url, { cache: 'no-store' });
        if (!fileResponse.ok) throw new Error(`Не удалось прочитать референс ${item.name}: HTTP ${fileResponse.status}`);
        const blob = await fileResponse.blob();
        const file = new File([blob], item.name || pathBasename(item.path), {
          type: blob.type || 'image/png',
          lastModified: Number(item.modifiedAt || Date.now())
        });
        nextAssets.push({
          key: `ref:${descriptor.storageKey}`,
          file,
          relativePath: item.path
        });
        nextMetadata.push([descriptor.storageKey, {
          name: file.name,
          size: file.size,
          lastModified: Number(file.lastModified || 0),
          fingerprint: fingerprintForFile(file),
          contentHash: await sha256File(file)
        }]);
      }
    });
    await Promise.all(workers);
    const uniqueAssets = new Map(nextAssets.map((entry) => [entry.key, entry]));
    if (uniqueAssets.size !== nextAssets.length) throw new Error('В обновлённых референсах повторяются ключи файлов.');
    await replaceAssets('ref:', [...uniqueAssets.values()], { force: true });
    referenceFiles.clear();
    for (const asset of uniqueAssets.values()) {
      const key = asset.key.slice('ref:'.length);
      referenceFiles.set(key, {
        storedKey: asset.key,
        name: asset.file.name,
        type: asset.file.type || 'image/png',
        size: asset.file.size
      });
    }
    queue = { ...queue, refs: Object.fromEntries(nextMetadata) };
    folderSelections = {
      ...folderSelections,
      references: {
        pathHint: 'input-ref-images',
        fileCount: uniqueAssets.size,
        selectedFileCount: sourceFiles.length,
        recognizedFileCount: uniqueAssets.size,
        storageStatus: 'ready',
        savedAt: new Date().toISOString()
      }
    };
    await chrome.storage.local.set({
      queue,
      folderSelections,
      manualReferenceSyncPackageId: packageId
    });
    renderAll();
    renderExtensionUpdateStatus({
      ...status,
      phase: 'complete',
      message: `Обновление установлено; синхронизировано референсов: ${uniqueAssets.size}. Папка входных фото часов сохранена.`
    });
    return true;
  } catch (error) {
    renderExtensionUpdateStatus({
      ...status,
      phase: 'error',
      message: `Код обновлён, но референсы не синхронизировались: ${error?.message || error}. Нажми кнопку ещё раз после запуска локального сервиса.`
    });
    return false;
  } finally {
    referenceSyncInFlight = false;
  }
}

function pathBasename(value) {
  return String(value || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || 'reference.png';
}

async function refreshExtensionUpdateStatus() {
  if (extensionUpdatePollInFlight) return;
  extensionUpdatePollInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_EXTENSION_UPDATE_STATUS' });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось получить состояние обновления');
    const status = response.status || {};
    const installed = response.installed || null;
    renderExtensionUpdateStatus(status, {
      deferred: response.deferred === true,
      reason: response.reason || '',
      applying: response.applying === true || status.phase === 'applying'
    });
    const currentVersion = String(chrome.runtime.getManifest?.().version || '');
    const installedVersionMatches = String(installed?.extensionVersion || '') === currentVersion;
    const packageInstallationInProgress = ['checking', 'downloading', 'validating', 'ready', 'applying'].includes(String(status.phase || ''));
    if (installed?.packageId && installedVersionMatches && !packageInstallationInProgress) {
      await syncUpdatedReferenceAssetsIfNeeded(installed, status);
    }
    if (EXTENSION_UPDATE_ACTIVE_PHASES.has(extensionUpdateStatus.phase)) scheduleExtensionUpdatePoll(5000);
    else if (extensionUpdatePollTimer) {
      clearTimeout(extensionUpdatePollTimer);
      extensionUpdatePollTimer = null;
    }
  } catch (error) {
    const message = String(error?.message || error);
    renderExtensionUpdateStatus({
      phase: 'error',
      currentVersion: chrome.runtime.getManifest?.().version || null,
      message: message.includes('Could not establish connection') || message.includes('Failed to fetch')
        ? 'Локальный сервис обновления не отвечает. Перезапусти WatchAutomation и повтори проверку.'
        : message
    });
    if (extensionUpdatePollTimer) {
      clearTimeout(extensionUpdatePollTimer);
      extensionUpdatePollTimer = null;
    }
  } finally {
    extensionUpdatePollInFlight = false;
  }
}

async function startExtensionUpdateFromUi() {
  const button = $('updateExtension');
  if (button) button.disabled = true;
  renderExtensionUpdateStatus({
    phase: 'checking',
    currentVersion: chrome.runtime.getManifest?.().version || null,
    message: 'Проверяю GitHub. Фотографии часов останутся на месте.'
  });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_EXTENSION_UPDATE' });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось начать проверку обновления');
    renderExtensionUpdateStatus(response.status || {
      phase: 'checking',
      currentVersion: chrome.runtime.getManifest?.().version || null,
      message: 'Проверяю доступное обновление…'
    });
    scheduleExtensionUpdatePoll(400);
  } catch (error) {
    renderExtensionUpdateStatus({
      phase: 'error',
      currentVersion: chrome.runtime.getManifest?.().version || null,
      message: error?.message || String(error)
    });
    throw error;
  }
}

// Selecting the same directory twice does not emit `change` unless the native
// input value is cleared first. This is especially important after a failed
// large-folder scan, where the user needs to retry the same folder.
['refFolder', 'watchFolder'].forEach((id) => {
  $(id)?.addEventListener('click', (event) => { event.currentTarget.value = ''; });
});
$('refFolder').addEventListener('change', () => scanReferenceFolder().catch(showError));
$('watchFolder').addEventListener('change', () => scanWatchFolder().catch(showError));
$('workerCount').addEventListener('change', () => { renderSlotGrid(); saveDraft().catch(showError); });
$('runLimit').addEventListener('change', () => {
  const value = Math.max(1, Math.min(RUN_PART_SIZE, normalizeRunLimit($('runLimit').value, RUN_PART_SIZE)));
  $('runLimit').value = String(value);
  renderAll();
  updateActionButtons();
  saveDraft().catch(showError);
});
$('inputMode')?.addEventListener('change', () => { renderAll(); saveDraft().catch(showError); });
$('rateLimitPauseMinutes')?.addEventListener('change', () => saveDraft().catch(showError));
$('rateLimitIgnoreMinutes')?.addEventListener('change', () => saveDraft().catch(showError));
$('generationPauseMinutes')?.addEventListener('change', () => saveDraft().catch(showError));
$('generationJitterSeconds')?.addEventListener('change', () => saveDraft().catch(showError));
$('domDiagnosticsMode')?.addEventListener('change', () => setDomDiagnosticsModeFromUi().catch(showError));
$('clearDomDiagnostics')?.addEventListener('click', () => clearDomDiagnosticsFromUi().catch(showError));
$('exportDiagnostics')?.addEventListener('click', () => exportDiagnosticSnapshot().catch(showError));
$('updateExtension')?.addEventListener('click', () => startExtensionUpdateFromUi().catch(showError));
$('refreshRunDiagnostics')?.addEventListener('click', () => refreshRunDiagnosticsList().catch(showError));
$('runDiagnosticsSelect')?.addEventListener('change', () => {
  $('exportRunDiagnostics').disabled = !$('runDiagnosticsSelect').value;
});
$('exportRunDiagnostics')?.addEventListener('click', () => exportSelectedRunDiagnostic().catch(showError));
$('start').addEventListener('click', () => setWorkspaceView('run'));
$('start').addEventListener('click', () => startOrResume().catch(showError));
$('stop').addEventListener('click', () => stopOrResetRun().catch(showError));
$('pauseRun').addEventListener('click', () => pauseRun().catch(showError));
$('resetRunRescan')?.addEventListener('click', () => setWorkspaceView('service'));
$('resetRunRescan')?.addEventListener('click', () => resetRunAndRescanFromUi().catch(showError));
$('clearHistory').addEventListener('click', (event) => clearHistory(event).catch(showError));
$('chooseOutputFolder')?.addEventListener('click', () => chooseOutputDirectory().catch(showError));
$('grantOutputFolder')?.addEventListener('click', () => grantOutputDirectory().catch(showError));
$('useDownloadsOutput')?.addEventListener('click', () => useDownloadsOutput().catch(showError));

$('openGallery')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html'), active: true })
    .catch(showError);
});

$('openDownloadsFolder')?.addEventListener('click', () => (async () => {
  const response = await chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOADS_FOLDER' });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось открыть папку загрузок');
  showFeedback(response.value?.fallback
    ? 'Скачанных файлов WatchAutomation пока нет. Открыта страница загрузок Chrome.'
    : 'Папка с последним результатом открыта в проводнике.', {
    type: 'success',
    autoHide: true
  });
})().catch(showError));
$('memoryExport')?.addEventListener('click', () => exportGenerationMemory().catch(showError));
$('memoryImport')?.addEventListener('click', () => $('memoryImportFile')?.click());
$('memoryImportFile')?.addEventListener('change', (event) => importGenerationMemory(event).catch(showError));
$('memorySearch')?.addEventListener('input', () => {
  renderAll();
  saveDraft().catch(showError);
});
['memoryGroupFilter', 'memoryBrandFilter', 'memoryStatusFilter'].forEach((id) => {
  $(id)?.addEventListener('change', () => {
    renderAll();
    saveDraft().catch(showError);
  });
});
['runQueueMode', 'runGroupFilter', 'runBrandFilter'].forEach((id) => {
  $(id)?.addEventListener('change', () => {
    resetRunPartSelection();
    renderAll();
    updateActionButtons();
    saveDraft().catch(showError);
  });
});
$('runPart')?.addEventListener('change', () => {
  desiredRunPart = String($('runPart').value || '');
  desiredRunPartSignature = desiredRunPart ? String($('runPart').dataset.partitionSignature || '') : '';
  renderAll();
  updateActionButtons();
  saveDraft().catch(showError);
});

$('feedbackAction')?.addEventListener('click', () => {
  const handler = feedbackActionHandler;
  if (!handler) return;
  feedbackActionHandler = null;
  Promise.resolve(handler()).catch(showError);
});
$('feedbackClose')?.addEventListener('click', () => clearFeedback());

let storageListRefreshBusy = false;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || storageListRefreshBusy) return;
  if (!changes.queue && !changes.history && !changes.generationMemory && !changes.folderSelections && !changes.lastPreflight && !changes.domDiagnosticsMode && !changes.outputDestination) return;
  storageListRefreshBusy = true;
  chrome.storage.local.get(['queue', 'history', 'generationMemory', 'folderSelections', 'lastPreflight', 'domDiagnosticsMode', 'outputDestination'])
    .then((stored) => {
      if (stored.queue?.groups) queue = stored.queue;
      if (stored.generationMemory) generationMemory = stored.generationMemory;
      if (stored.folderSelections) {
        folderSelections = {
          references: stored.folderSelections.references || null,
          watches: stored.folderSelections.watches || null
        };
      }
      if (stored.lastPreflight) lastPreflight = stored.lastPreflight;
      if (stored.domDiagnosticsMode != null) domDiagnosticsMode = normalizeDomDiagnosticsMode(stored.domDiagnosticsMode);
      if (stored.outputDestination) outputDestination = { ...outputDestination, ...stored.outputDestination };
      updateDomDiagnosticsStatus();
      refreshOutputDestinationUi().catch(() => {});
      applyGenerationHistory(queue.groups, stored.history);
      hydrateGenerationMemoryFromQueue();
      applyGenerationMemory(queue.groups, generationMemory);
      renderAll();
    })
    .catch(showError)
    .finally(() => { storageListRefreshBusy = false; });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'RUNTIME_UPDATED') {
    refreshRuntimeFast().catch(() => {});
    return;
  }
  if (message?.type === 'FACTS_STAGE_LIVE' && message.job?.factsJobId) {
    const jobs = Array.isArray(runtime.factsJobs) ? [...runtime.factsJobs] : [];
    const index = jobs.findIndex((item) => item?.factsJobId === message.job.factsJobId);
    if (index >= 0) jobs[index] = { ...jobs[index], ...message.job };
    else jobs.push(message.job);
    runtime = { ...runtime, factsJobs: jobs };
    renderSlotGrid();
    return;
  }
  if (message?.type !== 'GET_INPUT_FILE') return;
  const key = String(message.sourceKey || '');
  const file = key.startsWith('ref:')
    ? referenceFiles.get(key.slice(4))
    : watchFiles.get(key.slice(6));
  if (!file) {
    sendResponse({ ok: false, error: `Файл недоступен: ${key}. Выбери папки заново.` });
    return;
  }
  const cacheKey = key.startsWith('ref:') ? key : null;
  fileForInput(key, file)
    .then((resolvedFile) => payloadForFile(resolvedFile, cacheKey))
    .then((payload) => sendResponse({ ok: true, value: payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

initWorkspaceUi();
populateBrandFilter();
loadQueue()
  .then(async () => {
    await refreshRunDiagnosticsList();
    await refreshExtensionUpdateStatus();
  })
  .catch(showError);
// Fast status refresh is intentionally lightweight: GET_RUNTIME_FAST never
// synchronizes the 3000-item queue. A separate slow full refresh keeps queue
// and memory views coherent without creating a state-lock backlog.
setInterval(() => {
  refreshRuntimeFast().catch(() => {});
}, 1000);
setInterval(() => {
  refreshRuntime().catch(() => {});
  chrome.runtime.sendMessage({ type: 'DEV_RELOAD_POLL' }).catch(() => {});
}, 15000);
// Keep elapsed stage timers visually live even between worker messages.
setInterval(() => {
  renderRunStatus();
  if (runtime.run) renderSlotGrid();
}, 1000);
