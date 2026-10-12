import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_CATEGORY_LABELS, QUALITY_RULE_VERSION, auditCardRecords, buildComparisonGroups,
  canonicalQualityFingerprint, comparisonFamily, qualityIssueReason, sizeInMm, waterInBar
} from '../extension/gallery-quality-utils.js';
import { effectiveFactsWarnings } from '../extension/gallery-utils.js';

const baseFacts = Object.freeze({
  profileId: 'casio', titleBrand: 'Casio', titleSeries: 'G-Shock', titleModel: 'GA-2100-1A1',
  utp1: 'Минеральное стекло', utp2: 'Ударопрочный корпус',
  waterResistance: '20 бар водозащита', caseSize: '45,4 мм размер корпуса', warnings: []
});

function watch(overrides = {}) {
  const facts = { ...baseFacts, ...(overrides.facts || {}) };
  return {
    generationId: 'generation-1', sourceId: 'casio:GA21001A1', outputHash: 'a'.repeat(64),
    profileId: 'casio', modelName: 'Casio G-Shock GA-2100-1A1', factsStatus: 'ok',
    facts, ...overrides, facts
  };
}

const issueFor = (record, code, options) => auditCardRecords([record], options).find(issue => issue.code === code);

test('water resistance accepts equivalent units and nonnumeric WR markings, with one explanation for missing or bad units', () => {
  assert.equal(waterInBar('50 м водозащита'), 5);
  assert.equal(waterInBar('5 ATM'), 5);
  assert.equal(waterInBar('5 атм'), 5);
  assert.equal(waterInBar('50 м / 5 bar'), 5);
  assert.equal(waterInBar('-5 bar'), -5);
  assert.equal(waterInBar('50 м / 10 bar'), null);

  for (const value of ['WR', 'Water Resistant', 'водостойкие']) {
    const result = auditCardRecords([watch({ facts: { waterResistance: value } })]);
    assert.equal(result.some(issue => issue.field === 'waterResistance' && issue.category === 'value'), false, value);
  }

  const missingUnit = auditCardRecords([watch({ facts: { waterResistance: '50' } })]);
  assert.equal(missingUnit.filter(issue => issue.field === 'waterResistance').length, 1);
  assert.equal(missingUnit[0].code, 'WATER_RESISTANCE_UNIT_MISSING');
  const unknownUnit = issueFor(watch({ facts: { waterResistance: '50 fathoms' } }), 'INVALID_WATER_RESISTANCE_UNIT');
  assert.match(unknownUnit.reason, /единиц/i);
  const conflicting = issueFor(watch({ facts: { waterResistance: '50 м / 10 bar' } }), 'AMBIGUOUS_WATER_RESISTANCE');
  assert.match(conflicting.reason, /несовпадающие значения/i);
  assert.equal(issueFor(watch({ facts: { waterResistance: '+50' } }), 'WATER_RESISTANCE_UNIT_MISSING').resolvable, true);
  assert.equal(issueFor(watch({ facts: { waterResistance: '-5 bar' } }), 'WATER_RESISTANCE_OUT_OF_RANGE').resolvable, true);
  const missing = auditCardRecords([watch({ facts: { waterResistance: '' } })]);
  assert.equal(missing.filter(issue => issue.field === 'waterResistance').length, 1);
  assert.equal(missing.find(issue => issue.field === 'waterResistance').code, 'MISSING_WATER_RESISTANCE');
});

test('case size parser accepts mm/cm, rejects ambiguous axes, and allows 83 mm only for stopwatches', () => {
  assert.equal(sizeInMm('40,5 мм диаметр'), 40.5);
  assert.equal(sizeInMm('4.05 cm'), 40.5);
  assert.equal(sizeInMm('-45 mm'), -45);
  assert.equal(sizeInMm('42 × 46 × 13 мм'), null);
  assert.equal(sizeInMm('42*46*13 mm'), null);

  const wristIssue = issueFor(watch({ facts: { caseSize: '83 мм' } }), 'CASE_SIZE_OUT_OF_RANGE');
  assert.equal(wristIssue.category, 'value');
  assert.equal(wristIssue.resolvable, true);
  const stopwatch = watch({
    sourceId: 'casio:HS80TW', modelName: 'Casio HS-80TW Stopwatch',
    facts: { titleModel: 'HS-80TW', titleSeries: '', caseSize: '83 мм' }
  });
  assert.equal(auditCardRecords([stopwatch]).some(issue => issue.code === 'CASE_SIZE_OUT_OF_RANGE'), false);

  const multiAxis = issueFor(watch({ facts: { caseSize: '42 × 46 × 13 мм' } }), 'AMBIGUOUS_CASE_SIZE');
  assert.match(multiAxis.reason, /несколько осей/i);
  const missingUnit = issueFor(watch({ facts: { caseSize: '45' } }), 'CASE_SIZE_UNIT_MISSING');
  assert.match(missingUnit.reason, /единица измерения/i);
  assert.equal(issueFor(watch({ facts: { caseSize: '-45 мм' } }), 'CASE_SIZE_OUT_OF_RANGE').resolvable, true);
});

test('computed missing and title warnings follow current facts and layout policy while extraction warnings survive', () => {
  const record = watch({ facts: {
    titleModel: 'GA-2100-1A1', utp1: 'Минеральное стекло', utp2: '', titleSeries: 'G-Shock',
    warnings: ['MISSING_UTP_1', 'MISSING_UTP_2', 'TITLE_MODEL_MISMATCH', 'ENGINE_OCR_REVIEW']
  } });
  const warnings = effectiveFactsWarnings(record.facts, record.modelName);
  assert.equal(warnings.includes('MISSING_UTP_1'), false);
  assert.equal(warnings.includes('TITLE_MODEL_MISMATCH'), false);
  assert.equal(warnings.includes('MISSING_UTP_2'), true);
  assert.equal(warnings.includes('ENGINE_OCR_REVIEW'), true);

  const issues = auditCardRecords([record]);
  assert.equal(issues.some(issue => issue.code === 'MISSING_UTP_1'), false);
  assert.equal(issues.some(issue => issue.code === 'TITLE_MODEL_MISMATCH'), false);
  assert.equal(issues.filter(issue => issue.code === 'MISSING_UTP_2').length, 1);
  assert.equal(issues.filter(issue => issue.code === 'ENGINE_OCR_REVIEW').length, 1);
  const parseError = issueFor(watch({ facts: { warnings: ['FACTS_PARSE_ERROR'] } }), 'FACTS_PARSE_ERROR');
  assert.match(parseError.reason, /Не удалось разобрать ответ/);
  assert.equal(parseError.resolvable, false);

  for (const policyRecord of [
    watch({ profileId: 'benyar', modelName: 'Benyar BY-5101-1B', facts: {
      profileId: 'benyar', titleBrand: 'Benyar', titleSeries: '', titleModel: 'BY-5101-1B',
      warnings: ['MISSING_SERIES']
    } }),
    watch({ modelName: 'Casio Classic A168WA-1', facts: {
      profileId: 'casio', titleBrand: 'Casio', titleSeries: '', titleModel: 'A168WA-1',
      titleLayoutVersion: 1, seriesPolicy: 'forbidden', warnings: ['MISSING_SERIES']
    } })
  ]) {
    assert.equal(effectiveFactsWarnings(policyRecord.facts, policyRecord.modelName).includes('MISSING_SERIES'), false);
  }

  const mismatch = issueFor(watch({ facts: { titleModel: 'GA-9999-1A1' } }), 'TITLE_MODEL_MISMATCH');
  assert.match(mismatch.reason, /GA-9999-1A1.*GA-2100-1A1/);
  assert.equal(mismatch.category, 'value');
  assert.equal(mismatch.resolvable, true);
});

test('fingerprints scope resolutions to a rule, exact revision identity, relevant facts, and current family context', () => {
  const first = watch({ facts: { titleModel: 'GA-9999-1A1' } });
  const issue = issueFor(first, 'TITLE_MODEL_MISMATCH');
  assert.equal(typeof issue.fingerprint, 'string');
  assert.equal(issue.fingerprint, canonicalQualityFingerprint(JSON.parse(issue.fingerprint)));
  assert.match(issue.fingerprint, new RegExp(QUALITY_RULE_VERSION));
  assert.equal(issue.resolvable, true);

  const missing = issueFor(watch({ facts: { utp1: '' } }), 'MISSING_UTP_1');
  assert.equal(missing.resolvable, false);
  const mismatch = issueFor(watch({ imageTextMatchesFacts: false }), 'IMAGE_TEXT_MISMATCH');
  assert.equal(mismatch.resolvable, false);

  first.qualityIssueResolutions = [{ id: issue.id, fingerprint: issue.fingerprint, reviewedAt: '2026-10-12T00:00:00Z', comment: 'Сверено' }];
  assert.equal(auditCardRecords([first]).some(item => item.code === issue.code), false);
  const included = auditCardRecords([first], { includeResolved: true }).find(item => item.code === issue.code);
  assert.equal(included.resolved, true);
  const transientOverlay = { ...first, outputPath: 'D:/other/card.png', modifiedAt: 123, artifactMode: 'historical' };
  assert.equal(issueFor(transientOverlay, issue.code, { includeResolved: true }).fingerprint, issue.fingerprint);

  const nextRevision = { ...first, generationId: 'generation-2' };
  assert.equal(auditCardRecords([nextRevision]).some(item => item.code === issue.code), true);
  const changedHash = { ...first, outputHash: 'b'.repeat(64) };
  assert.equal(auditCardRecords([changedHash]).some(item => item.code === issue.code), true);
  const changedSource = { ...first, sourceId: 'casio:OTHER-SKU' };
  assert.equal(auditCardRecords([changedSource]).some(item => item.code === issue.code), true);
  const changedFact = { ...first, facts: { ...first.facts, titleModel: 'GA-8888-1A1' } };
  assert.equal(auditCardRecords([changedFact]).some(item => item.code === issue.code), true);
  const unresolvable = { ...watch({ imageTextMatchesFacts: false }), qualityIssueResolutions: [{ id: mismatch.id, fingerprint: mismatch.fingerprint }] };
  assert.equal(auditCardRecords([unresolvable]).some(item => item.code === 'IMAGE_TEXT_MISMATCH'), true);

  const extraction = watch({ facts: { warnings: ['ENGINE_OCR_REVIEW'] } });
  const extractionIssue = issueFor(extraction, 'ENGINE_OCR_REVIEW');
  extraction.qualityIssueResolutions = [{ id: extractionIssue.id, fingerprint: extractionIssue.fingerprint }];
  assert.equal(auditCardRecords([extraction]).some(item => item.code === 'ENGINE_OCR_REVIEW'), false);
  const changedRead = { ...extraction, facts: { ...extraction.facts, utp1: 'Сапфировое стекло' } };
  assert.equal(auditCardRecords([changedRead]).some(item => item.code === 'ENGINE_OCR_REVIEW'), true);
});

test('comparison groups stay conservative, source-code-led, deterministic, and never replace a member value', () => {
  const a = watch({ facts: { titleModel: 'OCR-ERROR-A', waterResistance: '50 м', caseSize: '45 мм' } });
  const b = watch({
    generationId: 'generation-2', sourceId: 'casio:GA21002A', outputHash: 'b'.repeat(64),
    modelName: 'Casio G-Shock GA-2100-2A',
    facts: { titleModel: 'OCR-ERROR-B', waterResistance: '5 атм', caseSize: '42 мм' }
  });
  const family = comparisonFamily(a);
  assert.equal(family, 'casio:GA2100');
  assert.equal(comparisonFamily(b), family);
  const group = buildComparisonGroups([a, b])[0];
  assert.deepEqual(group.fields, ['waterResistance', 'caseSize']);
  assert.deepEqual(group.differingFields, ['caseSize']);
  assert.deepEqual(buildComparisonGroups([b, a])[0].members.map(item => item.sourceId), group.members.map(item => item.sourceId));

  const forward = auditCardRecords([a, b]).filter(issue => issue.code === 'VARIANT_VALUE_MISMATCH');
  const reverse = auditCardRecords([b, a]).filter(issue => issue.code === 'VARIANT_VALUE_MISMATCH');
  assert.equal(forward.length, 2);
  assert.deepEqual(forward.map(item => item.fingerprint).sort(), reverse.map(item => item.fingerprint).sort());
  assert.deepEqual(forward, reverse);
  assert.ok(forward.every(item => item.related.length === 1 && item.reason.startsWith('Разные значения')));
  assert.deepEqual([a.facts.caseSize, b.facts.caseSize], ['45 мм', '42 мм']);
  const resolvedA = {
    ...a,
    qualityIssueResolutions: [{ id: forward.find(issue => issue.sourceId === a.sourceId).id,
      fingerprint: forward.find(issue => issue.sourceId === a.sourceId).fingerprint }]
  };
  assert.equal(auditCardRecords([resolvedA, b]).some(issue => issue.sourceId === a.sourceId && issue.code === 'VARIANT_VALUE_MISMATCH'), false);
  const changedRelated = { ...b, facts: { ...b.facts, caseSize: '43 мм' } };
  assert.equal(auditCardRecords([resolvedA, changedRelated]).some(issue => issue.sourceId === a.sourceId && issue.code === 'VARIANT_VALUE_MISMATCH'), true);

  const c = { ...b, sourceId: 'pagani_design:PD1759CBWWS' };
  assert.equal(comparisonFamily({ ...c, profileId: 'unsupported_brand' }), null);
  assert.equal(comparisonFamily({ profileId: 'tissot', sourceId: 'tissot:T0062071105802', modelName: 'Tissot T006.207.11.058.02' }), 'tissot:T006.207.11');
  assert.equal(QUALITY_CATEGORY_LABELS.variants, 'Расхождения между расцветками');
  assert.deepEqual(QUALITY_CATEGORY_LABELS, {
    extraction: 'Распознавание текста', value: 'Проверить значение', variants: 'Расхождения между расцветками'
  });
});

test('legacy Pagani title stack is tolerated and edit warnings join the audit without dismissing image text mismatch', () => {
  const legacy = watch({
    profileId: 'pagani_design', sourceId: 'pagani_design:PD1759CBWWS', modelName: 'Pagani Design PD-1759CBWWS',
    facts: {
      profileId: 'pagani_design', titleBrand: 'Pagani', titleSeries: 'Design', titleModel: 'PD-1759CBWWS',
      warnings: ['TITLE_BRAND_MISMATCH', 'TITLE_SERIES_MISMATCH', 'MISSING_SERIES']
    }
  });
  assert.equal(effectiveFactsWarnings(legacy.facts, legacy.modelName).some(code => code.startsWith('TITLE_') || code === 'MISSING_SERIES'), false);
  assert.equal(comparisonFamily(legacy), 'pagani:1759');

  const edited = watch({ imageTextMatchesFacts: false, editWarnings: [
    'ChatGPT изменил размеры изображения. Проверь композицию новой версии',
    'ChatGPT изменил размеры изображения. Проверь композицию новой версии',
    'Проверь расположение логотипа'
  ] });
  const issues = auditCardRecords([edited], { includeResolved: true });
  const editWarning = issues.find(issue => issue.code === 'EDIT_WARNING');
  const imageMismatch = issues.find(issue => issue.code === 'IMAGE_TEXT_MISMATCH');
  assert.match(qualityIssueReason(editWarning), /изменил размеры/);
  assert.match(qualityIssueReason(editWarning), /логотипа/);
  assert.equal(editWarning.category, 'value');
  assert.equal(imageMismatch.resolvable, false);
  assert.equal(imageMismatch.resolved, false);
});
