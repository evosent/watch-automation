import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createResultsTransferManager } from '../extension/local-service/results-transfer.mjs';
import { sha256, pngMetadata, writeResultsZip, inspectResultsZip, extractResultsZip } from '../extension/local-service/results-archive.mjs';
import { portableResult, validateResultsManifest, resultsImportPreview, planResultsMerge,
  RESULTS_PACKAGE_FORMAT, RESULTS_PACKAGE_VERSION } from '../extension/results-transfer-utils.js';
import { sourceIdFor, pendingEntryIds, modelCatalogRecordsFromGroups } from '../extension/queue-utils.js';
import { canonicalBrandIdentityId } from '../extension/sku-utils.js';
import { DB_NAME, mergeResultsDatabase, getAllGenerationRevisions, getAllModelCatalog } from '../extension/idb.js';
import { galleryRecordsFromCatalog } from '../extension/gallery-revision-utils.js';
import { initResultsTransfer } from '../extension/results-transfer-ui.js';

const project = path.resolve(import.meta.dirname, '..');
const owner = 'client:results-transfer-test';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function png(index = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, index & 255, (index >>> 8) & 255, 10, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function revision(index, bytes = png(index)) {
  const modelName = `Casio Collection MTP-${1000 + index}-1A`;
  const sourceId = sourceIdFor('in_sale_good', '', modelName);
  const generationId = `generation-${index}`;
  const outputHash = sha256(bytes), factsJobId = `facts-${index}`;
  return { generationId, sourceId, modelName, fileName: `${modelName}.png`, groupId: 'in_sale_good',
    sourceVariantId: `in_sale_good|input-watches-images/in_sale/${modelName}.png`,
    relativePath: `input-watches-images/in_sale/${modelName}.png`, sourceHash: sha256(Buffer.from(`input-${index}`)),
    operationId: 'friend-run', outputHash, status: 'READY', factsStatus: 'ok', factsJobId,
    generatedAt: '2026-10-05T09:00:00.000Z', outputWidth: 1, outputHeight: 1,
    facts: { sourceId, generationId, factsJobId, status: 'ok', outputHash, titleBrand: 'Casio',
      titleSeries: 'Collection', titleModel: `MTP-${1000 + index}-1A`, utp1: 'Стальной браслет',
      utp2: 'Минеральное стекло', waterResistance: '50 м', caseSize: '40 мм', warnings: [] } };
}
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-results-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function wait(manager, id, phase) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = await manager.status(id, owner);
    if (job.phase === phase || job.phase === 'error') return job;
    await delay(5);
  }
  throw new Error(`job ${id} never reached ${phase}`);
}
async function resetDb() {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
}
function manifest(items) { return { format: RESULTS_PACKAGE_FORMAT, schemaVersion: RESULTS_PACKAGE_VERSION, exportedAt: new Date().toISOString(),
  items: items.map((item) => ({ ...portableResult(item), image: `images/${item.outputHash}.png` })) }; }
async function upload(manager, file) { return manager.uploadImport(Readable.from(await readFile(file)), owner); }

test('brand identity evidence accepts reviewed aliases while rejecting unrelated brands', () => {
  assert.equal(canonicalBrandIdentityId('Pagani'), 'pagani_design');
  assert.equal(canonicalBrandIdentityId('Pagani Design'), 'pagani_design');
  assert.equal(canonicalBrandIdentityId('Q&Q'), 'q_and_q');
  assert.equal(canonicalBrandIdentityId('Casio'), 'casio');
  assert.notEqual(canonicalBrandIdentityId('Casio'), canonicalBrandIdentityId('Pagani'));

  const item = revision(500);
  item.modelName = 'Pagani Design PD-1759CBWWS Мужские механические наручные часы, Гарантия';
  item.sourceId = sourceIdFor(item.groupId, item.relativePath, item.modelName);
  item.facts = { ...item.facts, sourceId: item.sourceId, titleBrand: 'Pagani', titleModel: 'PD-1759CBWWS' };
  assert.equal(portableResult(item).sourceId, item.sourceId);
  assert.throws(() => portableResult({ ...item, facts: { ...item.facts, titleBrand: 'Casio' } }), /Бренд в названии/);
});

test('results transfer preserves versioned brand-title and series interpretation metadata', () => {
  const item = revision(501);
  item.modelName = 'Pagani Design PD-1759CBWWS Мужские механические наручные часы';
  item.sourceId = sourceIdFor(item.groupId, item.relativePath, item.modelName);
  item.facts = {
    ...item.facts,
    sourceId: item.sourceId,
    profileId: 'pagani_design',
    titleBrand: 'Pagani Design',
    titleSeries: null,
    titleModel: 'PD-1759CBWWS',
    titleLayoutVersion: 1,
    seriesPolicy: 'forbidden',
    brandLineCount: 2,
    seriesRequired: false,
    expectedTitleBrand: 'Pagani Design',
    expectedTitleSeries: null,
    expectedTitleModel: 'PD-1759CBWWS'
  };
  const exported = portableResult(item).facts;
  assert.equal(exported.profileId, 'pagani_design');
  assert.equal(exported.titleSeries, null);
  assert.equal(exported.titleLayoutVersion, 1);
  assert.equal(exported.seriesPolicy, 'forbidden');
  assert.equal(exported.brandLineCount, 2);
  assert.equal(exported.seriesRequired, false);
  assert.equal(exported.expectedTitleBrand, 'Pagani Design');
});

test('100 real PNGs export from Downloads and merge into a second installation without losing local results', async (t) => {
  const temp = await temporary(t);
  const senderRoot = path.join(temp, 'friend', 'Downloads', 'WatchAutomation');
  const receiverRoot = path.join(temp, 'mine', 'Downloads', 'WatchAutomation');
  await mkdir(path.join(senderRoot, 'in_sale_good'), { recursive: true });
  const records = [];
  for (let i = 0; i < 100; i++) {
    const record = revision(i); record.outputPath = path.join(senderRoot, 'in_sale_good', record.fileName);
    await writeFile(record.outputPath, png(i)); records.push(record);
  }
  const sender = createResultsTransferManager({ outputRoot: senderRoot });
  const receiver = createResultsTransferManager({ outputRoot: receiverRoot });
  const exported = await sender.startExport(records, owner);
  const ready = await wait(sender, exported.id, 'ready');
  assert.equal(ready.phase, 'ready', ready.error); assert.equal(ready.count, 100); assert.equal(ready.skipped.length, 0);
  const imported = await upload(receiver, await sender.archivePath(exported.id, owner));
  const checked = await wait(receiver, imported.id, 'ready');
  assert.equal(checked.phase, 'ready'); assert.equal(checked.items.length, 100);
  await assert.rejects(receiver.status(imported.id, 'another-client'), /другому экземпляру/);
  await receiver.install(imported.id, owner);
  const installed = await wait(receiver, imported.id, 'installed');
  assert.equal(installed.phase, 'installed');
  for (const item of installed.items) {
    assert.ok(item.outputPath.startsWith(receiverRoot));
    assert.equal(sha256(await readFile(item.outputPath)), item.outputHash);
    assert.ok(!item.outputPath.includes(senderRoot));
  }
  const local = { ...revision(0, png(200)), generationId: 'my-original', outputPath: path.join(receiverRoot, 'original.png') };
  local.facts.generationId = local.generationId;
  await writeFile(local.outputPath, png(200));
  const entries = records.map((item) => ({ ...item, sourceId: item.sourceId, skuKey: item.sourceId,
    status: 'pending', fingerprint: `local-time-${item.sourceId}`, variants: [{ ...item, status: 'pending', fingerprint: `local-time-${item.sourceId}` }] }));
  const queue = { groups: { in_sale_good: entries } };
  const catalog = modelCatalogRecordsFromGroups(queue.groups);
  catalog[0].currentGenerationId = local.generationId; catalog[0].latestReadyGenerationId = local.generationId;
  const existingMemory = { version: 1, items: { [local.sourceId]: { ...local, status: 'ready' }, 'untouched:SKU': { sourceId: 'untouched:SKU', status: 'ready' } } };
  const plan = planResultsMerge(installed.items, { queue, catalog, revisions: [local], generationMemory: existingMemory });
  assert.equal(plan.summary.conflicts, 1);
  assert.equal(plan.generationMemory.items[local.sourceId].generationId, local.generationId);
  assert.equal(plan.generationMemory.items['untouched:SKU'].status, 'ready');
  assert.equal(plan.models.some((model) => model.skuKey === local.sourceId && model.currentGenerationId !== local.generationId), false);
  assert.equal(sha256(await readFile(local.outputPath)), local.outputHash);
  assert.equal(plan.generationMemory.items[records[1].sourceId].fingerprint, entries[1].fingerprint);
  assert.equal(plan.queue.groups.in_sale_good[1].status, 'done');
  await resetDb();
  await mergeResultsDatabase({ revisions: [local], models: catalog });
  await mergeResultsDatabase(plan);
  const database = { revisions: await getAllGenerationRevisions(), catalog: await getAllModelCatalog({ includeRemoved: true }) };
  assert.equal(database.revisions.length, 101);
  assert.equal(galleryRecordsFromCatalog(database.catalog, database.revisions).length, 100);
  const again = planResultsMerge(installed.items, { ...database, queue: plan.queue,
    history: plan.history, generationMemory: plan.generationMemory });
  await mergeResultsDatabase(again);
  assert.equal((await getAllGenerationRevisions()).length, 101, 'repeat import cannot create extra versions');
  assert.equal(again.summary.duplicates, 100);
  assert.equal((await getAllModelCatalog({ includeRemoved: true })).find((row) => row.skuKey === local.sourceId).currentGenerationId, local.generationId);
  await receiver.finishImport(imported.id, owner);
  assert.equal((await receiver.verifyInstalled(imported.id, owner)).items.length, 100);
  await receiver.install(imported.id, owner);
  assert.equal((await readdir(path.join(receiverRoot, 'in_sale_good'))).length, 100);
});

test('PNG validation checks the compressed pixel stream as well as chunk checksums', () => {
  const valid = png(0);
  const invalid = Buffer.concat([valid.subarray(0, 33), chunk('IDAT', Buffer.from('invalid compressed stream')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => pngMetadata(invalid), /пикселей PNG повреждены/);
  assert.equal(pngMetadata(valid).width, 1);
});

test('export reports missing/changed PNGs and includes only photos verified on disk', async (t) => {
  const root = path.join(await temporary(t), 'WatchAutomation'); await mkdir(root);
  const records = [0, 1, 2].map((i) => ({ ...revision(i), outputPath: path.join(root, `${i}.png`) }));
  await writeFile(records[0].outputPath, png(0)); await writeFile(records[1].outputPath, png(99));
  const manager = createResultsTransferManager({ outputRoot: root });
  const job = await manager.startExport(records, owner);
  const result = await wait(manager, job.id, 'ready');
  assert.equal(result.count, 1); assert.equal(result.skipped.length, 2);
});

test('import rejects corrupt ZIP, path traversal, schema mismatch, duplicate records, extra files and mismatched PNG hashes', async (t) => {
  const temp = await temporary(t), root = path.join(temp, 'WatchAutomation');
  const manager = createResultsTransferManager({ outputRoot: root });
  const record = revision(0);
  const variants = [
    { manifest: { ...manifest([record]), schemaVersion: 2 }, bytes: png(0) },
    { manifest: manifest([record, record]), bytes: png(0) },
    { manifest: manifest([record]), bytes: png(1) },
    { manifest: manifest([record]), bytes: png(0), extra: true },
    { manifest: manifest([record]), bytes: png(0), mutate: 'crc' },
    { manifest: manifest([record]), bytes: png(0), mutate: 'path' }
  ];
  for (let i = 0; i < variants.length; i++) {
    const fixture = variants[i], file = path.join(temp, `${i}.zip`);
    await writeResultsZip(file, [{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(fixture.manifest)) },
      { name: `images/${record.outputHash}.png`, bytes: fixture.bytes },
      ...(fixture.extra ? [{ name: `images/${'a'.repeat(64)}.png`, bytes: png(0) }] : [])]);
    if (fixture.mutate) {
      const archive = await readFile(file);
      if (fixture.mutate === 'crc') archive[45] ^= 0xff;
      else {
        const replacement = Buffer.from('../evil__.json');
        for (let offset = archive.indexOf('manifest.json'); offset >= 0; offset = archive.indexOf('manifest.json', offset + 13)) replacement.copy(archive, offset);
      }
      await writeFile(file, archive);
    }
    const job = await upload(manager, file), checked = await wait(manager, job.id, 'ready');
    assert.equal(checked.phase, 'error', `invalid archive ${i} must fail`);
    await assert.rejects(manager.install(job.id, owner), /не проверен/);
  }
  const contents = await readdir(root);
  assert.deepEqual(contents, ['.result-transfers']);
});

test('failed destination copy preserves existing PNG and can be retried without corrupting progress', async (t) => {
  const temp = await temporary(t), root = path.join(temp, 'WatchAutomation');
  const record = revision(0), file = path.join(temp, 'data.zip');
  await writeResultsZip(file, [{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest([record]))) }, { name: `images/${record.outputHash}.png`, bytes: png(0) }]);
  const manager = createResultsTransferManager({ outputRoot: root });
  const job = await upload(manager, file); await wait(manager, job.id, 'ready');
  await mkdir(path.join(root, record.groupId));
  const target = path.join(root, record.groupId, `${record.modelName}__import_${record.outputHash}.png`);
  await writeFile(target, png(99)); await manager.install(job.id, owner);
  assert.equal((await wait(manager, job.id, 'installed')).phase, 'error');
  assert.equal(sha256(await readFile(target)), sha256(png(99)), 'existing file cannot be overwritten');
  await rm(target); await manager.install(job.id, owner);
  assert.equal((await wait(manager, job.id, 'installed')).phase, 'installed');
  await writeFile(target, png(98));
  await assert.rejects(manager.verifyInstalled(job.id, owner), /изменился/);
});

test('missing facts, local rejection and changed source photos keep their intended statuses', () => {
  const accepted = revision(0); accepted.outputPath = 'C:/Downloads/WatchAutomation/accepted.png';
  const noFacts = { ...accepted, factsStatus: 'missing', facts: null };
  const plan = planResultsMerge([noFacts]);
  assert.equal(plan.generationMemory.items[accepted.sourceId].status, 'image_saved');
  assert.equal(plan.revisions[0].facts, null);
  assert.equal(galleryRecordsFromCatalog(plan.models, plan.revisions).length, 0);
  const rejected = { ...accepted, reviewStatus: 'rejected' };
  assert.equal(planResultsMerge([accepted], { revisions: [rejected] }).revisions.length, 0);
  const entry = { ...accepted, status: 'pending', sourceHash: 'b'.repeat(64), skuKey: accepted.sourceId };
  const mismatch = planResultsMerge([accepted], { queue: { groups: { in_sale_good: [entry] } } });
  assert.equal(mismatch.summary.incompatibleInputs, 1);
  assert.equal(mismatch.queue.groups.in_sale_good[0].status, 'pending');
  assert.equal(Object.hasOwn(mismatch.generationMemory.items, accepted.sourceId), false);
  assert.equal(resultsImportPreview([accepted], [rejected]).rejected, 1);
});

test('catalog, revisions and facts roll back together when an IndexedDB write fails', async () => {
  await resetDb();
  const record = { ...revision(0), outputPath: 'C:/Downloads/WatchAutomation/0.png' };
  const plan = planResultsMerge([record]);
  plan.revisions.push({ sourceId: 'invalid-without-generation-id' });
  await assert.rejects(mergeResultsDatabase(plan));
  assert.equal((await getAllGenerationRevisions()).length, 0);
  assert.equal((await getAllModelCatalog({ includeRemoved: true })).length, 0);
});

test('durable journal resumes after failure between database and queue writes; active run blocks merge', async () => {
  await resetDb();
  const text = await readFile(path.join(project, 'extension/service-worker.js'), 'utf8');
  const start = text.indexOf('async function completeResultsImport()');
  const end = text.indexOf('async function importInstalledResults', start);
  const item = { ...revision(0), outputPath: 'C:/Downloads/WatchAutomation/0.png' };
  const state = { queue: { groups: {} }, generationMemory: { items: { 'mine:old': { sourceId: 'mine:old', status: 'ready' } } },
    history: { items: {} }, run: null, resultsImportJournal: { id: 'transfer-test', items: [item] } };
  let fail = true;
  const context = { planResultsMerge, mergeResultsDatabase, getAllGenerationRevisions, getAllModelCatalog, modelCatalogRecordsFromGroups,
    withStateLock: (task) => task(), getStored: async () => structuredClone(state),
    runHasActiveAutomationWork: (run) => run?.state === 'RUNNING',
    resultsTransferRequest: async () => ({ items: [item] }),
    chrome: { storage: { local: {
      get: async (key) => ({ [key]: structuredClone(state[key]) }),
      set: async (value) => Object.assign(state, structuredClone(value)), remove: async (key) => { delete state[key]; }
    } } },
    saveRunAndQueue: async (run, queue, history, generationMemory) => {
      if (fail) { fail = false; throw new Error('simulated storage failure'); }
      Object.assign(state, { run, queue, history, generationMemory });
    } };
  runInNewContext(`${text.slice(start, end)}; globalThis.complete = completeResultsImport;`, context);
  state.run = { state: 'RUNNING' };
  await assert.rejects(context.complete(), /активного прогона/);
  assert.equal((await getAllGenerationRevisions()).length, 0);
  state.run = null;
  await assert.rejects(context.complete(), /simulated storage/);
  assert.equal(state.resultsImportJournal.phase, 'database');
  assert.equal((await getAllGenerationRevisions()).length, 1);
  const summary = await context.complete();
  assert.equal(summary.newResults, 1, 'recovery retains the original import report');
  assert.equal(state.resultsImportJournal, undefined);
  assert.equal(state.generationMemory.items[item.sourceId].status, 'ready');
  assert.equal(state.generationMemory.items['mine:old'].status, 'ready');
  assert.equal((await getAllGenerationRevisions()).length, 1);
});

test('actual watcher HTTP endpoints enforce extension access and round-trip uploaded results', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'watch-results-test-'));
  const root = path.join(temp, 'WatchAutomation'); await mkdir(root);
  const port = 23000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(project, 'dev/watch-extension.mjs')], {
    env: { ...process.env, WATCH_AUTOMATION_PORT: String(port), WATCH_AUTOMATION_OUTPUT_ROOT: root }, windowsHide: true, stdio: 'pipe'
  });
  let log = ''; child.stderr.on('data', (chunk) => { log += chunk; }); child.stdout.on('data', () => {});
  t.after(async () => {
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); }); child.kill();
    });
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {}
    if (i === 99) throw new Error(log || 'watcher failed to start'); await delay(20);
  }
  assert.equal((await fetch(`${base}/results-transfer/status`)).status, 403);
  const identity = new URLSearchParams({ extensionId: 'a'.repeat(32), clientId: 'transfer-http-test' });
  assert.equal((await fetch(`${base}/results-transfer/status?${identity}`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const file = path.join(temp, 'http.zip'), record = revision(0);
  await writeResultsZip(file, [{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest([record]))) }, { name: `images/${record.outputHash}.png`, bytes: png(0) }]);
  const response = await fetch(`${base}/results-transfer/import?${identity}`, { method: 'POST', body: await readFile(file) });
  const payload = await response.json(); assert.equal(payload.ok, true);
  const query = `${identity}&id=${payload.value.id}`;
  let state;
  for (let i = 0; i < 100; i++) { state = await fetch(`${base}/results-transfer/status?${query}`).then((r) => r.json()); if (state.value.phase === 'ready') break; await delay(10); }
  assert.equal(state.value.phase, 'ready');
  assert.equal((await fetch(`${base}/results-transfer/install?${query}`, { method: 'POST' })).status, 200);
  for (let i = 0; i < 100; i++) { state = await fetch(`${base}/results-transfer/status?${query}`).then((r) => r.json()); if (state.value.phase === 'installed') break; await delay(10); }
  assert.equal(state.value.phase, 'installed');
  assert.equal(sha256(await readFile(state.value.items[0].outputPath)), record.outputHash);
  const exportRequest = await fetch(`${base}/results-transfer/export?${identity}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [{ ...record, outputPath: state.value.items[0].outputPath }] }) });
  const exportJob = await exportRequest.json(); assert.equal(exportJob.ok, true);
  const exportQuery = `${identity}&id=${exportJob.value.id}`;
  for (let i = 0; i < 100; i++) { state = await fetch(`${base}/results-transfer/status?${exportQuery}`).then((r) => r.json()); if (state.value.phase === 'ready') break; await delay(10); }
  assert.equal(state.value.phase, 'ready');
  const downloaded = await fetch(`${base}/results-transfer/archive?${exportQuery}`);
  assert.equal(downloaded.headers.get('content-type'), 'application/zip');
  const downloadedPath = path.join(temp, 'downloaded.zip');
  await writeFile(downloadedPath, Buffer.from(await downloaded.arrayBuffer()));
  assert.equal((await inspectResultsZip(downloadedPath)).length, 2);
});

test('filesystem junctions cannot redirect exported or imported photographs outside Downloads/WatchAutomation', async (t) => {
  const temp = await temporary(t), root = path.join(temp, 'WatchAutomation'), external = path.join(temp, 'outside');
  await mkdir(root); await mkdir(external);
  await symlink(external, path.join(root, 'in_sale_good'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(external, '0.png'), png(0));
  const record = { ...revision(0), outputPath: path.join(root, 'in_sale_good', '0.png') };
  const manager = createResultsTransferManager({ outputRoot: root });
  const exported = await manager.startExport([record], owner);
  assert.equal((await wait(manager, exported.id, 'ready')).phase, 'error');
  const zip = path.join(temp, 'valid.zip');
  await writeResultsZip(zip, [{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest([record]))) }, { name: `images/${record.outputHash}.png`, bytes: png(0) }]);
  const incoming = await upload(manager, zip); await wait(manager, incoming.id, 'ready');
  await manager.install(incoming.id, owner);
  assert.equal((await wait(manager, incoming.id, 'installed')).phase, 'error');
  assert.deepEqual(await readdir(external), ['0.png']);
});

test('gallery workflow previews before merge, waits for disk installation and retries interrupted completion', async (t) => {
  const original = { document: globalThis.document, chrome: globalThis.chrome, Option: globalThis.Option, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const nodes = new Map();
  const calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, value: '', files: [], listeners: {},
      classList: { toggle() {} }, addEventListener(type, listener) { this.listeners[type] = listener; },
      showModal() {}, close() {}, replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
      append(option) { this.options.push(option); } });
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node };
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value; } };
  let failed = false, phase = 'ready', reloaded = 0;
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    calls.push(message.type);
    if (message.type === 'GET_RESULTS_TRANSFER_INFO') return { ok: true, value: { count: 100, runs: [{ id: 'run-id', count: 100, date: '2026-10-05T12:00:00Z' }],
      identity: { extensionId: 'a'.repeat(32), clientId: 'ui-test-client' } } };
    if (message.type === 'PREVIEW_RESULTS_IMPORT') return { ok: true, value: { total: 100, models: 100, newResults: 98, duplicates: 2, conflicts: 1, withoutFacts: 0 } };
    if (message.type === 'COMMIT_RESULTS_IMPORT') {
      assert.equal(phase, 'installed', 'merge must follow completed file installation');
      if (!failed) { failed = true; return { ok: false, error: 'temporary storage failure' }; }
      return { ok: true, value: { newResults: 98, duplicates: 2, conflicts: 1 } };
    }
    return { ok: true, value: {} };
  } } };
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname === '/health') return { ok: true, json: async () => ({ apiVersion: 11 }) };
    if (target.pathname.endsWith('/import')) { assert.ok(options.body instanceof File); return { ok: true, json: async () => ({ ok: true, value: { id: 'import-id' } }) }; }
    if (target.pathname.endsWith('/install')) { phase = 'installed'; calls.push('DISK_INSTALL'); }
    return { ok: true, json: async () => ({ ok: true, value: { kind: 'import', phase, id: 'import-id' } }) };
  };
  initResultsTransfer({ reload: async () => { reloaded++; } });
  const click = async (id) => {
    node(id).listeners.click();
    for (let i = 0; i < 100 && node('resultsTransferClose').disabled; i++) await delay(1);
    assert.equal(node('resultsTransferClose').disabled, false);
  };
  await click('resultsTransferOpen');
  node('resultsImportFile').files = [new File(['zip-data'], 'results.zip')];
  await click('resultsImportCheck');
  assert.ok(node('resultsTransferStatus').textContent.includes('Новых: 98'));
  assert.equal(node('resultsImportApply').hidden, false);
  assert.equal(calls.includes('COMMIT_RESULTS_IMPORT'), false);
  await click('resultsImportApply');
  assert.ok(calls.indexOf('CLAIM_RESULTS_IMPORT') < calls.indexOf('DISK_INSTALL'));
  assert.ok(node('resultsTransferStatus').textContent.includes('temporary storage failure'));
  assert.equal(node('resultsImportResume').hidden, false);
  node('resultsImportFile').listeners.change();
  await click('resultsImportResume');
  assert.equal(reloaded, 1);
  assert.equal(node('resultsImportResume').hidden, true);
});
