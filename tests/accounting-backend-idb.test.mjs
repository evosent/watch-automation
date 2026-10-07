import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTING_BACKUP_STORE,
  FACTS_STORE,
  IDENTITY_QUARANTINE_STORE,
  MODEL_STORE,
  OUTPUT_RECOVERY_STORE,
  REVISION_STORE,
  applyExplicitIdentityMigration,
  beginGenerationRevision,
  getAccountingRecords,
  getAllGenerationFacts,
  getAllGenerationRevisions,
  getAllIdentityQuarantines,
  getAllModelCatalog,
  getGenerationFacts,
  getGenerationRevision,
  getModelCatalog,
  getOutputRecoveryRecord,
  openDb,
  persistGenerationFactsRevision,
  persistGenerationImageRevision,
  recordRegisteredOutputRevision,
  recordVerifiedOutputArtifact,
  rejectGenerationRevision,
  transactionResult
} from '../extension/idb.js';

const sha = (digit) => String(digit).repeat(64);

async function clearAccountingStores() {
  const db = await openDb();
  try {
    await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE,
      ACCOUNTING_BACKUP_STORE, IDENTITY_QUARANTINE_STORE], (tx) => {
      for (const store of [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE,
        ACCOUNTING_BACKUP_STORE, IDENTITY_QUARANTINE_STORE]) tx.objectStore(store).clear();
      return null;
    }, 'Test accounting store reset');
  } finally { db.close(); }
}

async function seedAccounting({ catalog = [], revisions = [], facts = [], recovery = [] } = {}) {
  const db = await openDb();
  try {
    await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      for (const [name, rows] of [[MODEL_STORE, catalog], [REVISION_STORE, revisions],
        [FACTS_STORE, facts], [OUTPUT_RECOVERY_STORE, recovery]]) {
        const store = tx.objectStore(name);
        store.clear();
        for (const row of rows) store.put(row);
      }
      return null;
    }, 'Test accounting fixture seed');
  } finally { db.close(); }
}

const inputVariant = (sourceVariantId, partitionOrderKey = 'legacy-part') => ({
  sourceVariantId,
  groupId: 'in_sale_good',
  modelName: 'Casio Test TRN-50SS-2A',
  fileName: 'Casio Test TRN-50SS-2A.png',
  relativePath: `in_sale_good/${sourceVariantId}.png`,
  partitionOrderKey,
  status: 'pending'
});

function imageTuple({
  generationId = 'generation-one',
  sourceId = 'casio:TRN50SS2A',
  outputPath = 'D:/Downloads/WatchAutomation/in_sale_good/generated.png',
  outputHash = sha('a')
} = {}) {
  return { generationId, sourceId, outputPath, outputHash };
}

function fileProof(tuple, patch = {}) {
  return {
    verified: true,
    exists: true,
    isFile: true,
    generationId: tuple.generationId,
    sourceId: tuple.sourceId,
    outputPath: tuple.outputPath,
    outputHash: tuple.outputHash,
    sizeBytes: 1024,
    verifiedAt: '2026-10-06T10:01:00.000Z',
    ...patch
  };
}

function factsFor(tuple, factsJobId = `facts-${tuple.generationId}`) {
  return {
    sourceId: tuple.sourceId,
    generationId: tuple.generationId,
    factsJobId,
    status: 'ok',
    outputHash: tuple.outputHash,
    titleBrand: 'Casio',
    titleModel: 'TRN-50SS-2A'
  };
}

function completeRevision(tuple, { factsJobId = `facts-${tuple.generationId}`, titleModel = 'TRN-50SS-2A' } = {}) {
  return {
    ...tuple,
    skuKey: tuple.sourceId,
    modelName: `Casio ${titleModel}`,
    sourceVariantId: `in_sale_good|${tuple.generationId}.png`,
    groupId: 'in_sale_good',
    status: 'READY',
    factsStatus: 'ok',
    factsJobId,
    facts: { ...factsFor(tuple, factsJobId), titleModel }
  };
}

test('IDB journal persists attempt, positive file proof, and registered revision transitions', async () => {
  await clearAccountingStores();
  const tuple = imageTuple();
  await beginGenerationRevision({ ...tuple, outputPath: null, outputHash: null,
    factsJobId: 'facts-generation-one', operationId: 'run-one', leaseId: 'lease-one',
    createdAt: '2026-10-06T10:00:00.000Z' });

  let journal = await getOutputRecoveryRecord(tuple.generationId);
  assert.equal(journal.state, 'attempt_started');
  assert.equal(journal.sourceId, tuple.sourceId);

  const proof = fileProof(tuple);
  const verified = await recordVerifiedOutputArtifact({ ...tuple, fileVerification: proof, verifiedAt: proof.verifiedAt });
  assert.equal(verified.recorded, true);
  assert.equal(verified.record.state, 'file_verified');
  journal = await getOutputRecoveryRecord(tuple.generationId);
  assert.equal(journal.state, 'file_verified');
  assert.equal(journal.fileVerification.outputHash, tuple.outputHash);
  assert.equal(journal.fileVerification.sizeBytes, proof.sizeBytes);

  const imageSaved = await persistGenerationImageRevision({
    ...completeRevision(tuple, { factsJobId: 'facts-generation-one' }),
    factsStatus: 'pending', facts: null, fileVerification: proof
  });
  assert.equal(imageSaved.registered, true);
  journal = await getOutputRecoveryRecord(tuple.generationId);
  assert.equal(journal.state, 'revision_registered');

  const replay = await recordRegisteredOutputRevision({ ...tuple, registeredAt: journal.revisionRegisteredAt });
  assert.equal(replay.registered, true);
  assert.equal((await getOutputRecoveryRecord(tuple.generationId)).state, 'revision_registered');
});

test('image revision persistence rejects missing or mismatched physical file verification', async () => {
  await clearAccountingStores();
  const tuple = imageTuple({ generationId: 'image-proof-required' });
  await beginGenerationRevision({ ...tuple, outputPath: null, outputHash: null,
    factsJobId: 'facts-image-proof-required', createdAt: '2026-10-06T10:00:00.000Z' });

  const invalidProofs = [
    null,
    fileProof(tuple, { verified: false }),
    fileProof(tuple, { exists: false }),
    fileProof(tuple, { isFile: false }),
    fileProof(tuple, { sizeBytes: 0 }),
    fileProof(tuple, { outputPath: 'D:/Downloads/other.png' }),
    fileProof(tuple, { outputHash: sha('b') }),
    fileProof(tuple, { generationId: 'another-generation' }),
    fileProof(tuple, { sourceId: 'casio:OTHER' })
  ];
  for (const proof of invalidProofs) {
    await assert.rejects(persistGenerationImageRevision({
      ...completeRevision(tuple, { factsJobId: 'facts-image-proof-required' }),
      fileVerification: proof
    }), /PNG registration requires positive physical existence and SHA-256 verification/);
  }

  assert.equal((await getGenerationRevision(tuple.generationId)).status, 'GENERATING');
  assert.equal((await getOutputRecoveryRecord(tuple.generationId)).state, 'attempt_started');
  assert.equal((await getModelCatalog(tuple.sourceId)).latestReadyGenerationId || null, null);
});

test('facts and accepted pointer commit only after the generation image has been verified and registered', async () => {
  await clearAccountingStores();
  const tuple = imageTuple({ generationId: 'facts-before-image' });
  const factsJobId = 'facts-facts-before-image';
  await beginGenerationRevision({ ...tuple, outputPath: null, outputHash: null,
    factsJobId, createdAt: '2026-10-06T10:00:00.000Z' });

  const extractedFacts = factsFor(tuple, factsJobId);
  const factsOnly = await persistGenerationFactsRevision({ generationId: tuple.generationId,
    sourceId: tuple.sourceId, factsJobId, facts: extractedFacts });
  assert.equal(factsOnly.latest, false);
  assert.equal(await getGenerationFacts(tuple.sourceId), null);
  assert.equal((await getModelCatalog(tuple.sourceId)).latestReadyGenerationId || null, null);
  assert.equal((await getGenerationRevision(tuple.generationId)).status, 'FACTS_WAITING_IMAGE');

  const imageWrite = await persistGenerationImageRevision({
    ...completeRevision(tuple, { factsJobId }),
    facts: extractedFacts,
    factsStatus: 'ok',
    fileVerification: fileProof(tuple)
  });
  assert.equal(imageWrite.registered, true);
  const records = await getAccountingRecords();
  const model = records.catalog.find((row) => row.skuKey === tuple.sourceId);
  const revision = records.revisions.find((row) => row.generationId === tuple.generationId);
  const facts = records.facts.find((row) => row.sourceId === tuple.sourceId);
  const journal = records.outputRecovery.find((row) => row.generationId === tuple.generationId);
  assert.equal(journal.state, 'revision_registered');
  assert.equal(revision.status, 'READY');
  assert.equal(revision.factsStatus, 'ok');
  assert.equal(facts.generationId, tuple.generationId);
  assert.equal(facts.outputHash, tuple.outputHash);
  assert.equal(model.latestReadyGenerationId, tuple.generationId);

  // A legacy path+hash alone does not prove that the exact file was checked
  // and registered. Facts cannot promote such a revision to the accepted slot.
  await seedAccounting({
    catalog: [{ skuKey: 'casio:UNVERIFIED', sourceId: 'casio:UNVERIFIED', sourcePresent: true,
      currentGenerationId: 'legacy-image', variants: [] }],
    revisions: [{ generationId: 'legacy-image', sourceId: 'casio:UNVERIFIED',
      factsJobId: 'facts-legacy-image', outputPath: 'D:/old.png', outputHash: sha('d'),
      status: 'FACTS_PENDING', factsStatus: 'pending' }]
  });
  const legacyFacts = { sourceId: 'casio:UNVERIFIED', generationId: 'legacy-image',
    factsJobId: 'facts-legacy-image', status: 'ok', titleModel: 'legacy' };
  const unverifiedFactsWrite = await persistGenerationFactsRevision({ generationId: 'legacy-image',
    sourceId: 'casio:UNVERIFIED', factsJobId: 'facts-legacy-image', facts: legacyFacts });
  assert.equal(unverifiedFactsWrite.latest, false);
  assert.equal(await getGenerationFacts('casio:UNVERIFIED'), null);
  assert.equal((await getModelCatalog('casio:UNVERIFIED')).latestReadyGenerationId || null, null);
});

test('identity migration quarantines colliding facts with snapshots and preserves the target row', async () => {
  await clearAccountingStores();
  const from = 'casio:50TH';
  const target = 'casio:TRN50SS2A';
  const variantId = 'in_sale_good|input-watches-images/TRN-50SS-2A.png';
  const incomingRevision = completeRevision(imageTuple({ generationId: 'migrated-generation', sourceId: from,
    outputPath: 'D:/old/migrated.png', outputHash: sha('a') }));
  const targetRevision = completeRevision(imageTuple({ generationId: 'target-generation', sourceId: target,
    outputPath: 'D:/new/accepted.png', outputHash: sha('b') }), { titleModel: 'TRN-50SS-2A' });
  const incomingFacts = { ...incomingRevision.facts, sourceId: from, titleModel: 'TRN-50SS-2A' };
  const targetFacts = { ...targetRevision.facts, sourceId: target, titleModel: 'TRN-50SS-2A' };
  await seedAccounting({
    catalog: [
      { skuKey: from, sourceId: from, brandId: 'casio', sourcePresent: true,
        modelName: incomingRevision.modelName, currentGenerationId: incomingRevision.generationId,
        latestReadyGenerationId: incomingRevision.generationId, partitionOrderKey: 'part-old',
        variants: [inputVariant(variantId, 'part-old')] },
      { skuKey: target, sourceId: target, brandId: 'casio', sourcePresent: true,
        currentGenerationId: targetRevision.generationId, latestReadyGenerationId: targetRevision.generationId,
        partitionOrderKey: 'part-target', variants: [] }
    ],
    revisions: [incomingRevision, targetRevision],
    facts: [incomingFacts, targetFacts]
  });

  const result = await applyExplicitIdentityMigration({
    fingerprint: 'facts-collision-test',
    revisionMoves: [{ generationId: incomingRevision.generationId, fromSourceId: from, toSourceId: target,
      originSourceId: from, outputHash: incomingRevision.outputHash, evidence: [{ source: 'full_model_code' }] }],
    catalogAssignments: [{ fromSourceId: from, toSourceId: target, originSourceId: from,
      variantKeys: [variantId], sourcePresent: true, modelName: incomingRevision.modelName,
      brandId: 'casio', variants: [inputVariant(variantId, 'part-old')] }]
  }, { backupId: 'facts-collision-backup' });

  assert.equal(result.movedRevisions, 1);
  assert.equal(result.movedFactsRows, 0);
  assert.equal(result.quarantined, 1);
  const activeFacts = await getAllGenerationFacts();
  assert.equal(activeFacts.length, 1);
  assert.equal(activeFacts[0].sourceId, target);
  assert.equal(activeFacts[0].generationId, targetRevision.generationId);
  for (const key of ['factsJobId', 'status', 'outputHash', 'titleBrand', 'titleModel']) {
    assert.equal(activeFacts[0][key], targetFacts[key]);
  }
  const quarantines = await getAllIdentityQuarantines();
  const collision = quarantines.find((row) => row.reason === 'facts-target-collision');
  assert.ok(collision);
  assert.equal(collision.recordSnapshot.generationId, incomingRevision.generationId);
  assert.deepEqual(collision.recordSnapshot, incomingFacts);
  assert.equal(activeFacts.length + quarantines.filter((row) => row.recordType === 'facts').length, 2,
    'one active facts row plus its quarantined original accounts for both source rows');

  const models = await getAllModelCatalog({ includeRemoved: true });
  const retiredSource = models.find((row) => row.skuKey === from);
  const migratedTarget = models.find((row) => row.skuKey === target);
  assert.equal(retiredSource.sourcePresent, false);
  assert.deepEqual(retiredSource.variants, []);
  assert.equal(migratedTarget.partitionOrderKey, 'part-target');
});

test('rejecting latest accepted generation sets replacementRequired without selecting older revision', async () => {
  await clearAccountingStores();
  const sourceId = 'casio:TRN50SS2A';
  const older = completeRevision(imageTuple({ generationId: 'older-generation', sourceId,
    outputPath: 'D:/old.png', outputHash: sha('a') }));
  const latest = completeRevision(imageTuple({ generationId: 'latest-generation', sourceId,
    outputPath: 'D:/latest.png', outputHash: sha('b') }));
  await seedAccounting({
    catalog: [{ skuKey: sourceId, sourceId, sourcePresent: true,
      currentGenerationId: latest.generationId, latestReadyGenerationId: latest.generationId,
      variants: [inputVariant('in_sale_good|latest.png')] }],
    revisions: [older, latest],
    facts: [latest.facts]
  });

  await rejectGenerationRevision(latest.generationId);
  const model = await getModelCatalog(sourceId);
  assert.equal(model.latestReadyGenerationId, null);
  assert.equal(model.replacementRequired, true);
  assert.equal(model.currentGenerationId, null);
  assert.equal((await getGenerationRevision(latest.generationId)).reviewStatus, 'rejected');
  assert.equal((await getGenerationRevision(older.generationId)).reviewStatus, undefined);
  assert.equal((await getAllGenerationRevisions()).length, 2);
});
