import { openDb, transactionResult, MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE } from './idb.js';
import { createOutputRecoveryRecord, transitionOutputRecoveryRecord, OUTPUT_RECOVERY_STATES } from './output-recovery-utils.js';

export function completeCardRevision(record) {
  return Boolean(record?.generationId && record.sourceId && ['READY', 'REVIEW_PENDING'].includes(record.status) && record.factsStatus === 'ok'
    && record.outputPath && /^[a-f0-9]{64}$/i.test(record.outputHash || '') && record.factsJobId
    && record.facts?.status === 'ok' && record.facts.generationId === record.generationId
    && record.facts.factsJobId === record.factsJobId && record.facts.outputHash === record.outputHash);
}

export async function stageCardRevision(record, proof) {
  if (!completeCardRevision(record)) throw new Error('Неполная привязка спецификации к PNG');
  const attempt = createOutputRecoveryRecord({ ...record, startedAt: record.createdAt || new Date().toISOString() });
  const checked = transitionOutputRecoveryRecord(attempt, { type: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
    ...record, fileVerification: proof, at: new Date().toISOString() });
  const registered = checked.ok && transitionOutputRecoveryRecord(checked.record, { type: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED, ...record });
  if (!registered?.ok) throw new Error('Подтверждение PNG не соответствует новой ревизии');
  const db = await openDb();
  try {
    return await transactionResult(db, [REVISION_STORE, OUTPUT_RECOVERY_STORE], tx => {
      const revisions = tx.objectStore(REVISION_STORE), result = { created: false };
      const get = revisions.get(record.generationId);
      get.onsuccess = () => {
        if (get.result) { if (get.result.outputHash === record.outputHash && get.result.parentGenerationId === record.parentGenerationId) result.duplicate = true; return; }
        revisions.add({ ...record, status: 'REVIEW_PENDING', reviewStatus: 'pending', fileVerification: proof });
        tx.objectStore(OUTPUT_RECOVERY_STORE).add(registered.record);
        result.created = true;
      };
      return result;
    }, 'Stage card revision');
  } finally { db.close(); }
}

// Atomically promote the reviewed tuple. A concurrent generation or another
// reviewer changing the accepted pointer cannot be overwritten by this action.
export async function reviewCardRevision(generationId, decision, expectedAcceptedId, proof, reviewComment = '') {
  if (!['accept', 'reject'].includes(decision)) throw new Error('Неизвестное решение проверки');
  const db = await openDb();
  try {
    return await transactionResult(db, [REVISION_STORE, MODEL_STORE, FACTS_STORE], tx => {
      const revisions = tx.objectStore(REVISION_STORE), models = tx.objectStore(MODEL_STORE), result = { changed: false };
      const get = revisions.get(generationId);
      get.onsuccess = () => {
        const revision = get.result;
        if (!revision || !completeCardRevision(revision) || revision.reviewStatus === 'rejected') { result.reason = 'invalid_revision'; return; }
        const modelGet = models.get(revision.sourceId);
        modelGet.onsuccess = () => {
          const model = modelGet.result;
          if (!model || model.latestReadyGenerationId !== expectedAcceptedId) { result.reason = 'accepted_version_changed'; return; }
          if (decision === 'reject') {
            if (revision.generationId === model.latestReadyGenerationId) { result.reason = 'cannot_reject_current'; return; }
            revisions.put({ ...revision, reviewStatus: 'rejected', reviewedAt: new Date().toISOString() });
          } else {
            if (proof?.verified !== true || proof.exists !== true || proof.isFile !== true || !(Number(proof.sizeBytes) > 0)
              || proof.outputHash !== revision.outputHash || proof.outputPath !== revision.outputPath
              || proof.generationId !== revision.generationId || proof.sourceId !== revision.sourceId) { result.reason = 'invalid_proof'; return; }
            if (model.currentGenerationId && model.currentGenerationId !== model.latestReadyGenerationId) { result.reason = 'active_attempt'; return; }
            const now = new Date().toISOString();
            revisions.put({ ...revision, status: 'READY', reviewStatus: 'accepted', reviewedAt: now, reviewComment: String(reviewComment).slice(0, 2000) });
            models.put({ ...model, latestReadyGenerationId: generationId, currentGenerationId: generationId,
              currentOutputHash: revision.outputHash, currentOutputPath: revision.outputPath,
              generationStatus: 'READY', replacementRequired: false, retryRequired: false, sessionRetry: null,
              variants: (model.variants || []).map(v => v.sourceVariantId === revision.sourceVariantId
                ? { ...v, status: 'done', generationId, outputHash: revision.outputHash, outputPath: revision.outputPath, factsStatus: 'ok' } : v),
              queueState: { ...(model.queueState || {}), status: 'done', generationId, lastError: null }, updatedAt: now });
            tx.objectStore(FACTS_STORE).put({ ...revision.facts, sourceId: revision.sourceId, updatedAt: now });
          }
          result.changed = true;
        };
      };
      return result;
    }, 'Review card revision');
  } finally { db.close(); }
}
