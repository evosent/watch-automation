import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, transactionResult, MODEL_STORE, REVISION_STORE, FACTS_STORE,
  applyExplicitIdentityMigration, getAccountingBackup,
  getAllModelCatalog, getAllGenerationRevisions, getAllGenerationFacts,
  getAllIdentityQuarantines
} from '../extension/idb.js';
import { buildIdentityMigrationPlan } from '../extension/identity-migration-utils.js';
import { queueGroupsFromCatalog, queuePartPlan } from '../extension/queue-utils.js';

const oldCasioId = 'casio:50TH';
const ssId = 'casio:TRN50SS2A';
const zeId = 'casio:TRN50ZE1A';
const makeHash = (digit) => digit.repeat(64);

function modelName(code) {
  return `Casio CASIOTRON 50th ${code} Мужские Японские наручные часы, Гарантия`;
}

function revision({ generationId, sourceId, code, digit }) {
  const name = modelName(code);
  const outputHash = makeHash(digit);
  const factsJobId = `facts-${generationId}`;
  const relativePath = `input-watches-images/in_sale/${name}.png`;
  return {
    generationId, sourceId, skuKey: sourceId,
    sourceVariantId: `in_sale_good|${relativePath}`, inputPath: relativePath,
    sourceHash: makeHash('a'), sourceFingerprint: `1:2:${name}.png`,
    modelName: name, fileName: `${name}.png`, outputFileName: `gen-${generationId}.png`,
    groupId: 'in_sale_good', outputPath: `D:/Downloads/WatchAutomation/${generationId}.png`,
    outputHash, factsJobId, operationId: `operation-${generationId}`, leaseId: `lease-${generationId}`,
    status: 'READY', factsStatus: 'ok', profileId: 'casio',
    facts: { sourceId, generationId, outputHash, factsJobId, status: 'ok', titleBrand: 'Casio', titleModel: code }
  };
}

function catalogVariant(code, index = '') {
  const name = modelName(code);
  const relativePath = `input-watches-images/in_sale/${name}${index}.png`;
  return {
    sourceVariantId: `in_sale_good|${relativePath}`, variantId: `in_sale_good|${relativePath}`,
    groupId: 'in_sale_good', relativePath, fileName: `${name}${index}.png`, modelName: name,
    status: 'done', fingerprint: `1:2:${name}${index}.png`, sourceHash: makeHash('a')
  };
}

function factsRow(row) {
  return { ...row.facts, outputPath: row.outputPath, chatUrl: null, updatedAt: '2026-10-01T00:00:00.000Z' };
}

function sortedBy(rows, key) {
  return [...rows].sort((left, right) => String(left[key] || '').localeCompare(String(right[key] || '')));
}

async function seed(catalog, revisions, facts) {
  const db = await openDb();
  try {
    await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], (tx) => {
      for (const [storeName, rows] of [[MODEL_STORE, catalog], [REVISION_STORE, revisions], [FACTS_STORE, facts]]) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const row of rows) store.put(row);
      }
    }, 'Seed synthetic identity migration fixture');
  } finally { db.close(); }
}

test('full-snapshot-shaped migration preserves collided facts and every prior part position', async () => {
  const selected = revision({ generationId: 'selected-ss', sourceId: oldCasioId, code: 'TRN-50SS-2A', digit: '1' });
  const displaced = revision({ generationId: 'displaced-ss',
    sourceId: `in_sale_good|${selected.inputPath}`, code: 'TRN-50SS-2A', digit: '2' });
  const splitVariant = revision({ generationId: 'split-ze', sourceId: oldCasioId, code: 'TRN-50ZE-1A', digit: '3' });
  const revisions = [selected, displaced, splitVariant];
  const facts = [factsRow(selected), factsRow(displaced)];
  const catalog = Array.from({ length: 99 }, (_, index) => {
    const code = `A${String(index).padStart(3, '0')}`;
    const id = `casio:${code}`;
    const variant = catalogVariant(code);
    return { skuKey: id, sourceId: id, brandId: 'casio', modelName: variant.modelName,
      sourcePresent: true, variants: [variant] };
  });
  catalog.push({
    skuKey: oldCasioId, sourceId: oldCasioId, brandId: 'casio', modelName: modelName('TRN-50SS-2A'),
    sourcePresent: true, currentGenerationId: selected.generationId, latestReadyGenerationId: selected.generationId,
    variants: [catalogVariant('TRN-50SS-2A'), catalogVariant('TRN-50ZE-1A')]
  });
  await seed(catalog, revisions, facts);

  const beforeGroups = queueGroupsFromCatalog(catalog);
  const beforePlan = queuePartPlan(beforeGroups.in_sale_good, 100, 'in_sale_good|casio');
  assert.equal(beforePlan.total, 100);
  const plan = buildIdentityMigrationPlan({ catalogRows: catalog, revisions, factsRows: facts });
  assert.equal(plan.revisionMoves.length, 3);
  assert.equal(plan.catalogAssignments.length, 2);

  const applied = await applyExplicitIdentityMigration(plan, { backupId: 'portable-full-snapshot-shaped' });
  assert.equal(applied.movedRevisions, 3);
  const backup = await getAccountingBackup('portable-full-snapshot-shaped');
  assert.equal(backup.complete, true);
  assert.deepEqual(sortedBy(backup.stores.catalog, 'skuKey'), sortedBy(catalog, 'skuKey'));
  assert.deepEqual(sortedBy(backup.stores.revisions, 'generationId'), sortedBy(revisions, 'generationId'));
  assert.deepEqual(sortedBy(backup.stores.facts, 'sourceId'), sortedBy(facts, 'sourceId'));

  const migratedRevisions = await getAllGenerationRevisions();
  for (const original of revisions) {
    const migrated = migratedRevisions.find((row) => row.generationId === original.generationId);
    assert.equal(migrated.sourceId, original.generationId === 'split-ze' ? zeId : ssId);
    for (const key of ['outputPath', 'outputHash', 'factsJobId', 'operationId', 'leaseId', 'sourceVariantId', 'inputPath', 'sourceHash', 'sourceFingerprint']) {
      assert.equal(migrated[key], original[key], `${key} changed for ${original.generationId}`);
    }
  }

  const migratedFacts = await getAllGenerationFacts();
  const quarantines = await getAllIdentityQuarantines();
  const displacedQuarantine = quarantines.find((row) => row.recordType === 'facts'
    && row.reason === 'facts-target-collision' && row.generationId === displaced.generationId);
  assert.ok(displacedQuarantine, 'the colliding facts row is preserved in quarantine');
  assert.deepEqual(displacedQuarantine.recordSnapshot, facts.find((row) => row.generationId === displaced.generationId));
  assert.equal(migratedFacts.length, 1, 'the active facts store keeps the selected current row for the shared SKU');
  assert.equal(migratedFacts.find((row) => row.sourceId === ssId).generationId, selected.generationId,
    'the catalog-pinned facts tuple wins without being overwritten');
  assert.deepEqual(new Set(migratedFacts.map((row) => row.sourceId)), new Set([ssId]));

  const allModels = await getAllModelCatalog({ includeRemoved: true });
  const activeModels = allModels.filter((row) => row.sourcePresent !== false);
  assert.equal(activeModels.length, 101);
  const oldAlias = allModels.find((row) => row.skuKey === oldCasioId);
  assert.equal(oldAlias.sourcePresent, false);
  assert.deepEqual(oldAlias.identitySupersededBy, [ssId, zeId]);
  const afterGroups = queueGroupsFromCatalog(allModels);
  const afterPlan = queuePartPlan(afterGroups.in_sale_good, 100, 'in_sale_good|casio');
  assert.equal(afterPlan.total, 101);
  assert.equal(afterPlan.sourceIds[100], zeId, 'the genuinely new split identity is appended after the old queue');
  const primaryByOldId = new Map([[oldCasioId, ssId]]);
  for (let index = 0; index < beforePlan.sourceIds.length; index += 1) {
    const beforeId = beforePlan.sourceIds[index];
    assert.equal(afterPlan.sourceIds[index], primaryByOldId.get(beforeId) || beforeId,
      `old part position ${index} changed for ${beforeId}`);
  }
  const replay = await applyExplicitIdentityMigration(plan, { backupId: 'portable-full-snapshot-shaped' });
  assert.equal(replay.alreadyApplied, true);
});
