import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCardRecords } from '../extension/gallery-quality-utils.js';
import { galleryRecordsFromAccountingSnapshot } from '../extension/gallery-revision-utils.js';
import { reviewCardIssue } from '../extension/card-review-db.js';
import { createCardEditController } from '../extension/card-edit-controller.js';
import {
  DB_NAME, FACTS_STORE, MODEL_STORE, REVISION_STORE, openDb, transactionResult,
  getAllGenerationRevisions, getAllModelCatalog, getGenerationFacts,
  getGenerationRevision, getModelCatalog
} from '../extension/idb.js';

const sha = digit => String(digit).repeat(64);

function card({ generationId, sourceId = 'casio:GA21001A', code = 'GA-2100-1A',
  caseSize = '83 мм', waterResistance = '20 бар', imageTextMatchesFacts = true,
  comparisonFamily = null } = {}) {
  const outputHash = sha(generationId.charCodeAt(generationId.length - 1).toString(16).slice(-1));
  const factsJobId = `facts-${generationId}`;
  const facts = { generationId, factsJobId, outputHash, status: 'ok', profileId: 'casio',
    titleBrand: 'Casio', titleSeries: 'G-Shock', titleModel: code,
    utp1: 'Минеральное стекло', utp2: 'Ударопрочный корпус', waterResistance,
    caseSize };
  return { generationId, sourceId, skuKey: sourceId, factsJobId, outputHash,
    outputPath: `D:/Downloads/WatchAutomation/${generationId}.png`,
    modelName: `Casio G-Shock ${code}`, profileId: 'casio',
    ...(comparisonFamily ? { comparisonFamily } : {}), status: 'READY', factsStatus: 'ok',
    reviewStatus: 'accepted', imageTextMatchesFacts, facts };
}

async function resetDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database deletion was blocked'));
  });
}

async function seedDatabase(revisions, models) {
  await resetDatabase();
  const db = await openDb();
  try {
    await transactionResult(db, [REVISION_STORE, MODEL_STORE, FACTS_STORE], tx => {
      const revisionStore = tx.objectStore(REVISION_STORE);
      const modelStore = tx.objectStore(MODEL_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      for (const row of revisions) revisionStore.put(structuredClone(row));
      for (const row of models) modelStore.put({ sourcePresent: true, ...structuredClone(row) });
      for (const model of models) {
        const latest = revisions.find(row => row.generationId === model.latestReadyGenerationId);
        if (latest) factsStore.put({ ...structuredClone(latest.facts), sourceId: model.skuKey, updatedAt: 'fixed' });
      }
      return null;
    }, 'Quality resolution test seed');
  } finally { db.close(); }
}

async function writeRevision(revision) {
  const db = await openDb();
  try {
    await transactionResult(db, REVISION_STORE, tx => {
      tx.objectStore(REVISION_STORE).put(structuredClone(revision));
      return null;
    }, 'Quality resolution test revision update');
  } finally { db.close(); }
}

async function readyCount() {
  const [models, revisions] = await Promise.all([getAllModelCatalog({ includeRemoved: true }), getAllGenerationRevisions()]);
  const byId = new Map(revisions.map(row => [row.generationId, row]));
  return models.filter(model => byId.get(model.latestReadyGenerationId)?.status === 'READY').length;
}

function resolvableValueIssue(records, sourceId, generationId) {
  const issue = auditCardRecords(records, { includeResolved: true }).find(item => (
    item.sourceId === sourceId && item.generationId === generationId
      && item.category === 'value' && item.resolvable === true
  ));
  assert.ok(issue, 'fixture should produce a resolvable value issue');
  return issue;
}

function modelFor(revision) {
  return { skuKey: revision.sourceId, sourceId: revision.sourceId, modelName: revision.modelName,
    profileId: revision.profileId, latestReadyGenerationId: revision.generationId,
    currentGenerationId: revision.generationId, currentOutputHash: revision.outputHash,
    currentOutputPath: revision.outputPath, generationStatus: 'READY', variants: [] };
}

test('confirm persists only exact version metadata and leaves model, facts, and ready count untouched', async () => {
  const old = card({ generationId: 'old-v1' });
  const latest = card({ generationId: 'latest-v2' });
  await seedDatabase([old, latest], [modelFor(latest)]);
  const issue = resolvableValueIssue([old], old.sourceId, old.generationId);
  const latestIssue = resolvableValueIssue([latest], latest.sourceId, latest.generationId);
  assert.equal(latestIssue.id, issue.id);
  assert.notEqual(latestIssue.fingerprint, issue.fingerprint, 'a matching warning on a new generation has a distinct signature');
  assert.equal((await reviewCardIssue({ generationId: latest.generationId,
    expectedAcceptedId: latest.generationId, issueId: issue.id, fingerprint: issue.fingerprint,
    decision: 'confirm' })).reason, 'stale_or_unknown_issue');
  const beforeModel = await getModelCatalog(old.sourceId);
  const beforeFacts = await getGenerationFacts(old.sourceId);
  const beforeCount = await readyCount();

  const result = await reviewCardIssue({ generationId: old.generationId,
    expectedAcceptedId: latest.generationId, issueId: issue.id, fingerprint: issue.fingerprint,
    decision: 'confirm', comment: 'Сверено по первоисточнику' });

  assert.equal(result.changed, true);
  const savedOld = await getGenerationRevision(old.generationId);
  const savedLatest = await getGenerationRevision(latest.generationId);
  assert.deepEqual(savedOld.qualityIssueResolutions, [{ id: issue.id, fingerprint: issue.fingerprint,
    reviewedAt: savedOld.qualityIssueResolutions[0].reviewedAt, comment: 'Сверено по первоисточнику' }]);
  assert.equal(savedLatest.qualityIssueResolutions, undefined);
  assert.equal(auditCardRecords([savedOld]).some(item => item.id === issue.id), false);
  assert.equal(auditCardRecords([savedOld], { includeResolved: true }).find(item => item.id === issue.id)?.resolved, true);
  const { qualityIssueResolutions: _resolution, ...savedOldFacts } = savedOld;
  assert.deepEqual(savedOldFacts, old);
  assert.deepEqual(await getModelCatalog(old.sourceId), beforeModel);
  assert.deepEqual(await getGenerationFacts(old.sourceId), beforeFacts);
  assert.equal(await readyCount(), beforeCount);
  assert.equal((await getModelCatalog(old.sourceId)).latestReadyGenerationId, latest.generationId);
});

test('reopen removes only the matching version-scoped resolution', async () => {
  const old = card({ generationId: 'old-reopen' });
  const latest = card({ generationId: 'latest-reopen' });
  await seedDatabase([old, latest], [modelFor(latest)]);
  const issue = resolvableValueIssue([old], old.sourceId, old.generationId);
  const request = { generationId: old.generationId, expectedAcceptedId: latest.generationId,
    issueId: issue.id, fingerprint: issue.fingerprint };
  assert.equal((await reviewCardIssue({ ...request, decision: 'confirm' })).changed, true);
  assert.equal((await reviewCardIssue({ ...request, decision: 'reopen' })).changed, true);
  assert.deepEqual((await getGenerationRevision(old.generationId)).qualityIssueResolutions, []);
  assert.equal((await getGenerationRevision(latest.generationId)).qualityIssueResolutions, undefined);
  assert.equal(auditCardRecords([await getGenerationRevision(old.generationId)]).some(item => item.id === issue.id), true);
});

test('rejects stale accepted pointer, forged signatures, unsupported choices, and nonresolvable issues', async () => {
  const selected = card({ generationId: 'selected-stale' });
  const latest = card({ generationId: 'latest-stale' });
  await seedDatabase([selected, latest], [modelFor(latest)]);
  const issue = resolvableValueIssue([selected], selected.sourceId, selected.generationId);
  const base = { generationId: selected.generationId, expectedAcceptedId: latest.generationId,
    issueId: issue.id, fingerprint: issue.fingerprint };
  assert.equal((await reviewCardIssue({ ...base, expectedAcceptedId: 'superseded', decision: 'confirm' })).reason,
    'accepted_version_changed');
  assert.equal((await reviewCardIssue({ ...base, fingerprint: `${issue.fingerprint} `, decision: 'confirm' })).reason,
    'stale_or_unknown_issue');
  assert.equal((await reviewCardIssue({ ...base, decision: 'dismiss' })).reason, 'unsupported_decision');

  const structural = card({ generationId: 'structural', imageTextMatchesFacts: false, caseSize: '45 мм' });
  await seedDatabase([structural], [modelFor(structural)]);
  const structuralIssue = auditCardRecords([structural], { includeResolved: true })
    .find(item => item.code === 'IMAGE_TEXT_MISMATCH');
  assert.ok(structuralIssue);
  assert.equal(structuralIssue.resolvable, false);
  assert.equal((await reviewCardIssue({ generationId: structural.generationId,
    expectedAcceptedId: structural.generationId, issueId: structuralIssue.id,
    fingerprint: structuralIssue.fingerprint, decision: 'confirm' })).reason, 'nonresolvable_issue');
  assert.equal((await getGenerationRevision(structural.generationId)).qualityIssueResolutions, undefined);

  const rejected = { ...selected, generationId: 'rejected', reviewStatus: 'rejected' };
  const accepted = card({ generationId: 'still-current' });
  await seedDatabase([rejected, accepted], [modelFor(accepted)]);
  const rejectedIssue = resolvableValueIssue([rejected], rejected.sourceId, rejected.generationId);
  assert.equal((await reviewCardIssue({ generationId: rejected.generationId,
    expectedAcceptedId: accepted.generationId, issueId: rejectedIssue.id,
    fingerprint: rejectedIssue.fingerprint, decision: 'confirm' })).reason, 'invalid_revision');

  const invalid = card({ generationId: 'invalid-tuple' });
  invalid.facts.outputHash = sha('f');
  const validCurrent = card({ generationId: 'valid-current' });
  await seedDatabase([invalid, validCurrent], [modelFor(validCurrent)]);
  const invalidIssue = resolvableValueIssue([invalid], invalid.sourceId, invalid.generationId);
  assert.equal((await reviewCardIssue({ generationId: invalid.generationId,
    expectedAcceptedId: validCurrent.generationId, issueId: invalidIssue.id,
    fingerprint: invalidIssue.fingerprint, decision: 'confirm' })).reason, 'invalid_revision');

  const quarantined = card({ generationId: 'identity-quarantined' });
  const quarantinedModel = { ...modelFor(quarantined), variants: [{ identityQuarantined: { reason: 'ambiguous' } }] };
  await seedDatabase([quarantined], [quarantinedModel]);
  const quarantinedIssue = resolvableValueIssue([quarantined], quarantined.sourceId, quarantined.generationId);
  assert.equal((await reviewCardIssue({ generationId: quarantined.generationId,
    expectedAcceptedId: quarantined.generationId, issueId: quarantinedIssue.id,
    fingerprint: quarantinedIssue.fingerprint, decision: 'confirm' })).reason, 'identity_quarantined');
});

test('family-context signatures become stale after a sibling revision changes', async () => {
  const first = card({ generationId: 'family-first', sourceId: 'casio:GA21001A',
    code: 'GA-2100-1A', caseSize: '42 мм', comparisonFamily: 'casio:GA-2100' });
  const second = card({ generationId: 'family-second', sourceId: 'casio:GA21002A',
    code: 'GA-2100-2A', caseSize: '45 мм', comparisonFamily: 'casio:GA-2100' });
  await seedDatabase([first, second], [modelFor(first), modelFor(second)]);
  const issue = auditCardRecords([first, second], { includeResolved: true }).find(item => (
    item.sourceId === first.sourceId && item.category === 'variants' && item.resolvable === true
  ));
  assert.ok(issue, 'fixture should produce a family comparison issue');

  const correctedSibling = { ...second, facts: { ...second.facts, caseSize: '42 мм' } };
  await writeRevision(correctedSibling);
  assert.equal((await reviewCardIssue({ generationId: first.generationId,
    expectedAcceptedId: first.generationId, issueId: issue.id, fingerprint: issue.fingerprint,
    decision: 'confirm' })).reason, 'stale_or_unknown_issue');
  assert.equal((await getGenerationRevision(first.generationId)).qualityIssueResolutions, undefined);
});

test('controller permits issue acknowledgement during a run and blocks import or update races', async () => {
  const selected = card({ generationId: 'controller-review' });
  await seedDatabase([selected], [modelFor(selected)]);
  const issue = resolvableValueIssue([selected], selected.sourceId, selected.generationId);
  const stored = { run: { state: 'RUNNING' } };
  globalThis.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries(keys.map(key => [key, stored[key]])); },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  } } };
  const controller = createCardEditController({ lock: callback => callback(),
    buildFactsPrompt: () => '', normalizeFacts: () => ({}), refreshAccounting: async () => {},
    runIsActive: run => run?.state === 'RUNNING' });
  const request = { type: 'REVIEW_CARD_ISSUE', generationId: selected.generationId,
    expectedAcceptedId: selected.generationId, issueId: issue.id, fingerprint: issue.fingerprint, decision: 'confirm' };

  assert.equal((await controller.handle(request, {})).changed, true);
  stored.resultsImportJournal = { id: 'importing' };
  await assert.rejects(controller.handle({ ...request, decision: 'reopen' }, {}), /импорта или обновления/);
  delete stored.resultsImportJournal;
  stored.manualExtensionUpdateLock = { active: true };
  await assert.rejects(controller.handle({ ...request, decision: 'reopen' }, {}), /импорта или обновления/);
});

test('new manual-facts revisions do not inherit issue confirmations', async () => {
  const selected = card({ generationId: 'manual-base', caseSize: '45 мм' });
  selected.qualityIssueResolutions = [{ id: 'old-rule:caseSize', fingerprint: 'old-fingerprint', reviewedAt: 'fixed', comment: '' }];
  await seedDatabase([selected], [modelFor(selected)]);
  const stored = {};
  globalThis.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  } }, alarms: { async clear() {} } };
  globalThis.fetch = async url => ({ ok: true,
    async json() { return { valid: true, sha256: new URL(url).searchParams.get('expectedHash'), bytes: 100 }; } });
  const controller = createCardEditController({ lock: callback => callback(),
    buildFactsPrompt: () => '', normalizeFacts: (_record, raw) => JSON.parse(raw),
    refreshAccounting: async () => {}, runIsActive: run => run?.state === 'RUNNING' });
  const job = await controller.handle({ type: 'SAVE_CARD_FACTS', generationId: selected.generationId,
    expectedAcceptedId: selected.generationId, fields: { ...selected.facts, utp1: 'Сапфировое стекло' } }, {});
  assert.equal(job.stage, 'ready');
  const revised = await getGenerationRevision(job.id);
  assert.deepEqual(revised.qualityIssueResolutions, []);
  assert.deepEqual((await getGenerationRevision(selected.generationId)).qualityIssueResolutions,
    selected.qualityIssueResolutions);
});

test('accounting snapshot rows receive review metadata only from their exact stored revision tuple', () => {
  const accepted = card({ generationId: 'snapshot-version', caseSize: '45 мм' });
  const resolution = { id: 'CASE_SIZE_OUT_OF_RANGE:caseSize', fingerprint: 'signature', reviewedAt: 'fixed', comment: '' };
  const snapshot = { entries: [{ skuKey: accepted.sourceId, acceptedGenerationId: accepted.generationId,
    identityStatus: 'OK', status: 'READY', acceptedRevision: accepted,
    artifactVerification: { verified: true } }] };
  const exact = galleryRecordsFromAccountingSnapshot(snapshot, [], [{ ...accepted, qualityIssueResolutions: [resolution] }]);
  assert.deepEqual(exact[0].qualityIssueResolutions, [resolution]);

  const mismatched = { ...accepted, outputHash: sha('f'), facts: { ...accepted.facts, outputHash: sha('f') },
    qualityIssueResolutions: [resolution] };
  const stale = galleryRecordsFromAccountingSnapshot(snapshot, [], [mismatched]);
  assert.equal(stale[0].qualityIssueResolutions, undefined);
});
