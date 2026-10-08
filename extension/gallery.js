import { initResultsTransfer } from './results-transfer-ui.js';
import {
  WATCH_BRAND_FILTERS,
  QUEUE_GROUP_IDS,
  brandIdFromModelName,
  sanitizeFilename,
  modelCatalogRecordsFromGroups
} from './queue-utils.js';
import {
  getOutputDirectoryHandle, getAllGenerationRevisions,
  getAllModelCatalog, replaceModelCatalog
} from './idb.js';
import {
  factsDisplayState, effectiveFactsWarnings, factsSeriesPolicy, displayFactsTitleBrand, sortGalleryRecords
} from './gallery-utils.js';
import { galleryRecordsFromCatalog } from './gallery-revision-utils.js';
import {
  ACCOUNTING_SNAPSHOT_STORAGE_KEY,
  acceptAccountingSnapshot,
  accountingSnapshotFromResponse,
  accountingSnapshotFreshness
} from './accounting-ui-utils.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 160;
const WATCHER_BASE = 'http://127.0.0.1:17321';
const brandLabelById = new Map(WATCH_BRAND_FILTERS.map((item) => [item.id, item.label]));
let records = [];
let filtered = [];
let shown = PAGE_SIZE;
let outputHandle = null;
let outputDestination = { mode: 'downloads', folderName: null, permission: 'unknown' };
let downloadItems = [];
let viewerIndex = -1;
let viewerObjectUrl = null;
let zoom = 1;
const thumbUrls = new Map();
const loadingThumbs = new Map();
let toastTimer = null;
let accountingSnapshot = null;
let galleryLoadSequence = 0;

function thumbnailCacheKey(record) {
  return [
    String(record?.sourceId || ''),
    String(record?.outputHash || ''),
    String(record?.modifiedAt || ''),
    String(record?.outputPath || '')
  ].join('|');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function normalizePath(value) { return String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/'); }
function lowerPath(value) { return normalizePath(value).toLowerCase(); }
function groupSale(groupId) { return String(groupId || '').startsWith('in_sale_') ? 'in_sale' : 'not_in_sale'; }
function groupQuality(groupId) { return String(groupId || '').endsWith('_bad') ? 'bad' : 'good'; }
function brandId(record) { return record.profileId || brandIdFromModelName(record.modelName || record.fileName || record.outputFileName || ''); }
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
function showToast(message, type = '') {
  const toast = $('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${type ? ` ${type}` : ''}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}
function showError(error) { showToast(error?.message || String(error), 'error'); }

async function permission(handle, mode = 'read') {
  if (!handle) return 'missing';
  try { return handle.queryPermission ? await handle.queryPermission({ mode }) : 'granted'; }
  catch (_) { return 'unknown'; }
}

async function scanCustomFolder(handle) {
  if (!handle) return [];
  const p = await permission(handle, 'read');
  if (p !== 'granted') return [];
  const artifacts = [];
  for (const groupId of QUEUE_GROUP_IDS) {
    let groupHandle;
    try { groupHandle = await handle.getDirectoryHandle(sanitizeFilename(groupId), { create: false }); }
    catch (_) { continue; }
    try {
      for await (const [name, fileHandle] of groupHandle.entries()) {
        if (fileHandle?.kind !== 'file' || !/\.png$/i.test(name)) continue;
        let file = null;
        try { file = await fileHandle.getFile(); } catch (_) {}
        artifacts.push({
          groupId,
          outputFileName: name,
          artifactMode: 'custom',
          outputPath: `custom://${handle.name}/${sanitizeFilename(groupId)}/${name}`,
          fileHandle,
          rootHandle: handle,
          modifiedAt: Number(file?.lastModified || 0),
          bytes: Number(file?.size || 0)
        });
      }
    } catch (_) {}
  }
  return artifacts;
}

async function countCustomArchivePngs(handle) {
  if (!handle || await permission(handle, 'read') !== 'granted') return 0;
  let count = 0;
  try {
    const archive = await handle.getDirectoryHandle('_archive', { create: false });
    for await (const [, groupHandle] of archive.entries()) {
      if (groupHandle?.kind !== 'directory') continue;
      for await (const [name, fileHandle] of groupHandle.entries()) {
        if (fileHandle?.kind === 'file' && /\.png$/i.test(name)) count += 1;
      }
    }
  } catch (_) {}
  return count;
}

function parseDownloadArtifact(item) {
  if (!item || item.state !== 'complete' || item.exists === false || !/\.png$/i.test(String(item.filename || ''))) return null;
  const normalized = normalizePath(item.filename || '');
  const lower = normalized.toLowerCase();
  const marker = '/watchautomation/';
  const markerIndex = lower.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const relative = normalized.slice(markerIndex + marker.length);
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length) return null;
  const groupId = parts.length > 1 ? parts.shift() : '';
  if (groupId === '_archive') return null;
  const outputFileName = parts.join('/');
  if (!outputFileName || outputFileName.includes('/')) return null;
  return {
    groupId,
    outputFileName,
    artifactMode: 'downloads-history',
    outputPath: item.filename,
    downloadId: item.id,
    downloadUrl: item.finalUrl || item.url || null,
    modifiedAt: Date.parse(item.endTime || item.startTime || '') || 0,
    bytes: Number(item.fileSize || item.bytesReceived || 0)
  };
}

async function scanDownloadsHistory() {
  downloadItems = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 10000 }).catch(() => []);
  return downloadItems.map(parseDownloadArtifact).filter(Boolean);
}

function inferWatchAutomationRootFromHistory(items = downloadItems) {
  for (const item of items) {
    const normalized = normalizePath(item?.filename || '');
    const lower = normalized.toLowerCase();
    const marker = '/watchautomation/';
    const index = lower.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(0, index + '/WatchAutomation'.length);
    if (lower.endsWith('/watchautomation')) return normalized;
  }
  return '';
}

async function watcherHealth() {
  const response = await fetch(`${WATCHER_BASE}/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`watcher_health_http_${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload?.ok || payload.service !== 'watch-extension') throw new Error('watcher_bad_health');
  const apiVersion = Number(payload.apiVersion || 0);
  if (apiVersion < 8) {
    const error = new Error(`watcher_outdated:${apiVersion || 'legacy'}`);
    error.code = 'WATCHER_OUTDATED';
    error.health = payload;
    throw error;
  }
  return payload;
}

async function scanWatcherFolder(rootHint = '') {
  const health = await watcherHealth();
  const query = new URLSearchParams();
  if (rootHint) query.set('root', rootHint);
  const response = await fetch(`${WATCHER_BASE}/output-files${query.size ? `?${query.toString()}` : ''}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`watcher_http_${response.status}`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.files)) throw new Error(payload?.error || 'watcher_bad_response');
  const artifacts = payload.files.map((item) => {
    const relative = normalizePath(item.relativePath || '');
    const parts = relative.split('/').filter(Boolean);
    const groupId = String(item.groupId || (parts.length > 1 ? parts[0] : ''));
    const outputFileName = String(item.outputFileName || parts.at(-1) || '');
    if (groupId === '_archive' || !/\.png$/i.test(outputFileName)) return null;
    return {
      groupId,
      outputFileName,
      artifactMode: 'watcher',
      outputPath: item.path,
      modifiedAt: Number(item.modifiedAt || 0),
      bytes: Number(item.bytes || 0),
      watcherRoot: payload.root || null
    };
  }).filter(Boolean);
  return { artifacts, root: payload.root || null, archivedCount: Number(payload.archivedCount || 0), health };
}

function watcherFileUrl(record) {
  const query = new URLSearchParams({ path: String(record?.outputPath || '') });
  if (record?.outputHash) query.set('expectedHash', String(record.outputHash));
  if (record?.modifiedAt) query.set('v', String(record.modifiedAt));
  return `${WATCHER_BASE}/output-file?${query.toString()}`;
}

async function loadState() {
  const loadSequence = ++galleryLoadSequence;
  $('folderStatus').textContent = 'Читаю каталог и актуальные ревизии…';
  const [stored, revisionRecords, storedCatalog, accountingResponse] = await Promise.all([
    chrome.storage.local.get(['queue', 'outputDestination', ACCOUNTING_SNAPSHOT_STORAGE_KEY]),
    getAllGenerationRevisions().catch(() => []),
    getAllModelCatalog({ includeRemoved: true }).catch(() => []),
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNTING_SNAPSHOT' }).catch(() => null)
  ]);
  const cachedSnapshot = stored[ACCOUNTING_SNAPSHOT_STORAGE_KEY];
  const candidate = accountingSnapshotFromResponse(accountingResponse)
    || (cachedSnapshot ? { ...cachedSnapshot, stale: true, staleReason: cachedSnapshot.staleReason || 'сервис проверки недоступен' } : null);
  accountingSnapshot = acceptAccountingSnapshot(accountingSnapshot, candidate);
  outputDestination = stored.outputDestination || { mode: 'downloads' };
  outputHandle = await getOutputDirectoryHandle().catch(() => null);
  let catalog = storedCatalog;
  let currentRevisionRecords = revisionRecords;
  if (!catalog.length && stored.queue?.groups) {
    catalog = modelCatalogRecordsFromGroups(stored.queue.groups);
    await replaceModelCatalog(catalog);
    [catalog, currentRevisionRecords] = await Promise.all([
      getAllModelCatalog({ includeRemoved: true }).catch(() => catalog),
      getAllGenerationRevisions().catch(() => revisionRecords)
    ]);
  }
  let physicalPngs = 0;
  let archivedPngs = 0;
  let watcherRoot = null;
  let watcherError = null;

  if (outputDestination?.mode === 'custom') {
    const disk = await scanCustomFolder(outputHandle);
    archivedPngs = await countCustomArchivePngs(outputHandle);
    physicalPngs = disk.length;
    await scanDownloadsHistory();
  } else {
    await scanDownloadsHistory();
    const rootHint = inferWatchAutomationRootFromHistory(downloadItems);
    try {
      const scanned = await scanWatcherFolder(rootHint);
      archivedPngs = scanned.archivedCount;
      physicalPngs = scanned.artifacts.length;
      watcherRoot = scanned.root;
    } catch (error) {
      watcherError = error;
      physicalPngs = downloadItems.filter((item) => item?.state === 'complete' && item.exists !== false
        && /\.png$/i.test(String(item.filename || ''))).length;
    }
  }
  if (loadSequence !== galleryLoadSequence) return;
  const accountingView = accountingSnapshot || { version: 1, entries: [], stale: true, staleReason: 'снимок готовности отсутствует' };
  records = galleryRecordsFromCatalog(catalog, currentRevisionRecords, accountingView);

  const customPermission = await permission(outputHandle, 'read');
  const currentCatalogCards = records.filter((record) => !record.outsideCurrentCatalog).length;
  const outsideCatalogCards = records.length - currentCatalogCards;
  const freshness = accountingSnapshotFreshness(accountingView);
  const pieces = [`Готовые модели в каталоге: ${currentCatalogCards}`];
  if (outsideCatalogCards) pieces.push(`вне текущего каталога: ${outsideCatalogCards}`);
  pieces.push(`PNG в папке: ${physicalPngs}`, freshness.label);
  if (archivedPngs > 0) pieces.push(`в архиве: ${archivedPngs}`);
  else pieces.push('в архиве: 0');
  if (outputDestination?.mode === 'downloads') {
    if (watcherRoot && !watcherError) {
      pieces.push(`папка: ${watcherRoot}`);
    } else if (watcherError?.code === 'WATCHER_OUTDATED' || String(watcherError?.message || '').startsWith('watcher_outdated:')) {
      pieces.push('watcher устарел · перезапусти START_AUTOGENERATION после установки патча');
    } else {
      pieces.push(`watcher недоступен${watcherError?.message ? ` (${watcherError.message})` : ''} · список карточек остаётся из сохранённых ревизий`);
    }
  } else if (outputHandle && customPermission === 'granted') {
    pieces.push(`папка: ${outputHandle.name}`);
  } else {
    pieces.push('нет доступа к выбранной папке — восстанови разрешение в основном расширении');
  }
  $('diskCount').textContent = String(physicalPngs + archivedPngs);
  $('folderStatus').textContent = pieces.join(' · ');
  const fileStatus = $('folderStatus').closest('details');
  if (fileStatus && (watcherError || (outputDestination?.mode === 'custom' && customPermission !== 'granted'))) fileStatus.open = true;
  populateBrands();
  applyFilters();
}

function populateBrands() {
  const select = $('brandFilter');
  const current = select.value || 'all';
  const ids = [...new Set(records.map(brandId).filter((id) => id && id !== 'all'))]
    .sort((a, b) => (brandLabelById.get(a) || a).localeCompare(brandLabelById.get(b) || b, 'ru'));
  select.innerHTML = '<option value="all">Все бренды</option>' + ids
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(brandLabelById.get(id) || id)}</option>`).join('');
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function applyFilters() {
  const query = $('search').value.trim().toLowerCase();
  const brand = $('brandFilter').value;
  const sale = $('saleFilter').value;
  const quality = $('qualityFilter').value;
  const factsFilter = $('factsFilter')?.value || 'all';
  const activeFilters = [sale, quality, factsFilter].filter((value) => value !== 'all').length;
  $('activeFilterCount').textContent = String(activeFilters);
  $('activeFilterCount').hidden = activeFilters === 0;
  filtered = records.filter((record) => {
    const haystack = `${record.modelName || ''} ${record.fileName || ''} ${record.outputFileName || ''} ${record.facts?.utp1 || ''} ${record.facts?.utp2 || ''} ${record.facts?.waterResistance || ''} ${record.facts?.caseSize || ''}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (brand !== 'all' && brandId(record) !== brand) return false;
    if (sale !== 'all' && groupSale(record.groupId) !== sale) return false;
    if (quality !== 'all' && groupQuality(record.groupId) !== quality) return false;
    const factsState = factsDisplayState(record);
    const warnings = factsState.warnings;
    if (factsFilter === 'missing' && factsState.kind !== 'missing') return false;
    if (factsFilter === 'warnings' && factsState.kind !== 'warning') return false;
    if (factsFilter === 'error' && factsState.kind !== 'error') return false;
    if (factsFilter === 'missing_series' && !warnings.includes('MISSING_SERIES') && !warnings.includes('TITLE_SERIES_MISMATCH')) return false;
    if (factsFilter === 'missing_utp' && !warnings.some((item) => item === 'MISSING_UTP_1' || item === 'MISSING_UTP_2')) return false;
    if (factsFilter === 'missing_water' && !warnings.includes('MISSING_WATER_RESISTANCE')) return false;
    if (factsFilter === 'missing_size' && !warnings.includes('MISSING_CASE_SIZE')) return false;
    return true;
  });
  const sortOrder = $('sortOrder')?.value || 'date_desc';
  filtered = sortGalleryRecords(filtered, sortOrder, (record) => recordMeta(record).brand);
  shown = PAGE_SIZE;
  render();
}

function recordMeta(record) {
  return {
    brand: brandLabelById.get(brandId(record)) || brandId(record) || '—',
    sale: groupSale(record.groupId) === 'in_sale' ? 'В продаже' : 'Не в продаже',
    quality: groupQuality(record.groupId) === 'bad' ? 'плохой исходник' : 'хороший исходник'
  };
}

function render() {
  const grid = $('grid');
  const page = filtered.slice(0, shown);
  $('visibleCount').textContent = String(filtered.length);
  $('totalCount').textContent = String(records.length);
  const currentCatalogCount = records.filter((record) => !record.outsideCurrentCatalog).length;
  const outsideCatalogCount = records.length - currentCatalogCount;
  const scopeHint = $('catalogCountHint');
  if (scopeHint) scopeHint.textContent = outsideCatalogCount
    ? `· ${currentCatalogCount} в текущем каталоге · ${outsideCatalogCount} вне каталога`
    : '';
  $('emptyState').hidden = filtered.length !== 0;
  $('loadMore').hidden = shown >= filtered.length;
  grid.innerHTML = page.map((record) => {
    const meta = recordMeta(record);
    const factsState = factsDisplayState(record);
    const warnings = factsState.warnings;
    const factsChip = factsState.kind === 'ok'
      ? '<span class="chip good">Текст ✓</span>'
      : factsState.kind === 'warning'
        ? `<span class="chip warning" title="Замечания к тексту карточки">⚠ ${warnings.length}</span>`
        : factsState.kind === 'error'
          ? '<span class="chip error">ошибка</span>'
          : factsState.kind === 'pending'
            ? '<span class="chip muted">обработка…</span>'
            : '<span class="chip muted">нет данных</span>';
    return `<article class="card" data-source-id="${escapeHtml(record.sourceId)}">
      <div class="thumb" data-open="1" role="button" tabindex="0" aria-label="Открыть ${escapeHtml(record.modelName || record.fileName || 'карточку')}">
        <div class="thumb-placeholder">Загрузка превью…</div>
        <img alt="${escapeHtml(record.modelName || record.fileName || '')}" loading="lazy">
        <div class="thumb-badges"><span class="chip">${escapeHtml(meta.brand)}</span>${record.versionCount > 1 ? `<span class="chip">версий ${record.versionCount}</span>` : ''}${factsChip}</div>
      </div>
      <div class="card-body" data-open="1">
        <div class="card-title">${escapeHtml(record.modelName || record.fileName || 'Без названия')}</div>
        <div class="card-meta"><span>${escapeHtml(meta.sale)}</span><span>${escapeHtml(formatDate(record.generatedAt))}</span></div>
        ${factsState.hasContent ? `<div class="card-facts">${escapeHtml(record.facts?.utp1 || '—')} · ${escapeHtml(record.facts?.waterResistance || '—')} · ${escapeHtml(record.facts?.caseSize || '—')}</div>` : ''}
      </div>
      <div class="card-actions"><button class="button reject" type="button" data-action="reject">В брак и перегенерацию</button></div>
    </article>`;
  }).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    const sourceId = card.dataset.sourceId;
    const record = records.find((item) => item.sourceId === sourceId);
    card.querySelectorAll('[data-open="1"]').forEach((node) => node.addEventListener('click', () => openViewerBySource(sourceId)));
    card.querySelector('.thumb').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openViewerBySource(sourceId);
    });
    card.querySelector('[data-action="reject"]')?.addEventListener('click', (event) => { event.stopPropagation(); reject(record).catch(showError); });
    queueThumbnail(record, card.querySelector('img'), card.querySelector('.thumb-placeholder'));
  });
}

async function fileForRecord(record) {
  if (record?.fileHandle) {
    try { return await record.fileHandle.getFile(); } catch (_) {}
  }
  if (!outputHandle || record?.artifactMode !== 'custom') return null;
  const p = await permission(outputHandle, 'read');
  if (p !== 'granted') return null;
  try {
    const expectedPath = `custom://${outputHandle.name}/${sanitizeFilename(record.groupId)}/${sanitizeFilename(record.outputFileName)}`;
    if (lowerPath(expectedPath) !== lowerPath(record.outputPath)) return null;
    const group = await outputHandle.getDirectoryHandle(sanitizeFilename(record.groupId), { create: false });
    const handle = await group.getFileHandle(record.outputFileName, { create: false });
    return await handle.getFile();
  } catch (_) { return null; }
}

async function sourceForRecord(record, { thumbnail = false } = {}) {
  if (record?.outputPath && !String(record.outputPath).startsWith('custom://')) {
    if (!/^[a-f0-9]{64}$/i.test(String(record.outputHash || ''))) return { url: null, revoke: false, mode: 'unverified' };
    return { url: watcherFileUrl(record), revoke: false, mode: 'watcher' };
  }
  const file = await fileForRecord(record);
  if (file) {
    if (record?.outputHash) {
      const actualHash = await sha256Blob(file);
      if (actualHash !== String(record.outputHash).toLowerCase()) return { url: null, revoke: false, mode: 'hash-mismatch' };
    }
    if (!thumbnail) return { url: URL.createObjectURL(file), revoke: true, file, mode: 'file' };
    try {
      const bitmap = await createImageBitmap(file);
      const max = 520;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .84));
      if (blob) return { url: URL.createObjectURL(blob), revoke: true, mode: 'thumb' };
    } catch (_) {}
    return { url: URL.createObjectURL(file), revoke: true, file, mode: 'file' };
  }

  return { url: null, revoke: false, mode: 'missing' };
}

async function sha256Blob(blob) {
  if (!blob || !crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function revealImage(img, placeholder) {
  img.classList.add('is-loaded');
  if (placeholder) placeholder.hidden = true;
}

async function queueThumbnail(record, img, placeholder) {
  if (!record || !img) return;
  const cacheKey = thumbnailCacheKey(record);
  const applySource = (url) => {
    if (!url) return false;
    img.onload = () => revealImage(img, placeholder);
    img.onerror = () => { if (placeholder) placeholder.textContent = 'PNG отсутствует или изменён · другая версия не подставляется'; };
    img.src = url;
    if (img.complete && img.naturalWidth > 0) revealImage(img, placeholder);
    return true;
  };

  const cached = thumbUrls.get(cacheKey);
  if (cached) {
    applySource(cached);
    return;
  }

  const pending = loadingThumbs.get(cacheKey);
  if (pending) {
    await pending.catch(() => null);
    if (!applySource(thumbUrls.get(cacheKey)) && placeholder) placeholder.textContent = 'Файл найден · превью недоступно';
    return;
  }

  const task = (async () => {
    const source = await sourceForRecord(record, { thumbnail: true });
    if (!source.url) {
      if (placeholder) placeholder.textContent = source.mode === 'hash-mismatch'
        ? 'SHA-256 файла изменился · подстановка отменена'
        : source.mode === 'unverified'
          ? 'У ревизии нет проверенного SHA-256'
          : 'Точный PNG ревизии отсутствует';
      return null;
    }
    // Cache both blob thumbnails and watcher/download URLs. Re-rendering the
    // grid while an image is still loading must attach the new <img> to the
    // same resolved source instead of leaving it on “Загрузка превью…”.
    thumbUrls.set(cacheKey, source.url);
    return source.url;
  })().finally(() => loadingThumbs.delete(cacheKey));
  loadingThumbs.set(cacheKey, task);
  const url = await task.catch(() => null);
  if (!applySource(url) && placeholder) placeholder.textContent = 'Файл найден · превью недоступно';
}

function clearThumbCache() {
  for (const url of thumbUrls.values()) if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
  thumbUrls.clear();
  loadingThumbs.clear();
}

async function reject(record) {
  if (!record) return;
  if (!$('fastReject').checked) {
    const ok = window.confirm(`Переместить это изображение в архив, убрать его спецификацию и добавить модель в отдельную очередь перегенерации брака?\n\n${record.modelName || record.fileName || ''}`);
    if (!ok) return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'REVIEW_GENERATION',
    sourceId: record.sourceId,
    decision: 'reject',
    artifact: {
      generationId: record.generationId || null,
      groupId: record.groupId,
      outputFileName: record.outputFileName,
      outputPath: record.outputPath,
      outputHash: record.outputHash || null,
      downloadId: record.downloadId ?? null,
      artifactMode: record.artifactMode || null,
      modifiedAt: Number(record.modifiedAt || 0) || null,
      bytes: Number(record.bytes || 0) || null
    }
  });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось отправить результат на перегенерацию');

  for (const [key, thumb] of [...thumbUrls.entries()]) {
    if (!key.startsWith(`${String(record.sourceId || '')}|`)) continue;
    if (thumb?.startsWith('blob:')) URL.revokeObjectURL(thumb);
    thumbUrls.delete(key);
    loadingThumbs.delete(key);
  }
  const removedIndex = filtered.findIndex((item) => item.sourceId === record.sourceId);
  records = records.filter((item) => !(item.groupId === record.groupId && item.outputFileName === record.outputFileName));
  applyFilters();
  const archiveWarning = response.value?.archiveWarning;
  showToast(archiveWarning
    ? `Модель добавлена в очередь перегенерации брака. PNG не перемещён в архив: ${archiveWarning}`
    : 'PNG и спецификация этой ревизии убраны из актуальных результатов. Модель добавлена в очередь перегенерации брака.',
  archiveWarning ? 'error' : '');
  if ($('viewer').open) {
    if (!filtered.length) closeViewer();
    else {
      viewerIndex = Math.min(Math.max(0, removedIndex), filtered.length - 1);
      await renderViewer();
    }
  }
}

function openViewerBySource(sourceId) {
  viewerIndex = filtered.findIndex((item) => item.sourceId === sourceId);
  if (viewerIndex < 0) return;
  $('viewer').showModal();
  renderViewer().catch(showError);
}
function closeViewer() {
  if (viewerObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = null;
  $('viewerImage').src = '';
  $('viewer').close();
}
function setZoom(value) {
  zoom = Math.min(3, Math.max(.5, value));
  $('viewerImage').style.transform = `scale(${zoom})`;
  $('zoomValue').textContent = `${Math.round(zoom * 100)}%`;
}

function warningLabel(code) {
  const labels = {
    MISSING_UTP_1: 'Нет первого УТП',
    MISSING_UTP_2: 'Нет второго УТП',
    MISSING_WATER_RESISTANCE: 'Не найдена водозащита',
    MISSING_CASE_SIZE: 'Не найден размер корпуса',
    MISSING_SERIES: 'Не найдена обязательная серия',
    TITLE_SERIES_MISMATCH: 'Серия на карточке не совпадает',
    TITLE_BRAND_MISMATCH: 'Бренд в заголовке не совпадает',
    TITLE_MODEL_MISMATCH: 'Код модели в заголовке не совпадает',
    MISSING_TITLE_BRAND: 'Не найден бренд в заголовке',
    MISSING_TITLE_MODEL: 'Не найден код модели в заголовке',
    UNCERTAIN_TEXT: 'Есть неуверенно прочитанные поля',
    FACTS_INCOMPLETE_RESPONSE: 'Ответ постпроверки оборвался до полного JSON',
    FACTS_PARSE_ERROR: 'Ответ постпроверки не удалось разобрать',
    EMPTY_FACTS: 'Постпроверка не содержит распознанного текста'
  };
  return labels[code] || code;
}

function renderFactsPanel(record) {
  const panel = $('viewerFacts');
  if (!panel) return;
  const facts = record?.facts || null;
  if (!facts) {
    const status = record?.factsStatus || 'не извлечено';
    panel.innerHTML = `<div class="facts-empty"><strong>Текст не извлечён</strong><span>Статус: ${escapeHtml(status)}</span>${record?.factsError ? `<span>${escapeHtml(record.factsError)}</span>` : ''}</div>`;
    return;
  }
  const factsState = factsDisplayState(record);
  if (factsState.kind === 'error' && !factsState.hasContent) {
    panel.innerHTML = `<div class="facts-empty"><strong>Ошибка извлечения текста</strong><span>${escapeHtml(record?.factsError || facts?.error || 'Постпроверка завершилась ошибкой')}</span></div>`;
    return;
  }
  if (!factsState.hasContent) {
    panel.innerHTML = `<div class="facts-empty"><strong>Текст не извлечён</strong><span>Запись постпроверки есть, но распознанные поля пустые.</span></div>`;
    return;
  }
  const modelName = record?.modelName || record?.fileName || '';
  const warnings = effectiveFactsWarnings(facts, modelName);
  const seriesRow = factsSeriesPolicy(facts, modelName) === 'forbidden'
    ? '' : `<div><dt>Серия</dt><dd>${escapeHtml(facts.titleSeries || '—')}</dd></div>`;
  panel.innerHTML = `
    <div class="facts-title">Спецификация</div>
    <dl class="facts-grid">
      <div><dt>Бренд</dt><dd>${escapeHtml(displayFactsTitleBrand(facts, modelName) || '—')}</dd></div>
      ${seriesRow}
      <div><dt>Модель</dt><dd>${escapeHtml(facts.titleModel || '—')}</dd></div>
      <div><dt>УТП 1</dt><dd>${escapeHtml(facts.utp1 || '—')}</dd></div>
      <div><dt>УТП 2</dt><dd>${escapeHtml(facts.utp2 || '—')}</dd></div>
      <div><dt>Водозащита</dt><dd>${escapeHtml(facts.waterResistance || '—')}</dd></div>
      <div><dt>Размер корпуса</dt><dd>${escapeHtml(facts.caseSize || '—')}</dd></div>
    </dl>
    <div class="facts-warnings ${warnings.length ? 'has-warnings' : ''}">
      ${warnings.length
        ? warnings.map((code) => `<div>⚠ ${escapeHtml(warningLabel(code))}</div>`).join('')
        : '<div>Автоматических замечаний нет</div>'}
    </div>`;
}

async function renderViewer() {
  if (viewerIndex < 0 || viewerIndex >= filtered.length) return;
  const record = filtered[viewerIndex];
  const meta = recordMeta(record);
  $('viewerTitle').textContent = record.modelName || record.fileName || 'Без названия';
  $('viewerMeta').textContent = `${meta.brand} · ${meta.sale} · ${meta.quality} · ${formatDate(record.generatedAt)}`;
  $('viewerCounter').textContent = `${viewerIndex + 1} / ${filtered.length}`;
  const chatUrl = /^https:\/\/chatgpt\.com\/c\/[^/?#]+/.test(String(record.chatUrl || '')) ? String(record.chatUrl) : '';
  $('viewerOpenChat').hidden = !chatUrl;
  $('viewerOpenChat').disabled = !chatUrl;
  renderFactsPanel(record);
  $('viewerPrev').disabled = viewerIndex <= 0;
  $('viewerNext').disabled = viewerIndex >= filtered.length - 1;
  $('viewerPlaceholder').hidden = false;
  $('viewerPlaceholder').textContent = 'Загрузка изображения…';
  const image = $('viewerImage');
  image.classList.remove('is-loaded');
  image.src = '';
  if (viewerObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = null;
  setZoom(1);
  const source = await sourceForRecord(record, { thumbnail: false });
  if (!source.url) {
    $('viewerPlaceholder').textContent = source.mode === 'hash-mismatch'
      ? 'Содержимое PNG отличается от сохранённого SHA-256. Другая версия файла не подставлена.'
      : source.mode === 'unverified'
        ? 'У ревизии отсутствует SHA-256. Файл не показывается как подтверждённый.'
        : 'Точный PNG этой ревизии отсутствует или недоступен.';
    return;
  }
  viewerObjectUrl = source.revoke ? source.url : null;
  image.onload = () => {
    $('viewerPlaceholder').hidden = true;
    image.classList.add('is-loaded');
  };
  image.onerror = () => { $('viewerPlaceholder').textContent = 'Не удалось открыть изображение'; };
  image.alt = record.modelName || record.fileName || '';
  image.src = source.url;
  if (image.complete && image.naturalWidth > 0) {
    $('viewerPlaceholder').hidden = true;
    image.classList.add('is-loaded');
  }
}
function viewerMove(delta) {
  const next = viewerIndex + delta;
  if (next < 0 || next >= filtered.length) return;
  viewerIndex = next;
  renderViewer().catch(showError);
}

function openCurrentChat() {
  const record = filtered[viewerIndex];
  const url = String(record?.chatUrl || '');
  if (!/^https:\/\/chatgpt\.com\/c\/[^/?#]+/.test(url)) throw new Error('Ссылка на чат для этой генерации не сохранена');
  const opened = window.open(url, '_blank');
  if (!opened) throw new Error('Chrome заблокировал открытие новой вкладки');
  try { opened.opener = null; } catch (_) {}
}

async function openCurrentFile() {
  const record = filtered[viewerIndex];
  if (!record) return;
  if (record.artifactMode === 'watcher' && record.outputPath) {
    const opened = window.open(watcherFileUrl(record), '_blank');
    if (!opened) throw new Error('Chrome заблокировал открытие новой вкладки');
    try { opened.opener = null; } catch (_) {}
    return;
  }
  const file = await fileForRecord(record);
  if (!file) throw new Error('Не удалось получить локальный PNG');
  const url = URL.createObjectURL(file);
  const opened = window.open(url, '_blank');
  if (!opened) {
    URL.revokeObjectURL(url);
    throw new Error('Chrome заблокировал открытие новой вкладки');
  }
  try { opened.opener = null; } catch (_) {}
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}


function exportFactsRows() {
  return records.map((record) => {
    const f = record.facts || {};
    const modelName = record.modelName || record.fileName || '';
    return {
      modelName,
      brand: recordMeta(record).brand,
      sale: recordMeta(record).sale,
      sourceQuality: recordMeta(record).quality,
      titleBrand: displayFactsTitleBrand(f, modelName),
      titleSeries: factsSeriesPolicy(f, modelName) === 'forbidden' ? '' : (f.titleSeries || ''),
      titleModel: f.titleModel || '',
      utp1: f.utp1 || '',
      utp2: f.utp2 || '',
      waterResistance: f.waterResistance || '',
      waterResistanceValue: f.waterResistanceValue ?? '',
      waterResistanceUnit: f.waterResistanceUnit || '',
      caseSize: f.caseSize || '',
      caseSizeValueMm: f.caseSizeValueMm ?? '',
      warnings: effectiveFactsWarnings(f, modelName).join('|'),
      factsStatus: record.factsStatus || f.status || 'missing',
      chatUrl: record.chatUrl || f.chatUrl || '',
      outputFileName: record.outputFileName || '',
      generatedAt: record.generatedAt || ''
    };
  });
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function exportFactsJson() {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    count: records.length,
    items: exportFactsRows()
  };
  downloadBlob(`watch-generation-facts-${new Date().toISOString().slice(0,10)}.json`,
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
}

function csvCell(value) {
  const text = String(value ?? '').replaceAll('"', '""');
  return `"${text}"`;
}

function exportFactsCsv() {
  const rows = exportFactsRows();
  const headers = Object.keys(rows[0] || {
    modelName:'', brand:'', sale:'', sourceQuality:'', titleBrand:'', titleSeries:'', titleModel:'',
    utp1:'', utp2:'', waterResistance:'', waterResistanceValue:'', waterResistanceUnit:'',
    caseSize:'', caseSizeValueMm:'', warnings:'', factsStatus:'', chatUrl:'', outputFileName:'', generatedAt:''
  });
  const csv = '\ufeff' + [headers.join(';'), ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(';'))].join('\r\n');
  downloadBlob(`watch-generation-facts-${new Date().toISOString().slice(0,10)}.csv`,
    new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

$('refreshGallery').addEventListener('click', () => {
  clearThumbCache();
  loadState().catch(showError);
});
$('exportFactsCsv')?.addEventListener('click', exportFactsCsv);
$('exportFactsJson')?.addEventListener('click', exportFactsJson);
initResultsTransfer({ reload: () => { clearThumbCache(); return loadState(); } });
if (location.hash === '#transfer') $('resultsTransferOpen').click();
$('search').addEventListener('input', applyFilters);
['brandFilter', 'saleFilter', 'qualityFilter', 'factsFilter', 'sortOrder'].forEach((id) => $(id)?.addEventListener('change', applyFilters));
$('loadMore').addEventListener('click', () => { shown += PAGE_SIZE; render(); });
$('viewerClose').addEventListener('click', closeViewer);
$('viewerPrev').addEventListener('click', () => viewerMove(-1));
$('viewerNext').addEventListener('click', () => viewerMove(1));
$('viewerReject').addEventListener('click', () => reject(filtered[viewerIndex]).catch(showError));
$('viewerOpenFile').addEventListener('click', () => openCurrentFile().catch(showError));
$('viewerOpenChat').addEventListener('click', () => { try { openCurrentChat(); } catch (error) { showError(error); } });
$('zoomOut').addEventListener('click', () => setZoom(zoom - .25));
$('zoomIn').addEventListener('click', () => setZoom(zoom + .25));
$('zoomReset').addEventListener('click', () => setZoom(1));
$('viewerImage').addEventListener('dblclick', () => setZoom(zoom > 1 ? 1 : 1.75));
$('viewerStage').addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setZoom(zoom + (event.deltaY < 0 ? .15 : -.15));
}, { passive: false });
$('viewer').addEventListener('click', (event) => { if (event.target === $('viewer')) closeViewer(); });
window.addEventListener('keydown', (event) => {
  if (!$('viewer').open) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); viewerMove(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); viewerMove(1); }
  if (event.key === 'Escape') closeViewer();
  if (event.key.toLowerCase() === 'b' || event.key === 'Delete') reject(filtered[viewerIndex]).catch(showError);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.generationMemory && !changes.queue && !changes.outputDestination && !changes[ACCOUNTING_SNAPSHOT_STORAGE_KEY])) return;
  loadState().catch(showError);
});
window.addEventListener('beforeunload', () => {
  clearThumbCache();
  if (viewerObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerObjectUrl);
});

loadState().catch(showError);
