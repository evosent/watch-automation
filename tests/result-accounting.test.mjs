import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCodeEvidence, projectCanonicalAccounting } from '../extension/result-accounting-utils.js';
import { galleryRecordsFromAccountingSnapshot } from '../extension/gallery-revision-utils.js';

const HASH = 'a'.repeat(64);
function factsFor(revision, patch = {}) {
  return { status: 'ok', generationId: revision.generationId, factsJobId: revision.factsJobId,
    outputHash: revision.outputHash, chatUrl: revision.chatUrl, titleModel: revision.modelName, ...patch };
}
function readyFixture(overrides = {}) {
  const skuKey = 'casio:mtpvd201';
  const generationId = 'generation-ready';
  const revision = { sourceId: skuKey, generationId, modelName: 'Casio Collection MTP-VD201',
    status: 'READY', factsStatus: 'ok', factsJobId: 'facts-ready', outputPath: 'in_sale_good/result.png',
    outputHash: HASH, chatUrl: 'https://chatgpt.com/c/chat-ready', facts: null, completedAt: '2026-10-06T10:00:00.000Z' };
  revision.facts = factsFor(revision);
  const model = { skuKey, sourceId: skuKey, brandId: 'casio', modelName: revision.modelName,
    sourcePresent: true, latestReadyGenerationId: generationId, currentGenerationId: generationId,
    variants: [{ sourceVariantId: 'variant-1', groupId: 'in_sale_good', modelName: revision.modelName }],
    ...overrides.model };
  const revisions = [revision, ...(overrides.revisions || [])];
  if (overrides.revision) revisions[0] = { ...revision, ...overrides.revision };
  return { model, revision: revisions[0], catalog: [model], revisions,
    artifactChecks: { [generationId]: { exists: true, hashMatches: true, outputHash: HASH, path: revision.outputPath } } };
}

test('one accepted image and its bound facts produce READY and the canonical counts', () => {
  const fixture = readyFixture();
  const snapshot = projectCanonicalAccounting(fixture);
  assert.deepEqual(snapshot.counts, { total: 1, ready: 1, needsFacts: 0, notReady: 0, needsVerification: 0 });
  assert.deepEqual(snapshot.eligibleCounts, snapshot.counts);
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.entries[0].acceptedGenerationId, 'generation-ready');
  assert.equal(snapshot.candidates.length, 0);
});

test('external accepted facts are exposed in the immutable snapshot view consumed by gallery', () => {
  const fixture = readyFixture();
  const externalFacts = factsFor(fixture.revision, { titleModel: 'Casio MTP-VD201 external facts' });
  fixture.revision.facts = null;
  const snapshot = projectCanonicalAccounting({
    ...fixture,
    facts: [externalFacts]
  });

  assert.equal(snapshot.counts.ready, 1);
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.entries[0].acceptedRevision.facts, externalFacts);
  assert.equal(fixture.revision.facts, null, 'projection does not mutate persisted revision');
  const cards = galleryRecordsFromAccountingSnapshot(snapshot, fixture.catalog, fixture.revisions);
  assert.equal(cards.length, snapshot.counts.ready);
  assert.equal(cards[0].facts, externalFacts);
});

test('fully bound accepted facts remain READY when both legacy chat URL fields are absent', () => {
  const fixture = readyFixture();
  fixture.revision.chatUrl = null;
  fixture.revision.facts.chatUrl = null;

  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.counts.ready, 1);
  assert.equal(snapshot.entries[0].nextTask, null);
});

test('FACTS_WAITING_IMAGE with exact generation/job/chat proof is held for artifact-registration review', () => {
  const fixture = readyFixture({ model: {} });
  fixture.model.latestReadyGenerationId = null;
  fixture.model.currentGenerationId = 'generation-ready';
  fixture.revision.status = 'FACTS_WAITING_IMAGE';
  fixture.revision.factsStatus = 'ok';
  fixture.revision.outputPath = null;
  fixture.revision.outputHash = null;
  fixture.revision.facts = {
    status: 'ok', generationId: 'generation-ready', factsJobId: 'facts-ready',
    chatUrl: 'https://chatgpt.com/c/chat-ready', titleModel: fixture.revision.modelName
  };

  const snapshot = projectCanonicalAccounting(fixture);
  const entry = snapshot.entries[0];
  assert.equal(entry.status, 'NEEDS_VERIFICATION');
  assert.equal(entry.statusReason, 'output_registration_manual_review');
  assert.equal(entry.nextTask, null);
  assert.equal(entry.outputRecoveryRequired, true);
  assert.equal(entry.artifactRecoveryPending, true);
  assert.equal(snapshot.outputRecoveryRequiredCount, 1);
  assert.deepEqual(snapshot.candidates, [], 'a captured facts tuple cannot trigger another image generation');
});

test('output verification candidates and in-flight recovery journals cannot schedule duplicate image generation', () => {
  const fixture = readyFixture({ model: {} });
  fixture.model.latestReadyGenerationId = null;
  fixture.model.currentGenerationId = 'generation-ready';
  fixture.revision.status = 'OUTPUT_VERIFICATION_PENDING';
  fixture.revision.outputVerificationPending = true;
  fixture.revision.factsStatus = 'pending';
  fixture.revision.facts = null;
  fixture.outputRecovery = [{ generationId: 'generation-ready', sourceId: fixture.model.skuKey,
    state: 'attempt_started', outputPath: fixture.revision.outputPath, outputHash: HASH }];

  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(snapshot.entries[0].statusReason, 'output_registration_pending');
  assert.equal(snapshot.entries[0].outputRecoveryRequired, true);
  assert.equal(snapshot.entries[0].nextTask, null);
  assert.deepEqual(snapshot.candidates, []);
});

test('bare inactive attempt journal is retryable, while a journal with an exact saved output tuple is held', () => {
  const bare = readyFixture({ model: {} });
  bare.model.latestReadyGenerationId = null;
  bare.model.currentGenerationId = bare.revision.generationId;
  bare.revision.status = 'CANCELLED';
  bare.revision.factsStatus = 'pending';
  bare.revision.outputPath = null;
  bare.revision.outputHash = null;
  bare.revision.facts = null;
  bare.outputRecovery = [{ generationId: bare.revision.generationId, sourceId: bare.model.skuKey,
    state: 'attempt_started' }];

  const retryable = projectCanonicalAccounting(bare);
  assert.equal(retryable.entries[0].status, 'NOT_READY');
  assert.equal(retryable.entries[0].outputRecoveryRequired, false);
  assert.equal(retryable.entries[0].nextTask, 'generate');
  assert.equal(retryable.candidates[0].task, 'generate');

  const candidate = readyFixture({ model: {} });
  candidate.model.latestReadyGenerationId = null;
  candidate.model.currentGenerationId = candidate.revision.generationId;
  candidate.revision.status = 'GENERATING';
  candidate.revision.factsStatus = 'pending';
  candidate.revision.facts = null;
  candidate.outputRecovery = [{ generationId: candidate.revision.generationId, sourceId: candidate.model.skuKey,
    state: 'attempt_started', outputPath: candidate.revision.outputPath, outputHash: HASH }];

  const held = projectCanonicalAccounting(candidate);
  assert.equal(held.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(held.entries[0].statusReason, 'output_registration_pending');
  assert.equal(held.entries[0].nextTask, null);
  assert.deepEqual(held.candidates, []);
});

test('accepted READY remains schedulable as complete while a newer output candidate is held for recovery', () => {
  const fixture = readyFixture();
  const pending = { ...fixture.revision, generationId: 'generation-output-pending',
    status: 'OUTPUT_VERIFICATION_PENDING', outputVerificationPending: true,
    factsStatus: 'pending', factsJobId: 'facts-pending', facts: null, createdAt: '2026-10-06T11:00:00.000Z' };
  fixture.revisions.push(pending);
  fixture.model.currentGenerationId = pending.generationId;
  fixture.outputRecovery = [{ generationId: pending.generationId, sourceId: fixture.model.skuKey,
    state: 'file_verified', outputPath: pending.outputPath, outputHash: pending.outputHash }];
  fixture.artifactChecks[pending.generationId] = { exists: true, verified: true,
    sha256: pending.outputHash, path: pending.outputPath };

  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.entries[0].acceptedGenerationId, 'generation-ready');
  assert.equal(snapshot.entries[0].outputRecoveryRequired, true);
  assert.equal(snapshot.entries[0].nextTask, null);
  assert.equal(snapshot.counts.ready, 1);
  assert.deepEqual(snapshot.candidates, []);
});

test('verified accepted image can repair its exact facts while a newer unregistered attempt stays held', () => {
  const fixture = readyFixture();
  fixture.revision.facts = null;
  fixture.revision.factsStatus = 'pending';
  fixture.revision.status = 'FACTS_PENDING';
  const pending = { sourceId: fixture.model.skuKey, generationId: 'generation-next', modelName: fixture.model.modelName,
    status: 'OUTPUT_VERIFICATION_PENDING', outputVerificationPending: true,
    factsStatus: 'pending', factsJobId: 'facts-next', outputPath: 'in_sale_good/next.png', outputHash: 'b'.repeat(64) };
  fixture.revisions.push(pending);
  fixture.model.currentGenerationId = pending.generationId;
  fixture.outputRecovery = [{ generationId: pending.generationId, sourceId: fixture.model.skuKey,
    state: 'attempt_started', outputPath: pending.outputPath, outputHash: pending.outputHash }];

  const snapshot = projectCanonicalAccounting(fixture);
  const entry = snapshot.entries[0];
  assert.equal(entry.outputRecoveryRequired, true, 'the newer generation remains separately flagged');
  assert.equal(entry.status, 'NEEDS_FACTS');
  assert.equal(entry.nextTask, 'facts');
  assert.equal(snapshot.candidates[0].generationId, fixture.revision.generationId);
  assert.equal(snapshot.candidates[0].factsJobId, fixture.revision.factsJobId);
});

test('an incomplete current generation preserves accepted READY and ordinary scheduling skips it', () => {
  const fixture = readyFixture();
  const pending = { sourceId: fixture.model.skuKey, generationId: 'generation-next', modelName: fixture.model.modelName,
    status: 'GENERATING', factsStatus: 'pending', factsJobId: 'facts-next', factsManualReviewRequired: true,
    createdAt: '2026-10-06T11:00:00.000Z' };
  fixture.revisions.push(pending);
  fixture.model.currentGenerationId = pending.generationId;
  fixture.model.retryRequired = true;
  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.entries[0].acceptedGenerationId, 'generation-ready');
  assert.equal(snapshot.entries[0].activeAttempt.generationId, 'generation-next');
  assert.equal(snapshot.entries[0].retryRequired, true);
  assert.equal(snapshot.entries[0].nextTask, null);
  assert.equal(snapshot.candidates.length, 0, 'READY stays done despite a legacy retry flag and active attempt');
});

test('a stale NOT_READY memory projection cannot override a verified gallery result', () => {
  const fixture = readyFixture({ model: { retryRequired: true } });
  const snapshot = projectCanonicalAccounting({ ...fixture,
    memory: { items: { [fixture.model.skuKey]: { status: 'not_ready' } } } });
  assert.equal(snapshot.entries[0].status, 'READY');
  assert.equal(snapshot.counts.ready, 1);
  assert.equal(snapshot.candidates.length, 0);
});

test('five verified gallery results remain complete despite stale memory and retry flags', () => {
  const fixtures = Array.from({ length: 5 }, (_, index) => {
    const fixture = readyFixture();
    const skuKey = `casio:model-${index}`;
    const generationId = `generation-${index}`;
    fixture.model.skuKey = skuKey;
    fixture.model.sourceId = skuKey;
    fixture.model.retryRequired = true;
    fixture.model.latestReadyGenerationId = generationId;
    fixture.model.currentGenerationId = generationId;
    fixture.revision.sourceId = skuKey;
    fixture.revision.generationId = generationId;
    fixture.revision.factsJobId = `facts-${index}`;
    fixture.revision.facts = factsFor(fixture.revision);
    fixture.artifactChecks = { [generationId]: { exists: true, hashMatches: true, outputHash: HASH, path: fixture.revision.outputPath } };
    return fixture;
  });
  const catalog = fixtures.flatMap(item => item.catalog);
  const revisions = fixtures.flatMap(item => item.revisions);
  const artifactChecks = Object.assign({}, ...fixtures.map(item => item.artifactChecks));
  const memory = { items: Object.fromEntries(catalog.map(model => [model.skuKey, { status: 'not_ready' }])) };
  const snapshot = projectCanonicalAccounting({ catalog, revisions, artifactChecks, memory,
    liveGenerationIds: new Set() });
  assert.equal(snapshot.counts.ready, 5);
  assert.equal(snapshot.candidates.length, 0);
  assert.ok(snapshot.entries.every(entry => entry.status === 'READY' && entry.nextTask === null));
});

test('a verified saved image with unbound or absent facts becomes a facts-only task', () => {
  const fixture = readyFixture({ model: {} });
  fixture.model.latestReadyGenerationId = null;
  fixture.model.currentGenerationId = 'generation-saved';
  fixture.revisions[0] = { ...fixture.revision, generationId: 'generation-saved', status: 'FACTS_PENDING',
    factsStatus: 'pending', factsJobId: 'facts-saved', facts: null };
  fixture.artifactChecks['generation-saved'] = { exists: true, hashMatches: true, outputHash: HASH, path: fixture.revision.outputPath };
  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_FACTS');
  assert.equal(snapshot.entries[0].nextTask, 'facts');
  assert.deepEqual(snapshot.candidates.map((item) => item.task), ['facts']);
  assert.equal(snapshot.candidates[0].generationId, 'generation-saved');
  assert.equal(snapshot.candidates[0].factsJobId, 'facts-saved');
  assert.equal(snapshot.candidates[0].outputHash, HASH);
  assert.equal(snapshot.candidates[0].outputPath, fixture.revision.outputPath);
  assert.equal(snapshot.candidates[0].targetRevision.generationId, 'generation-saved');
  assert.equal(snapshot.candidateCounts.facts, 1);
});

test('accepted facts candidates target the accepted revision and pause when another generation is live', () => {
  const fixture = readyFixture({ model: {} });
  fixture.model.currentGenerationId = 'generation-newer-live';
  const incompleteAccepted = { ...fixture.revision, status: 'FACTS_PENDING', factsStatus: 'pending', facts: null };
  const newerAttempt = { sourceId: fixture.model.skuKey, generationId: 'generation-newer-live',
    modelName: fixture.model.modelName, status: 'GENERATING', factsJobId: 'facts-newer', createdAt: '2026-10-06T11:00:00.000Z' };
  fixture.revisions.splice(0, fixture.revisions.length, incompleteAccepted, newerAttempt);
  const snapshot = projectCanonicalAccounting({ ...fixture, liveGenerationIds: new Set(['generation-newer-live']) });
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(snapshot.entries[0].statusReason, 'facts_conflict_with_live_attempt');
  assert.equal(snapshot.entries[0].actionRevision.generationId, 'generation-ready');
  assert.deepEqual(snapshot.candidates, []);
});

test('a complete verified current revision without an accepted pointer is quarantined for reconciliation', () => {
  const fixture = readyFixture({ model: {} });
  fixture.model.latestReadyGenerationId = null;
  fixture.model.currentGenerationId = 'generation-ready';
  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(snapshot.entries[0].statusReason, 'complete_current_revision_unaccepted');
  assert.equal(snapshot.entries[0].acceptedGenerationId, null);
  assert.equal(snapshot.candidates.length, 0, 'never regenerate a fully saved image because a pointer is missing');
});

test('an unverified path/hash is never counted as READY and produces a verification task', () => {
  const fixture = readyFixture();
  delete fixture.artifactChecks['generation-ready'];
  let snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(snapshot.entries[0].statusReason, 'check_missing');
  assert.equal(snapshot.entries[0].artifactVerification.status, 'UNKNOWN');
  assert.deepEqual(snapshot.candidates, [], 'an unavailable check cannot schedule a retry');
  fixture.artifactChecks['generation-ready'] = true;
  snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION', 'a boolean check cannot prove exact path and hash');
  assert.equal(snapshot.entries[0].artifactVerification.status, 'UNKNOWN');
  assert.deepEqual(snapshot.candidates, []);
  fixture.artifactChecks['generation-ready'] = { exists: false, hashMatches: false, checkedAt: '2026-10-06T12:00:00.000Z' };
  snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].artifactVerification.status, 'UNKNOWN', 'unconfirmed absence is not proof that the PNG was lost');
  assert.deepEqual(snapshot.candidates, []);
  fixture.artifactChecks['generation-ready'] = { exists: false, verified: true, valid: false,
    hashMatches: false, error: 'ENOENT', checkedAt: '2026-10-06T12:00:00.000Z' };
  assert.deepEqual(projectCanonicalAccounting(fixture).candidates.map((item) => item.task), ['verify']);
  fixture.artifactChecks['generation-ready'] = { exists: true, hashMatches: true, outputHash: 'b'.repeat(64) };
  assert.equal(projectCanonicalAccounting(fixture).entries[0].status, 'NEEDS_VERIFICATION');
});

test('endpoint-shaped missing artifact is actionable while permission and unverified results remain unknown', () => {
  const fixture = readyFixture();
  fixture.artifactChecks['generation-ready'] = { exists: false, verified: true, valid: false,
    hashMatches: false, error: 'ENOENT' };
  let snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].artifactVerification.status, 'MISSING');
  assert.deepEqual(snapshot.candidates.map((item) => item.task), ['verify']);

  fixture.artifactChecks['generation-ready'] = { exists: null, verified: false, valid: false,
    hashMatches: false, error: 'EACCES' };
  snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].artifactVerification.status, 'UNKNOWN');
  assert.deepEqual(snapshot.candidates, []);
});

test('saved facts binding failures and invalid chat URLs require manual review without retry candidates', () => {
  for (const patch of [
    { revision: { factsManualReviewRequired: true } },
    { revision: { chatUrl: 'https://chatgpt.com/' } },
    { revision: { facts: factsFor({ generationId: 'generation-ready', factsJobId: 'facts-ready', outputHash: HASH },
      { chatUrl: 'https://chatgpt.com/c/other-chat' }) } }
  ]) {
    const fixture = readyFixture({ ...patch, revision: { ...patch.revision, status: 'FACTS_PENDING', factsStatus: 'pending', facts: patch.revision.facts ?? null } });
    fixture.model.latestReadyGenerationId = null;
    fixture.model.currentGenerationId = fixture.revision.generationId;
    fixture.artifactChecks[fixture.revision.generationId] = { exists: true, verified: true,
      sha256: HASH, path: fixture.revision.outputPath };
    const snapshot = projectCanonicalAccounting(fixture);
    assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
    assert.equal(snapshot.entries[0].statusReason, 'saved_image_binding_manual_review');
    assert.equal(snapshot.entries[0].nextTask, null);
    assert.deepEqual(snapshot.candidates, []);
  }
});

test('invalid image metadata, changed paths and permission errors cannot masquerade as verified files', () => {
  const cases = [
    [{ exists: true, hashMatches: true, outputHash: HASH, path: 'in_sale_good/result.png', verified: false }, 'UNKNOWN', 0],
    [{ exists: true, sha256: HASH, path: 'in_sale_good/result.png', valid: false }, 'MISMATCH', 1],
    [{ exists: true, sha256: HASH, path: 'in_sale_bad/renamed.png' }, 'MISMATCH', 1],
    [{ exists: null, hashMatches: false, errorCode: 'EACCES', error: 'permission denied' }, 'UNKNOWN', 0]
  ];
  for (const [check, expectedStatus, expectedCandidates] of cases) {
    const fixture = readyFixture();
    fixture.artifactChecks['generation-ready'] = check;
    const snapshot = projectCanonicalAccounting(fixture);
    assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
    assert.equal(snapshot.entries[0].artifactVerification.status, expectedStatus);
    assert.equal(snapshot.candidates.length, expectedCandidates);
  }
});

test('a rejected accepted result does not resurrect an older good revision', () => {
  const older = readyFixture();
  older.model.latestReadyGenerationId = 'generation-rejected';
  older.model.currentGenerationId = 'generation-rejected';
  older.revisions.unshift({ ...older.revision, generationId: 'generation-rejected', reviewStatus: 'rejected',
    facts: factsFor({ ...older.revision, generationId: 'generation-rejected' }) });
  older.artifactChecks['generation-rejected'] = { exists: true, hashMatches: true, outputHash: HASH, path: older.revisions[0].outputPath };
  const snapshot = projectCanonicalAccounting(older);
  assert.equal(snapshot.entries[0].status, 'NOT_READY');
  assert.equal(snapshot.entries[0].acceptedGenerationId, null);
  assert.equal(snapshot.entries[0].replacementRequired, true);
  assert.deepEqual(snapshot.candidates.map((item) => item.task), ['generate']);
});

test('identity-quarantined catalog, variant, and revision records require manual review and block candidates', () => {
  for (const quarantineLocation of ['model', 'variant', 'revision']) {
    const fixture = readyFixture();
    const quarantine = { reason: 'ambiguous_identity', quarantineId: 'q-1', evidence: ['conflicting model code'] };
    if (quarantineLocation === 'model') fixture.model.identityQuarantined = quarantine;
    if (quarantineLocation === 'variant') fixture.model.variants[0].identityQuarantined = quarantine;
    if (quarantineLocation === 'revision') fixture.revision.identityQuarantined = quarantine;
    const snapshot = projectCanonicalAccounting(fixture);
    assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION', quarantineLocation);
    assert.equal(snapshot.entries[0].statusReason, 'identity_quarantined');
    assert.equal(snapshot.entries[0].identityQuarantined, true);
    assert.equal(snapshot.entries[0].revisionCount, 1);
    assert.equal(snapshot.quarantinedCount, 1);
    assert.deepEqual(snapshot.candidates, []);
  }
});

test('facts must bind the exact generation, facts job and output hash', () => {
  const fixture = readyFixture({ revision: { facts: factsFor({ generationId: 'generation-ready', factsJobId: 'facts-ready', outputHash: HASH }, { factsJobId: 'stale-job' }) } });
  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].status, 'NEEDS_FACTS');
  assert.equal(snapshot.candidates[0].task, 'facts');
});

test('legacy first-token collisions become AMBIGUOUS and cannot be silently counted ready', () => {
  assert.equal(modelCodeEvidence('Casio CASIOTRON 50th TRN-50SS-2A'), 'TRN50SS2A');
  assert.equal(modelCodeEvidence('Casio CASIOTRON 50th TRN-50ZE-1A'), 'TRN50ZE1A');
  const fixture = readyFixture({ model: { skuKey: 'casio:50TH', sourceId: 'casio:50TH', modelName: 'Casio CASIOTRON 50th TRN-50SS-2A' } });
  fixture.revisions[0].sourceId = 'casio:50TH';
  fixture.revisions[0].modelName = 'Casio CASIOTRON 50th TRN-50SS-2A';
  fixture.model.variants[0].modelName = fixture.revisions[0].modelName;
  fixture.revisions.push({ ...fixture.revisions[0], generationId: 'generation-other',
    modelName: 'Casio CASIOTRON 50th TRN-50ZE-1A' });
  fixture.artifactChecks['generation-other'] = { exists: true, hashMatches: true, outputHash: HASH, path: fixture.revisions.at(-1).outputPath };
  const snapshot = projectCanonicalAccounting(fixture);
  assert.equal(snapshot.entries[0].identityStatus, 'AMBIGUOUS');
  assert.equal(snapshot.entries[0].status, 'NEEDS_VERIFICATION');
  assert.equal(snapshot.entries[0].acceptedGenerationId, 'generation-ready', 'keep exact pointer visible for repair');
  assert.equal(snapshot.candidateCounts.verify, 0, 'collision requires explicit identity review');
});

test('dotted watch references retain numeric suffix segments', () => {
  assert.equal(modelCodeEvidence('Tissot T006.207.11.058.00.png'), 'T0062071105800');
});

test('scope and absent source rows share one readiness projection while only present rows are plannable', () => {
  const first = readyFixture();
  const second = readyFixture({ model: { skuKey: 'casio:other', sourceId: 'casio:other',
    modelName: 'Casio Collection AEQ-120W-7A', sourcePresent: false,
    variants: [{ sourceVariantId: 'variant-2', groupId: 'not_in_sale_bad' }] } });
  second.revisions[0] = { ...second.revision, sourceId: 'casio:other', generationId: 'other-ready',
    modelName: 'Casio Collection AEQ-120W-7A', facts: null };
  second.revisions[0].facts = factsFor(second.revisions[0]);
  second.model.latestReadyGenerationId = 'other-ready';
  second.model.currentGenerationId = 'other-ready';
  second.artifactChecks = { 'other-ready': { exists: true, hashMatches: true, outputHash: HASH, path: second.revisions[0].outputPath } };
  const snapshot = projectCanonicalAccounting({ catalog: [...first.catalog, ...second.catalog],
    revisions: [...first.revisions, ...second.revisions], artifactChecks: { ...first.artifactChecks, ...second.artifactChecks },
    scope: { quality: 'good' } });
  assert.equal(snapshot.counts.total, 1, 'the requested scope filters the same rows before counting');
  assert.equal(snapshot.eligibleCounts.total, 1);
  assert.equal(snapshot.counts.ready, 1);
  assert.equal(snapshot.candidates.length, 0);
});

test('sale and quality filters must match the same group rather than different variant groups', () => {
  const mixed = readyFixture();
  mixed.model.variants = [
    { sourceVariantId: 'bad-in-sale', groupId: 'in_sale_bad' },
    { sourceVariantId: 'good-not-sale', groupId: 'not_in_sale_good' }
  ];
  const mixedSnapshot = projectCanonicalAccounting({ ...mixed,
    scope: { saleStatus: 'in_sale', quality: 'good' } });
  assert.equal(mixedSnapshot.entries.length, 0);

  for (const [groupId, saleStatus, quality] of [
    ['in_sale_good', 'in_sale', 'good'],
    ['not_in_sale_bad', 'not_in_sale', 'bad']
  ]) {
    const fixture = readyFixture();
    fixture.model.variants = [{ sourceVariantId: 'variant-1', groupId }];
    const snapshot = projectCanonicalAccounting({ ...fixture, scope: { saleStatus, quality } });
    assert.equal(snapshot.entries.length, 1, `${groupId} is a valid combined match`);
  }
});
