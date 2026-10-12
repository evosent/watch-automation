import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCardRecords } from '../extension/gallery-quality-utils.js';
import { cardQualityIssues, renderCardQuality, renderComparisonGroups } from '../extension/gallery-quality-ui.js';

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function record(generationId, code, overrides = {}) {
  const sourceId = `casio:${code.replaceAll('-', '').toLowerCase()}`;
  const facts = {
    profileId: 'casio', titleBrand: 'Casio', titleSeries: 'G-Shock', titleModel: code,
    utp1: 'Ударопрочный корпус', utp2: 'Минеральное стекло',
    waterResistance: 'WR', caseSize: '45 мм', ...overrides.facts
  };
  return {
    sourceId, generationId, modelName: `Casio G-Shock ${code}`, profileId: 'casio', factsStatus: 'ok',
    facts, ...overrides, facts: { ...facts, ...(overrides.facts || {}) }
  };
}

const issueArticleCount = html => (html.match(/<article class="quality-issue/g) || []).length;

test('selected card shows every active audit issue in its category, regardless of severity', () => {
  const one = record('g1', 'GA-2100-1A', {
    facts: { warnings: ['MYSTERY_WARNING'], waterResistance: 'WR', caseSize: '83 мм' }
  });
  const two = record('g2', 'GA-2100-2A', { facts: { waterResistance: '20 бар', caseSize: '42 мм' } });
  const all = [one, two];
  const expected = auditCardRecords(all, { includeResolved: true }).filter(issue =>
    issue.sourceId === one.sourceId && issue.generationId === one.generationId && !issue.resolved
  );
  const html = renderCardQuality(one, all, escapeHtml);

  assert.equal(issueArticleCount(html), expected.length);
  assert.match(html, new RegExp(`Активных замечаний: ${expected.length}`));
  assert.match(html, /Распознавание текста/);
  assert.match(html, /Проверить значение/);
  assert.match(html, /Расхождения между расцветками/);
  assert.match(html, /MYSTERY_WARNING/);
  assert.match(html, /83 мм/);
  assert.match(html, /20 бар/);
  assert.match(html, /data-review-action="quality-confirm"/);
});

test('recognized WR marking is readable and does not create a false numeric water-resistance warning', () => {
  const one = record('g1', 'GA-2100-1A');
  const html = renderCardQuality(one, [one], escapeHtml);
  assert.match(html, /Активных замечаний: 0/);
  assert.match(html, /Активных замечаний нет\. Достоверность характеристик требует сверки с источником/);
  assert.doesNotMatch(html, /INVALID_WATER_RESISTANCE|WATER_RESISTANCE_UNIT_MISSING/);
});

test('related variant context links to the exact source and generation, and family table includes all members', () => {
  const one = record('g1', 'GA-2100-1A', { facts: { waterResistance: '5 бар' } });
  const two = record('g2', 'GA-2100-2A', { facts: { waterResistance: '20 бар' } });
  const html = renderCardQuality(one, [one, two], escapeHtml);
  const issue = cardQualityIssues(one, [one, two]).find(item => item.category === 'variants' && item.field === 'waterResistance');

  assert.ok(issue, 'the family mismatch should be present for the selected exact version');
  assert.match(html, /Связанный контекст/);
  assert.match(html, /Casio G-Shock GA-2100-2A: 20 бар/);
  assert.match(html, new RegExp(`data-quality-open-source="${two.sourceId}"`));
  assert.match(html, new RegExp(`data-quality-open-generation="${two.generationId}"`));
  assert.match(html, /class="quality-family"/);
  assert.match(html, /Выбранная версия/);
  assert.match(html, /Сверьте точные артикулы с источником/);
  assert.match(html, /data-quality-open-source="casio:ga21002a"/);
});

test('resolved issues stay collapsed with an exact reopen action and current fingerprints', () => {
  const original = record('g1', 'GA-2100-1A', { facts: { caseSize: '83 мм' } });
  const issue = auditCardRecords([original], { includeResolved: true }).find(item => item.code === 'CASE_SIZE_OUT_OF_RANGE');
  assert.ok(issue);
  const resolved = {
    ...original,
    qualityIssueResolutions: [{ id: issue.id, fingerprint: issue.fingerprint, reviewedAt: '2026-10-12T10:00:00Z', comment: 'Сверено с источником' }]
  };
  const html = renderCardQuality(resolved, [original], escapeHtml);

  assert.match(html, /Подтверждённые замечания: 1/);
  assert.match(html, /<details class="quality-resolved">/);
  assert.match(html, /data-review-action="quality-reopen"/);
  assert.match(html, /Вернуть на проверку/);
  assert.doesNotMatch(html, /data-review-action="quality-confirm"/);
  assert.equal(cardQualityIssues(resolved, [original]).find(item => item.id === issue.id)?.fingerprint, issue.fingerprint);
});

test('non-resolvable extraction errors have no confirm control, and untrusted text is escaped', () => {
  const blockedRecord = record('blocked-g', 'GA-2100-1A', { factsStatus: 'error' });
  const blockedHtml = renderCardQuality(blockedRecord, [blockedRecord], escapeHtml);
  const issues = cardQualityIssues(blockedRecord, [blockedRecord]);
  const blocked = issues.find(item => item.code === 'FACTS_ERROR');
  assert.ok(blocked && blocked.resolvable === false);
  assert.doesNotMatch(blockedHtml, /Проверено — значение верное/);

  const untrusted = record('untrusted-g', '<img src=x onerror=alert(1)>', {
    facts: { titleModel: '<script>alert(1)</script>', warnings: ['<img src=x onerror=alert(1)>'] }
  });
  const untrustedHtml = renderCardQuality(untrusted, [untrusted], escapeHtml);
  const comparisonHtml = renderComparisonGroups([{
    id: '<unsafe>', label: '<script>label</script>', members: [untrusted], fields: [], differingFields: []
  }], [], escapeHtml);
  assert.match(untrustedHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(comparisonHtml, /&lt;script&gt;label&lt;\/script&gt;/);
  assert.match(comparisonHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(`${untrustedHtml}${comparisonHtml}`, /<img src=x onerror=alert\(1\)>|<script>(?:label|alert\(1\))<\/script>/);
});

test('historical review replaces only the selected source row and names the exact generation', () => {
  const accepted = record('accepted-g', 'GA-2100-1A', { facts: { caseSize: '45 мм' } });
  const historical = record('history-g', 'GA-2100-1A', { facts: { caseSize: '83 мм' } });
  const html = renderCardQuality(historical, [accepted], escapeHtml);

  assert.match(html, /data-quality-generation="history-g"/);
  assert.match(html, /Проверяется выбранная версия; фильтр галереи относится к основной\./);
  assert.match(html, /83 мм/);
  assert.doesNotMatch(html, /data-quality-generation="accepted-g"/);
  assert.equal(cardQualityIssues(historical, [accepted]).every(issue => issue.generationId === 'history-g'), true);
});

test('main comparison groups highlight only differing columns and link exact rows', () => {
  const one = record('g1', 'GA-2100-1A', { facts: { waterResistance: '5 бар' } });
  const two = record('g2', 'GA-2100-2A', { facts: { waterResistance: '20 бар' } });
  const group = {
    id: 'casio:GA-2100', label: 'Casio GA-2100', members: [one, two],
    fields: ['waterResistance', 'caseSize'], differingFields: ['waterResistance']
  };
  const issues = auditCardRecords([one, two], { includeResolved: true });
  const html = renderComparisonGroups([group], issues, escapeHtml);

  assert.match(html, /class="comparison-group"/);
  assert.match(html, /Водозащита<\/th>/);
  assert.match(html, /<th scope="col">Размер корпуса<\/th>/, 'the invariant size column stays unhighlighted');
  assert.match(html, /<th scope="col" class="is-different">Водозащита<\/th>/);
  assert.match(html, /data-quality-open-generation="g2"/);
  assert.match(html, /Значения не копируются между карточками/);
});
