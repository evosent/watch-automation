import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCardRecords } from '../extension/gallery-quality-utils.js';
import { matchesGalleryQualityFilter } from '../extension/gallery-quality-filters.js';
import { cardWorkbookSheets } from '../extension/card-workbook.js';

const card = (code = 'GA-2100-1A', size = '45 мм') => ({
  sourceId: `casio:${code.replaceAll('-', '')}`, generationId: code, outputHash: 'a'.repeat(64),
  profileId: 'casio', modelName: `Casio G-Shock ${code}`, factsStatus: 'ok',
  facts: { titleBrand: 'Casio', titleModel: code, titleSeries: 'G-Shock',
    utp1: 'Минеральное стекло', utp2: 'Ударопрочный корпус', waterResistance: '20 бар', caseSize: size }
});

test('QA filters distinguish value checks, extraction and color differences on the exact version', () => {
  const a = card('GA-2100-1A', '83 мм'), b = card('GA-2100-2A', '43 мм');
  const issues = auditCardRecords([a, b]);
  assert.equal(matchesGalleryQualityFilter(a, 'warnings', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'quality_issues', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'variants', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'extraction', issues), false);
  assert.equal(matchesGalleryQualityFilter(b, 'quality_issues', issues), false);
  assert.equal(matchesGalleryQualityFilter(b, 'variants', issues), true);
  assert.equal(matchesGalleryQualityFilter({ ...a, generationId: 'old' }, 'warnings', issues), false);
  const resolved = issues.map(issue => ({ ...issue, resolved: true }));
  assert.equal(matchesGalleryQualityFilter(a, 'warnings', resolved), false);
});

test('title filter includes brand and model problems; extraction errors are readable under the error filter', () => {
  const a = card(); a.facts.titleBrand = 'Ошибочный бренд';
  a.facts.utp1 = ''; a.facts.warnings = ['FACTS_PARSE_ERROR'];
  const issues = auditCardRecords([a]);
  assert.equal(matchesGalleryQualityFilter(a, 'missing_series', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'missing_utp', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'error', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'extraction', issues), true);
  assert.equal(matchesGalleryQualityFilter(a, 'missing_water', issues), false);
});

test('filtered Excel retains full comparison context and explicit confirmed issue decisions', () => {
  const a = card('GA-2100-1A', '45 мм'), b = card('GA-2100-2A', '43 мм');
  const issues = auditCardRecords([a, b]);
  a.qualityIssueResolutions = [{ id: issues[0].id, fingerprint: issues[0].fingerprint, reviewedAt: '2026-10-12' }];
  const sheets = cardWorkbookSheets([a], { auditRecords: [a, b] });
  const checks = sheets.find(sheet => sheet.name === 'Проверки').rows;
  assert.equal(checks.length, 2);
  assert.equal(checks[1][9], 'Подтверждено для этой версии');
  assert.match(checks[1][5], /GA-2100-2A/);
  assert.equal(sheets[0].rows[1][12], '');
  const open = cardWorkbookSheets([b], { auditRecords: [a, b] });
  assert.match(open[0].rows[1][11], /Активных замечаний: 1/);
  assert.equal(open[1].rows[1][9], 'Требует проверки');
});
