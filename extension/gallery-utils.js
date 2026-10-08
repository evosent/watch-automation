import { isLegacyPaganiBrandStack, titleLayoutSpecFor, titleLayoutWarnings, displayTitleBrand } from './title-layout-utils.js';

const PLACEHOLDER_TEXT = /^(?:—|–|-|_+|null|undefined|n\/?a|нет|неизвестно)$/i;

export function physicalPngCount(activePngCount, archivedPngCount = 0) {
  return Math.max(0, Math.trunc(Number(activePngCount) || 0))
    + Math.max(0, Math.trunc(Number(archivedPngCount) || 0));
}

export function meaningfulFactValue(value) {
  if (value == null) return false;
  const text = String(value).trim();
  return Boolean(text) && !PLACEHOLDER_TEXT.test(text);
}

export function factsSeriesPolicy(facts, modelName = '') {
  return titleLayoutSpecFor(modelName, facts).titleLayout?.seriesPolicy || 'forbidden';
}

export function displayFactsTitleBrand(facts, modelName = '') {
  return displayTitleBrand(facts, modelName);
}

export function effectiveFactsWarnings(facts, modelName = '') {
  if (!facts || typeof facts !== 'object') return [];
  const warnings = new Set(Array.isArray(facts.warnings) ? facts.warnings.filter(Boolean) : []);
  const seriesPolicy = factsSeriesPolicy(facts, modelName);
  const legacyPaganiStack = isLegacyPaganiBrandStack(facts, modelName);

  if (legacyPaganiStack) {
    warnings.delete('TITLE_BRAND_MISMATCH');
    warnings.delete('TITLE_SERIES_MISMATCH');
    warnings.delete('MISSING_SERIES');
  } else if (seriesPolicy === 'forbidden') {
    warnings.delete('MISSING_SERIES');
  }
  for (const warning of titleLayoutWarnings(facts, titleLayoutSpecFor(modelName, facts))) warnings.add(warning);

  if (!meaningfulFactValue(facts.utp1)) warnings.add('MISSING_UTP_1');
  if (!meaningfulFactValue(facts.utp2)) warnings.add('MISSING_UTP_2');
  if (!meaningfulFactValue(facts.waterResistance)) warnings.add('MISSING_WATER_RESISTANCE');
  if (!meaningfulFactValue(facts.caseSize)) warnings.add('MISSING_CASE_SIZE');

  if (!meaningfulFactValue(displayFactsTitleBrand(facts, modelName))) warnings.add('MISSING_TITLE_BRAND');
  if (!meaningfulFactValue(facts.titleModel)) warnings.add('MISSING_TITLE_MODEL');
  if ((seriesPolicy === 'required' || meaningfulFactValue(facts.expectedTitleSeries))
    && !meaningfulFactValue(facts.titleSeries) && !legacyPaganiStack) {
    warnings.add('MISSING_SERIES');
  }

  const scalarKeys = ['titleBrand', 'titleSeries', 'titleModel', 'utp1', 'utp2', 'waterResistance', 'caseSize'];
  if (!scalarKeys.some((key) => meaningfulFactValue(facts[key]))) warnings.add('EMPTY_FACTS');
  return [...warnings];
}

export function factsDisplayState(record) {
  const facts = record?.facts && typeof record.facts === 'object' ? record.facts : null;
  const status = String(record?.factsStatus || facts?.status || '').trim().toLowerCase();
  const warnings = effectiveFactsWarnings(facts, record?.modelName || record?.fileName || '');
  const scalarKeys = ['titleBrand', 'titleSeries', 'titleModel', 'utp1', 'utp2', 'waterResistance', 'caseSize'];
  const hasContent = Boolean(facts && scalarKeys.some((key) => meaningfulFactValue(facts[key])));

  if (status === 'error') return { kind: 'error', status, warnings, hasContent };
  if (['extracting', 'pending', 'running', 'starting'].includes(status)) return { kind: 'pending', status, warnings, hasContent };
  if (!facts || !hasContent) return { kind: 'missing', status: status || 'missing', warnings, hasContent };
  if (warnings.length) return { kind: 'warning', status: status || 'ok', warnings, hasContent };
  return { kind: 'ok', status: status || 'ok', warnings, hasContent };
}

export function recordTimestamp(record) {
  const generated = Date.parse(String(record?.generatedAt || ''));
  if (Number.isFinite(generated)) return generated;
  const modified = Number(record?.modifiedAt || 0);
  return Number.isFinite(modified) ? modified : 0;
}

const nameCollator = new Intl.Collator(['ru', 'en'], { numeric: true, sensitivity: 'base' });

function recordName(record) {
  return String(record?.modelName || record?.fileName || record?.outputFileName || '').trim();
}

function recordBrand(record, brandResolver) {
  return String(typeof brandResolver === 'function' ? brandResolver(record) : (record?.profileId || '')).trim();
}

const factsRank = Object.freeze({ error: 0, warning: 1, missing: 2, pending: 3, ok: 4 });

export function compareGalleryRecords(a, b, order = 'date_desc', brandResolver = null) {
  switch (order) {
    case 'date_asc':
      return recordTimestamp(a) - recordTimestamp(b) || nameCollator.compare(recordName(a), recordName(b));
    case 'name_asc':
      return nameCollator.compare(recordName(a), recordName(b)) || recordTimestamp(b) - recordTimestamp(a);
    case 'name_desc':
      return nameCollator.compare(recordName(b), recordName(a)) || recordTimestamp(b) - recordTimestamp(a);
    case 'brand_asc': {
      const byBrand = nameCollator.compare(recordBrand(a, brandResolver), recordBrand(b, brandResolver));
      return byBrand || nameCollator.compare(recordName(a), recordName(b));
    }
    case 'brand_desc': {
      const byBrand = nameCollator.compare(recordBrand(b, brandResolver), recordBrand(a, brandResolver));
      return byBrand || nameCollator.compare(recordName(a), recordName(b));
    }
    case 'facts_issues': {
      const aState = factsDisplayState(a);
      const bState = factsDisplayState(b);
      const byState = (factsRank[aState.kind] ?? 99) - (factsRank[bState.kind] ?? 99);
      return byState || recordTimestamp(b) - recordTimestamp(a);
    }
    case 'date_desc':
    default:
      return recordTimestamp(b) - recordTimestamp(a) || nameCollator.compare(recordName(a), recordName(b));
  }
}

export function sortGalleryRecords(items, order = 'date_desc', brandResolver = null) {
  return [...(items || [])].sort((a, b) => compareGalleryRecords(a, b, order, brandResolver));
}
