export const ACCOUNTING_SNAPSHOT_STORAGE_KEY = 'accountingSnapshot';

function revisionOf(snapshot) {
  const value = Number(snapshot?.snapshotSequence ?? snapshot?.revision);
  return Number.isFinite(value) ? value : null;
}

function timestampOf(snapshot) {
  const value = Date.parse(snapshot?.generatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

export function accountingSnapshotFromResponse(response) {
  const candidate = response?.value?.snapshot || response?.value || response?.snapshot || response;
  return candidate && Array.isArray(candidate.entries) && candidate.version
    ? candidate
    : null;
}

// Snapshot reads can race: an older IndexedDB read may resolve after a newer
// one. Keep the freshest same-scope revision and never replace confirmed data
// with a stale fallback carrying an older revision.
export function acceptAccountingSnapshot(current, candidate) {
  if (!candidate || !Array.isArray(candidate.entries)) return current || null;
  if (!current) return candidate;
  const currentScope = String(current.scopeKey || '');
  const candidateScope = String(candidate.scopeKey || '');
  const sameScope = !currentScope || !candidateScope || currentScope === candidateScope;
  if (!sameScope) return timestampOf(candidate) >= timestampOf(current) ? candidate : current;

  const oldRevision = revisionOf(current);
  const nextRevision = revisionOf(candidate);
  if (oldRevision != null && nextRevision != null && nextRevision < oldRevision) return current;
  if (oldRevision === nextRevision && timestampOf(candidate) < timestampOf(current)) return current;
  if (candidate.stale === true || candidate.verificationAvailable === false) {
    return {
      ...current,
      revision: nextRevision ?? current.revision,
      snapshotSequence: candidate.snapshotSequence ?? current.snapshotSequence,
      generatedAt: candidate.generatedAt || current.generatedAt,
      stale: true,
      staleReason: candidate.staleReason || 'проверка сейчас недоступна',
      verificationAvailable: false,
      verificationUnavailable: true
    };
  }
  return candidate;
}

export function accountingSnapshotFreshness(snapshot) {
  if (!snapshot) return { state: 'unavailable', label: 'готовность не подтверждена' };
  if (snapshot.stale === true || snapshot.verificationAvailable === false) {
    return {
      state: 'stale',
      label: `данные требуют повторной проверки${snapshot.staleReason ? ` · ${snapshot.staleReason}` : ''}${snapshot.reconciliationComplete === false ? ' · сверка старого каталога не завершена' : ''}`
    };
  }
  if (snapshot.reconciliationComplete !== true) {
    return {
      state: 'blocked',
      label: `запуск заблокирован: сверка каталога не завершена${snapshot.reconciliationState ? ` · ${snapshot.reconciliationState}` : ''}`
    };
  }
  const generatedAt = timestampOf(snapshot);
  return {
    state: 'confirmed',
    label: generatedAt ? `снимок ${new Date(generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'снимок подтверждён'
  };
}

export function canonicalAccountingIndex(snapshot) {
  return new Map((Array.isArray(snapshot?.entries) ? snapshot.entries : [])
    .filter((entry) => entry?.skuKey)
    .map((entry) => [String(entry.skuKey), entry]));
}

export function accountingMemoryStatus(entry) {
  if (!entry) return 'needs_verification';
  if (entry.identityStatus === 'AMBIGUOUS' || entry.identityQuarantined === true) return 'identity_review';
  switch (String(entry.status || '').toUpperCase()) {
    case 'READY': return 'ready';
    case 'NEEDS_FACTS': return 'facts_pending';
    case 'NEEDS_VERIFICATION': return 'needs_verification';
    case 'NOT_READY':
    default: return 'not_ready';
  }
}

export function accountingAttemptIsActive(attempt) {
  if (!attempt || attempt.active === false || attempt.isActive === false) return false;
  const status = String(attempt?.status || attempt?.state || '').toUpperCase();
  return ['QUEUED', 'PREPARING', 'STARTING', 'RUNNING', 'GENERATING',
    'OBSERVING', 'FACTS_PENDING', 'FACTS_RUNNING', 'VERIFYING', 'DOWNLOADING'].includes(status);
}

export function accountingUiRecord(queueEntry, canonicalEntry, legacyRecord = {}) {
  if (!canonicalEntry) {
    return {
      ...legacyRecord,
      sourceId: String(queueEntry?.skuKey || queueEntry?.sourceId || ''),
      modelName: queueEntry?.modelName || legacyRecord.modelName || '',
      fileName: queueEntry?.fileName || legacyRecord.fileName || '',
      groupId: queueEntry?.groupId || legacyRecord.groupId || null,
      status: 'needs_verification',
      accountingStatus: 'NEEDS_VERIFICATION',
      accountingIdentityStatus: 'UNKNOWN',
      accountingUnconfirmed: true
    };
  }

  const revision = canonicalEntry.acceptedRevision || null;
  const attempt = canonicalEntry.activeAttempt || null;
  const status = accountingMemoryStatus(canonicalEntry);
  const attemptActive = accountingAttemptIsActive(attempt);
  const attemptError = attempt?.lastError || null;
  const historicalError = attemptError || legacyRecord.lastError || null;
  return {
    ...legacyRecord,
    sourceId: String(canonicalEntry.skuKey),
    generationId: revision?.generationId || null,
    groupId: queueEntry?.groupId || revision?.groupId || legacyRecord.groupId || null,
    sourceVariantId: queueEntry?.inputSourceId || queueEntry?.sourceVariantId || revision?.sourceVariantId || legacyRecord.sourceVariantId || null,
    relativePath: queueEntry?.relativePath || revision?.relativePath || legacyRecord.relativePath || null,
    fileName: queueEntry?.fileName || revision?.fileName || legacyRecord.fileName || null,
    modelName: canonicalEntry.model?.modelName || revision?.modelName || queueEntry?.modelName || legacyRecord.modelName || '',
    outputFileName: revision?.outputFileName || legacyRecord.outputFileName || null,
    generatedAt: revision?.generatedAt || revision?.completedAt || legacyRecord.generatedAt || null,
    outputPath: revision?.outputPath || null,
    outputHash: revision?.outputHash || null,
    outputWidth: Number(revision?.outputWidth || 0) || null,
    outputHeight: Number(revision?.outputHeight || 0) || null,
    facts: revision?.facts || null,
    status,
    accountingStatus: String(canonicalEntry.status || '').toUpperCase(),
    accountingIdentityStatus: String(canonicalEntry.identityStatus || 'OK').toUpperCase(),
    accountingReplacementRequired: Boolean(canonicalEntry.replacementRequired),
    accountingNextTask: canonicalEntry.nextTask || null,
    accountingActiveAttempt: attempt,
    accountingAttemptActive: attemptActive,
    accountingAttemptError: attemptError,
    historicalAttemptError: attemptActive ? null : historicalError,
    accountingVerification: canonicalEntry.artifactVerification || null,
    accountingUnconfirmed: false,
    lastError: canonicalEntry.identityStatus === 'AMBIGUOUS'
      ? 'Неоднозначный номер модели; требуется проверка идентичности'
      : (status === 'ready' && !attemptActive ? null : historicalError),
    sourcePresent: canonicalEntry.model?.sourcePresent !== false
  };
}
