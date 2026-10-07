import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, transactionResult, MODEL_STORE, REVISION_STORE, FACTS_STORE,
  applyExplicitIdentityMigration, getAccountingBackup, getAllModelCatalog,
  getAllGenerationRevisions, getAllGenerationFacts, beginGenerationRevision,
  persistGenerationImageRevision, persistGenerationFactsRevision, rejectGenerationRevision,
  getModelCatalog } from '../extension/idb.js';
import { projectCanonicalAccounting } from '../extension/result-accounting-utils.js';
import { buildIdentityMigrationPlan } from '../extension/identity-migration-utils.js';
import { queuePartPlan, queueGroupsFromCatalog } from '../extension/queue-utils.js';

const hash = 'c'.repeat(64);
async function seed(catalog, revisions, facts = []) {
  const db = await openDb();
  try {
    await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], tx => {
      for (const store of [MODEL_STORE, REVISION_STORE, FACTS_STORE]) tx.objectStore(store).clear();
      for (const row of catalog) tx.objectStore(MODEL_STORE).put(row);
      for (const row of revisions) tx.objectStore(REVISION_STORE).put(row);
      for (const row of facts) tx.objectStore(FACTS_STORE).put(row);
    }, 'Offline accounting fixture');
  } finally { db.close(); }
}
const variant = (code, quality = 'good') => ({ sourceVariantId: `in_sale_${quality}|input-watches-images/in_sale/Casio CASIOTRON 50th ${code}.png`, groupId: `in_sale_${quality}`,
  modelName: `Casio CASIOTRON 50th ${code}`, fileName: `Casio CASIOTRON 50th ${code}.png`,
  relativePath: `in_sale_${quality}/Casio CASIOTRON 50th ${code}.png`, status: 'pending' });
const revision = (generationId, code, sourceId = 'casio:50TH') => {
  const factsJobId = `facts-${generationId}`;
  return { generationId, sourceId, skuKey: sourceId, modelName: `Casio CASIOTRON 50th ${code}`,
    fileName: `Casio CASIOTRON 50th ${code}.png`, status: 'READY', factsStatus: 'ok',
    outputPath: `C:/Downloads/WatchAutomation/${generationId}.png`, outputHash: hash, factsJobId,
    chatUrl: `https://chatgpt.com/c/${generationId}`,
    facts: { sourceId, generationId, factsJobId, status: 'ok', outputHash: hash,
      chatUrl: `https://chatgpt.com/c/${generationId}`, titleModel: code, titleBrand: 'Casio' } };
};
const checksFor = revisions => Object.fromEntries(revisions.filter(row => row.outputPath).map(row => [row.generationId,
  { exists: true, verified: true, valid: true, path: row.outputPath, sha256: row.outputHash, hashMatches: true }]));

test('production identity migration backs up and splits exact revisions without losing tuples or part membership', async () => {
  const old = 'casio:50TH';
  const revisions = [revision('audit-ss', 'TRN-50SS-2A'), revision('audit-ze', 'TRN-50ZE-1A')];
  const catalog = [{ skuKey: old, sourceId: old, brandId: 'casio', sourcePresent: true,
    modelName: revisions[0].modelName, currentGenerationId: revisions[0].generationId,
    latestReadyGenerationId: revisions[0].generationId, variants: [variant('TRN-50SS-2A')] }];
  await seed(catalog, revisions, [revisions[0].facts]);
  const plan = buildIdentityMigrationPlan({ catalogRows: catalog, revisions, factsRows: [revisions[0].facts] });
  const migrated = await applyExplicitIdentityMigration(plan, { backupId: 'integration-identity' });
  assert.equal(migrated.movedRevisions, 2);
  const backup = await getAccountingBackup('integration-identity');
  assert.deepEqual(backup.stores.revisions, revisions);
  const rows = await getAllGenerationRevisions();
  assert.equal(rows.find(row => row.generationId === 'audit-ss').sourceId, 'casio:TRN50SS2A');
  assert.equal(rows.find(row => row.generationId === 'audit-ze').sourceId, 'casio:TRN50ZE1A');
  for (const row of rows) {
    assert.equal(row.outputHash, hash);
    assert.equal(row.facts.sourceId, row.sourceId);
    assert.equal(row.facts.generationId, row.generationId);
  }
  const models = await getAllModelCatalog({ includeRemoved: true });
  const live = models.find(row => row.skuKey === 'casio:TRN50SS2A');
  assert.ok(live, JSON.stringify(models.map(row => ({ skuKey: row.skuKey, sourceId: row.sourceId }))));
  assert.equal(live.partitionOrderKey, old);
  assert.equal(live.latestReadyGenerationId, 'audit-ss');
  const projection = projectCanonicalAccounting({ catalog: models, revisions: rows,
    facts: await getAllGenerationFacts(), artifactChecks: checksFor(rows) });
  assert.equal(projection.bySku.get('casio:TRN50SS2A').status, 'READY');
  const replay = await applyExplicitIdentityMigration(plan, { backupId: 'integration-identity' });
  assert.equal(replay.alreadyApplied, true);
  assert.equal((await getAllGenerationRevisions()).length, 2);
});

test('stale migration evidence aborts atomically and cannot corrupt the accounting backup', async () => {
  const rows = [revision('audit-stale', 'TRN-50SS-2A')];
  const catalog = [{ skuKey: 'casio:50TH', modelName: rows[0].modelName, variants: [variant('TRN-50SS-2A')] }];
  await seed(catalog, rows);
  const plan = buildIdentityMigrationPlan({ catalogRows: catalog, revisions: rows });
  plan.revisionMoves[0].outputHash = 'd'.repeat(64);
  await assert.rejects(applyExplicitIdentityMigration(plan, { backupId: 'integration-stale' }));
  assert.deepEqual(await getAllGenerationRevisions(), rows);
  assert.equal(await getAccountingBackup('integration-stale'), null);
});

test('production replacement failure preserves accepted result and rejection cannot resurrect an older version', async () => {
  const id = 'casio:TRN50SS2A';
  const accepted = revision('accepted-preserved', 'TRN-50SS-2A', id);
  const catalog = [{ skuKey: id, sourceId: id, modelName: accepted.modelName, sourcePresent: true,
    currentGenerationId: accepted.generationId, latestReadyGenerationId: accepted.generationId,
    variants: [variant('TRN-50SS-2A')] }];
  await seed(catalog, [accepted], [accepted.facts]);
  await beginGenerationRevision({ ...accepted, generationId: 'new-attempt', factsJobId: 'new-job',
    operationId: 'test-launch', outputPath: undefined, outputHash: undefined, facts: undefined, factsStatus: 'pending' });
  const rows = await getAllGenerationRevisions();
  let model = await getModelCatalog(id);
  assert.equal(model.latestReadyGenerationId, accepted.generationId);
  let snapshot = projectCanonicalAccounting({ catalog: [model], revisions: rows, artifactChecks: checksFor(rows) });
  assert.equal(snapshot.counts.ready, 1);
  assert.equal(snapshot.candidates.length, 0);
  await rejectGenerationRevision(accepted.generationId);
  model = await getModelCatalog(id);
  snapshot = projectCanonicalAccounting({ catalog: [model], revisions: await getAllGenerationRevisions(), artifactChecks: checksFor(rows) });
  assert.equal(snapshot.counts.ready, 0);
  assert.equal(snapshot.entries[0].replacementRequired, true);
});

test('image and facts transactions share one READY criterion while source alternatives remain one product', async () => {
  const id = 'casio:TRN50SS2A';
  const image = revision('combined-ready', 'TRN-50SS-2A', id);
  const catalog = [{ skuKey: id, sourceId: id, modelName: image.modelName, sourcePresent: true,
    variants: [variant('TRN-50SS-2A'), variant('TRN-50SS-2A', 'bad')] }];
  await seed(catalog, []);
  await beginGenerationRevision({ ...image, facts: null, factsStatus: 'pending', outputPath: null, outputHash: null });
  await persistGenerationImageRevision({ ...image, facts: null, factsStatus: 'pending',
    fileVerification: { verified: true, exists: true, isFile: true, sizeBytes: 1024,
      outputHash: image.outputHash, outputPath: image.outputPath, generationId: image.generationId,
      sourceId: image.sourceId, verifiedAt: new Date().toISOString() } });
  let rows = await getAllGenerationRevisions();
  let models = await getAllModelCatalog();
  const before = projectCanonicalAccounting({ catalog: models, revisions: rows, artifactChecks: checksFor(rows) });
  assert.equal(before.counts.ready, 0);
  assert.equal(before.counts.needsFacts, 1);
  await persistGenerationFactsRevision({ ...image, facts: image.facts });
  rows = await getAllGenerationRevisions(); models = await getAllModelCatalog();
  const after = projectCanonicalAccounting({ catalog: models, revisions: rows, artifactChecks: checksFor(rows) });
  assert.equal(after.counts.ready, 1);
  assert.equal(after.candidates.length, 0);
  assert.equal(queuePartPlan(Object.values(queueGroupsFromCatalog(models)).flat()).total, 1);
});
