import { skuKeyForModelName } from './sku-utils.js';

export const QUEUE_GROUPS = Object.freeze({
  in_sale_good: { label: 'В продаже · хорошее качество', folder: 'in_sale' },
  in_sale_bad: { label: 'В продаже · плохое качество', folder: 'in_sale/bad_resolution' },
  not_in_sale_good: { label: 'Не в продаже · хорошее качество', folder: 'not_in_sale' },
  not_in_sale_bad: { label: 'Не в продаже · плохое качество', folder: 'not_in_sale/bad_resolution' }
});

export const QUEUE_GROUP_IDS = Object.freeze(Object.keys(QUEUE_GROUPS));
export const REGENERATION_QUEUE_ID = 'regeneration';
export const RUN_PART_SIZE = 100;
export const IMAGE_EXTENSIONS = Object.freeze(new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']));

// Persistent generation memory is intentionally separate from the transient
// queue status. The queue is rebuilt when a folder is rescanned, while this
// registry keeps the user's decision for every model across rescans and
// extension updates.
export const GENERATION_MEMORY_STATUSES = Object.freeze({
  NOT_READY: 'not_ready',
  RUNNING: 'running',
  IMAGE_SAVED: 'image_saved',
  FACTS_PENDING: 'facts_pending',
  READY: 'ready'
});

export const GENERATION_MEMORY_STATUS_LABELS = Object.freeze({
  not_ready: 'Не готово',
  running: 'Запущена генерация',
  image_saved: 'Фото сохранено · ждёт спецификацию',
  facts_pending: 'Получение спецификации',
  ready: 'Готово'
});

export const SALE_STATUS_FILTERS = Object.freeze({
  all: { label: 'Все статусы' },
  in_sale: { label: 'В продаже' },
  not_in_sale: { label: 'Не в продаже' }
});

export const QUALITY_FILTERS = Object.freeze({
  all: { label: 'Любое качество' },
  good: { label: 'Хорошее качество' },
  bad: { label: 'Плохое качество' }
});

// These ids intentionally match prompt-profiles.js. Keeping the small list in
// the queue layer lets the service worker filter files without importing the
// prompt profile module and creating a circular dependency.
export const WATCH_BRAND_FILTERS = Object.freeze([
  { id: 'all', label: 'Все бренды' },
  { id: 'armani_exchange', label: 'Armani Exchange' },
  { id: 'benyar', label: 'Benyar' },
  { id: 'casio', label: 'Casio' },
  { id: 'certina', label: 'Certina' },
  { id: 'citizen', label: 'Citizen' },
  { id: 'diesel', label: 'Diesel' },
  { id: 'longines', label: 'Longines' },
  { id: 'orient', label: 'Orient' },
  { id: 'pagani_design', label: 'Pagani Design' },
  { id: 'q_and_q', label: 'Q&Q' },
  { id: 'seiko', label: 'Seiko' },
  { id: 'tissot', label: 'Tissot' },
  { id: 'generic', label: 'Другие / не распознано' }
]);

const REFERENCE_NAMES = Object.freeze({
  '1. base.png': 'template',
  '2. base n ozon.png': 'ozonMap',
  '2. ozon blind zones.png': 'ozonMap',
  '2. ozon blind zones 2.png': 'ozonMap',
  '3. logo black.png': 'storeLogo'
});

const BRAND_FOLDER_ALIASES = Object.freeze({
  casio: 'casio',
  orient: 'orient',
  tissot: 'tissot',
  benyar: 'benyar',
  'pagani design': 'pagani_design',
  pagani_design: 'pagani_design',
  'q&q': 'q_and_q',
  'q & q': 'q_and_q',
  q_and_q: 'q_and_q',
  seiko: 'seiko',
  citizen: 'citizen',
  longines: 'longines',
  diesel: 'diesel',
  'armani exchange': 'armani_exchange',
  armani_exchange: 'armani_exchange',
  certina: 'certina'
});

export function normalizeRelativePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function isImageFileName(name) {
  const value = String(name || '').toLowerCase();
  return [...IMAGE_EXTENSIONS].some((extension) => value.endsWith(extension));
}

export function normalizeBrandFolderId(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (BRAND_FOLDER_ALIASES[normalized]) return BRAND_FOLDER_ALIASES[normalized];
  return normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '') || 'generic';
}

export function referenceDescriptorForPath(relativePath) {
  const parts = normalizeRelativePath(relativePath).split('/').filter(Boolean);
  const rootIndex = parts.findIndex((part) => part.toLowerCase() === 'input-ref-images');
  if (rootIndex < 0) return null;
  const brandParts = parts
    .slice(rootIndex + 1, -1)
    .filter((part) => !['brands', 'common'].includes(String(part).toLowerCase()));
  const fileName = String(parts.at(-1) || '');
  // Brand base images are often named after the brand (for example
  // `brands/Benyar/1. Benyar.png`) when they are prepared manually. Treat
  // that stable first-image convention as the same template key as
  // `brands/Benyar/1. Base.png`.
  let key = REFERENCE_NAMES[fileName.toLowerCase()];
  if (!key && brandParts.length && /^1\.\s*.+\.(?:png|jpe?g|webp)$/i.test(fileName)) {
    key = 'template';
  }
  if (!key) return null;
  if (key === 'storeLogo') {
    return brandParts.length ? null : { key, brandId: null, storageKey: key };
  }
  const brandId = brandParts.length ? normalizeBrandFolderId(brandParts.join(' ')) : null;
  return { key, brandId, storageKey: brandId ? `${key}:${brandId}` : key };
}

export function referenceKeyForPath(relativePath) {
  return referenceDescriptorForPath(relativePath)?.key || null;
}

export function referenceStorageKeyForPath(relativePath) {
  return referenceDescriptorForPath(relativePath)?.storageKey || null;
}

export function classifyWatchPath(relativePath) {
  const parts = normalizeRelativePath(relativePath).split('/').filter(Boolean);
  const rootIndex = parts.findIndex((part) => part.toLowerCase() === 'input-watches-images');
  // A directory input reports paths relative to the folder the user picked.
  // When the user picks `in_sale` itself, the `input-watches-images` marker is
  // absent; the sale segment is still enough to classify the image safely.
  const saleIndex = rootIndex >= 0
    ? rootIndex + 1
    : parts.findIndex((part) => ['in_sale', 'not_in_sale'].includes(String(part).toLowerCase()));
  if (saleIndex < 0) return null;
  const salePart = String(parts[saleIndex] || '').toLowerCase();
  if (salePart !== 'in_sale' && salePart !== 'not_in_sale') return null;
  const isBad = parts.slice(saleIndex + 1, -1).some((part) => part.toLowerCase() === 'bad_resolution');
  return `${salePart}_${isBad ? 'bad' : 'good'}`;
}

function normalizeBrandSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('с', 'c')
    .replaceAll('а', 'a')
    .replaceAll('е', 'e')
    .replaceAll('о', 'o')
    .replaceAll('р', 'p')
    .replaceAll('х', 'x')
    .replaceAll('у', 'y')
    .replace(/\s+/g, ' ')
    .trim();
}

export function brandIdFromModelName(modelName) {
  const value = normalizeBrandSearchText(modelName);
  if (/\barmani\s+exchange\b/.test(value)) return 'armani_exchange';
  if (/\bpagani\s+design\b/.test(value)) return 'pagani_design';
  if (/\bbenyar\b/.test(value)) return 'benyar';
  if (/\bcasio\b/.test(value)) return 'casio';
  if (/\borient\b/.test(value)) return 'orient';
  if (/\btissot\b/.test(value)) return 'tissot';
  if (/\bq\s*&\s*q\b|\bq\s*n\s*q\b/.test(value)) return 'q_and_q';
  if (/\bseiko\b/.test(value)) return 'seiko';
  if (/\bcitizen\b/.test(value)) return 'citizen';
  if (/\blongines\b/.test(value)) return 'longines';
  if (/\bdiesel\b/.test(value)) return 'diesel';
  if (/\bcertina\b/.test(value)) return 'certina';
  return 'generic';
}

export function normalizeSaleStatusFilter(value) {
  const normalized = String(value || '').trim();
  return Object.hasOwn(SALE_STATUS_FILTERS, normalized) ? normalized : 'all';
}

export function normalizeQualityFilter(value) {
  const normalized = String(value || '').trim();
  return Object.hasOwn(QUALITY_FILTERS, normalized) ? normalized : 'all';
}

export function normalizeBrandFilter(value) {
  const normalized = String(value || '').trim();
  return WATCH_BRAND_FILTERS.some((item) => item.id === normalized) ? normalized : 'all';
}

export function normalizeCoverageMode(value) {
  return String(value || '').trim() === 'one_per_brand' ? 'one_per_brand' : 'queue';
}

export function normalizeGenerationMemoryStatus(value, fallback = GENERATION_MEMORY_STATUSES.NOT_READY) {
  const normalized = String(value || '').trim();
  return Object.hasOwn(GENERATION_MEMORY_STATUS_LABELS, normalized)
    ? normalized
    : fallback;
}

export function queueStatusForGenerationMemoryStatus(value) {
  const status = normalizeGenerationMemoryStatus(value);
  if ([GENERATION_MEMORY_STATUSES.READY, GENERATION_MEMORY_STATUSES.IMAGE_SAVED,
    GENERATION_MEMORY_STATUSES.FACTS_PENDING].includes(status)) return 'done';
  if (status === GENERATION_MEMORY_STATUSES.RUNNING) return 'running';
  return 'pending';
}

export function normalizeQueueStatus(value, fallback = 'pending') {
  const status = String(value || '').trim();
  return ['pending', 'running', 'done', 'error', 'failed'].includes(status)
    ? status
    : queueStatusForGenerationMemoryStatus(status || fallback);
}

function queueEntryIdentity(entry = {}) {
  const relativePath = normalizeRelativePath(entry.relativePath || '');
  return {
    sourceVariantId: String(entry.inputSourceId || entry.sourceVariantId || entry.variantId
      || (relativePath && entry.groupId ? sourceVariantIdFor(entry.groupId, relativePath) : '')),
    relativePath,
    fingerprint: String(entry.fingerprint || ''),
    sourceHash: String(entry.sourceHash || '').toLowerCase()
  };
}

export function generationMemoryMatchesQueueEntry(record, entry) {
  if (!record || !entry) return false;
  const memoryIdentity = queueEntryIdentity(record);
  const entryIdentity = queueEntryIdentity(entry);
  if (memoryIdentity.sourceVariantId && entryIdentity.sourceVariantId
    && memoryIdentity.sourceVariantId !== entryIdentity.sourceVariantId) return false;
  if (memoryIdentity.relativePath && entryIdentity.relativePath
    && memoryIdentity.relativePath !== entryIdentity.relativePath) return false;
  if (memoryIdentity.fingerprint && entryIdentity.fingerprint
    && memoryIdentity.fingerprint !== entryIdentity.fingerprint) return false;
  if (memoryIdentity.sourceHash && entryIdentity.sourceHash
    && memoryIdentity.sourceHash !== entryIdentity.sourceHash) return false;
  return true;
}

// Identify the source asset independently from its bytes. This lets memory
// detect a changed file at the same path and invalidate the old result.
export function generationMemoryMatchesQueueAsset(record, entry) {
  if (!record || !entry) return false;
  const memoryIdentity = queueEntryIdentity(record);
  const entryIdentity = queueEntryIdentity(entry);
  if (memoryIdentity.sourceVariantId && entryIdentity.sourceVariantId
    && memoryIdentity.sourceVariantId !== entryIdentity.sourceVariantId) return false;
  if (memoryIdentity.relativePath && entryIdentity.relativePath
    && memoryIdentity.relativePath !== entryIdentity.relativePath) return false;
  const memoryGroup = String(record.groupId || '');
  const entryGroup = String(entry.groupId || '');
  if (memoryGroup && entryGroup && memoryGroup !== entryGroup) return false;
  const memoryFile = String(record.fileName || '').toLowerCase();
  const entryFile = String(entry.fileName || '').toLowerCase();
  if (!memoryIdentity.relativePath && memoryFile && entryFile && memoryFile !== entryFile) return false;
  return true;
}

function generationMemoryFields(record = {}) {
  const status = normalizeGenerationMemoryStatus(record.status);
  return {
    status: queueStatusForGenerationMemoryStatus(status),
    generationId: record.generationId || null,
    previousGenerationId: record.previousGenerationId || null,
    generatedAt: record.generatedAt || null,
    outputPath: record.outputPath || null,
    outputHash: record.outputHash || null,
    outputWidth: record.outputWidth || null,
    outputHeight: record.outputHeight || null,
    verificationMode: record.verificationMode || null,
    recipeHash: record.recipeHash || null,
    profileId: record.profileId || null,
    profileVersion: record.profileVersion || null,
    attempt: Number(record.attempt || 0),
    errorClass: record.errorClass || null,
    nextRetryAt: record.nextRetryAt || null,
    retryCount: Number(record.retryCount || 0),
    lastError: status === GENERATION_MEMORY_STATUSES.READY ? null : (record.lastError || null),
    lastRunId: record.lastRunId || null
  };
}

function isQueueEntryCompleted(entry) {
  return normalizeQueueStatus(entry?.status) === 'done';
}

function clearUnfinishedQueueEntry(entry) {
  if (!entry || isQueueEntryCompleted(entry)) return false;
  const resetState = {
    status: 'pending',
    generationId: null,
    generationStartedAt: null,
    generatedAt: null,
    outputPath: null,
    outputHash: null,
    outputWidth: null,
    outputHeight: null,
    verificationMode: null,
    chatUrl: null,
    attempt: 0,
    retryCount: 0,
    lastError: null,
    errorClass: null,
    nextRetryAt: null,
    lastRunId: null
  };
  const changed = Object.entries(resetState).some(([key, value]) => entry[key] !== value);
  if (changed) Object.assign(entry, resetState);
  return changed;
}

// Reset only the requested source variant. The parent queue row may represent
// another quality variant, so callers control whether that row is in scope.
export function resetUnfinishedQueueGenerationState(entry, {
  identity = null,
  resetEntry = true,
  resetVariants = true
} = {}) {
  if (!entry || typeof entry !== 'object') return { entryReset: false, variantsReset: 0 };
  const entryReset = resetEntry && (!identity || generationMemoryMatchesQueueEntry(identity, entry))
    ? clearUnfinishedQueueEntry(entry)
    : false;
  let variantsReset = 0;
  for (const variant of resetVariants && Array.isArray(entry.variants) ? entry.variants : []) {
    if (identity && !generationMemoryMatchesQueueEntry(identity, variant)) continue;
    if (clearUnfinishedQueueEntry(variant)) variantsReset += 1;
  }
  return { entryReset, variantsReset };
}

export function factsMetadataProjections(patch = {}) {
  const factsStatus = String(patch.factsStatus || '').toLowerCase();
  const memoryStatus = factsStatus === 'ok'
    ? GENERATION_MEMORY_STATUSES.READY
    : factsStatus === 'pending'
      ? GENERATION_MEMORY_STATUSES.FACTS_PENDING
      : ['error', 'unavailable'].includes(factsStatus)
        ? GENERATION_MEMORY_STATUSES.IMAGE_SAVED
        : null;
  return {
    queue: { ...patch, status: 'done' },
    memory: memoryStatus ? { ...patch, status: memoryStatus } : { ...patch }
  };
}

export function generationMemoryStatusForQueueStatus(value) {
  if (String(value || '').trim() === 'done') return GENERATION_MEMORY_STATUSES.READY;
  if (String(value || '').trim() === 'running') return GENERATION_MEMORY_STATUSES.RUNNING;
  return GENERATION_MEMORY_STATUSES.NOT_READY;
}

export function normalizeWatchFilter(value = {}) {
  return {
    saleStatus: normalizeSaleStatusFilter(value.saleStatus),
    quality: normalizeQualityFilter(value.quality),
    brand: normalizeBrandFilter(value.brand)
  };
}

export function filterFromQueueGroup(groupId) {
  const value = String(groupId || '').trim();
  const match = /^(in_sale|not_in_sale)_(good|bad)$/.exec(value);
  return normalizeWatchFilter(match
    ? { saleStatus: match[1], quality: match[2], brand: 'all' }
    : {});
}

export function queueGroupForWatchFilter(value = {}) {
  const filter = normalizeWatchFilter(value);
  if (filter.brand !== 'all' || filter.saleStatus === 'all' || filter.quality === 'all') return null;
  return `${filter.saleStatus}_${filter.quality}`;
}

export function filterSelectionId(value = {}) {
  const filter = normalizeWatchFilter(value);
  return `filter:${filter.saleStatus}:${filter.quality}:${filter.brand}`;
}

export function parseFilterSelectionId(value) {
  const match = /^filter:([^:]+):([^:]+):([^:]+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return normalizeWatchFilter({ saleStatus: match[1], quality: match[2], brand: match[3] });
}

export function groupIdForWatchFilter(value = {}) {
  return queueGroupForWatchFilter(value) || filterSelectionId(value);
}

export function watchFilterLabel(value = {}) {
  const filter = normalizeWatchFilter(value);
  const brand = WATCH_BRAND_FILTERS.find((item) => item.id === filter.brand)?.label || 'Все бренды';
  return `${SALE_STATUS_FILTERS[filter.saleStatus].label} · ${QUALITY_FILTERS[filter.quality].label} · ${brand}`;
}

function entrySaleStatus(entry) {
  const groupId = String(entry?.groupId || '');
  return groupId.startsWith('in_sale_') ? 'in_sale' : (groupId.startsWith('not_in_sale_') ? 'not_in_sale' : null);
}

function entryQuality(entry) {
  return String(entry?.groupId || '').endsWith('_bad') ? 'bad' : 'good';
}

export function matchesWatchFilter(entry, value = {}) {
  const filter = normalizeWatchFilter(value);
  if (Array.isArray(entry?.variants) && entry.variants.length) {
    return entry.variants.some((variant) => matchesWatchFilter({
      ...variant,
      sourceId: entry.sourceId,
      modelName: variant.modelName || entry.modelName,
      groupId: variant.groupId
    }, filter));
  }
  const saleStatus = entrySaleStatus(entry);
  const quality = entryQuality(entry);
  return (filter.saleStatus === 'all' || filter.saleStatus === saleStatus)
    && (filter.quality === 'all' || filter.quality === quality)
    && (filter.brand === 'all' || brandIdFromModelName(entry?.modelName || entry?.fileName) === filter.brand);
}

export function filteredWatchEntries(groups = {}, value = {}) {
  const filter = normalizeWatchFilter(value);
  const candidates = QUEUE_GROUP_IDS
    .flatMap((groupId) => groups?.[groupId] || [])
    .filter((entry) => matchesWatchFilter(entry, filter));
  const bySource = new Map();
  for (const entry of candidates) {
    const modelName = entry?.modelName || entry?.fileName || '';
    const sourceId = String(entry?.skuKey || skuKeyForModelName(modelName, brandIdFromModelName(modelName)));
    if (!sourceId) continue;
    const fallbackVariantId = entry.sourceVariantId || entry.inputSourceId
      || sourceVariantIdFor(entry.groupId || 'in_sale_good', entry.relativePath || entry.fileName);
    const candidate = {
      ...entry,
      sourceId,
      skuKey: sourceId,
      sourceVariantId: fallbackVariantId,
      inputSourceId: entry.inputSourceId || fallbackVariantId,
      variants: entry.variants?.length ? entry.variants : [{
        ...entry,
        sourceVariantId: fallbackVariantId,
        variantId: fallbackVariantId,
        assetKey: `watch:${fallbackVariantId}`
      }]
    };
    const previous = bySource.get(sourceId);
    if (!previous) {
      bySource.set(sourceId, candidate);
      continue;
    }
    const variants = new Map();
    for (const variant of [...(previous.variants || []), ...(candidate.variants || [])]) {
      const variantId = String(variant?.sourceVariantId || variant?.variantId || variant?.relativePath || '');
      if (variantId) variants.set(variantId, variant);
    }
    previous.variants = [...variants.values()];
  }
  return [...bySource.values()].map((entry) => {
    const selected = chooseSourceVariant(entry.variants || [], filter);
    const sameInput = String(selected?.sourceVariantId || selected?.variantId || '')
      === String(entry.sourceVariantId || entry.inputSourceId || '');
    const status = normalizeQueueStatus(selected?.status || (sameInput ? entry.status : 'pending'));
    return selected ? {
      ...entry,
      ...selected,
      sourceId: entry.sourceId,
      skuKey: entry.skuKey || entry.sourceId,
      variants: entry.variants || [],
      status,
      generationId: selected.generationId || (sameInput ? entry.generationId : null),
      previousGenerationId: sameInput ? entry.previousGenerationId : null,
      outputPath: selected.outputPath || (sameInput ? entry.outputPath : null),
      outputHash: selected.outputHash || (sameInput ? entry.outputHash : null),
      recipeHash: selected.recipeHash || (sameInput ? entry.recipeHash : null),
      groupId: selected.groupId || entry.groupId,
      sourceVariantId: selected.sourceVariantId || selected.variantId || entry.sourceVariantId,
      inputSourceId: selected.sourceVariantId || selected.variantId || entry.inputSourceId
    } : entry;
  });
}

export function chooseSourceVariant(variants = [], filterValue = {}) {
  const filter = normalizeWatchFilter(filterValue);
  const candidates = (variants || []).filter((variant) => {
    if (!variant?.groupId) return true;
    const groupFilter = filterFromQueueGroup(variant.groupId);
    return (filter.saleStatus === 'all' || groupFilter.saleStatus === filter.saleStatus)
      && (filter.quality === 'all' || groupFilter.quality === filter.quality)
      && (filter.brand === 'all' || brandIdFromModelName(variant.modelName || variant.fileName) === filter.brand);
  });
  const list = candidates.length ? candidates : (variants || []);
  return [...list].sort((left, right) => {
    const quality = Number(entryQuality(left) === 'bad') - Number(entryQuality(right) === 'bad');
    if (quality) return quality;
    const sale = Number(entrySaleStatus(right) === 'in_sale') - Number(entrySaleStatus(left) === 'in_sale');
    if (sale) return sale;
    const path = normalizeRelativePath(left.relativePath || left.fileName).toLowerCase()
      .localeCompare(normalizeRelativePath(right.relativePath || right.fileName).toLowerCase(), 'en');
    return path || String(left.sourceVariantId || left.variantId || '').localeCompare(String(right.sourceVariantId || right.variantId || ''));
  })[0] || null;
}

export function modelNameFromFileName(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '').trim();
}

export function sanitizeFilename(name) {
  let value = String(name || 'generated-watch.png')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) value = 'generated-watch.png';
  if (value.length > 180) value = value.slice(0, 180).replace(/[ .]+$/, '');
  return value || 'generated-watch.png';
}

export function generatedFileName(sourceFileName) {
  const safeName = sanitizeFilename(sourceFileName);
  return safeName.toLowerCase().startsWith('gen-') ? safeName : `gen-${safeName}`;
}

// Every physical attempt gets its own output path. This keeps a Chrome
// " (1)" filename collision from becoming an implicit version selector and
// prevents a later revision from overwriting an older revision's PNG.
export function generationOutputFileName(baseFileName, generationId) {
  const safeBase = sanitizeFilename(baseFileName || 'generated-watch.png').replace(/\.png$/i, '') || 'generated-watch';
  const safeId = String(generationId || 'revision').replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = (safeId || 'revision').slice(-48);
  const ending = `__${suffix}.png`;
  const maxStemLength = Math.max(1, 180 - ending.length);
  const stem = safeBase.slice(0, maxStemLength).replace(/[ .]+$/g, '') || 'generated-watch';
  return sanitizeFilename(`${stem}${ending}`);
}

export function ensureGenerationOutputFileName(slot, entry, revisionId) {
  const existing = String(slot?.outputFileName || '').trim();
  if (existing) return existing;
  const outputFileName = generationOutputFileName(entry?.outputFileName, revisionId);
  if (slot) slot.outputFileName = outputFileName;
  return outputFileName;
}

export function sourceVariantIdFor(groupId, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  const rootIndex = parts.findIndex((part) => part.toLowerCase() === 'input-watches-images');
  const saleIndex = parts.findIndex((part) => ['in_sale', 'not_in_sale'].includes(String(part).toLowerCase()));
  const canonical = rootIndex >= 0
    ? parts.slice(rootIndex).join('/')
    : saleIndex >= 0
      ? ['input-watches-images', ...parts.slice(saleIndex)].join('/')
      : normalized;
  return `${groupId}|${canonical}`;
}

export function sourceIdFor(groupId, relativePath, modelName = null) {
  const normalized = normalizeRelativePath(relativePath);
  const candidate = String(modelName || normalized.split('/').at(-1) || '');
  return skuKeyForModelName(candidate, brandIdFromModelName(candidate));
}

export function fingerprintForFile(file) {
  return `${Number(file?.size || 0)}:${Number(file?.lastModified || 0)}:${String(file?.name || '')}`;
}

export function makeQueueEntry(file, relativePath, groupId, previous = null) {
  const rawPath = normalizeRelativePath(relativePath || file?.webkitRelativePath || file?.name);
  const rawParts = rawPath.split('/').filter(Boolean);
  const watchRootIndex = rawParts.findIndex((part) => part.toLowerCase() === 'input-watches-images');
  const saleIndex = rawParts.findIndex((part) => ['in_sale', 'not_in_sale'].includes(String(part).toLowerCase()));
  const normalizedPath = watchRootIndex >= 0
    ? rawParts.slice(watchRootIndex).join('/')
    : saleIndex >= 0
      ? ['input-watches-images', ...rawParts.slice(saleIndex)].join('/')
      : rawPath;
  const sourceVariantId = sourceVariantIdFor(groupId, normalizedPath);
  const modelName = modelNameFromFileName(file?.name || normalizedPath.split('/').at(-1));
  const skuKey = sourceIdFor(groupId, normalizedPath, modelName);
  const sourceId = skuKey;
  const fingerprint = fingerprintForFile(file);
  const sameSource = (previous?.skuKey === skuKey || previous?.sourceId === sourceId || previous?.sourceId === sourceVariantId
    || previous?.sourceVariantId === sourceVariantId || previous?.variantId === sourceVariantId)
    && previous?.fingerprint === fingerprint;
  const keepDone = sameSource && previous.status === 'done';
  return {
    sourceId,
    skuKey,
    partitionOrderKey: previous?.partitionOrderKey || previous?.skuKey || sourceId,
    sourceVariantId,
    inputSourceId: sourceVariantId,
    groupId,
    relativePath: normalizedPath,
    fileName: String(file?.name || normalizedPath.split('/').at(-1) || 'watch.png'),
    modelName,
    outputFileName: generatedFileName(file?.name || normalizedPath.split('/').at(-1)),
    fingerprint,
    sourceHash: sameSource ? (previous.sourceHash || null) : null,
    size: Number(file?.size || 0),
    lastModified: Number(file?.lastModified || 0),
    status: keepDone ? 'done' : 'pending',
    generationId: sameSource ? (previous.generationId || null) : null,
    previousGenerationId: sameSource ? (previous.previousGenerationId || null) : null,
    retryCount: sameSource ? Number(previous.retryCount || 0) : 0,
    lastError: sameSource ? (previous.lastError || null) : null,
    generatedAt: keepDone ? (previous.generatedAt || null) : null,
    outputPath: keepDone ? (previous.outputPath || null) : null,
    outputHash: keepDone ? (previous.outputHash || null) : null,
    outputWidth: keepDone ? (previous.outputWidth || null) : null,
    outputHeight: keepDone ? (previous.outputHeight || null) : null,
    verificationMode: keepDone ? (previous.verificationMode || null) : null,
    recipeHash: sameSource ? (previous.recipeHash || null) : null,
    profileId: sameSource ? (previous.profileId || null) : null,
    profileVersion: sameSource ? (previous.profileVersion || null) : null,
    attempt: sameSource ? Number(previous.attempt || 0) : 0,
    errorClass: sameSource ? (previous.errorClass || null) : null,
    nextRetryAt: sameSource ? (previous.nextRetryAt || null) : null
  };
}

export function generationMemoryRecordFromEntry(entry, overrides = {}) {
  const status = normalizeGenerationMemoryStatus(
    overrides.status,
    generationMemoryStatusForQueueStatus(entry?.status)
  );
  return {
    sourceId: entry?.sourceId || null,
    generationId: overrides.generationId ?? entry?.generationId ?? null,
    previousGenerationId: overrides.previousGenerationId ?? entry?.previousGenerationId ?? null,
    groupId: entry?.groupId || null,
    sourceVariantId: overrides.sourceVariantId ?? entry?.inputSourceId ?? entry?.sourceVariantId ?? null,
    sourceHash: overrides.sourceHash ?? entry?.sourceHash ?? null,
    relativePath: entry?.relativePath || null,
    fileName: entry?.fileName || null,
    modelName: entry?.modelName || null,
    outputFileName: entry?.outputFileName || null,
    fingerprint: entry?.fingerprint || null,
    status,
    sourcePresent: overrides.sourcePresent ?? true,
    statusSource: overrides.statusSource || 'automatic',
    generationStartedAt: overrides.generationStartedAt || null,
    generatedAt: overrides.generatedAt || entry?.generatedAt || null,
    outputPath: overrides.outputPath ?? entry?.outputPath ?? null,
    outputHash: overrides.outputHash ?? entry?.outputHash ?? null,
    outputWidth: Number(overrides.outputWidth ?? entry?.outputWidth ?? 0) || null,
    outputHeight: Number(overrides.outputHeight ?? entry?.outputHeight ?? 0) || null,
    verificationMode: overrides.verificationMode ?? entry?.verificationMode ?? null,
    recipeHash: overrides.recipeHash ?? entry?.recipeHash ?? null,
    profileId: overrides.profileId ?? entry?.profileId ?? null,
    profileVersion: overrides.profileVersion ?? entry?.profileVersion ?? null,
    attempt: Number(overrides.attempt ?? entry?.attempt ?? 0),
    errorClass: overrides.errorClass ?? entry?.errorClass ?? null,
    nextRetryAt: overrides.nextRetryAt ?? entry?.nextRetryAt ?? null,
    retryCount: Number(overrides.retryCount ?? entry?.retryCount ?? 0),
    lastError: overrides.lastError ?? entry?.lastError ?? null,
    lastRunId: overrides.lastRunId || null,
    reviewStatus: overrides.reviewStatus ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    reviewReason: overrides.reviewReason ?? null,
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString()
  };
}

export function applyGenerationMemory(groups = {}, memory = {}) {
  const items = memory?.items || {};
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of groups[groupId] || []) {
      const record = items[entry.sourceId];
      if (!record) continue;
      const fields = generationMemoryFields(record);
      if (generationMemoryMatchesQueueEntry(record, entry)) Object.assign(entry, fields);
      for (const variant of Array.isArray(entry.variants) ? entry.variants : []) {
        if (generationMemoryMatchesQueueEntry(record, variant)) Object.assign(variant, fields);
      }
    }
  }
  return groups;
}

export function mergeScannedGroups(scannedGroups, previousGroups = {}) {
  const result = Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => [groupId, []]));
  const previousEntries = QUEUE_GROUP_IDS.flatMap((groupId) => previousGroups[groupId] || []);
  const previousBySku = new Map(previousEntries.map((entry) => [String(entry.skuKey || entry.sourceId || ''), entry]));
  const previousByVariant = new Map();
  for (const entry of previousEntries) {
    const topLevelId = String(entry.sourceVariantId || entry.inputSourceId || '');
    if (topLevelId) previousByVariant.set(topLevelId, entry);
    for (const variant of entry.variants || []) {
      const variantId = String(variant?.sourceVariantId || variant?.variantId || '');
      if (variantId) previousByVariant.set(variantId, variant);
    }
  }
  const grouped = new Map();
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const item of scannedGroups[groupId] || []) {
      const entry = makeQueueEntry(item.file, item.relativePath, groupId, null);
      entry.sourceHash = item.sourceHash || null;
      const previousVariant = previousByVariant.get(entry.sourceVariantId);
      const sameVariant = Boolean(previousVariant && (
        previousVariant.sourceHash && entry.sourceHash
          ? String(previousVariant.sourceHash).toLowerCase() === String(entry.sourceHash).toLowerCase()
          : previousVariant.fingerprint === entry.fingerprint
      ));
      const variant = {
        sourceVariantId: entry.sourceVariantId,
        variantId: entry.sourceVariantId,
        assetKey: `watch:${entry.sourceVariantId}`,
        groupId,
        relativePath: entry.relativePath,
        fileName: entry.fileName,
        modelName: entry.modelName,
        partitionOrderKey: previousVariant?.partitionOrderKey || previousVariant?.skuKey || previousVariant?.sourceId || null,
        outputFileName: entry.outputFileName,
        fingerprint: entry.fingerprint,
        sourceFingerprint: entry.fingerprint,
        sourceHash: item.sourceHash || null,
        status: sameVariant ? previousVariant.status : 'pending',
        generationId: sameVariant ? previousVariant.generationId || null : null,
        outputPath: sameVariant ? previousVariant.outputPath || null : null,
        outputHash: sameVariant ? previousVariant.outputHash || null : null,
        recipeHash: sameVariant ? previousVariant.recipeHash || null : null,
        size: entry.size,
        lastModified: entry.lastModified
      };
      const variants = grouped.get(entry.skuKey) || [];
      variants.push(variant);
      grouped.set(entry.skuKey, variants);
    }
  }
  for (const [skuKey, variants] of grouped) {
    const selected = chooseSourceVariant(variants, {});
    const priorVariant = selected ? previousByVariant.get(selected.sourceVariantId) : null;
    const priorHashMatches = priorVariant?.sourceHash && selected?.sourceHash
      ? String(priorVariant.sourceHash).toLowerCase() === String(selected.sourceHash).toLowerCase()
      : priorVariant?.fingerprint === selected?.fingerprint;
    const oldSku = previousBySku.get(skuKey);
    const oldSkuMatchesSelected = oldSku && (
      String(oldSku.sourceVariantId || oldSku.inputSourceId || '') === String(selected?.sourceVariantId || '')
      || normalizeRelativePath(oldSku.relativePath || '') === normalizeRelativePath(selected?.relativePath || '')
    );
    const prior = priorVariant && priorHashMatches ? priorVariant
      : (oldSkuMatchesSelected && priorHashMatches ? oldSku : null);
    const selectedGroup = selected?.groupId || 'in_sale_good';
    const representative = makeQueueEntry(
      { name: selected?.fileName || variants[0]?.fileName, size: selected?.size, lastModified: selected?.lastModified },
      selected?.relativePath || variants[0]?.relativePath,
      selectedGroup,
      prior
    );
    representative.sourceId = skuKey;
    representative.skuKey = skuKey;
    representative.partitionOrderKey = oldSku?.partitionOrderKey || oldSku?.skuKey || oldSku?.sourceId
      || selected?.partitionOrderKey || skuKey;
    representative.variants = variants;
    representative.sourceVariantIds = variants.map((variant) => variant.sourceVariantId);
    representative.inputSourceId = selected?.sourceVariantId || representative.sourceVariantId;
    representative.sourceVariantId = representative.inputSourceId;
    representative.sourceHash = selected?.sourceHash || null;
    representative.groupId = selectedGroup;
    const groupIds = [...new Set(variants.map((variant) => variant.groupId))];
    for (const groupId of groupIds) result[groupId].push({ ...representative, groupId });
  }
  for (const groupId of QUEUE_GROUP_IDS) {
    result[groupId].sort((left, right) => String(left.modelName || '').localeCompare(String(right.modelName || ''), 'ru'));
  }
  return result;
}

export function modelCatalogRecordsFromGroups(groups = {}) {
  const bySku = new Map();
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of groups[groupId] || []) {
      const skuKey = String(entry?.skuKey || entry?.sourceId || '');
      if (!skuKey) continue;
      const row = bySku.get(skuKey) || {
        skuKey,
        sourceId: skuKey,
        partitionOrderKey: entry.partitionOrderKey || skuKey,
        modelName: entry.modelName || entry.fileName || '',
        brandId: brandIdFromModelName(entry.modelName || entry.fileName),
        variants: [],
        sourcePresent: true
      };
      if (row.partitionOrderKey === skuKey && entry.partitionOrderKey && entry.partitionOrderKey !== skuKey) {
        row.partitionOrderKey = entry.partitionOrderKey;
      }
      const variants = entry.variants?.length ? entry.variants : [{
        ...entry,
        sourceVariantId: entry.sourceVariantId || entry.inputSourceId || sourceVariantIdFor(entry.groupId || groupId, entry.relativePath || entry.fileName),
        assetKey: `watch:${entry.sourceVariantId || entry.inputSourceId || sourceVariantIdFor(entry.groupId || groupId, entry.relativePath || entry.fileName)}`
      }];
      const known = new Set(row.variants.map((item) => String(item.sourceVariantId || item.variantId || '')));
      for (const variant of variants) {
        const id = String(variant.sourceVariantId || variant.variantId || entry.sourceVariantId || entry.inputSourceId || '');
        if (!id || known.has(id)) continue;
        known.add(id);
        row.variants.push({
          ...variant,
          sourceVariantId: id,
          variantId: id,
          groupId: variant.groupId || entry.groupId || groupId,
          relativePath: variant.relativePath || entry.relativePath || null,
          fileName: variant.fileName || entry.fileName || null,
          modelName: variant.modelName || entry.modelName || null,
          fingerprint: variant.fingerprint || entry.fingerprint || null,
          assetKey: variant.assetKey || `watch:${id}`
        });
      }
      bySku.set(skuKey, row);
    }
  }
  return [...bySku.values()].map((record) => {
    const variants = record.variants.sort((a, b) => String(a.relativePath || '').toLowerCase().localeCompare(String(b.relativePath || '').toLowerCase(), 'en'));
    const selected = chooseSourceVariant(variants, {});
    record.queueState = {
      status: selected?.status || 'pending', generationId: selected?.generationId || null,
      recipeHash: selected?.recipeHash || null, profileVersion: selected?.profileVersion || null,
      retryCount: Number(selected?.retryCount || 0), lastError: selected?.lastError || null
    };
    return { ...record, variants };
  });
}

export function queueGroupsFromCatalog(records = [], previousGroups = {}) {
  const result = Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => [groupId, []]));
  const previous = new Map(QUEUE_GROUP_IDS.flatMap((groupId) => previousGroups[groupId] || [])
    .map((entry) => [String(entry.skuKey || entry.sourceId || ''), entry]));
  for (const record of records || []) {
    if (!record?.skuKey || record.sourcePresent === false) continue;
    const sessionRetry = record.retryRequired && (!record.currentGenerationId
      || record.currentGenerationId === record.sessionRetry?.previousGenerationId) ? record.sessionRetry : null;
    const variants = (Array.isArray(record.variants) ? record.variants : []).map(variant => {
      if (!sessionRetry || String(variant.sourceVariantId || variant.variantId) !== String(sessionRetry.inputSourceId)) return variant;
      return { ...variant, status: 'pending', generationId: null, outputPath: null, outputHash: null,
        factsStatus: null, generatedAt: null, lastError: null, retryCount: 0, nextRetryAt: null };
    });
    if (!variants.length) continue;
    const old = previous.get(String(record.skuKey));
    const defaultVariant = chooseSourceVariant(variants, {});
    const baseVariant = defaultVariant || variants[0];
    const representative = old || makeQueueEntry({
      name: baseVariant.fileName || record.modelName,
      size: baseVariant.size,
      lastModified: baseVariant.lastModified
    }, baseVariant.relativePath, baseVariant.groupId || 'in_sale_good');
    representative.partitionOrderKey = record.partitionOrderKey || record.originSourceId
      || old?.partitionOrderKey || old?.skuKey || old?.sourceId || String(record.skuKey);
    const groupIds = [...new Set(variants.map((item) => item.groupId).filter((id) => QUEUE_GROUP_IDS.includes(id)))];
    for (const groupId of groupIds) {
      const queuedStatus = baseVariant.status || record.queueState?.status;
      result[groupId].push({
        ...representative,
        sourceId: String(record.skuKey),
        skuKey: String(record.skuKey),
        modelName: representative.modelName || record.modelName || baseVariant.modelName,
        variants,
        groupId,
        sourceVariantId: baseVariant.sourceVariantId || baseVariant.variantId,
        inputSourceId: baseVariant.sourceVariantId || baseVariant.variantId,
        sourceHash: baseVariant.sourceHash || null,
        relativePath: baseVariant.relativePath,
        fileName: baseVariant.fileName,
        fingerprint: baseVariant.fingerprint,
        size: Number(baseVariant.size || 0),
        lastModified: Number(baseVariant.lastModified || 0),
        status: normalizeQueueStatus(queuedStatus || representative.status),
        generationId: baseVariant.generationId || record.queueState?.generationId || representative.generationId || null,
        outputPath: baseVariant.outputPath || representative.outputPath || null,
        outputHash: baseVariant.outputHash || representative.outputHash || null,
        recipeHash: baseVariant.recipeHash || record.queueState?.recipeHash || representative.recipeHash || null,
        lastError: baseVariant.lastError || record.queueState?.lastError || null,
        retryCount: Number(record.queueState?.retryCount || representative.retryCount || 0)
      });
      if (sessionRetry && String(baseVariant.sourceVariantId || baseVariant.variantId) === String(sessionRetry.inputSourceId)) {
        Object.assign(result[groupId].at(-1), { status: 'pending', generationId: null, outputPath: null,
          outputHash: null, factsStatus: null, generatedAt: null, lastError: null, nextRetryAt: null, retryCount: 0 });
      }
    }
  }
  return result;
}

export function queueCounts(groups = {}) {
  return Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => {
    const entries = groups[groupId] || [];
    return [groupId, {
      total: entries.length,
      done: entries.filter((entry) => entry.status === 'done').length,
      pending: entries.filter((entry) => entry.status !== 'done').length
    }];
  }));
}

export function normalizeRunLimit(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function normalizeWorkerCount(value, fallback = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(6, Math.max(2, Math.floor(parsed)));
}

export function pendingEntryIds(entries = [], runLimit = 0) {
  const ids = entries
    .filter((entry) => !['done', 'running'].includes(entry?.status) && entry?.sourceId)
    .map((entry) => entry.sourceId);
  const limit = normalizeRunLimit(runLimit, 0);
  return limit > 0 ? ids.slice(0, limit) : ids;
}

export function pendingEntryIdsForFilter(entries = [], runLimit = 0, coverageMode = 'queue') {
  const pending = entries.filter((entry) => !['done', 'running'].includes(entry?.status) && entry?.sourceId);
  const selected = normalizeCoverageMode(coverageMode) === 'one_per_brand'
    ? pending.filter((entry, index, list) => {
      const brand = brandIdFromModelName(entry.modelName || entry.fileName);
      return list.findIndex((candidate) => (
        brandIdFromModelName(candidate.modelName || candidate.fileName) === brand
      )) === index;
    })
    : pending;
  const limit = normalizeRunLimit(runLimit, 0);
  return limit > 0 ? selected.slice(0, limit).map((entry) => entry.sourceId) : selected.map((entry) => entry.sourceId);
}

function stableQueueEntries(entries = []) {
  const bySourceId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sourceId = String(entry?.skuKey || entry?.sourceId || '').trim();
    if (sourceId && !bySourceId.has(sourceId)) bySourceId.set(sourceId, entry);
  }
  return [...bySourceId.entries()]
    .sort(([left, leftEntry], [right, rightEntry]) => {
      const leftOrder = String(leftEntry?.partitionOrderKey || left);
      const rightOrder = String(rightEntry?.partitionOrderKey || right);
      return leftOrder < rightOrder ? -1 : (leftOrder > rightOrder ? 1 : (left < right ? -1 : (left > right ? 1 : 0)));
    })
    .map(([, entry]) => entry);
}

function queuePartSignature(sourceIds, context = '') {
  let hash = 2166136261;
  const value = `${String(context)}\u0000${sourceIds.join('\u0000')}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1:${sourceIds.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function queuePartPlan(entries = [], partSize = RUN_PART_SIZE, context = '') {
  const parsedSize = Number(partSize);
  const size = Number.isFinite(parsedSize) && parsedSize > 0
    ? Math.floor(parsedSize)
    : RUN_PART_SIZE;
  const orderedEntries = stableQueueEntries(entries);
  const sourceIds = orderedEntries.map((entry) => String(entry?.skuKey || entry?.sourceId || '').trim());
  const partCount = Math.ceil(orderedEntries.length / size);
  const parts = [];
  for (let start = 0; start < orderedEntries.length; start += size) {
    const partEntries = orderedEntries.slice(start, start + size);
    parts.push({
      partNumber: parts.length + 1,
      start,
      end: start + partEntries.length,
      count: partEntries.length,
      sourceIds: partEntries.map((entry) => String(entry?.skuKey || entry?.sourceId || '').trim()),
      entries: partEntries
    });
  }
  return {
    total: orderedEntries.length,
    partSize: size,
    partCount,
    signature: queuePartSignature(sourceIds, context),
    sourceIds,
    parts
  };
}

export function queueEntriesForPart(plan, partNumber) {
  const number = Number(partNumber);
  if (!Number.isSafeInteger(number) || number < 1) return [];
  return plan?.parts?.find((part) => part.partNumber === number)?.entries || [];
}

export function buildQueueProgressTree(groups = {}, repairQueue = [], partSize = RUN_PART_SIZE) {
  const repairs = new Set((Array.isArray(repairQueue) ? repairQueue : [])
    .filter((item) => typeof item === 'string' || item?.status !== 'completed')
    .map((item) => typeof item === 'string' ? item : item?.sourceId)
    .filter(Boolean)
    .map(String));
  const uniqueEntries = (entries = []) => {
    const bySource = new Map();
    for (const entry of entries) {
      const sourceId = String(entry?.skuKey || entry?.sourceId || '').trim();
      if (sourceId && !bySource.has(sourceId)) bySource.set(sourceId, { ...entry, sourceId, skuKey: sourceId });
    }
    return [...bySource.values()];
  };
  const snapshot = (entries = [], mode = 'regular') => {
    const items = uniqueEntries(entries);
    const done = mode === 'regular'
      ? items.filter((entry) => entry.status === 'done' && !repairs.has(String(entry.sourceId))).length
      : 0;
    const running = mode === 'regular'
      ? items.filter((entry) => entry.status === 'running' && !repairs.has(String(entry.sourceId))).length
      : 0;
    const total = items.length;
    return {
      total,
      done,
      running,
      pending: Math.max(0, total - done - running),
      percent: total ? Math.floor((done / total) * 100) : 0,
      queued: mode === REGENERATION_QUEUE_ID ? total : 0
    };
  };
  const brandLabel = (brandId) => WATCH_BRAND_FILTERS.find((item) => item.id === brandId)?.label || brandId;
  const roots = [];

  for (const mode of ['regular', REGENERATION_QUEUE_ID]) {
    const sales = [];
    for (const saleStatus of ['in_sale', 'not_in_sale']) {
      const categories = [];
      for (const quality of ['good', 'bad']) {
        const groupId = `${saleStatus}_${quality}`;
        const baseEntries = filteredWatchEntries(groups, { saleStatus, quality, brand: 'all' })
          .filter((entry) => mode === 'regular' || repairs.has(String(entry.sourceId)));
        const entriesByBrand = new Map();
        for (const entry of baseEntries) {
          const brandId = brandIdFromModelName(entry.modelName || entry.fileName);
          const items = entriesByBrand.get(brandId) || [];
          items.push(entry);
          entriesByBrand.set(brandId, items);
        }
        const brandIds = [...entriesByBrand.keys()]
          .sort((left, right) => brandLabel(left).localeCompare(brandLabel(right), 'ru'));
        const brands = [];
        for (const brandId of brandIds) {
          const entries = entriesByBrand.get(brandId) || [];
          if (!entries.length) continue;
          const plan = queuePartPlan(entries, partSize, `${mode}|${saleStatus}|${quality}|${brandId}`);
          const parts = plan.parts.map((part) => ({
            id: `part:${mode}:${groupId}:${brandId}:${plan.signature}:${part.partNumber}`,
            type: 'part',
            mode,
            groupId,
            brandId,
            partNumber: part.partNumber,
            signature: plan.signature,
            sourceIds: part.sourceIds,
            entries: part.entries,
            ...snapshot(part.entries, mode)
          }));
          brands.push({
            id: `brand:${mode}:${groupId}:${brandId}`,
            type: 'brand',
            mode,
            groupId,
            brandId,
            label: brandLabel(brandId),
            entries,
            children: parts,
            ...snapshot(entries, mode)
          });
        }
        if (brands.length) {
          const entries = uniqueEntries(brands.flatMap((brand) => brand.entries));
          categories.push({
            id: `category:${mode}:${groupId}`,
            type: 'quality',
            mode,
            groupId,
            label: quality === 'good' ? 'Хорошее качество' : 'Плохое качество',
            entries,
            children: brands,
            ...snapshot(entries, mode)
          });
        }
      }
      if (categories.length) {
        const entries = uniqueEntries(categories.flatMap((category) => category.entries));
        sales.push({
          id: `sale:${mode}:${saleStatus}`,
          type: 'sale',
          mode,
          saleStatus,
          label: saleStatus === 'in_sale' ? 'В продаже' : 'Не в продаже',
          entries,
          children: categories,
          ...snapshot(entries, mode)
        });
      }
    }
    const entries = uniqueEntries(sales.flatMap((sale) => sale.entries));
    roots.push({
      id: `queue:${mode}`,
      type: 'queue',
      mode,
      label: mode === 'regular' ? 'Обычная очередь' : 'Перегенерация брака',
      entries,
      children: sales,
      ...snapshot(entries, mode)
    });
  }
  return roots;
}

export function historyRecordFromEntry(entry, overrides = {}) {
  return {
    sourceId: entry?.sourceId || null,
    generationId: overrides.generationId ?? entry?.generationId ?? null,
    previousGenerationId: overrides.previousGenerationId ?? entry?.previousGenerationId ?? null,
    groupId: entry?.groupId || null,
    sourceVariantId: entry?.inputSourceId || entry?.sourceVariantId || null,
    sourceHash: entry?.sourceHash || null,
    relativePath: entry?.relativePath || null,
    fileName: entry?.fileName || null,
    modelName: entry?.modelName || null,
    outputFileName: entry?.outputFileName || null,
    fingerprint: entry?.fingerprint || null,
    generatedAt: overrides.generatedAt || entry?.generatedAt || new Date().toISOString(),
    outputPath: overrides.outputPath ?? entry?.outputPath ?? null,
    outputHash: overrides.outputHash ?? entry?.outputHash ?? null,
    outputWidth: Number(overrides.outputWidth ?? entry?.outputWidth ?? 0) || null,
    outputHeight: Number(overrides.outputHeight ?? entry?.outputHeight ?? 0) || null,
    verificationMode: overrides.verificationMode ?? entry?.verificationMode ?? null,
    recipeHash: overrides.recipeHash ?? entry?.recipeHash ?? null,
    profileId: overrides.profileId ?? entry?.profileId ?? null,
    profileVersion: overrides.profileVersion ?? entry?.profileVersion ?? null
  };
}

export function applyGenerationHistory(groups = {}, history = {}) {
  const items = history?.items || {};
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of groups[groupId] || []) {
      const record = items[entry.sourceId];
      if (!record) continue;
      const fields = {
        status: 'done',
        generatedAt: record.generatedAt || null,
        generationId: record.generationId || null,
        previousGenerationId: record.previousGenerationId || null,
        outputPath: record.outputPath || null,
        outputHash: record.outputHash || null,
        outputWidth: record.outputWidth || null,
        outputHeight: record.outputHeight || null,
        verificationMode: record.verificationMode || null,
        recipeHash: record.recipeHash || null,
        profileId: record.profileId || null,
        profileVersion: record.profileVersion || null,
        lastError: null,
        errorClass: null,
        nextRetryAt: null
      };
      if (generationMemoryMatchesQueueEntry(record, entry)) Object.assign(entry, fields);
      for (const variant of Array.isArray(entry.variants) ? entry.variants : []) {
        if (generationMemoryMatchesQueueEntry(record, variant)) Object.assign(variant, fields);
      }
    }
  }
  return groups;
}
