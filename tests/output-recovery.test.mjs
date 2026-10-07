import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRecoverOutputRecord,
  createOutputRecoveryRecord,
  markOutputRecoveryRecord,
  normalizeOutputRecoveryRecord,
  OUTPUT_RECOVERY_STATES,
  transitionOutputRecoveryRecord
} from '../extension/output-recovery-utils.js';

const startedAt = '2026-10-06T10:00:00.000Z';
const verifiedAt = '2026-10-06T10:01:00.000Z';
const registeredAt = '2026-10-06T10:02:00.000Z';
const hash = 'a'.repeat(64);
const tuple = {
  generationId: 'generation-1',
  sourceId: 'casio:DW5600E1V',
  outputPath: 'in_sale_good/generated-watch.png',
  outputHash: hash
};

function started(overrides = {}) {
  return createOutputRecoveryRecord({
    generationId: tuple.generationId,
    sourceId: tuple.sourceId,
    operationId: 'run-1',
    attemptId: 'attempt-1',
    startedAt,
    ...overrides
  });
}

function fileVerified(eventOverrides = {}) {
  return {
    type: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
    ...tuple,
    outputHash: hash.toUpperCase(),
    verified: true,
    exists: true,
    isFile: true,
    sizeBytes: 128,
    verifiedAt,
    at: verifiedAt,
    ...eventOverrides
  };
}

function register(record, overrides = {}) {
  return transitionOutputRecoveryRecord(record, {
    type: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED,
    ...tuple,
    at: registeredAt,
    ...overrides
  });
}

test('creates a normalized attempt record with durable identity and timestamp', () => {
  const record = started();
  assert.deepEqual(record, {
    version: 1,
    generationId: tuple.generationId,
    sourceId: tuple.sourceId,
    operationId: 'run-1',
    attemptId: 'attempt-1',
    state: OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED,
    startedAt,
    updatedAt: startedAt,
    outputPath: null,
    outputHash: null,
    fileVerification: null,
    revisionRegisteredAt: null,
    terminalReason: null,
    terminalAt: null
  });
  assert.equal(normalizeOutputRecoveryRecord({ ...record, sourceId: '' }), null);
  assert.equal(started({ startedAt: 'not-a-date' }), null);
});

test('requires positive path-and-hash-matched file verification before recovery', () => {
  const attempt = started();
  for (const patch of [
    { exists: false },
    { isFile: false },
    { sizeBytes: 0 },
    { fileVerification: {
      verified: true, exists: true, isFile: true, generationId: tuple.generationId,
      sourceId: tuple.sourceId, outputPath: 'in_sale_bad/other.png', outputHash: hash,
      sizeBytes: 128, verifiedAt
    } },
    { fileVerification: {
      verified: true, exists: true, isFile: true, generationId: tuple.generationId,
      sourceId: tuple.sourceId, outputPath: tuple.outputPath, outputHash: 'b'.repeat(64),
      sizeBytes: 128, verifiedAt
    } },
    { generationId: 'generation-other' },
    { sourceId: 'casio:other' },
    { outputHash: 'not-a-sha256' }
  ]) {
    const rejected = transitionOutputRecoveryRecord(attempt, fileVerified(patch));
    assert.equal(rejected.ok, false, JSON.stringify(patch));
    assert.equal(rejected.record.state, OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED);
  }

  const accepted = transitionOutputRecoveryRecord(attempt, fileVerified());
  assert.equal(accepted.ok, true);
  assert.equal(accepted.changed, true);
  assert.equal(accepted.record.state, OUTPUT_RECOVERY_STATES.FILE_VERIFIED);
  assert.equal(accepted.record.outputHash, hash);
  assert.equal(accepted.record.fileVerification.sizeBytes, 128);
  assert.equal(accepted.record.fileVerification.verifiedAt, verifiedAt);
  assert.equal(canRecoverOutputRecord(accepted.record, tuple), true);
  assert.equal(canRecoverOutputRecord(accepted.record, { ...tuple, outputHash: 'c'.repeat(64) }), false);
  assert.equal(canRecoverOutputRecord(accepted.record, { ...tuple, sourceId: 'casio:other' }), false);
  assert.equal(canRecoverOutputRecord(accepted.record, { ...tuple, outputPath: 'different.png' }), false);
  assert.equal(canRecoverOutputRecord(accepted.record, { ...tuple, generationId: 'generation-other' }), false);
  assert.equal(canRecoverOutputRecord(accepted.record), false);
});

test('accepts `bytes` as the positive verified file size alias', () => {
  const accepted = transitionOutputRecoveryRecord(started(), fileVerified({ sizeBytes: undefined, bytes: 42 }));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.record.fileVerification.sizeBytes, 42);
});

test('revision registration requires the same complete identity tuple', () => {
  const verified = transitionOutputRecoveryRecord(started(), fileVerified());
  for (const patch of [
    { generationId: 'generation-other' },
    { sourceId: 'casio:other' },
    { outputPath: 'in_sale_bad/generated-watch.png' },
    { outputHash: 'b'.repeat(64) }
  ]) {
    const mismatch = register(verified.record, patch);
    assert.equal(mismatch.ok, false, JSON.stringify(patch));
    assert.equal(mismatch.reason, 'revision_tuple_mismatch');
    assert.equal(mismatch.record.state, OUTPUT_RECOVERY_STATES.FILE_VERIFIED);
  }

  const registered = register(verified.record);
  assert.equal(registered.ok, true);
  assert.equal(registered.changed, true);
  assert.equal(registered.record.state, OUTPUT_RECOVERY_STATES.REVISION_REGISTERED);
  assert.equal(registered.record.revisionRegisteredAt, registeredAt);
  assert.deepEqual(registered.record.fileVerification, verified.record.fileVerification);
  assert.equal(canRecoverOutputRecord(registered.record, tuple), false);
});

test('identical file verification and revision events replay safely without downgrading state', () => {
  const attempt = started();
  const verified = transitionOutputRecoveryRecord(attempt, fileVerified());
  const replayedFile = transitionOutputRecoveryRecord(verified.record, fileVerified());
  assert.equal(replayedFile.ok, true);
  assert.equal(replayedFile.changed, false);
  assert.deepEqual(replayedFile.record, verified.record);

  const registered = register(verified.record);
  const replayedRevision = register(registered.record);
  assert.equal(replayedRevision.ok, true);
  assert.equal(replayedRevision.changed, false);
  assert.deepEqual(replayedRevision.record, registered.record);
  const lateFileReplay = transitionOutputRecoveryRecord(registered.record, fileVerified());
  assert.equal(lateFileReplay.ok, true);
  assert.equal(lateFileReplay.changed, false);
  assert.equal(lateFileReplay.record.state, OUTPUT_RECOVERY_STATES.REVISION_REGISTERED);
});

test('conflicting verification replay and skipped state transitions fail closed', () => {
  const attempt = started();
  const earlyRegistration = register(attempt);
  assert.equal(earlyRegistration.ok, false);
  assert.equal(earlyRegistration.reason, 'revision_tuple_mismatch');

  const verified = transitionOutputRecoveryRecord(attempt, fileVerified());
  const conflict = transitionOutputRecoveryRecord(verified.record, fileVerified({ sizeBytes: 999 }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'file_verification_conflict');

  const unknown = transitionOutputRecoveryRecord(attempt, { type: 'accepted' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unsupported_transition');
});

test('rejected and ambiguous records are terminal and never recoverable or promotable', () => {
  const attempt = started();
  for (const state of [OUTPUT_RECOVERY_STATES.REJECTED, OUTPUT_RECOVERY_STATES.AMBIGUOUS]) {
    const marked = markOutputRecoveryRecord(attempt, { state, reason: 'manual_review', at: verifiedAt });
    assert.equal(marked.ok, true);
    assert.equal(marked.record.state, state);
    assert.equal(marked.record.terminalReason, 'manual_review');
    assert.equal(canRecoverOutputRecord(marked.record, tuple), false);

    const promotion = transitionOutputRecoveryRecord(marked.record, fileVerified());
    assert.equal(promotion.ok, false);
    assert.equal(promotion.reason, 'terminal_record');
    assert.equal(promotion.record.state, state);
  }
});

test('normalization refuses forged verified and revision records', () => {
  const attempt = started();
  const verified = transitionOutputRecoveryRecord(attempt, fileVerified()).record;
  assert.equal(normalizeOutputRecoveryRecord({ ...verified, fileVerification: { ...verified.fileVerification, exists: false } }), null);
  assert.equal(normalizeOutputRecoveryRecord({ ...verified, fileVerification: { ...verified.fileVerification, outputHash: 'b'.repeat(64) } }), null);

  const registered = register(verified).record;
  assert.equal(normalizeOutputRecoveryRecord({ ...registered, revision: { ...tuple, sourceId: 'casio:other' } }), null);
});
