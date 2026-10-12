import { zipBytes } from './portable-zip.js';
import { CARD_FIELDS, auditCardRecords, waterInBar, sizeInMm, QUALITY_CATEGORY_LABELS } from './gallery-quality-utils.js';
import { factsSeriesPolicy } from './gallery-utils.js';

const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const col = n => { let result = ''; for (++n; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
function sheetXml(rows, widths, { filter = true, freeze = true, reviewColumn = -1, severityColumn = -1 } = {}) {
  const data = rows.map((row, r) => `<row r="${r + 1}" ht="${r === 0 ? 32 : Math.min(300, Math.max(28, ...row.map((value, c) => String(value ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(10, widths[c] - 2))), 0) * 15 + 8)))}" customHeight="1">${row.map((value, c) => {
    const address = `${col(c)}${r + 1}`, style = r === 0 ? 1 : value instanceof Date ? 3 : c === reviewColumn ? 2 : c === severityColumn && value === 'Критично' ? 4 : 0;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return `<c r="${address}" s="${style}"><v>${value.getTime() / 86400000 + 25569}</v></c>`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${address}" s="0"><v>${value}</v></c>`;
    // Literal strings prevent Excel formula injection, including '=' prefixes.
    return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const range = `A1:${col(widths.length - 1)}${rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0">${freeze ? '<pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/>' : ''}</sheetView></sheetViews><cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${data}</sheetData>${filter ? `<autoFilter ref="${range}"/>` : ''}</worksheet>`;
}

export function cardWorkbookSheets(records, { customer = false, exportedAt = new Date(), auditRecords = records } = {}) {
  // Filtering exported rows must not shrink their comparison family.
  const exportedVersions = new Set(records.map(record => record.generationId));
  const allIssues = auditCardRecords(auditRecords, { includeResolved: true }).filter(issue => exportedVersions.has(issue.generationId));
  const issues = allIssues.filter(issue => !issue.resolved), byId = new Map();
  for (const issue of issues) { if (!byId.has(issue.generationId)) byId.set(issue.generationId, []); byId.get(issue.generationId).push(issue); }
  const headers = ['Название часов', 'Бренд', 'Серия', 'Код модели', 'УТП 1', 'УТП 2', 'Водозащита (текст)', 'Водозащита (бар)', 'Размер (текст)', 'Размер (мм)', 'PNG', 'Статус проверки', 'Замечания', 'Комментарий проверяющего', 'Дата результата', 'ID модели', 'ID версии', 'SHA-256 PNG'];
  if (!customer) headers.push('ID извлечения', 'Чат');
  const cards = records.map(record => {
    const f = record.facts || {}, warnings = byId.get(record.generationId) || [];
    const row = [record.modelName, f.titleBrand, factsSeriesPolicy(f, record.modelName) === 'forbidden' ? '' : f.titleSeries, f.titleModel,
      f.utp1, f.utp2, f.waterResistance, waterInBar(f.waterResistance), f.caseSize, sizeInMm(f.caseSize),
      record.deliveryFileName || record.outputFileName, record.imageTextMatchesFacts === false ? 'Требуется исправление PNG'
        : warnings.length ? `Активных замечаний: ${warnings.length}` : record.reviewStatus === 'accepted' ? 'Карточка подтверждена' : 'Ожидает проверки',
      warnings.map(issue => issue.reason).join('\n'), record.reviewComment || '', record.generatedAt && Number.isFinite(Date.parse(record.generatedAt)) ? new Date(record.generatedAt) : '', record.sourceId, record.generationId, record.outputHash];
    if (!customer) row.push(record.factsJobId, record.chatUrl || '');
    return row;
  });
  return [
    { name: 'Карточки', rows: [headers, ...cards], reviewColumn: 13, widths: [44, 20, 22, 24, 32, 32, 26, 16, 24, 14, 42, 27, 54, 40, 22, 32, 38, 68, ...(!customer ? [38, 48] : [])] },
    { name: 'Проверки', rows: [['Модель', 'Важность', 'Поле', 'Значение', 'Причина', 'Связанные варианты', 'ID модели', 'ID версии', 'Категория', 'Решение'],
      ...allIssues.map(i => [i.modelName, i.severity, CARD_FIELDS.find(([key]) => key === i.field)?.[1] || 'Общее замечание', i.value, i.reason, i.related.join('\n'), i.sourceId, i.generationId,
        QUALITY_CATEGORY_LABELS[i.category] || i.category, i.resolved ? 'Подтверждено для этой версии' : 'Требует проверки'])], severityColumn: 1, widths: [44, 16, 22, 28, 65, 65, 32, 38, 28, 34] },
    { name: 'Инструкция', rows: [['Раздел', 'Описание'], ['Дата выгрузки', exportedAt.toLocaleString('ru-RU')], ['Источник', 'Сохранённые текущие ревизии WatchAutomation. Поля описывают текст инфографики; достоверность характеристик сверяется отдельно.'], ['Проверка', 'Отфильтруй лист Проверки по категории и решению «Требует проверки». Запиши комментарий в жёлтой колонке на листе Карточки. Подтверждение отдельного замечания сохраняется в галерее для выбранной версии.'], ['Единицы', 'Для сравнения 1 атм и 1 бар считаются эквивалентными 10 м заявленной водозащиты. Это маркировка, не разрешённая глубина погружения.'], ['Варианты', 'Группы Casio, Pagani Design и Tissot предполагают сходство моделей. Различия требуют проверки точных артикулов. Для остальных брендов автоматическое объединение не применяется.'], ['Серии', 'Пустая серия допустима согласно профилю бренда. Код модели хранится текстом и сохраняет все точки и нули.'], ['Редактирование Excel', 'Изменения в Excel служат проверке заказчиком. Автоматического обратного импорта Excel нет. Исправления в приложении выполняются через галерею.'], ['Версии', 'ID версии и SHA-256 связывают строку с конкретным PNG. Исходные версии сохраняются.']], widths: [24, 120], filter: false, freeze: false }
  ];
}

export function buildCardWorkbook(records, options = {}) {
  const sheets = cardWorkbookSheets(records, options);
  const files = [['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF24334D"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFD9E0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf fontId="0" fillId="0" borderId="0" numFmtId="164" xfId="0" applyNumberFormat="1"/><xf fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`]
  ];
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths, s)]));
  return zipBytes(files);
}
