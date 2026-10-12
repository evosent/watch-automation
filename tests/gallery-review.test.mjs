import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { zipBytes } from '../extension/portable-zip.js';
import { buildCardWorkbook, cardWorkbookSheets } from '../extension/card-workbook.js';
import { waterInBar, sizeInMm, auditCardRecords, validateCardChanges, buildCardEditPrompt } from '../extension/gallery-quality-utils.js';
import { galleryVersionsForRecord } from '../extension/gallery-revision-utils.js';
import { stageCardRevision, reviewCardRevision } from '../extension/card-review-db.js';
import { createCardEditController } from '../extension/card-edit-controller.js';
import { getGenerationRevision, getModelCatalog, getAllGenerationRevisions, upsertGenerationRevision, replaceModelCatalog, DB_NAME } from '../extension/idb.js';
import { portableResult, transferableRevision, portableRevisionKey, validateResultsManifest, resultsImportPreview, planResultsMerge } from '../extension/results-transfer-utils.js';
import { createResultsTransferManager } from '../extension/local-service/results-transfer.mjs';

const hash = 'a'.repeat(64);
const record = (id = 'original', code = 'GA-2100-1A') => ({ generationId: id, sourceId: `casio:${code.replaceAll('-', '')}`, factsJobId: `facts-${id}`,
  modelName: `Casio G-Shock ${code}`, profileId: 'casio', groupId: 'in_sale_good', outputPath: 'D:/Downloads/WatchAutomation/card.png', outputFileName: 'card.png', outputHash: hash,
  status: 'READY', factsStatus: 'ok', generatedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T01:00:00Z',
  facts: { generationId: id, factsJobId: `facts-${id}`, outputHash: hash, status: 'ok', profileId: 'casio', titleBrand: 'Casio', titleSeries: 'G-Shock', titleModel: code,
    utp1: 'Минеральное стекло', utp2: 'Ударопрочный корпус', waterResistance: '20 бар водозащита', caseSize: '45,4 мм размер корпуса' } });
const proof = r => ({ generationId: r.generationId, sourceId: r.sourceId, outputPath: r.outputPath, outputHash: r.outputHash,
  verified: true, exists: true, isFile: true, sizeBytes: 100, verifiedAt: new Date().toISOString() });
async function reset() { await new Promise((resolve, reject) => { const req = indexedDB.deleteDatabase(DB_NAME); req.onsuccess = resolve; req.onerror = () => reject(req.error); }); }
async function seed() {
  await reset(); const original = record();
  await upsertGenerationRevision(original);
  await replaceModelCatalog([{ skuKey: original.sourceId, modelName: original.modelName, latestReadyGenerationId: original.generationId, currentGenerationId: original.generationId, variants: [] }]);
  return original;
}
function unzipStored(bytes) {
  const buffer = Buffer.from(bytes), files = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const size = buffer.readUInt32LE(offset + 18), n = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + n).toString();
    const start = offset + 30 + n + extra; files.set(name, buffer.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}
test('QA normalizes Russian units and equivalent declared water resistance', () => {
  assert.equal(waterInBar('50 м водозащита'), 5); assert.equal(waterInBar('5 ATM'), 5); assert.equal(waterInBar('5 атм'), 5);
  assert.equal(sizeInMm('40,5 мм диаметр'), 40.5); assert.equal(sizeInMm('4.05 cm'), 40.5);
  const a = record(), b = record('other', 'GA-2100-2A');
  a.facts.waterResistance = '50 м'; b.facts.waterResistance = '5 атм';
  assert.equal(auditCardRecords([a, b]).filter(i => i.reason.startsWith('Разные значения')).length, 0);
  b.facts.caseSize = '42 мм';
  assert.equal(auditCardRecords([a, b]).filter(i => i.field === 'caseSize' && i.severity === 'Критично').length, 2);
});
test('editing enforces SKU identity, Russian UTPs and brand-specific no-series', () => {
  const a = record();
  assert.throws(() => validateCardChanges(a, { ...a.facts, titleModel: 'GA-9999', utp1: 'Сапфировое стекло' }), /Код модели/);
  assert.throws(() => validateCardChanges(a, { ...a.facts, utp1: 'Sapphire glass' }), /по-русски/);
  const seiko = { ...a, modelName: 'Seiko SRPB43', facts: { ...a.facts, titleBrand: 'Seiko', titleModel: 'SRPB43', titleSeries: 'Presage' } };
  const change = validateCardChanges(seiko, { ...seiko.facts, utp1: 'Сапфировое стекло' });
  assert.equal(change.fields.titleSeries, '');
  assert.match(buildCardEditPrompt(seiko, change.changes), /серии и линейки.*запрещены/);
  const manual = { ...a, imageTextMatchesFacts: false, originalPrintedFacts: a.facts, facts: { ...a.facts, utp1: 'Сапфировое стекло' } };
  assert.equal(validateCardChanges(manual, manual.facts).changes[0].before, 'Минеральное стекло');
});

test('card edit prompt locks the 3:4 canvas and permits only literal replacements in named blocks', () => {
  const a = { ...record(), outputWidth: 1086, outputHeight: 1448 };
  const { changes } = validateCardChanges(a, { ...a.facts, utp1: 'Сапфировое стекло' });
  const prompt = buildCardEditPrompt(a, changes);
  assert.match(prompt, /строго 3:4 \(ширина:высота\)/);
  assert.match(prompt, /1086 × 1448 пикселей/);
  assert.match(prompt, /9:16, 2:3, квадрат.*запрещены/);
  assert.match(prompt, /обрезка, сжатие, растяжение/);
  assert.match(prompt, /Совпадающие слова в других блоках менять запрещено/);
  assert.match(prompt, /Все надписи, отсутствующие в списке замен, должны остаться прежними/);
  assert.match(prompt, /Единственный источник новых значений — строки to в JSON/);
  assert.match(prompt, /WATCHES WORLD/);
  assert.match(prompt, /перерисовка и ретушь часов/);
  const data = JSON.parse(prompt.match(/\{\n[\s\S]*\n\}/)[0]);
  assert.equal(data.model, a.modelName);
  assert.deepEqual(data.replacements, [{ field: 'utp1', from: 'Минеральное стекло', to: 'Сапфировое стекло' }]);
  for (const dimensions of [{}, { outputWidth: 1080, outputHeight: 1920 }, { outputWidth: -3, outputHeight: -4 }]) {
    const fallback = buildCardEditPrompt({ ...record(), ...dimensions }, changes);
    assert.match(fallback, /строго 3:4/);
    assert.doesNotMatch(fallback, /Размер полного выходного холста:/);
    assert.match(fallback, /Формат результата 3:4 обязателен/);
  }
});
test('XLSX is a native OOXML package with literal identifiers, dates, frozen headers and customer privacy', () => {
  const a = record(); a.facts.utp1 = '=HYPERLINK("https://example.com")'; a.chatUrl = 'https://chatgpt.com/c/private';
  const files = unzipStored(buildCardWorkbook([a], { customer: true }));
  assert.equal(files.size, 8);
  const sheet = files.get('xl/worksheets/sheet1.xml').toString();
  assert.match(sheet, /t="inlineStr"/); assert.match(sheet, /=HYPERLINK/); assert.doesNotMatch(sheet, /<f[ >]/);
  assert.match(sheet, /state="frozen"/); assert.match(sheet, /autoFilter/); assert.doesNotMatch(sheet, /private/);
  const rows = cardWorkbookSheets([a], { customer: true })[0].rows;
  assert.equal(rows[1][7], 20); assert.equal(rows[1][9], 45.4); assert.ok(rows[1][14] instanceof Date);
  assert.throws(() => zipBytes([['../bad', 'test']]), /Unsafe/);
});
test('history excludes incomplete and mismatched tuples while preserving exact rejected versions', () => {
  const a = record(), b = { ...record('second'), completedAt: '2026-10-02T01:00:00Z' };
  const corrupt = { ...record('bad'), facts: a.facts };
  const rejected = { ...record('rejected'), reviewStatus: 'rejected', archivedFacts: record('rejected').facts, facts: null };
  const versions = galleryVersionsForRecord(a, [a, b, corrupt, rejected, { ...record('failed'), status: 'FAILED' }]);
  assert.deepEqual(new Set(versions.map(r => r.generationId)), new Set(['original', 'second', 'rejected']));
  assert.equal(versions.find(r => r.generationId === 'rejected').facts.generationId, 'rejected');
  const afterEdit = galleryVersionsForRecord({ ...a, revisionKind: 'manual_facts', imageTextMatchesFacts: false, reviewComment: 'note', editChanges: [{ key: 'utp1' }] }, [b]);
  const old = afterEdit.find(r => r.generationId === 'second');
  assert.equal(old.revisionKind, undefined); assert.equal(old.imageTextMatchesFacts, undefined);
  assert.equal(old.reviewComment, undefined); assert.equal(old.editChanges, undefined);
});
test('staging preserves accepted version; review uses atomic compare-and-swap and verified proof', async () => {
  const original = await seed(), candidate = { ...record('candidate'), sourceId: original.sourceId, parentGenerationId: original.generationId };
  await assert.rejects(stageCardRevision(candidate, { ...proof(candidate), outputHash: 'b'.repeat(64) }), /Подтверждение/);
  assert.equal((await stageCardRevision(candidate, proof(candidate))).created, true);
  assert.equal((await getModelCatalog(original.sourceId)).latestReadyGenerationId, 'original');
  const staged = await getGenerationRevision('candidate');
  assert.equal(staged.status, 'REVIEW_PENDING'); assert.equal(transferableRevision(staged), false);
  assert.equal((await reviewCardRevision('candidate', 'accept', 'stale', proof(candidate))).reason, 'accepted_version_changed');
  assert.equal((await reviewCardRevision('candidate', 'accept', 'original', { ...proof(candidate), exists: false })).reason, 'invalid_proof');
  assert.equal((await reviewCardRevision('candidate', 'accept', 'original', proof(candidate))).changed, true);
  assert.equal((await getGenerationRevision('original')).outputHash, hash);
  assert.equal((await getModelCatalog(original.sourceId)).latestReadyGenerationId, 'candidate');
  assert.equal((await getGenerationRevision('candidate')).status, 'READY');
});
test('rejecting edit leaves source image, facts and current model intact', async () => {
  const original = await seed(), candidate = { ...record('candidate'), parentGenerationId: 'original' };
  await stageCardRevision(candidate, proof(candidate));
  assert.equal((await reviewCardRevision('candidate', 'reject', 'original')).changed, true);
  assert.equal((await getGenerationRevision('candidate')).reviewStatus, 'rejected');
  assert.equal((await getModelCatalog(original.sourceId)).latestReadyGenerationId, 'original');
  assert.ok((await getGenerationRevision('original')).facts);
});
function controllerFixture(options = {}) {
  const stored = {}, calls = []; let tail = Promise.resolve();
  globalThis.chrome = { storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, stored[k]])); }, async set(value) { Object.assign(stored, structuredClone(value)); } } },
    tabs: { async create(options) { calls.push(options); return { id: 7 }; }, async get() { return { id: 7 }; }, async sendMessage(_id, message) { calls.push(message); } },
    alarms: { async create() {}, async clear() {} }, downloads: { async download() { return 17; }, async search() { return []; } } };
  globalThis.fetch = async () => ({ ok: true, async json() { return { valid: true, sha256: hash, bytes: 100 }; }, async arrayBuffer() { return new Uint8Array([1]).buffer; } });
  const ctrl = createCardEditController({ lock: task => { const next = tail.then(task); tail = next.catch(() => {}); return next; }, buildFactsPrompt: () => 'OCR', normalizeFacts: (_record, text) => JSON.parse(text), refreshAccounting: async () => {}, runIsActive: run => run?.state === 'RUNNING', ...options });
  return { ctrl, stored, calls };
}
test('manual facts job creates separate pending revision and preserves original provenance', async () => {
  const a = await seed(), { ctrl, stored } = controllerFixture();
  const job = await ctrl.handle({ type: 'SAVE_CARD_FACTS', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } }, {});
  assert.equal(job.stage, 'ready');
  const changed = await getGenerationRevision(job.id); assert.equal(changed.facts.utp1, 'Сапфировое стекло');
  assert.equal(changed.imageTextMatchesFacts, false); assert.equal(changed.originalPrintedFacts.utp1, a.facts.utp1);
  assert.equal((await getModelCatalog(a.sourceId)).latestReadyGenerationId, a.generationId);
  assert.equal(await ctrl.busy(), false, 'a saved candidate does not block generation or another edit');
  assert.equal((await getAllGenerationRevisions()).length, 2);
  stored.run = { state: 'RUNNING' };
  await assert.rejects(ctrl.handle({ type: 'REVIEW_CARD_VERSION', generationId: job.id, expectedAcceptedId: a.generationId, decision: 'accept' }, {}), /Заверши/);
});

test('manual corrections survive portable re-export and do not deduplicate against the original PNG', () => {
  const original = record(), corrected = { ...record('manual'), revisionKind: 'manual_facts', imageTextMatchesFacts: false,
    originalPrintedFacts: original.facts, facts: { ...record('manual').facts, utp1: 'Сапфировое стекло' } };
  const items = [original, corrected].map(r => ({ ...portableResult(r), image: `images/${hash}.png` }));
  assert.equal(validateResultsManifest({ format: 'watch-automation-results', schemaVersion: 1, items }).items.length, 2);
  assert.equal(resultsImportPreview([items[1]], [original]).newResults, 1);
  const plan = planResultsMerge(items.map(r => ({ ...r, outputPath: corrected.outputPath })), {});
  assert.equal(plan.revisions.length, 2);
  const manual = plan.revisions.find(r => r.revisionKind === 'manual_facts');
  const exported = portableResult(manual);
  assert.equal(exported.generationId, 'manual'); assert.equal(exported.facts.generationId, 'manual');
  assert.equal(exported.originalPrintedFacts.utp1, original.facts.utp1);
  assert.equal(portableRevisionKey(manual), portableRevisionKey(exported));
  assert.equal(resultsImportPreview([exported], plan.revisions).duplicates, 1);
  assert.equal(validateResultsManifest({ format: 'watch-automation-results', schemaVersion: 1, items: [{ ...exported, image: `images/${hash}.png` }] }).items[0].factsStatus, 'ok');
});

test('update and import locks block card edits before any new tab is created', async () => {
  const a = await seed(), { ctrl, stored, calls } = controllerFixture();
  const request = { type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } };
  stored.manualExtensionUpdateLock = { active: true };
  await assert.rejects(ctrl.handle(request, {}), /импорта или обновления/);
  stored.manualExtensionUpdateLock = null; stored.resultsImportJournal = { id: 'import' };
  await assert.rejects(ctrl.handle(request, {}), /импорта или обновления/);
  assert.equal(calls.length, 0);
});
test('image editing is single-owner, cancellable and never sends again after timeout/restart', async () => {
  const a = await seed(), { ctrl, stored, calls } = controllerFixture();
  const request = { type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } };
  const job = await ctrl.handle(request, {}); assert.equal(calls.length, 1);
  await assert.rejects(ctrl.handle(request, {}), /предыдущ/);
  assert.equal(await ctrl.handle({ type: 'CARD_EDIT_CLAIM', requestedId: job.id }, { tab: { id: 8 } }), null);
  await ctrl.handle({ type: 'CANCEL_CARD_EDIT' }, {});
  assert.equal(stored.cardEditJob.stage, 'cancelled');
  assert.equal(await ctrl.handle({ type: 'CARD_EDIT_RESULT', id: job.id }, { tab: { id: 7 } }), null);
  const second = await ctrl.handle(request, {}); stored.cardEditJob.deadline = Date.now() - 1;
  await ctrl.reconcile(); assert.equal(stored.cardEditJob.stage, 'error');
  assert.equal(calls.filter(c => c.url).length, 2); assert.equal((await getModelCatalog(a.sourceId)).latestReadyGenerationId, 'original');
});

test('image edit result is downloaded once, reads actual OCR and stays pending until explicit acceptance', async () => {
  const a = await seed(), { ctrl, stored } = controllerFixture();
  const input = Buffer.from([137,80,78,71,13,10,26,10,1]), output = Buffer.from([137,80,78,71,13,10,26,10,2]);
  a.outputHash = createHash('sha256').update(input).digest('hex'); a.facts.outputHash = a.outputHash;
  await upsertGenerationRevision(a);
  const outputHash = createHash('sha256').update(output).digest('hex');
  globalThis.fetch = async url => ({ ok: true, arrayBuffer: async () => input.buffer.slice(input.byteOffset, input.byteOffset + input.length),
    json: async () => ({ valid: true, sha256: new URL(url).searchParams.get('expectedHash'), bytes: 100, width: 100, height: 200 }) });
  let downloads = 0, completed = false;
  chrome.downloads.download = async () => { downloads++; return 17; };
  chrome.downloads.search = async () => [{ id: 17, state: completed ? 'complete' : 'in_progress', filename: 'D:/Downloads/WatchAutomation/new.png' }];
  const job = await ctrl.handle({ type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } }, {});
  const sender = { tab: { id: 7 } };
  const claim = await ctrl.handle({ type: 'CARD_EDIT_CLAIM', requestedId: job.id }, sender);
  assert.equal(claim.file.dataUrl, `data:image/png;base64,${input.toString('base64')}`);
  assert.equal(await ctrl.handle({ type: 'CARD_EDIT_CLAIM', requestedId: job.id }, sender), null);
  await ctrl.handle({ type: 'CARD_EDIT_STAGE', id: job.id, stage: 'submitted' }, sender);
  await ctrl.handle({ type: 'CARD_EDIT_STAGE', id: job.id, stage: 'extracting' }, sender);
  const result = { type: 'CARD_EDIT_RESULT', id: job.id, dataUrl: `data:image/png;base64,${output.toString('base64')}`, rawFacts: JSON.stringify(a.facts), chatUrl: 'https://chatgpt.com/c/edit' };
  await ctrl.handle(result, sender); await ctrl.handle(result, sender); assert.equal(downloads, 1);
  completed = true; await ctrl.reconcile();
  const candidate = await getGenerationRevision(job.id);
  assert.equal(stored.cardEditJob.stage, 'ready'); assert.equal(candidate.outputHash, outputHash);
  assert.equal(candidate.facts.outputHash, outputHash); assert.equal(candidate.facts.generationId, job.id);
  assert.equal(candidate.facts.utp1, 'Минеральное стекло'); assert.equal(candidate.editChanges[0].after, 'Сапфировое стекло');
  assert.equal((await getModelCatalog(a.sourceId)).latestReadyGenerationId, a.generationId);
  await ctrl.handle({ type: 'REVIEW_CARD_VERSION', generationId: job.id, expectedAcceptedId: a.generationId, decision: 'accept', reviewComment: 'note' }, {});
  assert.equal((await getModelCatalog(a.sourceId)).latestReadyGenerationId, job.id);
  assert.equal((await getGenerationRevision(job.id)).reviewComment, 'note');
});

test('failed image claim releases the edit job with an actionable error', async () => {
  const a = await seed(), { ctrl, stored } = controllerFixture();
  const job = await ctrl.handle({ type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } }, {});
  globalThis.fetch = async () => ({ ok: false });
  await assert.rejects(ctrl.handle({ type: 'CARD_EDIT_CLAIM', requestedId: job.id }, { tab: { id: 7 } }), /прочитать/);
  assert.equal(stored.cardEditJob.stage, 'error'); assert.equal(await ctrl.busy(), false);
});

test('worker boots its saved tab outside the lock and reports a handshake failure immediately', async () => {
  const a = await seed(); let fixture, observed;
  fixture = controllerFixture({ prepareTab: async (tabId, id) => {
    observed = { tabId, id, stage: fixture.stored.cardEditJob.stage };
    // A second lock acquisition completes, proving boot is outside start lock.
    await fixture.ctrl.handle({ type: 'CANCEL_CARD_EDIT' }, {});
    throw new Error('handshake failed');
  } });
  const job = await fixture.ctrl.handle({ type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } }, {});
  for (let i=0; i<10 && fixture.stored.cardEditJob.stage === 'opening'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(observed, { tabId: 7, id: job.id, stage: 'opening' });
  assert.equal(fixture.stored.cardEditJob.stage, 'cancelled');
  const next = controllerFixture({ prepareTab: async () => { throw new Error('ChatGPT did not respond'); } });
  await next.ctrl.handle({ type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } }, {});
  for (let i=0; i<10 && next.stored.cardEditJob.stage === 'opening'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(next.stored.cardEditJob.stage, 'error');
  assert.equal(next.stored.cardEditJob.error, 'ChatGPT did not respond');
  assert.equal(await next.ctrl.busy(), false);
});

test('opening and attachment watchdogs release the job long before the full generation deadline', async () => {
  const a = await seed(), { ctrl, stored } = controllerFixture();
  const request = { type: 'START_CARD_EDIT', generationId: a.generationId, expectedAcceptedId: a.generationId, fields: { ...a.facts, utp1: 'Сапфировое стекло' } };
  const job = await ctrl.handle(request, {});
  assert.ok(stored.cardEditJob.stageDeadline < stored.cardEditJob.deadline - 10 * 60000);
  await ctrl.onAlarm({ name: 'watch-card-edit-deadline' });
  assert.equal(stored.cardEditJob.stage, 'opening', 'an early alarm must only reschedule');
  stored.cardEditJob.stageDeadline = Date.now() - 1;
  await ctrl.onAlarm({ name: 'watch-card-edit-deadline' });
  assert.match(stored.cardEditJob.error, /90 секунд/);
  assert.equal(await ctrl.busy(), false);
  const second = await ctrl.handle(request, {});
  globalThis.fetch = async url => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
  // Reconcile an interrupted attachment stage without retrying its prompt.
  stored.cardEditJob.stage = 'preparing'; stored.cardEditJob.stageDeadline = Date.now() - 1;
  await ctrl.onAlarm({ name: 'watch-card-edit-deadline' });
  assert.match(stored.cardEditJob.error, /3 минуты/);
  assert.equal(await ctrl.handle({ type: 'CARD_EDIT_CLAIM', requestedId: second.id }, { tab: { id: 7 } }), null);
  assert.equal((await getModelCatalog(a.sourceId)).latestReadyGenerationId, 'original');
});
test('content edit boot survives stripped URL/gate and duplicated injection, attaching the exact PNG before one send', async () => {
  const source = await readFile(new URL('../extension/card-edit-content.js', import.meta.url), 'utf8');
  const calls = [], png = new Uint8Array([137,80,78,71,13,10,26,10,1]);
  const task = { id: 'id', deadline: Date.now() + 60000, file: { name: 'exact.png', dataUrl: 'data:image/png;base64,AA==' }, prompt: 'edit', factsPrompt: 'OCR' };
  let done, receiver, listeners = 0, sends = 0; const finished = new Promise(resolve => { done = resolve; });
  const adapter = { async ensureChatMode() {}, async waitForComposerReadyForInput() {}, async waitForComposerReadyForSend() {},
    async uploadFiles(value) { calls.push(['upload', value.files[0].name]); }, async setComposerText(value) { assert.equal(typeof value, 'string'); calls.push(['prompt', value]); },
    async sendPrompt() { sends++; return { baselineAssistantCount: 0, userTurnId: 'turn' }; }, async waitForGeneratedImage() { return { src: 'https://image/result' }; }, async waitForSettledAssistantText(options) { assert.equal(options.afterUserTurnId, 'turn'); return { text: 'json' }; } };
  class Reader { readAsDataURL() { this.result = 'data:image/png;base64,AA=='; this.onload(); } }
  const context = { window: { __WATCH_AUTOMATION_ENABLED__: false, WatchChatGPTAdapter: adapter }, URL, Blob, FileReader: Reader, AbortController, setTimeout, clearTimeout,
    location: { href: 'https://chatgpt.com/c/result' }, fetch: async () => ({ ok: true, blob: async () => new Blob([png]) }),
    chrome: { runtime: { onMessage: { addListener(fn) { listeners++; receiver = fn; } }, async sendMessage(message) { calls.push(message.type); if (message.type === 'CARD_EDIT_RESULT') done(); return { ok: true, value: message.type === 'CARD_EDIT_CLAIM' ? task : message.type === 'CARD_EDIT_STAGE' ? { stage: message.stage } : null }; } } } };
  runInNewContext(source, context);
  runInNewContext(source, context);
  assert.equal(listeners, 1); assert.equal(calls.length, 0, 'loading a page must not race the saved worker tab ID');
  receiver({ type: 'CARD_EDIT_START', id: task.id }, {}, () => {});
  receiver({ type: 'CARD_EDIT_START', id: task.id }, {}, () => {});
  await finished;
  assert.deepEqual(calls.filter(c => Array.isArray(c)), [['upload', 'exact.png'], ['prompt', 'edit'], ['prompt', 'OCR']]);
  assert.equal(calls.filter(c => c === 'CARD_EDIT_RESULT').length, 1);
  assert.equal(calls.filter(c => c === 'CARD_EDIT_CLAIM').length, 1);
  assert.equal(sends, 2, 'one image edit and one OCR request');
});

test('attachment failure and cancellation during claim never click Send or replace the original', async () => {
  const source = await readFile(new URL('../extension/card-edit-content.js', import.meta.url), 'utf8');
  for (const mode of ['attachment-failure', 'cancel-during-claim']) {
    let receiver, releaseClaim, sent = 0, uploaded = 0, done;
    const finished = new Promise(resolve => { done = resolve; });
    const claim = new Promise(resolve => { releaseClaim = resolve; });
    const task = { id: mode, deadline: Date.now() + 60000, file: { name: 'exact.png' }, prompt: 'edit' };
    const errors = [];
    const adapter = { async ensureChatMode() {}, async waitForComposerReadyForInput() {},
      async uploadFiles() { uploaded++; throw new Error('PNG не прикрепился'); },
      async setComposerText() { throw new Error('must not write prompt'); }, async sendPrompt() { sent++; } };
    runInNewContext(source, { window: { WatchChatGPTAdapter: adapter }, AbortController, setTimeout, clearTimeout,
      chrome: { runtime: { onMessage: { addListener(fn) { receiver = fn; } }, async sendMessage(message) {
        if (message.type === 'CARD_EDIT_CLAIM') return { ok: true, value: mode === 'cancel-during-claim' ? await claim : task };
        if (message.type === 'CARD_EDIT_ERROR') { errors.push(message); done(); }
        return { ok: true };
      } } } });
    receiver({ type: 'CARD_EDIT_START', id: task.id }, {}, () => {});
    if (mode === 'cancel-during-claim') {
      receiver({ type: 'CANCEL_CARD_EDIT', id: task.id }, {}, () => {});
      releaseClaim(task);
    }
    await finished;
    receiver({ type: 'CARD_EDIT_START', id: task.id }, {}, () => {});
    await Promise.resolve();
    assert.equal(sent, 0); assert.equal(uploaded, mode === 'attachment-failure' ? 1 : 0);
    assert.equal(errors.length, 1); assert.equal(errors[0].id, mode);
    assert.match(errors[0].error, mode === 'attachment-failure' ? /не прикрепился/ : /отменено/);
  }
});
test('customer delivery ZIP streams exact images and contains Excel without chat URLs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'watch-customer-')); t.after(() => rm(root, { recursive: true, force: true }));
  function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i=0;i<8;i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
  function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1,4); ihdr[8]=8; ihdr[9]=6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(Buffer.from([0,1,2,3,255]))), chunk('IEND',Buffer.alloc(0))]);
  const a = { ...record(), outputPath: path.join(root,'card.png'), outputHash: createHash('sha256').update(png).digest('hex'), reviewStatus: 'accepted', chatUrl: 'https://chatgpt.com/c/private' };
  a.facts.outputHash = a.outputHash;
  await writeFile(a.outputPath, png);
  const manager = createResultsTransferManager({ outputRoot: root });
  await assert.rejects(manager.startCustomerExport([{ ...a, imageTextMatchesFacts: false }], 'owner'), /проверенные/);
  const job = await manager.startCustomerExport([a], 'owner');
  let value; for (let i=0;i<100;i++) { value = await manager.status(job.id, 'owner'); if (['ready','error'].includes(value.phase)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(value.phase,'ready',value.error);
  const entries = unzipStored(await readFile(await manager.archivePath(job.id,'owner')));
  assert.equal(entries.size,3); assert.ok(entries.has('Карточки.xlsx')); assert.ok(entries.has('Проверка.txt'));
  const workbook = unzipStored(entries.get('Карточки.xlsx'));
  assert.doesNotMatch(workbook.get('xl/worksheets/sheet1.xml').toString(),/chatgpt|private/);
  assert.deepEqual([...entries.values()].find(bytes => bytes.subarray(0,8).equals(png.subarray(0,8))),png);
});
