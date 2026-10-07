import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function productionFunction(name) {
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
  assert.ok(declaration, `production function ${name} exists`);
  const following = /^(?:async )?function \w+\(/m.exec(worker.slice(declaration.index + declaration[0].length));
  const end = following ? declaration.index + declaration[0].length + following.index : worker.length;
  return worker.slice(declaration.index, end);
}

function harness({ run = null, records, plan, verification, projection } = {}) {
  const clock = { now: 2_000_000 };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const stored = {
    run: clone(run),
    sessionRestartIntent: null,
    queue: { groups: { in_sale_good: ['legacy-entry'] } },
    accountingSnapshot: null
  };
  const calls = { getRecords: 0, buildPlan: 0, apply: 0, set: [], verify: 0 };
  const storage = {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in stored).map((key) => [key, clone(stored[key])]));
    },
    async set(patch) {
      calls.set.push(clone(patch));
      Object.assign(stored, clone(patch));
    }
  };
  const context = vm.createContext({
    Date: TestDate,
    chrome: { storage: { local: storage } },
    structuredClone,
    console,
    stableHash: (value) => JSON.stringify(value),
    withStateLock: (task) => task(),
    hasLiveSlotWork: (run) => Object.values(run?.slots || {}).some((slot) => slot?.entryId && slot?.generationId),
    FACTS_EXTRACTOR_VERSION: 'test-extractor-v1',
    getAccountingRecords: async () => { calls.getRecords++; return clone(records); },
    buildIdentityMigrationPlan: () => { calls.buildPlan++; return clone(plan); },
    applyExplicitIdentityMigration: async (...args) => { calls.apply++; return { movedRevisions: 0, ...args }; },
    persistGenerationImageRevision: async () => { throw new Error('strict persistence stub must be configured by the test'); },
    getAllModelCatalog: async () => clone(records?.catalog || []),
    queueGroupsFromCatalog: () => ({ in_sale_good: ['catalog-entry'] }),
    accountingRevisionArtifacts: () => [],
    verifyCanonicalArtifacts: async () => { calls.verify++; return clone(verification); },
    recordExistingVerifiedRevisions: async () => {},
    projectCanonicalAccounting: () => clone(projection)
  });
  vm.runInContext(`let accountingIdentityMigrationInFlight = null;
    let accountingIdentityMigrationCheckedAt = 0;
    let accountingIdentityMigrationLastOutcome = { checked: false, pending: true, reason: 'not_checked' };
    let accountingSnapshotCache = null;
    let accountingSnapshotInFlight = null;
    let accountingSnapshotCheckedAt = 0;`, context);
  for (const name of [
    'runHasActiveAutomationWork',
    'isIdentityMigrationSafeWhileIdle',
    'canonicalSnapshotEntriesFromProjection',
    'ensureCanonicalIdentityMigration',
    'accountingRevisionArtifacts',
    'verifiedJournalProofForRevision',
    'recoverFileVerifiedAccountingArtifacts',
    'refreshCanonicalAccountingSnapshot'
  ]) {
    vm.runInContext(productionFunction(name), context, { filename: `service-worker.${name}.js` });
  }
  return { context, stored, calls, clock };
}

const emptyRecords = { catalog: [{ skuKey: 'casio:A168', sourceId: 'casio:A168' }], revisions: [], facts: [], outputRecovery: [] };
const noMigration = { version: 1, revisionMoves: [], catalogAssignments: [], quarantined: [] };

test('identity migration remains pending for every active or paused run shape', async () => {
  const activeRuns = [
    { state: 'RUNNING', slots: {} },
    { state: 'STARTING', slots: {} },
    { state: 'DRAINING', slots: {} },
    { state: 'PAUSED', rateLimitPauseUntil: 2_100_000, slots: {} },
    { state: 'PAUSED', slots: { 1: { entryId: 'casio:A168', tabId: 7 } } },
    { state: 'STOPPED', slots: { 1: { entryId: 'casio:A168', leaseId: 'lease' } } }
  ];

  for (const run of activeRuns) {
    const h = harness({ run, records: emptyRecords, plan: noMigration });
    const result = await h.context.ensureCanonicalIdentityMigration();
    assert.equal(result.pending, true, `state ${run.state} must defer migration`);
    assert.equal(result.reason, 'active_run');
    assert.equal(h.calls.getRecords, 0, 'deferred migration must not read or rewrite accounting stores');
    assert.equal(h.calls.apply, 0);
    assert.equal(h.calls.set.length, 0, 'deferral must not mutate queue or progress storage');
  }
});

test('completed slots with only historical lease ids do not keep identity migration blocked', async () => {
  const completedRun = {
    state: 'DONE',
    postprocessTabs: {},
    recoveryTabs: {},
    slots: Object.fromEntries(Array.from({ length: 6 }, (_, slotId) => [slotId, {
      phase: 'DONE', status: 'DONE', leaseId: `old-lease-${slotId}`, entryId: null, tabId: null
    }]))
  };
  const h = harness({ run: completedRun, records: emptyRecords, plan: noMigration });

  assert.equal(h.context.isIdentityMigrationSafeWhileIdle(completedRun, null), true);
  const result = await h.context.ensureCanonicalIdentityMigration();
  assert.equal(result.pending, false);
  assert.equal(h.calls.getRecords, 1, 'terminal lease history must allow catalog reconciliation to run');
  assert.equal(h.calls.apply, 0, 'an already canonical catalog remains unchanged');

  const liveLease = { state: 'DONE', slots: { 0: { phase: 'VERIFYING_FILE', leaseId: 'still-live' } } };
  assert.equal(h.context.isIdentityMigrationSafeWhileIdle(liveLease, null), false,
    'a lease attached to a nonterminal slot remains a safety barrier');
  const liveTab = { state: 'DONE', slots: { 0: { phase: 'DONE', tabId: 17 } } };
  assert.equal(h.context.isIdentityMigrationSafeWhileIdle(liveTab, null), false,
    'an owned tab reference remains a safety barrier even after the lease is terminal');
});

test('pending result remains pending in cache and is re-evaluated after its short TTL', async () => {
  const migrationPlan = {
    version: 1,
    revisionMoves: [],
    catalogAssignments: [{ fromSourceId: 'casio:OLD', toSourceId: 'casio:NEW', variantKeys: ['variant-1'] }],
    quarantined: []
  };
  const h = harness({
    run: { state: 'RUNNING', slots: {} }, records: emptyRecords, plan: migrationPlan
  });

  const deferred = await h.context.ensureCanonicalIdentityMigration();
  assert.equal(deferred.pending, true);
  h.stored.run = { state: 'DONE', slots: {}, postprocessTabs: {}, recoveryTabs: {} };
  h.clock.now += 1_000;

  const cached = await h.context.ensureCanonicalIdentityMigration();
  assert.equal(cached.pending, true, 'a pending cache entry must not be reported as a completed check');
  assert.equal(cached.cached, true);
  assert.equal(h.calls.apply, 0);

  h.clock.now += 5_001;

  const resumed = await h.context.ensureCanonicalIdentityMigration();
  assert.equal(resumed.applied, true, 'migration must resume after the short active-run cache expires');
  assert.equal(h.calls.apply, 1);
  assert.equal(h.calls.buildPlan, 1);
});

test('migration rechecks run state after waiting behind the shared state lock', async () => {
  const h = harness({ records: emptyRecords, plan: {
    version: 1, revisionMoves: [],
    catalogAssignments: [{ fromSourceId: 'casio:OLD', toSourceId: 'casio:NEW', variantKeys: ['variant-1'] }],
    quarantined: []
  } });
  let releaseLock;
  const lockGate = new Promise((resolve) => { releaseLock = resolve; });
  let stateChain = Promise.resolve();
  h.context.withStateLock = (task) => {
    const next = stateChain.then(task);
    stateChain = next.catch(() => {});
    return next;
  };

  const held = h.context.withStateLock(() => lockGate);
  const migration = h.context.ensureCanonicalIdentityMigration({ force: true });
  h.stored.run = { state: 'RUNNING', slots: { 0: { entryId: 'casio:A168', tabId: 3 } } };
  releaseLock();
  await held;

  const result = await migration;
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'active_run');
  assert.equal(h.calls.getRecords, 0);
  assert.equal(h.calls.apply, 0);
});

test('concurrent canonical snapshot requests share one migration check', async () => {
  let releaseRecords;
  const recordsPromise = new Promise((resolve) => { releaseRecords = resolve; });
  const h = harness({ records: emptyRecords, plan: noMigration });
  h.context.getAccountingRecords = async () => {
    h.calls.getRecords++;
    return recordsPromise;
  };

  const first = h.context.ensureCanonicalIdentityMigration({ force: true });
  const second = h.context.ensureCanonicalIdentityMigration({ force: true });
  await Promise.resolve();
  releaseRecords(clone(emptyRecords));
  const [a, b] = await Promise.all([first, second]);

  assert.equal(h.calls.getRecords, 1);
  assert.deepEqual(a, b);
  assert.equal(h.calls.apply, 0);
});

test('semantic snapshot refreshes do not persist timestamp-only changes', async () => {
  const projection = {
    entries: [{ skuKey: 'casio:A168', brandId: 'casio', model: { variants: [] }, status: 'READY' }],
    counts: { ready: 1 }, eligibleCounts: { ready: 1 }, quarantinedCount: 0,
    quarantinedEntries: [], candidates: [], candidateCounts: { total: 0 }
  };
  const h = harness({
    records: emptyRecords,
    plan: noMigration,
    verification: { checks: {}, verificationAvailable: true },
    projection
  });
  const first = await h.context.refreshCanonicalAccountingSnapshot({ force: true });
  assert.equal(h.calls.set.length, 1, 'initial canonical snapshot should be persisted');
  assert.equal(first.revision, 1);

  h.clock.now += 5_000;
  const refreshed = await h.context.refreshCanonicalAccountingSnapshot({ force: true });
  assert.equal(refreshed.generatedAt, new Date(h.clock.now).toISOString());
  assert.equal(refreshed.revision, first.revision, 'timestamp-only refresh must preserve semantic revision');
  assert.equal(h.calls.set.length, 1, 'timestamp-only refresh must not rewrite the stored snapshot');
  assert.equal(h.stored.accountingSnapshot.generatedAt, first.generatedAt);
});

test('forced snapshot arriving during an older read refreshes after the in-flight projection', async () => {
  const projectionFor = (records) => {
    const ready = (records.revisions || []).some((revision) => revision.status === 'READY');
    return {
      entries: [{ skuKey: 'casio:A168', brandId: 'casio', model: { variants: [] },
        status: ready ? 'READY' : 'NOT_READY' }],
      counts: { ready: ready ? 1 : 0 }, eligibleCounts: { ready: ready ? 1 : 0 },
      quarantinedCount: 0, quarantinedEntries: [], candidates: [], candidateCounts: { total: 0 }
    };
  };
  const oldRecords = { ...clone(emptyRecords), revisions: [{ generationId: 'g-1', status: 'SUBMITTED' }] };
  const newRecords = { ...clone(emptyRecords), revisions: [{ generationId: 'g-1', status: 'READY' }] };
  const h = harness({ records: oldRecords, plan: noMigration,
    verification: { checks: {}, verificationAvailable: true } });
  h.context.projectCanonicalAccounting = projectionFor;
  await h.context.ensureCanonicalIdentityMigration({ force: true });

  let releaseOldRead;
  const oldRead = new Promise((resolve) => { releaseOldRead = resolve; });
  let snapshotReads = 0;
  h.context.getAccountingRecords = async () => {
    h.calls.getRecords++;
    snapshotReads++;
    if (snapshotReads === 1) return oldRead;
    return clone(newRecords);
  };
  const firstPromise = h.context.refreshCanonicalAccountingSnapshot();
  await Promise.resolve();
  const secondPromise = h.context.refreshCanonicalAccountingSnapshot({ force: true });
  releaseOldRead(clone(oldRecords));

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.entries[0].status, 'NOT_READY', 'the first request uses its original snapshot read');
  assert.equal(second.entries[0].status, 'READY', 'the forced request must observe the newer accepted revision');
  assert.ok(snapshotReads >= 2, 'the forced request must perform a post-flight canonical read');
});

test('file-verified recovery rechecks the artifact, registers before projection, and replays idempotently', async () => {
  const sourceId = 'casio:A168';
  const generationId = 'recovered-generation';
  const outputPath = 'D:/Downloads/WatchAutomation/in_sale_good/recovered.png';
  const outputHash = 'a'.repeat(64);
  const model = { skuKey: sourceId, sourceId, brandId: 'casio', modelName: 'Casio A168',
    sourcePresent: true, currentGenerationId: generationId, latestReadyGenerationId: null, variants: [] };
  const journal = { generationId, sourceId, state: 'file_verified', outputPath, outputHash,
    fileVerification: { verified: true, exists: true, isFile: true, generationId, sourceId,
      outputPath, outputHash, sizeBytes: 128, verifiedAt: '2026-10-06T15:00:00.000Z' } };
  const state = { catalog: [clone(model)], revisions: [], facts: [], outputRecovery: [clone(journal)], quarantines: [] };
  const events = [];
  const h = harness({ records: state, plan: noMigration,
    verification: { checks: {}, verificationAvailable: true } });
  h.context.getAccountingRecords = async () => { events.push('read'); return clone(state); };
  h.context.getAllModelCatalog = async () => clone(state.catalog);
  h.context.verifyCanonicalArtifacts = async (revisions) => {
    events.push(`verify:${revisions.map((row) => row.generationId).join(',')}`);
    const checks = Object.fromEntries(revisions.map((revision) => [String(revision.generationId), {
      verified: true, exists: true, valid: true, isFile: true, path: revision.outputPath,
      sha256: revision.outputHash, hashMatches: true, size: 128, checkedAt: '2026-10-06T15:01:00.000Z'
    }]));
    return { checks, verificationAvailable: true };
  };
  h.context.persistGenerationImageRevision = async (record) => {
    events.push('persist');
    const proof = record.fileVerification || {};
    const exactProof = proof.verified === true && proof.exists === true && proof.isFile === true
      && Number.isSafeInteger(Number(proof.sizeBytes)) && Number(proof.sizeBytes) > 0
      && String(proof.generationId) === generationId && String(proof.sourceId) === sourceId
      && String(proof.outputPath).replaceAll('\\', '/') === outputPath
      && String(proof.outputHash).toLowerCase() === outputHash;
    assert.equal(exactProof, true, 'registration stub enforces the exact verified generation/path/hash tuple');
    const currentModel = state.catalog.find((row) => row.sourceId === sourceId);
    const previous = state.revisions.find((row) => row.generationId === generationId);
    if (currentModel?.currentGenerationId !== generationId || previous?.reviewStatus === 'rejected'
      || previous?.identityQuarantined || previous?.supersededBySessionRestartId) {
      return { registered: false, reason: 'current_revision_compare_and_swap_failed' };
    }
    const recovered = { ...record, status: 'FACTS_PENDING', factsStatus: 'pending', fileVerification: clone(proof) };
    state.revisions = [recovered];
    state.outputRecovery = [{ ...journal, state: 'revision_registered',
      revisionRegisteredAt: '2026-10-06T15:01:00.000Z' }];
    return { registered: true, current: true };
  };
  h.context.projectCanonicalAccounting = ({ revisions }) => {
    events.push('project');
    const registered = revisions.some((row) => row.generationId === generationId && row.outputPath === outputPath);
    return {
      entries: [{ skuKey: sourceId, brandId: 'casio', model: clone(model), sourcePresent: true,
        status: registered ? 'NEEDS_FACTS' : 'NOT_READY', statusReason: registered ? 'recovered_image_needs_facts' : 'no_registered_image' }],
      counts: { total: 1, ready: 0, needsFacts: registered ? 1 : 0, notReady: registered ? 0 : 1, needsVerification: 0 },
      eligibleCounts: { total: 1, ready: 0, needsFacts: registered ? 1 : 0, notReady: registered ? 0 : 1, needsVerification: 0 },
      quarantinedCount: 0, quarantinedEntries: [], candidates: [], candidateCounts: { total: registered ? 1 : 0 }
    };
  };

  const first = await h.context.refreshCanonicalAccountingSnapshot({ force: true });
  assert.equal(first.entries[0].status, 'NEEDS_FACTS');
  assert.equal(first.queueSummary.revisionRows, 1);
  assert.deepEqual(events.filter((item) => item.startsWith('verify:') || ['persist', 'project'].includes(item)),
    [`verify:${generationId}`, 'persist', `verify:${generationId}`, 'project'],
    'registration must complete, records must be re-read and the recovered file re-verified before projection');
  assert.equal(h.calls.set.length, 1, 'the resulting canonical snapshot is persisted once');

  events.length = 0;
  const replay = await h.context.refreshCanonicalAccountingSnapshot({ force: true });
  assert.equal(replay.entries[0].status, 'NEEDS_FACTS');
  assert.equal(events.includes('persist'), false, 'revision_registered journal must not register the same generation twice');
  assert.equal(h.calls.set.length, 1, 'idempotent refresh with unchanged semantics must not rewrite the snapshot');
});

test('file-verified recovery fails closed for missing artifacts, rejected revisions, and stale current-generation CAS', async () => {
  const sourceId = 'casio:A168';
  const generationId = 'guarded-generation';
  const outputPath = 'D:/Downloads/WatchAutomation/in_sale_good/guarded.png';
  const outputHash = 'b'.repeat(64);

  async function scenario({ missing = false, rejected = false, staleCurrent = false } = {}) {
    const model = { skuKey: sourceId, sourceId, brandId: 'casio', sourcePresent: true,
      currentGenerationId: staleCurrent ? 'newer-generation' : generationId, latestReadyGenerationId: null, variants: [] };
    const revision = rejected ? { generationId, sourceId, outputPath, outputHash, reviewStatus: 'rejected' } : null;
    const journal = { generationId, sourceId, state: 'file_verified', outputPath, outputHash };
    const state = { catalog: [model], revisions: revision ? [revision] : [], facts: [],
      outputRecovery: [journal], quarantines: [] };
    const h = harness({ records: state, plan: noMigration,
      verification: { checks: {}, verificationAvailable: true } });
    let persistCalls = 0;
    h.context.getAccountingRecords = async () => clone(state);
    h.context.getAllModelCatalog = async () => clone(state.catalog);
    h.context.verifyCanonicalArtifacts = async (revisions) => ({
      checks: Object.fromEntries(revisions.map((item) => [String(item.generationId), missing
        ? { exists: false, verified: true, valid: false, hashMatches: false, path: item.outputPath,
          error: 'file_missing' }
        : { verified: true, exists: true, valid: true, path: item.outputPath,
          sha256: item.outputHash, hashMatches: true, size: 128 }])),
      verificationAvailable: true
    });
    h.context.persistGenerationImageRevision = async (record) => {
      persistCalls++;
      const proof = record.fileVerification || {};
      if (proof.verified !== true || proof.exists !== true || proof.isFile !== true
        || Number(proof.sizeBytes || 0) <= 0 || proof.generationId !== generationId
        || proof.sourceId !== sourceId || proof.outputPath !== outputPath || proof.outputHash !== outputHash) {
        throw new Error('PNG registration requires positive physical existence and exact tuple proof');
      }
      const current = state.catalog.find((item) => item.sourceId === sourceId);
      const existing = state.revisions.find((item) => item.generationId === generationId);
      if (current?.currentGenerationId !== generationId || existing?.reviewStatus === 'rejected') {
        return { registered: false, reason: 'current_revision_compare_and_swap_failed' };
      }
      return { registered: true };
    };
    h.context.projectCanonicalAccounting = ({ revisions }) => ({
      entries: [{ skuKey: sourceId, brandId: 'casio', model, sourcePresent: true,
        status: revisions.some((item) => item.generationId === generationId) ? 'NEEDS_FACTS' : 'NOT_READY' }],
      counts: { total: 1, ready: 0, needsFacts: 0, notReady: 1, needsVerification: 0 },
      eligibleCounts: { total: 1, ready: 0, needsFacts: 0, notReady: 1, needsVerification: 0 },
      quarantinedCount: 0, quarantinedEntries: [], candidates: [], candidateCounts: { total: 0 }
    });
    const snapshot = await h.context.refreshCanonicalAccountingSnapshot({ force: true });
    return { snapshot, persistCalls };
  }

  const missing = await scenario({ missing: true });
  assert.equal(missing.persistCalls, 0, 'a confirmed missing output must never be registered');
  assert.equal(missing.snapshot.entries[0].status, 'NOT_READY');

  const rejected = await scenario({ rejected: true });
  assert.equal(rejected.persistCalls, 0, 'a rejected generation must never be resurrected from its journal');

  const stale = await scenario({ staleCurrent: true });
  assert.equal(stale.persistCalls, 0, 'journal recovery must skip a generation after the catalog advances');
  assert.equal(stale.snapshot.entries[0].status, 'NOT_READY');
});
