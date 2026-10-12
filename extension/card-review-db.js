import { openDb, transactionResult, MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE } from './idb.js';
import { createOutputRecoveryRecord, transitionOutputRecoveryRecord, OUTPUT_RECOVERY_STATES } from './output-recovery-utils.js';
import { auditCardRecords } from './gallery-quality-utils.js';

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

// Confirm an audit issue against the exact facts, image hash, rule version,
// and comparison-family context currently produced by the canonical audit.
// The audit and metadata write share one IDB transaction, so family changes or
// pointer changes cannot race the signature check.
export async function reviewCardIssue({ generationId, expectedAcceptedId, issueId, fingerprint, decision, comment = '' } = {}) {
  if (!['confirm', 'reopen'].includes(decision)) return { changed: false, reason: 'unsupported_decision' };
  const generationKey = String(generationId || '');
  const expectedAcceptedKey = String(expectedAcceptedId || '');
  const requestedIssueId = String(issueId || '');
  const requestedFingerprint = String(fingerprint || '');
  if (!generationKey || !expectedAcceptedKey || !requestedIssueId || !requestedFingerprint) {
    return { changed: false, reason: 'missing_identity' };
  }

  const db = await openDb();
  try {
    return await transactionResult(db, [REVISION_STORE, MODEL_STORE], tx => {
      const revisions = tx.objectStore(REVISION_STORE), models = tx.objectStore(MODEL_STORE);
      const result = { changed: false };
      let revisionRows = [], modelRows = null;
      const validateAndWrite = () => {
        if (!modelRows) return;
        const byGeneration = new Map(revisionRows.map(row => [String(row.generationId || ''), row]));
        const selected = byGeneration.get(generationKey);
        if (!selected || String(selected.generationId || '') !== generationKey || !completeCardRevision(selected)
          || selected.reviewStatus === 'rejected' || selected.identityQuarantined === true) {
          result.reason = 'invalid_revision'; return;
        }

        const model = modelRows.find(row => String(row.skuKey || '') === String(selected.sourceId || ''));
        if (!model || String(model.latestReadyGenerationId || '') !== expectedAcceptedKey) {
          result.reason = 'accepted_version_changed'; return;
        }
        if (model.identityQuarantined || (model.variants || []).some(variant => variant?.identityQuarantined)) {
          result.reason = 'identity_quarantined'; return;
        }
        const accepted = byGeneration.get(expectedAcceptedKey);
        if (!accepted || String(accepted.sourceId || '') !== String(model.skuKey || '')
          || !completeCardRevision(accepted) || accepted.status !== 'READY'
          || accepted.reviewStatus === 'rejected' || accepted.identityQuarantined === true) {
          result.reason = 'invalid_accepted_revision'; return;
        }

        const currentRecords = modelRows.flatMap(catalogRow => {
          const revision = byGeneration.get(String(catalogRow.latestReadyGenerationId || ''));
          if (!revision || String(revision.sourceId || '') !== String(catalogRow.skuKey || '')
            || !completeCardRevision(revision) || revision.status !== 'READY'
            || revision.reviewStatus === 'rejected' || revision.identityQuarantined === true) return [];
          return [{ ...revision,
            modelName: revision.modelName || catalogRow.modelName || '',
            profileId: catalogRow.profileId || catalogRow.brandId || null }];
        });
        const selectedCurrent = currentRecords.find(row => String(row.sourceId || '') === String(selected.sourceId || ''));
        const selectedRecord = { ...selected,
          modelName: selected.modelName || selectedCurrent?.modelName || model.modelName || '',
          profileId: selected.profileId || selectedCurrent?.profileId || model.profileId || model.brandId || null };
        const auditRecords = [
          ...currentRecords.filter(row => String(row.sourceId || '') !== String(selected.sourceId || '')),
          selectedRecord
        ];
        const issue = auditCardRecords(auditRecords, { includeResolved: true }).find(candidate => (
          candidate.sourceId === selectedRecord.sourceId
          && candidate.generationId === selectedRecord.generationId
          && candidate.id === requestedIssueId
          && candidate.fingerprint === requestedFingerprint
        ));
        if (!issue) { result.reason = 'stale_or_unknown_issue'; return; }
        if (issue.resolvable !== true) { result.reason = 'nonresolvable_issue'; return; }

        const existing = Array.isArray(selected.qualityIssueResolutions) ? selected.qualityIssueResolutions : [];
        const matches = entry => entry?.id === issue.id && entry?.fingerprint === issue.fingerprint;
        if (decision === 'confirm') {
          if (existing.some(matches)) { result.reason = 'already_confirmed'; return; }
          const reviewedAt = new Date().toISOString();
          const resolution = { id: issue.id, fingerprint: issue.fingerprint, reviewedAt,
            comment: String(comment ?? '').slice(0, 2000) };
          // Retain other issue decisions; a changed context replaces only its
          // obsolete decision for this rule, keeping review metadata bounded.
          revisions.put({ ...selected, qualityIssueResolutions: [...existing.filter(entry => entry?.id !== issue.id), resolution] });
          result.changed = true; result.resolution = resolution;
        } else {
          const retained = existing.filter(entry => !matches(entry));
          if (retained.length === existing.length) { result.reason = 'not_confirmed'; return; }
          revisions.put({ ...selected, qualityIssueResolutions: retained });
          result.changed = true;
        }
        result.issue = issue;
      };
      const modelRequest = models.getAll();
      modelRequest.onsuccess = () => {
        modelRows = modelRequest.result || [];
        const revisionIds = new Set([generationKey, ...modelRows.map(row => String(row.latestReadyGenerationId || '')).filter(Boolean)]);
        let remaining = revisionIds.size;
        if (!remaining) return validateAndWrite();
        for (const revisionId of revisionIds) {
          const request = revisions.get(revisionId);
          request.onsuccess = () => {
            if (request.result) revisionRows.push(request.result);
            remaining -= 1;
            if (!remaining) validateAndWrite();
          };
        }
      };
      return result;
    }, 'Review card quality issue');
  } finally { db.close(); }
}
