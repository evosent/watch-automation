import {
  CARD_FIELDS,
  QUALITY_CATEGORY_LABELS,
  auditCardRecords,
  buildComparisonGroups,
  qualityIssueReason
} from './gallery-quality-utils.js';

const REVIEW_CATEGORY_LABELS = Object.freeze({
  extraction: 'Распознавание текста',
  value: 'Проверить значение',
  variants: 'Расхождения между расцветками'
});

const asText = value => value == null ? '' : String(value);
const fieldLabel = field => CARD_FIELDS.find(([key]) => key === field)?.[1] || (field ? asText(field) : 'Общее замечание');
const factValue = (record, field) => asText(record?.facts?.[field]).trim() || 'Не указано';
const modelCode = record => asText(record?.facts?.titleModel || record?.modelName || record?.fileName).trim() || 'Не указан';
const currentKey = record => `${asText(record?.sourceId)}\u0000${asText(record?.generationId)}`;
const escapeDefault = value => asText(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const escFn = escapeHtml => typeof escapeHtml === 'function' ? escapeHtml : escapeDefault;

function categoryLabel(category, escapeHtml) {
  if (Object.hasOwn(REVIEW_CATEGORY_LABELS, category)) return REVIEW_CATEGORY_LABELS[category];
  const labels = QUALITY_CATEGORY_LABELS || {};
  const label = labels instanceof Map ? labels.get(category)
    : Object.hasOwn(labels, category) ? labels[category] : '';
  return label ? escapeHtml(label) : escapeHtml(category || 'Другие замечания');
}

function reviewRowsFor(record, records = []) {
  const rows = (records || []).map(row => row?.sourceId === record?.sourceId ? record : row);
  if (record?.sourceId && !rows.some(row => row?.sourceId === record.sourceId)) rows.push(record);
  return rows;
}

export function cardQualityIssues(record, records = []) {
  const rows = reviewRowsFor(record, records);
  return auditCardRecords(rows, { includeResolved: true }).filter(issue =>
    issue.sourceId === record?.sourceId && issue.generationId === record?.generationId
  );
}

function renderRelated(related, records, escapeHtml) {
  const items = Array.isArray(related) ? related : [];
  if (!items.length) return '';
  const rows = (records || []).filter(row => row?.sourceId && row?.generationId);
  return `<div class="quality-issue-related"><span class="quality-context-label">Связанный контекст</span><ul>${items.map(item => {
    const text = asText(item).trim();
    const relatedLabel = text.split(':', 1)[0].trim().toLocaleLowerCase('ru');
    const match = rows.find(row => [modelCode(row), row.modelName, row.sourceName, row.sourceId]
      .some(value => asText(value).trim().toLocaleLowerCase('ru') === relatedLabel));
    const open = match
      ? ` <button type="button" class="quality-related-open" data-quality-open-source="${escapeHtml(match.sourceId)}" data-quality-open-generation="${escapeHtml(match.generationId)}">Открыть ${escapeHtml(modelCode(match))}</button>`
      : '';
    return `<li>${escapeHtml(text)}${open}</li>`;
  }).join('')}</ul></div>`;
}

function renderIssue(issue, index, records, escapeHtml, { resolved = false } = {}) {
  const reason = issue.reason || qualityIssueReason(issue.code, { value: issue.value, reason: issue.reason }) || issue.code || 'Требуется сверка с источником';
  const value = factValue({ facts: { [issue.field]: issue.value } }, issue.field);
  const field = fieldLabel(issue.field);
  const related = renderRelated(issue.related, records, escapeHtml);
  const action = resolved
    ? `<button type="button" data-review-action="quality-reopen" data-quality-decision="${index}">Вернуть на проверку</button>`
    : issue.resolvable
      ? `<button type="button" data-review-action="quality-confirm" data-quality-decision="${index}">Проверено — значение верное</button>`
      : '';
  return `<article class="quality-issue${resolved ? ' is-resolved' : ''}" data-quality-severity="${escapeHtml(issue.severity || '')}">
    <p class="quality-issue-reason">${escapeHtml(reason)}</p>
    <dl class="quality-issue-facts"><div><dt>Поле</dt><dd>${escapeHtml(field)}</dd></div><div><dt>Значение</dt><dd><code>${escapeHtml(value)}</code></dd></div></dl>
    ${related}${action ? `<div class="quality-issue-actions">${action}</div>` : ''}
  </article>`;
}

function renderQualityFamily(group, issues, records, record, escapeHtml) {
  const differingFields = new Set(group.differingFields || []);
  const activeCount = issues.filter(issue => !issue.resolved && issue.category === 'variants' && issue.familyId === group.id).length;
  const exactCurrentKey = currentKey(record);
  const members = (group.members || []).map(member => ({
    ...member,
    qualityCurrent: currentKey(member) === exactCurrentKey
  }));
  const label = group.label || group.id || 'Семейство моделей';
  return `<section class="quality-family" data-quality-family="${escapeHtml(group.id || '')}">
    <header><h4>${escapeHtml(label)}</h4><span>Вариантов: ${members.length}</span>${activeCount ? `<span class="quality-family-active">Замечаний у выбранной версии: ${activeCount}</span>` : ''}</header>
    <p class="quality-family-note">Группировка показывает возможные расцветки. Сверьте точные артикулы с источником; совпадение большинства не подтверждает характеристику.</p>
    ${comparisonTable(members, differingFields, escapeHtml)}
  </section>`;
}

function comparisonTable(members, differingFields, escapeHtml) {
  return `<div class="comparison-table-wrap"><table class="comparison-table">
    <thead><tr><th scope="col">Модель</th><th scope="col"${differingFields.has('waterResistance') ? ' class="is-different"' : ''}>Водозащита</th><th scope="col"${differingFields.has('caseSize') ? ' class="is-different"' : ''}>Размер корпуса</th><th scope="col">Карточка</th></tr></thead>
    <tbody>${members.map(member => {
      const current = Boolean(member.qualityCurrent || member.isQualityCurrent || member.isCurrent);
      const code = modelCode(member);
      const available = Boolean(member.sourceId && member.generationId);
      return `<tr class="${current ? 'is-current' : ''}"${current ? ' aria-current="true"' : ''}>
        <th scope="row">${escapeHtml(code)}${current ? '<span class="quality-current-indicator">Выбранная версия</span>' : ''}</th>
        <td${differingFields.has('waterResistance') ? ' class="is-different"' : ''}>${escapeHtml(factValue(member, 'waterResistance'))}</td>
        <td${differingFields.has('caseSize') ? ' class="is-different"' : ''}>${escapeHtml(factValue(member, 'caseSize'))}</td>
        <td>${available ? `<button type="button" data-quality-open-source="${escapeHtml(member.sourceId)}" data-quality-open-generation="${escapeHtml(member.generationId)}">Открыть ${escapeHtml(code)}</button>` : '<span>Переход недоступен</span>'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

export function renderCardQuality(record, records, escapeHtml) {
  const escape = escFn(escapeHtml);
  const rows = reviewRowsFor(record, records);
  const issues = cardQualityIssues(record, rows);
  const active = issues.map((issue, index) => ({ issue, index })).filter(({ issue }) => !issue.resolved);
  const resolved = issues.map((issue, index) => ({ issue, index })).filter(({ issue }) => issue.resolved);
  const categories = ['extraction', 'value', 'variants'];
  const grouped = categories.map(category => ({ category, entries: active.filter(({ issue }) => issue.category === category) })).filter(group => group.entries.length);
  const groupedMarkup = grouped.map(({ category, entries }) => `<section class="quality-category" data-quality-category="${escape(category)}">
      <h4>${categoryLabel(category, escape)} <span>${entries.length}</span></h4>
      <div class="quality-category-issues">${entries.map(({ issue, index }) => renderIssue(issue, index, rows, escape)).join('')}</div>
    </section>`).join('');
  const groups = buildComparisonGroups(rows).filter(group => (group.members || []).some(member => currentKey(member) === currentKey(record)));
  const families = groups.map(group => renderQualityFamily(group, issues, rows, record, escape)).join('');
  const resolvedMarkup = resolved.length ? `<details class="quality-resolved"><summary>Подтверждённые замечания: ${resolved.length}</summary>
      <div class="quality-resolved-list">${resolved.map(({ issue, index }) => renderIssue(issue, index, rows, escape, { resolved: true })).join('')}</div>
    </details>` : '';
  const empty = active.length === 0
    ? '<p class="quality-empty">Активных замечаний нет. Достоверность характеристик требует сверки с источником.</p>'
    : '';
  return `<section class="card-quality-review" data-quality-source="${escape(record?.sourceId || '')}" data-quality-generation="${escape(record?.generationId || '')}">
    <header class="card-quality-review-header"><h3>Проверка карточки</h3><span class="quality-active-count">Активных замечаний: ${active.length}</span></header>
    <p class="quality-version-context">Проверяется выбранная версия; фильтр галереи относится к основной.</p>
    ${empty}${groupedMarkup}${families}${resolvedMarkup}
  </section>`;
}

export function renderComparisonGroups(groups, issues, escapeHtml) {
  const escape = escFn(escapeHtml);
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return '<section class="comparison-groups"><p class="comparison-groups-empty">Группы возможных вариантов не найдены.</p></section>';
  const allIssues = Array.isArray(issues) ? issues : [];
  return `<section class="comparison-groups">
    <p class="comparison-groups-legend">Группы показывают возможные варианты модели. Для характеристики сверяйте точные артикулы с источником. Значения не копируются между карточками.</p>
    ${list.map(group => {
      const members = group.members || [];
      const count = allIssues.filter(issue => !issue.resolved && issue.category === 'variants' && issue.familyId === group.id).length;
      const label = group.label || group.id || 'Семейство моделей';
      return `<section class="comparison-group" data-comparison-group="${escape(group.id || '')}">
        <header><h3>${escape(label)}</h3><span>Карточек: ${members.length}</span><span>Активных замечаний: ${count}</span></header>
        ${comparisonTable(members, new Set(group.differingFields || []), escape)}
      </section>`;
    }).join('')}
  </section>`;
}
