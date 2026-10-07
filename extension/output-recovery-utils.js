const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const STATES = new Set([
  'attempt_started',
  'file_verified',
  'revision_registered',
  'rejected',
  'ambiguous'
]);

export const OUTPUT_RECOVERY_STATES = Object.freeze({
  ATTEMPT_STARTED: 'attempt_started',
  FILE_VERIFIED: 'file_verified',
  REVISION_REGISTERED: 'revision_registered',
  REJECTED: 'rejected',
  AMBIGUOUS: 'ambiguous'
});

function text(value) {
  return String(value ?? '').trim();
}

function pathText(value) {
  return text(value).replace(/\\/g, '/');
}

function hashText(value) {
  const hash = text(value);
  return SHA256_PATTERN.test(hash) ? hash.toLowerCase() : '';
}

function isoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  const raw = text(value);
  const parsed = Date.parse(raw);
  return parsed > 0 ? new Date(parsed).toISOString() : '';
}

function normalizedTuple(value) {
  const generationId = text(value?.generationId);
  const sourceId = text(value?.sourceId);
  const outputPath = pathText(value?.outputPath);
  const outputHash = hashText(value?.outputHash ?? value?.sha256);
  if (!generationId || !sourceId || !outputPath || !outputHash) return null;
  return { generationId, sourceId, outputPath, outputHash };
}

function tupleEquals(left, right) {
  const a = normalizedTuple(left);
  const b = normalizedTuple(right);
  return Boolean(a && b
    && a.generationId === b.generationId
    && a.sourceId === b.sourceId
    && a.outputPath === b.outputPath
    && a.outputHash === b.outputHash);
}

function verificationFrom(value, tuple) {
  const source = value?.fileVerification || value?.verification || value || {};
  const verificationTuple = normalizedTuple({
    generationId: source.generationId ?? value?.generationId ?? tuple?.generationId,
    sourceId: source.sourceId ?? value?.sourceId ?? tuple?.sourceId,
    outputPath: source.outputPath ?? source.path ?? value?.outputPath ?? value?.path ?? tuple?.outputPath,
    outputHash: source.outputHash ?? source.sha256 ?? value?.outputHash ?? value?.sha256 ?? tuple?.outputHash
  });
  const bytes = Number(source.sizeBytes ?? source.bytes ?? value?.sizeBytes ?? value?.bytes);
  const verifiedAt = isoTimestamp(source.verifiedAt ?? source.checkedAt ?? value?.verifiedAt ?? value?.checkedAt);
  if (!verificationTuple || !tupleEquals(verificationTuple, tuple)
    || source.verified !== true || source.exists !== true || source.isFile !== true
    || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return {
    verified: true,
    exists: true,
    isFile: true,
    generationId: verificationTuple.generationId,
    sourceId: verificationTuple.sourceId,
    outputPath: verificationTuple.outputPath,
    outputHash: verificationTuple.outputHash,
    sizeBytes: bytes,
    verifiedAt: verifiedAt || null
  };
}

function sameVerificationEvidence(left, right) {
  if (!left || !right) return false;
  return left.verified === true && right.verified === true
    && left.exists === true && right.exists === true
    && left.isFile === true && right.isFile === true
    && String(left.generationId || '') === String(right.generationId || '')
    && String(left.sourceId || '') === String(right.sourceId || '')
    && pathText(left.outputPath) === pathText(right.outputPath)
    && hashText(left.outputHash) === hashText(right.outputHash)
    && Number(left.sizeBytes) === Number(right.sizeBytes);
}

function result(ok, changed, record, reason = null) {
  return { ok, changed, record, reason };
}

function terminalState(state) {
  return state === OUTPUT_RECOVERY_STATES.REJECTED || state === OUTPUT_RECOVERY_STATES.AMBIGUOUS;
}

/**
 * Validate and canonicalize one durable output-recovery journal record.
 * Invalid records return null so callers can fail closed while reading storage.
 */
export function normalizeOutputRecoveryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const generationId = text(value.generationId);
  const sourceId = text(value.sourceId);
  const state = text(value.state);
  const startedAt = isoTimestamp(value.startedAt);
  const updatedAt = isoTimestamp(value.updatedAt) || startedAt;
  if (Number(value.version ?? 1) !== 1 || !generationId || !sourceId
    || !STATES.has(state) || !startedAt || !updatedAt) return null;

  const partialTuple = {
    generationId,
    sourceId,
    outputPath: value.outputPath,
    outputHash: value.outputHash
  };
  const hasPath = Boolean(pathText(value.outputPath));
  const hasHash = Boolean(text(value.outputHash));
  let tuple = null;
  if (hasPath || hasHash) {
    tuple = normalizedTuple(partialTuple);
    if (!tuple) return null;
  }

  const normalized = {
    version: 1,
    generationId,
    sourceId,
    operationId: text(value.operationId) || null,
    attemptId: text(value.attemptId) || null,
    state,
    startedAt,
    updatedAt,
    outputPath: tuple?.outputPath || null,
    outputHash: tuple?.outputHash || null,
    fileVerification: null,
    revisionRegisteredAt: null,
    terminalReason: null,
    terminalAt: null
  };

  if (state === OUTPUT_RECOVERY_STATES.FILE_VERIFIED || state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) {
    if (!tuple) return null;
    const proof = verificationFrom(value.fileVerification, tuple);
    if (!proof) return null;
    normalized.fileVerification = proof;
  }

  if (state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) {
    const revisionTuple = normalizedTuple(value.revision || value);
    if (!revisionTuple || !tupleEquals(revisionTuple, tuple)) return null;
    normalized.revisionRegisteredAt = isoTimestamp(value.revisionRegisteredAt) || updatedAt;
  }

  if (terminalState(state)) {
    const terminalReason = text(value.terminalReason || value.reason);
    const terminalAt = isoTimestamp(value.terminalAt) || updatedAt;
    if (!terminalReason) return null;
    normalized.terminalReason = terminalReason;
    normalized.terminalAt = terminalAt;
    if (tuple) {
      const proof = verificationFrom(value.fileVerification, tuple);
      if (value.fileVerification && !proof) return null;
      normalized.fileVerification = proof;
    }
  }

  return normalized;
}

/**
 * Construct a new journal entry for a generation attempt. `startedAt` is
 * explicit to keep this helper deterministic and suitable for replay/tests.
 */
export function createOutputRecoveryRecord(value = {}) {
  const generationId = text(value.generationId);
  const sourceId = text(value.sourceId);
  const startedAt = isoTimestamp(value.startedAt || value.at);
  if (!generationId || !sourceId || !startedAt) return null;
  return normalizeOutputRecoveryRecord({
    version: 1,
    generationId,
    sourceId,
    operationId: value.operationId,
    attemptId: value.attemptId,
    state: OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED,
    startedAt,
    updatedAt: isoTimestamp(value.updatedAt) || startedAt,
    outputPath: value.outputPath || null,
    outputHash: value.outputHash || null
  });
}

/**
 * Apply one journal event. Replaying an identical event is safe and leaves the
 * record unchanged. Identity or evidence conflicts fail closed.
 */
export function transitionOutputRecoveryRecord(value, event = {}) {
  const record = normalizeOutputRecoveryRecord(value);
  if (!record) return result(false, false, null, 'invalid_record');

  const type = text(event.type || event.state);
  const at = isoTimestamp(event.at || event.updatedAt || event.verifiedAt || event.registeredAt)
    || record.updatedAt;
  if (!type) return result(false, false, record, 'event_type_required');

  if (terminalState(record.state)) {
    if (type !== record.state || text(event.reason || event.terminalReason) !== record.terminalReason) {
      return result(false, false, record, 'terminal_record');
    }
    return result(true, false, record);
  }

  if (type === OUTPUT_RECOVERY_STATES.REJECTED || type === OUTPUT_RECOVERY_STATES.AMBIGUOUS) {
    const reason = text(event.reason || event.terminalReason) || type;
    const terminal = normalizeOutputRecoveryRecord({
      ...record,
      state: type,
      updatedAt: at,
      terminalAt: isoTimestamp(event.terminalAt || event.at) || at,
      terminalReason: reason
    });
    return terminal ? result(true, true, terminal) : result(false, false, record, 'invalid_terminal_event');
  }

  if (type === OUTPUT_RECOVERY_STATES.FILE_VERIFIED) {
    if (record.state === OUTPUT_RECOVERY_STATES.FILE_VERIFIED
      || record.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) {
      const existingTuple = normalizedTuple(record);
      const replayTuple = normalizedTuple({
        generationId: event.generationId,
        sourceId: event.sourceId,
        outputPath: event.outputPath ?? event.path,
        outputHash: event.outputHash ?? event.sha256
      });
      const replayProof = verificationFrom(event, existingTuple);
      if (!existingTuple || !tupleEquals(existingTuple, replayTuple) || !replayProof
        || !sameVerificationEvidence(replayProof, record.fileVerification)) {
        return result(false, false, record, 'file_verification_conflict');
      }
      return result(true, false, record);
    }
    if (record.state !== OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED) {
      return result(false, false, record, 'invalid_transition');
    }

    const tuple = normalizedTuple({
      generationId: event.generationId,
      sourceId: event.sourceId,
      outputPath: event.outputPath ?? event.path,
      outputHash: event.outputHash ?? event.sha256
    });
    const proof = tuple ? verificationFrom(event, tuple) : null;
    if (!tuple || tuple.generationId !== record.generationId || tuple.sourceId !== record.sourceId || !proof) {
      return result(false, false, record, 'file_verification_required');
    }
    const next = normalizeOutputRecoveryRecord({
      ...record,
      state: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
      outputPath: tuple.outputPath,
      outputHash: tuple.outputHash,
      fileVerification: proof,
      updatedAt: at
    });
    return next ? result(true, true, next) : result(false, false, record, 'invalid_file_verification');
  }

  if (type === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) {
    const tuple = normalizedTuple({
      generationId: event.generationId,
      sourceId: event.sourceId,
      outputPath: event.outputPath ?? event.path,
      outputHash: event.outputHash ?? event.sha256
    });
    if (!tuple || !tupleEquals(tuple, record)) return result(false, false, record, 'revision_tuple_mismatch');
    if (record.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) return result(true, false, record);
    if (record.state !== OUTPUT_RECOVERY_STATES.FILE_VERIFIED || !record.fileVerification) {
      return result(false, false, record, 'file_not_verified');
    }
    const next = normalizeOutputRecoveryRecord({
      ...record,
      state: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED,
      revision: tuple,
      revisionRegisteredAt: at,
      updatedAt: at
    });
    return next ? result(true, true, next) : result(false, false, record, 'invalid_revision_registration');
  }

  return result(false, false, record, 'unsupported_transition');
}

/**
 * An orphan output can be considered for revision recovery only after positive
 * file verification, and only for the exact attempt, source, path, and hash.
 */
export function canRecoverOutputRecord(value, expectedTuple) {
  const record = normalizeOutputRecoveryRecord(value);
  if (!record || record.state !== OUTPUT_RECOVERY_STATES.FILE_VERIFIED
    || terminalState(record.state) || !record.fileVerification) return false;
  return tupleEquals(record, expectedTuple)
    && tupleEquals(record.fileVerification, expectedTuple)
    && record.fileVerification.verified === true
    && record.fileVerification.exists === true
    && record.fileVerification.isFile === true
    && Number(record.fileVerification.sizeBytes) > 0;
}

/**
 * Explicitly stop automatic promotion of a record. The state is terminal.
 */
export function markOutputRecoveryRecord(value, { state, reason, at } = {}) {
  if (!terminalState(text(state))) return result(false, false, normalizeOutputRecoveryRecord(value), 'terminal_state_required');
  return transitionOutputRecoveryRecord(value, { type: text(state), reason, at });
}
