import { detectBrandProfile, getBrandProfile, resolveTitleSpec } from './prompt-profiles.js';

const normalized = (value) => String(value || '')
  .toLowerCase()
  .replace(/[ё]/g, 'е')
  .replace(/[^a-zа-я0-9]+/gi, '');

export function titleLayoutSpecFor(modelName, facts = null) {
  const sourceName = modelName || facts?.modelName || getBrandProfile(facts?.profileId).displayName || '';
  const spec = resolveTitleSpec(sourceName);
  const savedPolicy = String(facts?.seriesPolicy || '').toLowerCase();
  if (Number(facts?.titleLayoutVersion || 0) >= 1
    && ['required', 'optional', 'forbidden'].includes(savedPolicy)) {
    return Object.freeze({
      ...spec,
      seriesRequired: savedPolicy === 'required',
      titleLayout: Object.freeze({
        ...(spec.titleLayout || {}),
        version: Number(facts.titleLayoutVersion),
        brandLineCount: Math.max(1, Number(facts.brandLineCount || spec.titleLayout?.brandLineCount || 1)),
        seriesPolicy: savedPolicy
      })
    });
  }
  return spec;
}

export function isLegacyPaganiBrandStack(facts, modelName = '') {
  const profile = String(facts?.profileId || detectBrandProfile(modelName || facts?.modelName || ''));
  return profile === 'pagani_design'
    && normalized(facts?.titleBrand) === 'pagani'
    && normalized(facts?.titleSeries) === 'design';
}

export function displayTitleBrand(facts, modelName = '') {
  return isLegacyPaganiBrandStack(facts, modelName) ? 'Pagani Design' : String(facts?.titleBrand || '');
}

export function titleLayoutWarnings(facts, titleSpec) {
  if (!facts || typeof facts !== 'object' || !titleSpec) return [];
  const warnings = [];
  const actualBrand = normalized(facts.titleBrand);
  const actualSeries = normalized(facts.titleSeries);
  const actualModel = normalized(facts.titleModel);
  const layout = titleSpec.titleLayout || {};
  const policy = layout.seriesPolicy || (titleSpec.seriesRequired ? 'required' : 'optional');
  const expectedBrand = normalized(titleSpec.brand);
  const expectedSeries = normalized(titleSpec.explicitSeriesPrint);
  const expectedModel = normalized(titleSpec.referenceCode);
  const legacyPagani = isLegacyPaganiBrandStack(facts, titleSpec.brand);

  if (Array.isArray(titleSpec.fixedLines)) {
    const brandLines = Array.isArray(layout.brandLines) && layout.brandLines.length
      ? layout.brandLines : titleSpec.fixedLines.slice(0, Math.max(1, Number(layout.brandLineCount || 1)));
    const fixedBrand = normalized(brandLines.join(' ') || titleSpec.brand);
    if (!legacyPagani && fixedBrand && fixedBrand !== actualBrand) warnings.push('TITLE_BRAND_MISMATCH');
    if (policy === 'forbidden') {
      if (actualSeries && !legacyPagani) warnings.push('TITLE_SERIES_MISMATCH');
      if (normalized(titleSpec.fixedLines.at(-1)) !== actualModel) warnings.push('TITLE_MODEL_MISMATCH');
    } else {
      const expectedSeriesLine = normalized(titleSpec.fixedLines[brandLines.length]);
      if (expectedSeriesLine !== actualSeries) warnings.push('TITLE_SERIES_MISMATCH');
      if (normalized(titleSpec.fixedLines.at(-1)) !== actualModel) warnings.push('TITLE_MODEL_MISMATCH');
    }
    return [...new Set(warnings)];
  }

  if (expectedBrand && actualBrand && expectedBrand !== actualBrand) warnings.push('TITLE_BRAND_MISMATCH');
  if (expectedBrand && !actualBrand) warnings.push('MISSING_TITLE_BRAND');
  if (policy === 'required' && !actualSeries) warnings.push('MISSING_SERIES');
  if (policy === 'forbidden' && actualSeries) warnings.push('TITLE_SERIES_MISMATCH');
  if (expectedSeries && actualSeries && expectedSeries !== actualSeries) warnings.push('TITLE_SERIES_MISMATCH');
  if (expectedSeries && !actualSeries) warnings.push('MISSING_SERIES');
  if (actualSeries && policy !== 'forbidden'
    && Array.isArray(titleSpec.seriesVocabulary) && titleSpec.seriesVocabulary.length
    && !titleSpec.seriesVocabulary.some((series) => normalized(series) === actualSeries)) {
    warnings.push('TITLE_SERIES_MISMATCH');
  }
  if (expectedModel && actualModel && expectedModel !== actualModel) warnings.push('TITLE_MODEL_MISMATCH');
  if (expectedModel && !actualModel) warnings.push('MISSING_TITLE_MODEL');
  return [...new Set(warnings)];
}
