import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  DB_NAME,
  STORE,
  openDb,
  transactionResult,
  adoptLegacyGenerationRevisions,
  beginGenerationRevision,
  cancelUnsubmittedGenerationRevision,
  getAllGenerationRevisions,
  getAllModelCatalog,
  getGenerationRevision,
  getGenerationRevisionsForSource,
  getModelCatalog,
  persistGenerationFactsRevision,
  persistGenerationImageRevision,
  rejectGenerationRevision,
  replaceModelCatalog,
  upsertGenerationRevision
} from '../extension/idb.js';
import {
  QUEUE_GROUP_IDS,
  applyGenerationMemory,
  factsMetadataProjections,
  filteredWatchEntries,
  generationMemoryMatchesQueueAsset,
  generationMemoryMatchesQueueEntry,
  mergeScannedGroups,
  modelCatalogRecordsFromGroups,
  pendingEntryIdsForFilter,
  pendingEntryIds,
  queuePartPlan,
  queueGroupsFromCatalog,
  resetUnfinishedQueueGenerationState,
  chooseSourceVariant
} from '../extension/queue-utils.js';
import { galleryRecordsFromCatalog, currentRevisionsForCatalog } from '../extension/gallery-revision-utils.js';
import { verifiedRevisionMatchesEvent } from '../extension/generation-revision-utils.js';
import {
  shouldTripAttachmentFailureCircuitBreaker,
  coalescedPauseDeadline,
  isRateLimitIgnored,
  resolveGenerationPause,
  scheduledRunRetries
} from '../extension/reliability-utils.js';
import { factsStageMatchesOwner, selectFactsProgressForSlot } from '../extension/facts-progress-utils.js';
import {
  excludeRepairQueueEntries,
  selectRepairQueueEntries,
  upsertRepairQueueItem
} from '../extension/repair-queue-utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const future = '2099-01-01T00:00:00.000Z';

test('attachment failures trip a run circuit breaker only across three distinct unsent models', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const errorFor = (entryId, secondsAgo = 10) => ({
    entryId,
    slotId: 0,
    generationSubmitted: false,
    at: new Date(now - secondsAgo * 1000).toISOString(),
    message: 'Timeout waiting for attachment batch 2 (90000ms)'
  });

  assert.equal(shouldTripAttachmentFailureCircuitBreaker({ errors: [errorFor('sku-a')] }, errorFor('sku-b'), now), false);
  assert.equal(shouldTripAttachmentFailureCircuitBreaker({ errors: [errorFor('sku-a'), errorFor('sku-a')] }, errorFor('sku-a'), now), false,
    'duplicate reports for one model cannot trip the breaker');
  assert.equal(shouldTripAttachmentFailureCircuitBreaker({ errors: [errorFor('sku-a'), errorFor('sku-b')] }, errorFor('sku-c'), now), true);
  assert.equal(shouldTripAttachmentFailureCircuitBreaker({ errors: [errorFor('sku-a', 900)] }, errorFor('sku-b'), now), false,
    'old failures outside the ten-minute window are ignored');
  assert.equal(shouldTripAttachmentFailureCircuitBreaker({ errors: [errorFor('sku-a'), errorFor('sku-b')] }, {
    ...errorFor('sku-c'), generationSubmitted: true
  }, now), false, 'a submitted generation is never classified as an attachment-only failure');
});

test('IndexedDB transactions have a hard timeout instead of remaining pending forever', async () => {
  const db = await openDb();
  try {
    await assert.rejects(transactionResult(db, [STORE], (tx) => {
      const store = tx.objectStore(STORE);
      const keepAlive = () => {
        const request = store.get('__keep_alive__');
        request.onsuccess = keepAlive;
      };
      keepAlive();
    }, 'Test deliberately stalled write', 20), (error) => error.code === 'IDB_TRANSACTION_TIMEOUT');
  } finally {
    db.close();
  }
});

test('pausing an unsent revision cancels its catalog pointer and preserves the audit row', async () => {
  const sourceId = `pause-${randomUUID()}`;
  const generationId = `generation-${randomUUID()}`;
  await beginGenerationRevision({ sourceId, generationId, sourceVariantId: `variant-${sourceId}`,
    operationId: `run-${randomUUID()}`, leaseId: `lease-${randomUUID()}` });
  assert.equal((await getModelCatalog(sourceId)).currentGenerationId, generationId);
  assert.deepEqual(await cancelUnsubmittedGenerationRevision(generationId, sourceId, 'user_pause_before_send'), { cancelled: true });
  const revision = await getGenerationRevision(generationId);
  const catalog = await getModelCatalog(sourceId);
  assert.equal(revision.status, 'CANCELLED');
  assert.equal(revision.cancellationReason, 'user_pause_before_send');
  assert.equal(catalog.currentGenerationId, null);
  assert.equal(catalog.queueState.status, 'pending');
  assert.deepEqual(await cancelUnsubmittedGenerationRevision(generationId, sourceId), { cancelled: false });
});

function completeFacts({ generationId, factsJobId, outputPath, outputHash, chatUrl }) {
  return {
    status: 'ok',
    generationId,
    factsJobId,
    outputPath,
    outputHash,
    chatUrl,
    titleBrand: 'Casio',
    titleSeries: 'Collection',
    titleModel: 'AE-1200WHD-1A',
    utp1: 'Батарея 10 лет',
    utp2: 'Мировое время',
    waterResistance: '100 м',
    caseSize: '45 мм',
    uncertain: []
  };
}

function modelRecord(skuKey = 'casio:AE1200WHD1A') {
  return {
    skuKey,
    sourceId: skuKey,
    brandId: 'casio',
    modelName: 'Casio AE-1200WHD-1A',
    sourcePresent: true,
    variants: [{
      sourceVariantId: 'input-watches-images/in_sale/AE-1200WHD-1A.png',
      variantId: 'input-watches-images/in_sale/AE-1200WHD-1A.png',
      groupId: 'in_sale_good',
      relativePath: 'input-watches-images/in_sale/AE-1200WHD-1A.png',
      fileName: 'AE-1200WHD-1A.png',
      modelName: 'Casio AE-1200WHD-1A',
      fingerprint: '128:1000:AE-1200WHD-1A.png',
      sourceHash: digest('input-v1'),
      status: 'pending',
      size: 128,
      lastModified: 1000
    }],
    queueState: { status: 'pending', generationId: null }
  };
}

test('a saved facts status cannot put a completed model back into the regular queue', () => {
  const model = modelRecord();
  model.variants[0].status = 'ready';
  model.queueState.status = 'ready';
  const previous = { in_sale_good: [{
    sourceId: model.skuKey,
    skuKey: model.skuKey,
    status: 'ready',
    generationId: 'revision-ready',
    outputPath: 'C:/tmp/revision-ready.png',
    outputHash: digest('revision-ready')
  }] };
  const entry = queueGroupsFromCatalog([model], previous).in_sale_good[0];
  assert.equal(entry.status, 'done');
  assert.equal(filteredWatchEntries({ in_sale_good: [entry] }, { saleStatus: 'in_sale', quality: 'good', brand: 'casio' })[0].status, 'done');
  assert.deepEqual(pendingEntryIds([entry]), []);
});

test('facts updates preserve queue and memory status domains', () => {
  for (const [factsStatus, memoryStatus] of [
    ['pending', 'facts_pending'], ['ok', 'ready'], ['error', 'image_saved']
  ]) {
    const projected = factsMetadataProjections({ factsStatus, chatUrl: 'https://chatgpt.com/c/example' });
    assert.equal(projected.queue.status, 'done');
    assert.equal(projected.memory.status, memoryStatus);
    assert.equal(projected.queue.chatUrl, projected.memory.chatUrl);
  }
});

test('stopped unfinished memory resets its matching variant and leaves other quality assets isolated', () => {
  const sourceId = 'casio:ae-1200whd-1a';
  const goodVariantId = 'input-watches-images/in_sale/AE-1200WHD-1A.png';
  const badVariantId = 'input-watches-images/in_sale/bad_resolution/AE-1200WHD-1A.png';
  const goodIdentity = {
    sourceId,
    sourceVariantId: goodVariantId,
    groupId: 'in_sale_good',
    relativePath: goodVariantId,
    fileName: 'AE-1200WHD-1A.png',
    fingerprint: '128:1000:AE-1200WHD-1A.png',
    sourceHash: digest('good-source')
  };
  const entry = {
    ...goodIdentity,
    skuKey: sourceId,
    inputSourceId: goodVariantId,
    modelName: 'Casio AE-1200WHD-1A',
    status: 'pending',
    variants: [
      { ...goodIdentity, variantId: goodVariantId, status: 'running', generationId: 'stale-good', lastError: 'old timeout', errorClass: 'timeout' },
      {
        sourceVariantId: badVariantId,
        variantId: badVariantId,
        groupId: 'in_sale_bad',
        relativePath: badVariantId,
        fileName: 'AE-1200WHD-1A.png',
        fingerprint: '64:1000:AE-1200WHD-1A.png',
        sourceHash: digest('bad-source'),
        status: 'running',
        generationId: 'other-quality-run',
        lastError: 'different asset'
      }
    ]
  };
  const groups = { in_sale_good: [entry], in_sale_bad: [], not_in_sale_good: [], not_in_sale_bad: [] };
  const memoryRecord = {
    ...goodIdentity,
    status: 'not_ready',
    generationId: null,
    lastError: null,
    errorClass: null,
    nextRetryAt: null
  };
  const memory = { items: { [sourceId]: memoryRecord } };

  applyGenerationMemory(groups, memory);
  assert.equal(entry.variants[0].status, 'pending', 'memory status replaces stale running variant state');
  assert.equal(entry.variants[0].generationId, null);
  assert.equal(entry.variants[1].status, 'running', 'a different quality variant keeps its own state');
  assert.equal(generationMemoryMatchesQueueAsset(memoryRecord, {
    ...goodIdentity,
    fingerprint: 'changed-fingerprint',
    sourceHash: digest('changed-source')
  }), true, 'the same path remains associated so changed bytes can invalidate old progress');
  assert.equal(generationMemoryMatchesQueueEntry(memoryRecord, {
    ...goodIdentity,
    fingerprint: 'changed-fingerprint',
    sourceHash: digest('changed-source')
  }), false, 'changed bytes cannot inherit the old generation result');

  entry.lastError = 'stale queue error';
  entry.variants[0].status = 'running';
  entry.variants[0].generationId = 'stale-good';
  entry.variants[0].lastError = 'stale variant error';
  const reset = resetUnfinishedQueueGenerationState(entry, { identity: memoryRecord, resetEntry: true });
  assert.deepEqual(reset, { entryReset: true, variantsReset: 1 });
  const again = resetUnfinishedQueueGenerationState(entry, { identity: memoryRecord, resetEntry: true });
  assert.deepEqual(again, { entryReset: false, variantsReset: 0 }, 'repeated stop normalization is idempotent');
  const completed = {
    ...goodIdentity,
    status: 'done',
    generationId: 'confirmed-generation',
    outputPath: 'C:/results/confirmed.png',
    outputHash: digest('confirmed-png')
  };
  assert.deepEqual(resetUnfinishedQueueGenerationState(completed), { entryReset: false, variantsReset: 0 });
  assert.equal(completed.generationId, 'confirmed-generation');
  assert.equal(completed.outputPath, 'C:/results/confirmed.png');
  applyGenerationMemory(groups, memory);

  const selected = filteredWatchEntries(groups, { saleStatus: 'in_sale', quality: 'good', brand: 'casio' });
  assert.equal(selected[0].status, 'pending');
  assert.deepEqual(pendingEntryIdsForFilter(selected, 100, 'queue'), [sourceId]);
  assert.deepEqual(queuePartPlan(selected, 100, 'regular|in_sale|good|casio').parts[0].sourceIds, [sourceId]);
  assert.equal(entry.variants[1].status, 'running', 'repair remains scoped to the matching source variant');
});

test('legacy sparse generation memory still restores a completed queue row', () => {
  const sourceId = 'casio:legacy-model';
  const entry = {
    sourceId,
    skuKey: sourceId,
    groupId: 'in_sale_good',
    fileName: 'Legacy.png',
    status: 'pending'
  };
  const memory = { items: { [sourceId]: { sourceId, fileName: 'Legacy.png', status: 'ready', generationId: 'legacy-ready' } } };
  applyGenerationMemory({ in_sale_good: [entry] }, memory);
  assert.equal(entry.status, 'done');
  assert.equal(entry.generationId, 'legacy-ready');
});

function idbDelete(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB ${name} deletion was blocked`));
  });
}

async function startRevision({ skuKey, id, pathName, chat = `https://chatgpt.com/c/${id}`, imageText = id, operationId = 'offline-operation' }) {
  const factsJobId = `facts-${id}`;
  const outputHash = digest(`png-${imageText}`);
  await beginGenerationRevision({
    generationId: id,
    sourceId: skuKey,
    operationId,
    sourceVariantId: modelRecord(skuKey).variants[0].sourceVariantId,
    modelName: `Casio ${skuKey}`,
    outputFileName: path.basename(pathName),
    chatUrl: chat,
    factsJobId,
    status: 'GENERATING',
    createdAt: future
  });
  await persistGenerationImageRevision({
    generationId: id,
    sourceId: skuKey,
    operationId,
    sourceVariantId: modelRecord(skuKey).variants[0].sourceVariantId,
    factsJobId,
    outputPath: pathName,
    outputHash,
    outputFileName: path.basename(pathName),
    chatUrl: chat,
    factsStatus: 'pending',
    downloadedAt: future,
    completedAt: future
  });
  return { generationId: id, sourceId: skuKey, operationId, factsJobId, outputPath: pathName, outputHash, chatUrl: chat };
}

async function saveFacts(revision, facts = completeFacts(revision)) {
  return persistGenerationFactsRevision({
    ...revision,
    facts,
    factsStatus: 'ok',
    status: 'READY',
    extractedAt: future
  });
}

test('offline catalog, immutable revisions, queues, stale OCR, rejection, restart, and partial JSON', async (t) => {
  await idbDelete();
  t.after(() => idbDelete());

  await t.test('temporary input scan collapses duplicate SKU variants and detects a same-size/same-time content change', async (scanTest) => {
    const inputBase = await mkdtemp(path.join(os.tmpdir(), `watch-input-fixture-${randomUUID()}-`));
    const inputRoot = path.join(inputBase, 'input-watches-images');
    scanTest.after(() => rm(inputBase, { recursive: true, force: true }));
    const fixedTime = new Date('2026-01-02T03:04:05.000Z');
    const inputs = [
      { relative: 'in_sale/Benyar BY-5101-1B.png', content: 'benyar-1' },
      { relative: 'not_in_sale/Benyar BY-5101-1B.png', content: 'benyar-2' },
      { relative: 'in_sale/Casio AE-1200WHD-1A.png', content: 'casio-v1' }
    ];
    for (const item of inputs) {
      const fullPath = path.join(inputRoot, item.relative);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, Buffer.from(item.content));
      await utimes(fullPath, fixedTime, fixedTime);
    }
    const empty = Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []]));
    const scanTemporaryInput = async () => {
      const scanned = structuredClone(empty);
      const visit = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true });
        const paths = [];
        for (const entry of entries) {
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) paths.push(...await visit(fullPath));
          else if (entry.isFile()) paths.push(fullPath);
        }
        return paths;
      };
      for (const fullPath of await visit(inputRoot)) {
        const relative = path.relative(inputRoot, fullPath).split(path.sep).join('/');
        const groupId = relative.startsWith('in_sale/') ? 'in_sale_good' : 'not_in_sale_good';
        const [info, bytes] = await Promise.all([stat(fullPath), readFile(fullPath)]);
        scanned[groupId].push({
          groupId,
          file: { name: path.basename(fullPath), size: info.size, lastModified: info.mtimeMs },
          relativePath: `input-watches-images/${relative}`,
          sourceHash: digest(bytes)
        });
      }
      return scanned;
    };
    const scanned = await scanTemporaryInput();

    const firstGroups = mergeScannedGroups(scanned, empty);
    const firstCatalog = modelCatalogRecordsFromGroups(firstGroups);
    const benyar = firstCatalog.find((row) => row.brandId === 'benyar');
    assert.ok(benyar, 'both Benyar files resolve to a catalog SKU');
    assert.equal(benyar.variants.length, 2);
    assert.equal(new Set(benyar.variants.map((variant) => variant.sourceVariantId)).size, 2);
    assert.equal(chooseSourceVariant(benyar.variants).groupId, 'in_sale_good', 'sale and quality tags determine the default variant');

    const previous = structuredClone(firstGroups);
    for (const groupId of QUEUE_GROUP_IDS) {
      for (const entry of previous[groupId]) {
        entry.status = 'done';
        entry.generationId = 'old-generation';
        entry.variants = entry.variants.map((variant) => ({ ...variant, status: 'done', generationId: 'old-generation' }));
      }
    }
    const casioFile = path.join(inputRoot, 'in_sale', 'Casio AE-1200WHD-1A.png');
    await writeFile(casioFile, Buffer.from('casio-v2'));
    await utimes(casioFile, fixedTime, fixedTime);
    const changed = await scanTemporaryInput();
    const oldCasio = scanned.in_sale_good.find((item) => item.file.name.startsWith('Casio'));
    const newCasio = changed.in_sale_good.find((item) => item.file.name.startsWith('Casio'));
    assert.equal(oldCasio.file.size, newCasio.file.size);
    assert.equal(oldCasio.file.lastModified, newCasio.file.lastModified);
    assert.notEqual(oldCasio.sourceHash, newCasio.sourceHash);
    const rescanned = mergeScannedGroups(changed, previous);
    const casioRow = modelCatalogRecordsFromGroups(rescanned).find((row) => row.brandId === 'casio');
    assert.equal(casioRow.variants[0].status, 'pending', 'changed source bytes reset only this input variant');
    assert.equal(casioRow.variants[0].generationId, null);
    const benyarAfter = modelCatalogRecordsFromGroups(rescanned).find((row) => row.brandId === 'benyar');
    assert.ok(benyarAfter.variants.every((variant) => variant.status === 'done'), 'unchanged duplicate SKU variants retain completion');

    await replaceModelCatalog(firstCatalog);
    const visible = await getAllModelCatalog();
    assert.equal(visible.length, firstCatalog.length);
    await replaceModelCatalog(firstCatalog.filter((row) => row.brandId !== 'casio'));
    assert.equal((await getAllModelCatalog()).some((row) => row.brandId === 'casio'), false);
    const removed = (await getAllModelCatalog({ includeRemoved: true })).find((row) => row.brandId === 'casio');
    assert.equal(removed.sourcePresent, false, 'manual rescan retains removed SKU history as unavailable');
  });

  await t.test('three physical revisions keep exact image/facts/chat and the gallery follows the persisted latest-ready pointer', async () => {
    await idbDelete();
    const skuKey = 'casio:AE1200WHD1A';
    await replaceModelCatalog([modelRecord(skuKey)]);
    const names = ['AE-1200WHD-1A.png', 'AE-1200WHD-1A (1).png', 'AE-1200WHD-1A (2).png'];
    const revisions = [];

    const a1 = await startRevision({ skuKey, id: 'revision-a1', pathName: `C:/tmp/WatchAutomation/in_sale_good/${names[0]}` });
    const a2 = await startRevision({ skuKey, id: 'revision-a2', pathName: `C:/tmp/WatchAutomation/in_sale_good/${names[1]}` });
    assert.deepEqual(await saveFacts(a1), { latest: false, matched: true });
    revisions.push(a1);
    assert.equal(galleryRecordsFromCatalog(await getAllModelCatalog(), await getAllGenerationRevisions()).length, 0,
      'late OCR for A1 cannot publish while A2 owns the current generation');

    const a1Late = completeFacts({ ...a1, utp1: 'Старый ответ A1' });
    a1Late.utp1 = 'Старый ответ A1';
    assert.deepEqual(await saveFacts(a1, a1Late), { latest: false, matched: true, duplicate: true });
    await saveFacts(a2);
    revisions.push(a2);
    let catalog = await getAllModelCatalog();
    let allRevisions = await getGenerationRevisionsForSource(skuKey);
    let gallery = galleryRecordsFromCatalog(catalog, allRevisions);
    assert.equal(gallery.length, 1);
    assert.equal(gallery[0].generationId, a2.generationId);
    assert.equal(gallery[0].outputPath, a2.outputPath, 'duplicate Chrome filename order is irrelevant');
    assert.equal(gallery[0].facts.utp1, 'Батарея 10 лет');
    assert.equal(gallery[0].chatUrl, a2.chatUrl);

    const a3 = await startRevision({ skuKey, id: 'revision-a3', pathName: `C:/tmp/WatchAutomation/in_sale_good/${names[2]}` });
    await saveFacts(a3);
    revisions.push(a3);
    catalog = await getAllModelCatalog();
    allRevisions = await getGenerationRevisionsForSource(skuKey);
    gallery = galleryRecordsFromCatalog(catalog, allRevisions);
    assert.equal(allRevisions.length, 3);
    assert.equal(gallery.length, 1);
    assert.deepEqual(currentRevisionsForCatalog(catalog, allRevisions).map((item) => item.generationId), ['revision-a3'],
      'gallery post-processing reads the catalog currentGenerationId from the matching revision map');
    assert.equal(gallery[0].generationId, a3.generationId);
    assert.equal(gallery[0].outputPath, a3.outputPath);
    assert.equal(gallery[0].outputHash, a3.outputHash);
    assert.equal(gallery[0].facts.generationId, a3.generationId);
    assert.equal(gallery[0].facts.factsJobId, a3.factsJobId);
    assert.equal(gallery[0].chatUrl, a3.chatUrl);

    const obsoleteReject = await rejectGenerationRevision('revision-a2', { archivePath: 'C:/tmp/WatchAutomation/_archive/in_sale_good/revision-a2.png' });
    assert.equal(obsoleteReject.reviewStatus, 'rejected');
    assert.equal((await getModelCatalog(skuKey)).latestReadyGenerationId, 'revision-a3',
      'rejecting an old gallery card cannot clear a newer revision pointer');
    assert.equal(galleryRecordsFromCatalog(await getAllModelCatalog(), await getAllGenerationRevisions())[0].generationId, 'revision-a3');

    const persistedAcrossReload = await getModelCatalog(skuKey);
    assert.equal(persistedAcrossReload.latestReadyGenerationId, 'revision-a3');
    assert.equal((await getGenerationRevision('revision-a1')).outputPath, a1.outputPath);
    assert.equal(queueGroupsFromCatalog([persistedAcrossReload]).in_sale_good[0].status, 'done',
      'worker/extension reload does not put completed SKU back into the regular queue');

    const queue = { repairQueue: [] };
    upsertRepairQueueItem(queue, skuKey, 'revision-a3');
    const normalEntries = queueGroupsFromCatalog([persistedAcrossReload]).in_sale_good;
    assert.deepEqual(pendingEntryIds(excludeRepairQueueEntries(normalEntries, queue.repairQueue)), [],
      'manual reject work remains outside the ordinary queue');
    assert.deepEqual(selectRepairQueueEntries([{ sourceId: skuKey, status: 'pending' }], queue.repairQueue).map((item) => item.sourceId), [skuKey]);

    const rejected = await rejectGenerationRevision('revision-a3', { archivePath: 'C:/tmp/WatchAutomation/_archive/in_sale_good/revision-a3.png' });
    assert.equal(rejected.reviewStatus, 'rejected');
    assert.equal(rejected.facts, null);
    assert.equal(rejected.archivedFacts.generationId, 'revision-a3');
    assert.equal((await getGenerationRevision('revision-a3')).reviewStatus, 'rejected');
    catalog = await getAllModelCatalog();
    gallery = galleryRecordsFromCatalog(catalog, await getAllGenerationRevisions());
    assert.equal(gallery.length, 0, 'rejected revision is no longer an active gallery card');
    assert.equal((await getGenerationRevision('revision-a2')).status, 'READY', 'prior revision remains in version history');
  });

  await t.test('five hidden owners still persist complete OCR responses arriving after fifteen virtual minutes', async () => {
    await idbDelete();
    const skuKeys = Array.from({ length: 5 }, (_, index) => `casio:model${index + 1}`);
    await replaceModelCatalog(skuKeys.map((skuKey) => modelRecord(skuKey)));
    const hiddenOwners = await Promise.all(skuKeys.map((skuKey, index) => startRevision({
      skuKey,
      id: `hidden-${index + 1}`,
      pathName: `C:/tmp/WatchAutomation/in_sale_good/model-${index + 1}.png`,
      operationId: 'five-tab-run'
    }).then((revision) => ({ ...revision, tabId: index + 101, visibilityState: 'hidden', discarded: false }))));

    const responseAt = Date.now() + 15 * 60 * 1000;
    const completions = await Promise.all(hiddenOwners.map(async (owner, index) => {
      const revision = await getGenerationRevision(owner.generationId);
      const event = {
        type: 'output_verified',
        operationId: 'five-tab-run',
        entryId: owner.sourceId,
        generationId: owner.generationId,
        outputPath: owner.outputPath,
        sha256: owner.outputHash,
        observedAt: responseAt,
        visibilityState: owner.visibilityState,
        tabId: owner.tabId
      };
      assert.equal(verifiedRevisionMatchesEvent(event, revision, 'five-tab-run'), true);
      return saveFacts(owner, completeFacts(owner));
    }));
    assert.equal(completions.filter((result) => result.latest).length, 5);
    const reopenedCatalog = await getAllModelCatalog();
    const reopenedRevisions = await getAllGenerationRevisions();
    const reopenedGallery = galleryRecordsFromCatalog(reopenedCatalog, reopenedRevisions);
    assert.equal(reopenedGallery.length, 5, 'a newly opened gallery reads all five persistent cards');
    assert.deepEqual(new Set(reopenedGallery.map((record) => record.generationId)), new Set(hiddenOwners.map((owner) => owner.generationId)));
    assert.ok(reopenedGallery.every((record) => record.factsStatus === 'ok' && record.chatUrl && record.outputHash));
  });

  await t.test('partial streamed JSON is rejected at every prefix and full response is accepted immediately', async () => {
    const source = await readFile(path.join(root, 'extension', 'facts-json-utils.js'), 'utf8');
    const context = {};
    runInNewContext(source, context);
    const factsUtils = context.WatchFactsUtils;
    const full = JSON.stringify(completeFacts({ generationId: 'g', factsJobId: 'f', outputPath: 'x.png', outputHash: digest('x'), chatUrl: 'https://chatgpt.com/c/1' }));
    for (let end = 0; end < full.length; end += 1) {
      assert.equal(factsUtils.isCompleteFactsResponse(full.slice(0, end)), false, `prefix length ${end} is incomplete`);
    }
    assert.equal(factsUtils.isCompleteFactsResponse(full), true);
    assert.equal(factsUtils.parseExtractionJson(full).parsed.utp1, 'Батарея 10 лет');
  });

  await t.test('legacy migration adopts only a provable path/hash/facts tuple and leaves old stores intact', async () => {
    await idbDelete();
    const skuKey = 'casio:AE1200WHD1A';
    await replaceModelCatalog([modelRecord(skuKey)]);
    const unreliable = {
      generationId: 'legacy-without-image-identity',
      sourceId: 'legacy:AE1200',
      status: 'READY',
      factsStatus: 'ok',
      factsJobId: 'legacy-facts-job',
      facts: completeFacts({
        generationId: 'legacy-without-image-identity',
        factsJobId: 'legacy-facts-job',
        outputPath: null,
        outputHash: null,
        chatUrl: 'https://chatgpt.com/c/legacy'
      })
    };
    await upsertGenerationRevision(unreliable);
    assert.deepEqual(await adoptLegacyGenerationRevisions({ 'legacy:AE1200': skuKey }), { adopted: 0, ready: 0 });
    assert.equal((await getGenerationRevision(unreliable.generationId)).sourceId, 'legacy:AE1200');
    assert.equal((await getModelCatalog(skuKey)).latestReadyGenerationId || null, null);

    const outputPath = 'C:/tmp/WatchAutomation/in_sale_good/legacy-a.png';
    const outputHash = digest('legacy-image');
    const reliable = {
      generationId: 'legacy-with-exact-tuple',
      sourceId: 'legacy:AE1201',
      status: 'READY',
      factsStatus: 'ok',
      factsJobId: 'legacy-facts-job-2',
      outputPath,
      outputHash,
      chatUrl: 'https://chatgpt.com/c/reliable-legacy',
      completedAt: future,
      facts: completeFacts({
        generationId: 'legacy-with-exact-tuple',
        factsJobId: 'legacy-facts-job-2',
        outputPath,
        outputHash,
        chatUrl: 'https://chatgpt.com/c/reliable-legacy'
      })
    };
    await upsertGenerationRevision(reliable);
    assert.deepEqual(await adoptLegacyGenerationRevisions({ 'legacy:AE1201': skuKey }), { adopted: 1, ready: 1 });
    const migrated = await getGenerationRevision(reliable.generationId);
    assert.equal(migrated.sourceId, skuKey);
    assert.equal((await getModelCatalog(skuKey)).latestReadyGenerationId, reliable.generationId);
    const cards = galleryRecordsFromCatalog(await getAllModelCatalog(), await getAllGenerationRevisions());
    assert.equal(cards.length, 1);
    assert.equal(cards[0].outputPath, outputPath);
    assert.equal(cards[0].chatUrl, reliable.chatUrl);

    const db = await import('../extension/idb.js');
    const opened = await db.openDb();
    const stores = [...opened.objectStoreNames];
    opened.close();
    assert.ok(stores.includes('assets'));
    assert.ok(stores.includes('handles'));
    assert.ok(stores.includes('generationFacts'));
    assert.ok(stores.includes('generationRevisions'));
    assert.ok(stores.includes('modelCatalog'));
  });

  await t.test('saved pause survives worker restart and cooldown/ignore deadlines do not stack', () => {
    const samples = [0.32, 0.82];
    const first = resolveGenerationPause(null, 3, 30, () => samples.shift());
    const persistedRun = JSON.parse(JSON.stringify({ generationGapMs: first.delayMs, nextSendAt: 500000 }));
    const resumed = resolveGenerationPause(persistedRun.generationGapMs, 3, 30, () => { throw new Error('worker wake must reuse the stored sample'); });
    assert.equal(resumed.reused, true);
    assert.equal(resumed.delayMs, first.delayMs);

    const pauseUntil = coalescedPauseDeadline(300000, 250000, 180000);
    assert.equal(pauseUntil, 300000, 'duplicate limit detection does not extend active cooldown');
    const resumedAfterCooldown = coalescedPauseDeadline(pauseUntil, 301000, 180000);
    assert.equal(resumedAfterCooldown, 481000, 'a new incident starts only after the old cooldown expires');
    const ignoreUntil = resumedAfterCooldown + 10 * 60 * 1000;
    assert.equal(isRateLimitIgnored(ignoreUntil, resumedAfterCooldown + 1), true);
    assert.equal(isRateLimitIgnored(ignoreUntil, ignoreUntil), false);
  });
});

test('watcher serves and archives only the requested temporary PNG revision after hash verification', async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), `watch-automation-offline-${randomUUID()}-`));
  const outputRoot = path.join(temporaryParent, 'WatchAutomation');
  const groupRoot = path.join(outputRoot, 'in_sale_good');
  await mkdir(groupRoot, { recursive: true });
  t.after(() => rm(temporaryParent, { recursive: true, force: true }));

  const basePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tfUAAAAASUVORK5CYII=', 'base64');
  const files = ['name.png', 'name (1).png', 'name (2).png'].map((name, index) => {
    const bytes = Buffer.concat([basePng, Buffer.from([index + 1])]);
    const filePath = path.join(groupRoot, name);
    return { name, bytes, filePath, hash: digest(bytes) };
  });
  for (const file of files) await writeFile(file.filePath, file.bytes);
  const older = new Date(Date.now() - 60000);
  await utimes(files[0].filePath, older, older);
  await utimes(files[1].filePath, new Date(), new Date());

  const portServer = (await import('node:net')).createServer();
  await new Promise((resolve, reject) => portServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = portServer.address();
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'dev', 'watch-extension.mjs')], {
    cwd: root,
    env: { ...process.env, WATCH_AUTOMATION_PORT: String(port), WATCH_AUTOMATION_OUTPUT_ROOT: outputRoot },
    stdio: 'ignore',
    windowsHide: true
  });
  t.after(async () => {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let health = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.ok, true, 'isolated watcher process starts on its temporary port');

  const selected = files[1];
  const exactUrl = `${baseUrl}/output-file?path=${encodeURIComponent(selected.filePath)}&expectedHash=${selected.hash}`;
  const exactResponse = await fetch(exactUrl);
  assert.equal(exactResponse.status, 200);
  assert.deepEqual(Buffer.from(await exactResponse.arrayBuffer()), selected.bytes);

  const wrongHashResponse = await fetch(`${baseUrl}/output-file?path=${encodeURIComponent(selected.filePath)}&expectedHash=${digest('wrong')}`);
  assert.equal(wrongHashResponse.status, 409);

  const archiveResponse = await fetch(`${baseUrl}/output-archive-revision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: selected.filePath, expectedHash: selected.hash, root: outputRoot, archiveGroupId: 'in_sale_good' })
  });
  assert.equal(archiveResponse.status, 200);
  const archived = await archiveResponse.json();
  assert.equal(archived.archived, 1);
  assert.equal(archived.outputHash, selected.hash);
  assert.equal(await stat(selected.filePath).then(() => true).catch(() => false), false, 'only the exact revision leaves the active output folder');
  assert.equal(await stat(files[0].filePath).then(() => true).catch(() => false), true);
  assert.equal(await stat(files[2].filePath).then(() => true).catch(() => false), true);
  const archiveFiles = await readdir(path.join(outputRoot, '_archive', 'in_sale_good'));
  assert.equal(archiveFiles.length, 1);
  assert.equal(digest(await readFile(path.join(outputRoot, '_archive', 'in_sale_good', archiveFiles[0]))), selected.hash);
  const missingFileResponse = await fetch(exactUrl);
  assert.equal(missingFileResponse.status, 404, 'gallery can surface a missing exact revision without selecting a neighbor');

  const mismatchArchive = await fetch(`${baseUrl}/output-archive-revision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: files[2].filePath, expectedHash: selected.hash, root: outputRoot, archiveGroupId: 'in_sale_good' })
  });
  assert.equal(mismatchArchive.status, 409, 'mismatched revision hash cannot archive a neighbor');
  assert.equal(await stat(files[2].filePath).then(() => true).catch(() => false), true);
});

test('retry deadlines resume only unsent entries and respect a manual pause', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const run = {
    state: 'RUNNING',
    plannedIds: ['sku-a', 'sku-b'],
    slots: {
      0: { slotId: 0, entryId: 'sku-a', status: 'PAUSED', phase: 'RETRY_BACKOFF', nextRetryAt: '2026-09-25T12:00:10.000Z' },
      1: { slotId: 1, entryId: 'sku-b', status: 'OBSERVING', phase: 'OBSERVING', generationSubmittedAt: '2026-09-25T11:59:00.000Z' }
    }
  };
  const entries = [
    { sourceId: 'sku-a', status: 'error', autoRetryPending: true, nextRetryAt: '2026-09-25T12:00:10.000Z' },
    { sourceId: 'sku-b', status: 'error', autoRetryPending: true, nextRetryAt: '2026-09-25T12:00:01.000Z' }
  ];

  assert.deepEqual(scheduledRunRetries(run, entries, now), [
    { entryId: 'sku-a', retryAt: Date.parse('2026-09-25T12:00:10.000Z'), slotId: 0, due: false }
  ], 'a sent generation remains under observation and cannot be submitted twice');
  assert.deepEqual(scheduledRunRetries(run, entries, Date.parse('2026-09-25T12:00:11.000Z')), [
    { entryId: 'sku-a', retryAt: Date.parse('2026-09-25T12:00:10.000Z'), slotId: 0, due: true }
  ]);
  assert.deepEqual(scheduledRunRetries({ ...run, state: 'PAUSED', pauseReason: 'USER' }, entries, now + 1000), [],
    'automatic retries do not defeat an explicit user pause');
});

test('sidepanel facts are joined to the current generation and reject late stale stages', () => {
  const owner = {
    entryId: 'sku-a',
    generationId: 'generation-2',
    factsJobId: 'facts-2',
    outputHash: digest('png-2')
  };
  assert.equal(factsStageMatchesOwner({ ...owner }, owner), true);
  assert.equal(factsStageMatchesOwner({ ...owner, factsJobId: 'facts-1', generationId: 'generation-1' }, owner), false);
  assert.equal(factsStageMatchesOwner({ ...owner, outputHash: digest('png-1') }, owner), false);

  const jobs = [
    { ...owner, slotId: 0, stage: 'PERSISTING', stageAtMs: 200 },
    { ...owner, generationId: 'generation-1', factsJobId: 'facts-1', slotId: 0, stage: 'ERROR', stageAtMs: 300 }
  ];
  assert.equal(selectFactsProgressForSlot({ slotId: 0, entryId: 'sku-a', generationId: 'generation-2', factsJobId: 'facts-2' }, jobs), jobs[0]);
  assert.equal(selectFactsProgressForSlot({ slotId: 0, entryId: 'sku-b', generationId: 'generation-3', factsJobId: null }, jobs), null,
    'a reused worker slot does not display another SKU generation status');
});
