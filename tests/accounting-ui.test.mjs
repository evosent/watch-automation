import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

import {
  acceptAccountingSnapshot,
  accountingAttemptIsActive,
  accountingSnapshotFromResponse,
  accountingSnapshotFreshness,
  accountingUiRecord,
  canonicalAccountingIndex
} from '../extension/accounting-ui-utils.js';
import { galleryRecordsFromCatalog } from '../extension/gallery-revision-utils.js';
import { buildPlaylistProgressTree } from '../extension/playlist-ui-utils.js';
import { QUEUE_GROUP_IDS } from '../extension/queue-utils.js';

const sidepanelSource = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function readyRevision(skuKey, generationId) {
  const outputHash = 'a'.repeat(64);
  const factsJobId = `facts-${generationId}`;
  return {
    sourceId: skuKey,
    generationId,
    status: 'READY',
    factsStatus: 'ok',
    factsJobId,
    outputPath: `in_sale_good/${generationId}.png`,
    outputHash,
    completedAt: '2026-10-06T10:00:00.000Z',
    facts: { status: 'ok', generationId, factsJobId, outputHash }
  };
}

function canonicalEntry(skuKey, status, options = {}) {
  const acceptedRevision = options.revision ? readyRevision(skuKey, options.revision) : null;
  return {
    skuKey,
    identityStatus: options.identityStatus || 'OK',
    identityQuarantined: options.identityQuarantined === true,
    status,
    model: { skuKey, modelName: `Casio ${skuKey}`, sourcePresent: options.sourcePresent !== false,
      variants: [{ groupId: 'in_sale_good' }] },
    acceptedGenerationId: acceptedRevision?.generationId || null,
    acceptedRevision,
    revisionCount: options.revisionCount || 1,
    artifactVerification: options.artifactVerification || { status: acceptedRevision ? 'VERIFIED' : 'UNKNOWN', verified: Boolean(acceptedRevision), exists: Boolean(acceptedRevision), hashMatches: Boolean(acceptedRevision) },
    activeAttempt: options.activeAttempt || null,
    replacementRequired: false,
    nextTask: status === 'NEEDS_FACTS' ? 'facts' : status === 'NOT_READY' ? 'generate' : null
  };
}

function queueGroups(entries) {
  const groups = Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []]));
  for (const entry of entries) {
    groups.in_sale_good.push({ sourceId: entry.skuKey, skuKey: entry.skuKey,
      modelName: entry.model.modelName, groupId: 'in_sale_good', status: 'pending' });
  }
  return groups;
}

function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children || [])]);
}

function launchableEntries({ entries, accountingSnapshot, mode = 'regular', repairs = [] }) {
  const start = sidepanelSource.indexOf('function launchQueueEntries(');
  const end = sidepanelSource.indexOf('function resetRunPartSelection', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = createContext({
    accountingSnapshot,
    accountingAttemptIsActive,
    canonicalAccountingIndex,
    queueEntriesForPart: () => entries,
    $: () => ({ value: '1' }),
    repairQueueSourceIds: () => new Set(repairs),
    launchQueueMode: () => mode,
    REGENERATION_QUEUE_ID: 'regeneration'
  });
  runInContext(sidepanelSource.slice(start, end), context);
  return context.launchQueueEntries({ parts: [] });
}

test('queue part counts use canonical readiness; active attempts stay secondary to accepted READY', () => {
  const entries = [
    canonicalEntry('casio:ready', 'READY', { revision: 'ready-1', activeAttempt: { status: 'RUNNING', active: true } }),
    canonicalEntry('casio:facts', 'NEEDS_FACTS', { activeAttempt: { status: 'FACTS_PENDING', active: false } }),
    canonicalEntry('casio:pending', 'NOT_READY'),
    canonicalEntry('casio:verify', 'NEEDS_VERIFICATION'),
    canonicalEntry('casio:ambiguous', 'NEEDS_VERIFICATION', { identityStatus: 'AMBIGUOUS' })
  ];
  const conflictingMemory = { items: Object.fromEntries(entries.map((entry) => [entry.skuKey, { status: 'ready' }])) };
  const tree = buildPlaylistProgressTree(queueGroups(entries), [], conflictingMemory, {
    version: 1, revision: 7, scopeKey: 'present', reconciliationComplete: true, entries
  });
  const regularNodes = flatten([tree.find((node) => node.mode === 'regular')]);
  for (const node of regularNodes) {
    assert.equal(node.total, 5);
    assert.equal(node.done, 1);
    assert.equal(node.factsPending, 1);
    assert.equal(node.needsVerification, 2);
    assert.equal(node.identityAmbiguous, 1);
    assert.equal(node.notReady, 1);
    assert.equal(node.running, 1);
    assert.equal(node.percent, 20);
  }
});

test('queue root deduplicates one SKU across variants and groups while child counts stay scoped', () => {
  const skuKey = 'casio:shared-sku';
  const groups = Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []]));
  groups.in_sale_good.push({ skuKey, sourceId: skuKey, sourceVariantId: 'variant-good',
    modelName: 'Casio Shared', groupId: 'in_sale_good', status: 'pending' });
  groups.not_in_sale_bad.push({ skuKey, sourceId: skuKey, sourceVariantId: 'variant-bad',
    modelName: 'Casio Shared', groupId: 'not_in_sale_bad', status: 'pending' });
  const snapshot = { version: 1, reconciliationComplete: true,
    eligibleCounts: { total: 1, ready: 1, needsFacts: 0, needsVerification: 0, notReady: 0 },
    entries: [canonicalEntry(skuKey, 'READY', { revision: 'accepted' })] };
  const tree = buildPlaylistProgressTree(groups, [], {}, snapshot);
  const root = tree.find((node) => node.mode === 'regular');
  assert.deepEqual([root.total, root.done], [1, 1]);
  const inSale = root.children.find((node) => node.saleStatus === 'in_sale');
  const notInSale = root.children.find((node) => node.saleStatus === 'not_in_sale');
  assert.deepEqual([inSale.total, inSale.done], [1, 1]);
  assert.deepEqual([notInSale.total, notInSale.done], [1, 1]);
});

test('canonical READY remains complete in repair membership while repair stays an independent queue scope', () => {
  const accepted = canonicalEntry('casio:accepted', 'READY', { revision: 'accepted-1' });
  const snapshot = { version: 1, revision: 8, scopeKey: 'present', reconciliationComplete: true, entries: [accepted] };
  const gallery = galleryRecordsFromCatalog([accepted.model], [accepted.acceptedRevision], snapshot);
  const tree = buildPlaylistProgressTree(queueGroups([accepted]), [
    { sourceId: accepted.skuKey, status: 'pending', reason: 'manual_replacement' }
  ], {}, snapshot);

  assert.equal(gallery.length, 1);
  const regularPart = flatten([tree.find((node) => node.mode === 'regular')])
    .find((node) => node.type === 'part');
  const repairPart = flatten([tree.find((node) => node.mode === 'regeneration')])
    .find((node) => node.type === 'part');
  assert.equal(regularPart.done, gallery.length);
  assert.equal(repairPart.done, gallery.length);
});

test('launch preview uses canonical tasks, including facts despite legacy done, and skips accepted READY', () => {
  const entries = [];
  const canonical = [];
  const candidates = [];
  for (let index = 0; index < 100; index += 1) {
    const skuKey = `casio:launch-${index}`;
    const status = index < 66 ? 'READY' : index < 71 ? 'NEEDS_FACTS' : 'NOT_READY';
    const model = canonicalEntry(skuKey, status, status === 'READY' || status === 'NEEDS_FACTS'
      ? { revision: `generation-${index}` }
      : {});
    canonical.push(model);
    entries.push({ sourceId: skuKey, skuKey, status: index < 66 ? 'pending' : index < 71 ? 'done' : 'pending' });
    if (status === 'NEEDS_FACTS') candidates.push({ skuKey, task: 'facts' });
    if (status === 'NOT_READY') candidates.push({ skuKey, task: 'generate' });
  }
  const selected = launchableEntries({ entries, accountingSnapshot: {
    version: 1, revision: 12, scopeKey: 'all', stale: false, reconciliationComplete: true,
    entries: canonical, candidates
  } });

  assert.equal(selected.length, 34);
  assert.equal(selected.filter((entry) => Number(entry.sourceId.split('-').at(-1)) >= 66 && Number(entry.sourceId.split('-').at(-1)) < 71).length, 5);
  assert.equal(selected.some((entry) => Number(entry.sourceId.split('-').at(-1)) < 66), false);
});

test('launch preview fails closed until reconciliation and regeneration still requires canonical identity', () => {
  const entries = ['casio:valid-repair', 'casio:ambiguous-repair', 'casio:quarantined-repair', 'casio:active-repair'].map((skuKey) => ({
    skuKey, sourceId: skuKey, status: 'done'
  }));
  const canonical = [
    canonicalEntry('casio:valid-repair', 'NEEDS_VERIFICATION'),
    canonicalEntry('casio:ambiguous-repair', 'NEEDS_VERIFICATION', { identityStatus: 'AMBIGUOUS' }),
    canonicalEntry('casio:quarantined-repair', 'NEEDS_VERIFICATION', { identityQuarantined: true }),
    canonicalEntry('casio:active-repair', 'NOT_READY', { activeAttempt: { status: 'RUNNING', active: true } })
  ];
  const repairs = entries.map((entry) => entry.sourceId);
  const accountingSnapshot = {
    version: 1, revision: 13, scopeKey: 'all', stale: false, reconciliationComplete: true,
    entries: canonical, candidates: []
  };

  assert.deepEqual(launchableEntries({ entries, accountingSnapshot, mode: 'regeneration', repairs })
    .map((entry) => entry.sourceId), ['casio:valid-repair']);
  assert.equal(launchableEntries({ entries, accountingSnapshot: { ...accountingSnapshot, reconciliationComplete: false } }).length, 0);
  assert.equal(launchableEntries({ entries, accountingSnapshot: { ...accountingSnapshot, stale: true } }).length, 0);
});

test('a stale async accounting response cannot replace newer counts, and outage marks retained data stale', () => {
  const current = { version: 1, revision: 9, scopeKey: 'present', generatedAt: '2026-10-06T10:02:00Z', entries: [{ skuKey: 'new' }] };
  const delayed = { version: 1, revision: 8, scopeKey: 'present', generatedAt: '2026-10-06T10:01:00Z', entries: [{ skuKey: 'old' }] };
  assert.equal(acceptAccountingSnapshot(current, delayed), current);

  const outage = { version: 1, revision: 9, scopeKey: 'present', generatedAt: current.generatedAt,
    stale: true, staleReason: 'проверка файла недоступна', entries: [] };
  const retained = acceptAccountingSnapshot(current, outage);
  assert.deepEqual(retained.entries, current.entries);
  assert.equal(retained.revision, current.revision);
  assert.equal(retained.stale, true);
  assert.match(accountingSnapshotFreshness(retained).label, /требуют повторной проверки/);

  assert.equal(accountingSnapshotFromResponse({ ok: true, value: current }), current);
  assert.equal(accountingSnapshotFromResponse({ ok: false, error: 'offline' }), null);
});

test('an older stale snapshot cannot mark a newer confirmed revision stale', () => {
  const fresh = { version: 1, revision: 10, scopeKey: 'all', generatedAt: '2026-10-06T10:10:00Z',
    stale: false, entries: [{ skuKey: 'newest' }] };
  const lateOutage = { version: 1, revision: 9, scopeKey: 'all', generatedAt: '2026-10-06T10:09:00Z',
    stale: true, staleReason: 'late timeout', entries: [{ skuKey: 'older' }] };
  const accepted = acceptAccountingSnapshot(fresh, lateOutage);
  assert.equal(accepted.stale, false);
  assert.equal(accepted.revision, 10);
  assert.deepEqual(accepted.entries, fresh.entries);
});

test('a newer outage revision advances freshness while retaining the last confirmed counts', () => {
  const fresh = { version: 1, revision: 10, snapshotSequence: 10, scopeKey: 'all',
    generatedAt: '2026-10-06T10:10:00Z', stale: false, entries: [{ skuKey: 'confirmed' }],
    counts: { total: 1, ready: 1 } };
  const outage = { version: 1, revision: 11, snapshotSequence: 11, scopeKey: 'all',
    generatedAt: '2026-10-06T10:11:00Z', stale: true, staleReason: 'verifier timeout',
    entries: [], counts: { total: 0, ready: 0 } };
  const retained = acceptAccountingSnapshot(fresh, outage);
  assert.equal(retained.revision, 11);
  assert.equal(retained.snapshotSequence, 11);
  assert.equal(retained.stale, true);
  assert.deepEqual(retained.entries, fresh.entries);
  assert.deepEqual(retained.counts, fresh.counts);
});

test('legacy catalog reconciliation is visible as a blocked accounting state', () => {
  const freshness = accountingSnapshotFreshness({
    version: 1, revision: 1, reconciliationComplete: false,
    reconciliationState: 'legacy_catalog_missing'
  });
  assert.equal(freshness.state, 'blocked');
  assert.match(freshness.label, /запуск заблокирован/);
});

test('canonical gallery displays verified accepted revisions only and labels records outside current catalog', () => {
  const current = canonicalEntry('casio:current', 'READY', { revision: 'gen-current', revisionCount: 3 });
  const removed = canonicalEntry('casio:removed', 'READY', { revision: 'gen-removed', sourcePresent: false });
  const needsFacts = canonicalEntry('casio:facts', 'NEEDS_FACTS', { revision: 'gen-facts' });
  const unverified = canonicalEntry('casio:unknown', 'NEEDS_VERIFICATION', { revision: 'gen-unknown',
    artifactVerification: { status: 'UNKNOWN', verified: false } });
  const ambiguous = canonicalEntry('casio:ambiguous', 'READY', { revision: 'gen-ambiguous', identityStatus: 'AMBIGUOUS' });
  const records = galleryRecordsFromCatalog([], [current, removed, needsFacts, unverified, ambiguous]
    .map((entry) => entry.acceptedRevision).filter(Boolean), {
    version: 1, revision: 3, scopeKey: 'all', reconciliationComplete: true,
    entries: [current, removed, needsFacts, unverified, ambiguous]
  });
  assert.deepEqual(records.map((record) => record.skuKey).sort(), ['casio:current', 'casio:removed']);
  assert.equal(records.find((record) => record.skuKey === 'casio:current').versionCount, 3);
  assert.equal(records.find((record) => record.skuKey === 'casio:removed').outsideCurrentCatalog, true);
  const migrationPending = {
    version: 1, revision: 2, scopeKey: 'all', reconciliationComplete: false,
    reconciliationState: 'legacy_run_migration_pending', entries: [current]
  };
  assert.equal(galleryRecordsFromCatalog([], [current.acceptedRevision], migrationPending).length, 1,
    'an already verified accepted result remains visible while legacy reconciliation is pending');
  assert.equal(accountingSnapshotFreshness(migrationPending).state, 'blocked',
    'the same incomplete snapshot still blocks starting new tasks');

  const pendingGeneration = canonicalEntry('casio:ready-with-retry', 'READY', {
    revision: 'old-ready', activeAttempt: { status: 'GENERATING', active: true }
  });
  assert.equal(galleryRecordsFromCatalog([], [pendingGeneration.acceptedRevision], {
    version: 1, revision: 4, scopeKey: 'present', reconciliationComplete: true, entries: [pendingGeneration]
  }).length, 1);
  assert.equal(accountingAttemptIsActive({ status: 'FACTS_PENDING', active: false }), false);
});

test('sidepanel and gallery read the shared snapshot and startup does not auto-rekey ambiguous legacy revisions', async () => {
  const [sidepanel, gallery, galleryHtml] = await Promise.all([
    readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/gallery.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/gallery.html', import.meta.url), 'utf8')
  ]);
  assert.match(sidepanel, /GET_ACCOUNTING_SNAPSHOT/);
  assert.match(sidepanel, /buildPlaylistProgressTree\(queue\.groups, queue\.repairQueue, generationMemory, accountingSnapshot\)/);
  assert.match(sidepanel, /acceptAccountingSnapshot\(accountingSnapshot, incoming\)/);
  assert.match(gallery, /GET_ACCOUNTING_SNAPSHOT/);
  assert.match(gallery, /galleryRecordsFromCatalog\(catalog, currentRevisionRecords, accountingView\)/);
  assert.doesNotMatch(sidepanel, /adoptLegacyGenerationRevisions/);
  assert.doesNotMatch(sidepanel, /const aliases = \{\}/);
  assert.doesNotMatch(sidepanel, /hydrateGenerationMemoryFromQueue/);
  assert.doesNotMatch(sidepanel, /generationMemoryRecordFromEntry/);
  assert.match(sidepanel, /В выбранном списке готово по сверке/);
  assert.doesNotMatch(sidepanel, /appliedEntries\.filter\(\(entry\) => entry\.status === 'done'\)/);
  const playlistUi = await readFile(new URL('../extension/playlist-ui-utils.js', import.meta.url), 'utf8');
  assert.doesNotMatch(playlistUi, /generationMemoryRecordFromEntry/);
  assert.match(sidepanel, /modelCatalogRecordsFromGroups\(stored\.queue\.groups\)/);
  assert.doesNotMatch(gallery, /adoptLegacyGenerationRevisions/);
  assert.match(galleryHtml, /id="catalogCountHint"/);
  assert.match(gallery, /в текущем каталоге · \$\{outsideCatalogCount\} вне каталога/);
});

test('sidepanel result rows retain accepted readiness while exposing the separate active attempt', () => {
  const model = { skuKey: 'casio:watch', modelName: 'Casio Watch' };
  const acceptedRevision = readyRevision(model.skuKey, 'accepted');
  const record = accountingUiRecord({ ...model, groupId: 'in_sale_good' }, {
    skuKey: model.skuKey,
    identityStatus: 'OK',
    status: 'READY',
    model,
    acceptedRevision,
    activeAttempt: { status: 'RUNNING', active: true },
    artifactVerification: { status: 'VERIFIED', verified: true }
  });
  assert.equal(record.status, 'ready');
  assert.equal(record.generationId, 'accepted');
  assert.equal(record.accountingAttemptActive, true);
});

test('accepted READY rows do not inherit an inactive attempt error as their current error', () => {
  const model = { skuKey: 'casio:watch', modelName: 'Casio Watch' };
  const acceptedRevision = readyRevision(model.skuKey, 'accepted');
  const record = accountingUiRecord({ ...model, groupId: 'in_sale_good' }, {
    skuKey: model.skuKey,
    identityStatus: 'OK',
    status: 'READY',
    model,
    acceptedRevision,
    activeAttempt: { status: 'ERROR', active: false, lastError: 'old DOM timeout' },
    artifactVerification: { status: 'VERIFIED', verified: true }
  }, { lastError: 'older tab lost' });
  assert.equal(record.status, 'ready');
  assert.equal(record.lastError, null);
  assert.equal(record.historicalAttemptError, 'old DOM timeout');
});
