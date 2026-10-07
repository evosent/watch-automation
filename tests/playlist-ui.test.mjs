import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildPlaylistProgressTree, findPlaylistPart, playlistPath } from '../extension/playlist-ui-utils.js';
import { buildQueueProgressTree, QUEUE_GROUP_IDS } from '../extension/queue-utils.js';
import * as queueUtils from '../extension/queue-utils.js';
import * as reliability from '../extension/reliability-utils.js';
import * as inputPlan from '../extension/input-plan.js';

function entry(index, { brand = 'Casio', groupId = 'in_sale_good', status = 'pending' } = {}) {
  const sourceId = `sku-${String(index).padStart(4, '0')}`;
  return { sourceId, skuKey: sourceId, modelName: `${brand} Model ${index}`, groupId, status };
}

function groupsFor(entries) {
  return Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, entries.filter((item) => item.groupId === id)]));
}

function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children || [])]);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function memoryFor(entries, statuses) {
  return { items: Object.fromEntries(entries.map((item, i) => [item.sourceId, {
    sourceId: item.sourceId, status: statuses[i], modelName: item.modelName
  }])) };
}

test('playlist readiness distinguishes complete specifications from saved images and pending OCR at every level', () => {
  const entries = [entry(1, { status: 'done' }), entry(2, { status: 'done' }),
    entry(3, { status: 'done' }), entry(4, { status: 'running' }), entry(5)];
  const memory = memoryFor(entries, ['ready', 'image_saved', 'facts_pending', 'running', 'not_ready']);
  const tree = buildPlaylistProgressTree(groupsFor(entries), [], memory);
  const regularNodes = flatten([tree.find((node) => node.mode === 'regular')]);
  assert.deepEqual(regularNodes.map((node) => node.type), ['queue', 'sale', 'quality', 'brand', 'part']);
  for (const node of regularNodes) {
    assert.equal(node.total, 5);
    assert.equal(node.done, 1, `${node.type}: only image plus specification is ready`);
    assert.equal(node.running, 1);
    assert.equal(node.imageSaved, 1);
    assert.equal(node.factsPending, 1);
    assert.equal(node.percent, 20);
  }
});

test('presentation never mutates queue status, memory, repairs, part membership or backend signatures', () => {
  const entries = Array.from({ length: 105 }, (_, i) => entry(i + 1, { status: i < 4 ? 'done' : 'pending' })).reverse();
  const groups = freeze(groupsFor(entries));
  const repairs = freeze([{ sourceId: 'sku-0001', status: 'pending' }]);
  const memory = freeze({ items: { 'sku-0002': { sourceId: 'sku-0002', status: 'facts_pending' } } });
  const before = JSON.stringify({ groups, repairs, memory });
  const backend = buildQueueProgressTree(groups, repairs);
  const decorated = buildPlaylistProgressTree(groups, repairs, memory);
  const identity = (tree) => flatten(tree).filter((node) => node.type === 'part').map((node) => ({
    id: node.id, signature: node.signature, sourceIds: node.sourceIds,
    statuses: node.entries.map((item) => item.status)
  }));
  assert.deepEqual(identity(decorated), identity(backend));
  assert.equal(JSON.stringify({ groups, repairs, memory }), before);
  assert.equal(groups.in_sale_good.find((item) => item.sourceId === 'sku-0002').status, 'done');
});

test('only active repairs populate regeneration and completed repair records no longer hide readiness', () => {
  const entries = [1, 2, 3, 4].map((i) => entry(i, { status: 'done' }));
  const memory = memoryFor(entries, entries.map(() => 'ready'));
  const repairs = [
    { sourceId: entries[0].sourceId, status: 'pending' },
    { sourceId: entries[1].sourceId, status: 'completed' },
    entries[2].sourceId
  ];
  const tree = buildPlaylistProgressTree(groupsFor(entries), repairs, memory);
  const regular = tree.find((node) => node.mode === 'regular');
  const regeneration = tree.find((node) => node.mode === 'regeneration');
  assert.equal(regular.total, 4);
  assert.equal(regular.done, 2);
  assert.equal(regular.percent, 50);
  assert.equal(regeneration.total, 2);
  assert.equal(regeneration.queued, 2);
  assert.equal(regeneration.done, 0);
  assert.deepEqual(regeneration.entries.map((item) => item.sourceId).sort(), [entries[0].sourceId, entries[2].sourceId]);
});

test('playlist parts preserve 100-item boundaries when progress changes or source order changes', () => {
  const entries = Array.from({ length: 205 }, (_, i) => entry(i + 1));
  const first = buildPlaylistProgressTree(groupsFor(entries));
  const afterEntries = entries.toReversed().map((item) => ({ ...item, status: 'done' }));
  const after = buildPlaylistProgressTree(groupsFor(afterEntries), [], memoryFor(afterEntries, afterEntries.map(() => 'ready')));
  const parts = (tree) => flatten(tree).filter((node) => node.type === 'part' && node.mode === 'regular');
  assert.deepEqual(parts(first).map((node) => node.total), [100, 100, 5]);
  assert.deepEqual(parts(after).map((node) => [node.id, node.sourceIds]), parts(first).map((node) => [node.id, node.sourceIds]));
  assert.equal(parts(after).every((node) => node.percent === 100), true);
  assert.equal(new Set(parts(first).flatMap((node) => node.sourceIds)).size, 205);
});

test('part lookup selects the exact generic brand and exposes its readable queue path', () => {
  const tree = buildPlaylistProgressTree(groupsFor([
    entry(1), entry(2, { brand: 'UnknownBrand', groupId: 'not_in_sale_bad' })
  ]));
  const part = findPlaylistPart(tree, (node) => node.brandId === 'generic');
  assert.ok(part);
  assert.equal(part.groupId, 'not_in_sale_bad');
  assert.deepEqual(part.sourceIds, ['sku-0002']);
  assert.equal(playlistPath(part), 'Основная · Другие / не распознано · Не в продаже · плохое качество');
  assert.equal(findPlaylistPart(tree, (node) => node.partNumber === 9), null);
  assert.equal(findPlaylistPart([], () => true), null);
  assert.equal(playlistPath(null), '');
  assert.equal(playlistPath({ ...part, mode: 'regeneration' }), 'Перегенерация · Другие / не распознано · Не в продаже · плохое качество');
});

test('empty catalog remains readable and queue status alone never synthesizes readiness', () => {
  const empty = buildPlaylistProgressTree(groupsFor([]));
  assert.equal(empty.length, 2);
  assert.equal(empty.every((node) => node.total === 0 && node.percent === 0), true);
  const tree = buildPlaylistProgressTree(groupsFor([entry(1, { status: 'done' }), entry(2)]));
  assert.equal(tree[0].done, 0);
  assert.equal(tree[0].needsVerification, 2);
  assert.equal(tree[0].percent, 0);
});

const panelSource = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function declaration(name) {
  const start = panelSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing sidepanel function ${name}`);
  const tail = panelSource.slice(start);
  const end = tail.slice(1).search(/^\}/m) + 2;
  assert.ok(end > 1, `Missing end of ${name}`);
  return tail.slice(0, end);
}

function panelHarness(entries, repairQueue = []) {
  const nodes = Object.fromEntries(['runQueueMode', 'runGroupFilter', 'runBrandFilter', 'runPart',
    'launchQueueSummary', 'runLimit', 'workerCount', 'rateLimitPauseMinutes', 'rateLimitIgnoreMinutes',
    'generationPauseMinutes', 'generationJitterSeconds', 'inputMode', 'memorySearch', 'memoryStatusFilter', 'prompt'
  ].map((id) => [id, {
    value: '', dataset: {}, textContent: '', options: [],
    replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
    add(option) { this.options.push(option); }
  }]));
  for (const [id, value] of Object.entries({ runLimit: '100', workerCount: '4', inputMode: '2',
    rateLimitPauseMinutes: '3', rateLimitIgnoreMinutes: '10', generationPauseMinutes: '0.17',
    generationJitterSeconds: '2', memoryStatusFilter: 'all', prompt: 'Base prompt' })) nodes[id].value = value;
  const data = { job: { prompt: 'Base prompt', generationTimeoutMs: 900000 } };
  const context = vm.createContext({
    ...queueUtils, ...reliability, ...inputPlan,
    buildPlaylistProgressTree, findPlaylistPart, playlistPath,
    queue: { groups: groupsFor(entries), repairQueue }, generationMemory: { items: {} },
    accountingSnapshot: null,
    runtime: { state: 'IDLE', run: null }, actionBusy: false,
    selectedMemoryPartId: '', playlistMode: 'regular', lastPreflight: { ok: true },
    desiredRunPart: '', desiredRunPartSignature: '', currentLaunchPartPlan: null,
    currentLaunchSelectionExact: false, promptText: 'Base prompt',
    cachedMemoryTreeGroups: null, cachedMemoryTreeRepairQueue: null,
    cachedMemoryTreeGenerationMemory: null, cachedMemoryProgressTree: null,
    cachedMemoryTreeAccountingSnapshot: null,
    cachedMemoryProgressTreeSignature: '',
    DEFAULT_RATE_LIMIT_PAUSE_MINUTES: 3, MIN_RATE_LIMIT_PAUSE_MINUTES: 1, MAX_RATE_LIMIT_PAUSE_MINUTES: 30,
    $: (id) => nodes[id],
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    renderPlaylistLaunchSummary() {}, renderPreflight() {}, updateActionButtons() {},
    chrome: { storage: { local: {
      get: async () => structuredClone(data),
      set: async (patch) => Object.assign(data, structuredClone(patch))
    } } }
  });
  vm.runInContext([
    'playlistSelectionLocked', 'selectedLaunchPlaylist', 'restorePlaylistSelection', 'selectPlaylistForLaunch',
    'filterFromInputs', 'filterEntries', 'normalizedRepairQueueItems', 'repairQueueSourceIds',
    'launchQueueMode', 'launchSelectionIsExact', 'launchQueueCandidates', 'launchQueuePartPlan',
    'launchQueueEntries', 'resetRunPartSelection', 'updateLaunchQueueSummary', 'findMemoryPart',
    'memoryTreeSignature', 'currentMemoryProgressTree', 'memoryFilterState',
    'normalizeRateLimitPauseMinutes', 'saveDraft'
  ].map(declaration).join('\n'), context);
  return { context, nodes, data,
    part: (predicate) => findPlaylistPart(context.currentMemoryProgressTree().tree, predicate) };
}

test('selecting a playlist persists the exact existing backend launch contract including generic and regeneration', async () => {
  const entries = Array.from({ length: 102 }, (_, i) => entry(i + 1));
  entries.push(entry(200, { brand: 'UnknownBrand', groupId: 'not_in_sale_bad' }));
  const h = panelHarness(entries, [{ sourceId: 'sku-0200', status: 'pending' }]);
  for (const wanted of [
    { mode: 'regular', brand: 'casio', part: 2, group: 'in_sale_good', ids: ['sku-0101', 'sku-0102'] },
    { mode: 'regeneration', brand: 'generic', part: 1, group: 'not_in_sale_bad', ids: ['sku-0200'] }
  ]) {
    const selected = h.part((node) => node.mode === wanted.mode && node.brandId === wanted.brand && node.partNumber === wanted.part);
    assert.equal(h.context.selectPlaylistForLaunch(selected), true);
    await h.context.saveDraft();
    const job = h.data.job;
    assert.equal(job.runQueueMode, wanted.mode);
    assert.equal(job.runPart, wanted.part);
    assert.equal(job.runPartSignature, selected.signature);
    assert.equal(job.filters.brand, wanted.brand);
    assert.equal(`${job.filters.saleStatus}_${job.filters.quality}`, wanted.group);
    const backendEntries = queueUtils.filteredWatchEntries(h.context.queue.groups, job.filters)
      .filter((item) => wanted.mode !== 'regeneration' || item.sourceId === 'sku-0200');
    const backendPlan = queueUtils.queuePartPlan(backendEntries, 100,
      `${job.runQueueMode}|${job.filters.saleStatus}|${job.filters.quality}|${job.filters.brand}`);
    assert.equal(job.runPartSignature, backendPlan.signature);
    assert.deepEqual(backendPlan.parts.find((part) => part.partNumber === job.runPart).sourceIds, wanted.ids);
    assert.equal(h.context.selectedLaunchPlaylist().id, selected.id);
    assert.equal(h.context.lastPreflight, null, 'old preflight cannot describe a new playlist');
  }
});

test('a clicked stale playlist cannot silently select the same numbered part after catalog changes', async () => {
  const h = panelHarness([entry(1), entry(2)]);
  const selected = h.part((node) => node.mode === 'regular');
  assert.equal(h.context.selectPlaylistForLaunch(selected), true);
  await h.context.saveDraft();
  const before = structuredClone(h.data.job);
  h.context.queue = { groups: groupsFor([entry(1), entry(2), entry(3)]), repairQueue: [] };
  assert.equal(h.context.selectPlaylistForLaunch(selected), false);
  assert.equal(h.context.selectedLaunchPlaylist(), null);
  assert.deepEqual(h.data.job, before);
  assert.equal(h.nodes.runPart.dataset.partitionSignature, before.runPartSignature);
  h.context.selectedMemoryPartId = '';
  h.context.restorePlaylistSelection();
  assert.equal(h.context.selectedMemoryPartId, '');
});

test('browsing another playlist during active, paused or busy states preserves launch selection and saved job', async () => {
  const h = panelHarness([entry(1), entry(2, { brand: 'Orient' })]);
  const casio = h.part((node) => node.brandId === 'casio');
  const orient = h.part((node) => node.brandId === 'orient');
  assert.equal(h.context.selectPlaylistForLaunch(casio), true);
  await h.context.saveDraft();
  const before = structuredClone(h.data.job);
  for (const state of ['RUNNING', 'STARTING', 'DRAINING', 'RECONCILING', 'PAUSED', 'BUSY']) {
    h.context.runtime = { state: state === 'BUSY' ? 'IDLE' : state, run: state === 'BUSY' ? null : { state } };
    h.context.actionBusy = state === 'BUSY';
    assert.equal(h.context.playlistSelectionLocked(), true, state);
    assert.equal(h.context.selectPlaylistForLaunch(orient), false, state);
    assert.equal(h.context.selectedLaunchPlaylist().id, casio.id, state);
    await h.context.saveDraft();
    assert.deepEqual(h.data.job, before, `${state}: browsing may not alter the job`);
  }
});

test('restoring saved playlist requires the exact signature and preserves an intentional browsing selection', async () => {
  const h = panelHarness([entry(1), entry(2, { brand: 'UnknownBrand', groupId: 'not_in_sale_bad' })], ['sku-0002']);
  const part = h.part((node) => node.mode === 'regeneration');
  assert.equal(h.context.selectPlaylistForLaunch(part), true);
  await h.context.saveDraft();
  h.context.selectedMemoryPartId = '';
  h.context.playlistMode = 'regular';
  h.context.restorePlaylistSelection();
  assert.equal(h.context.selectedMemoryPartId, part.id);
  assert.equal(h.context.playlistMode, 'regeneration');
  const browse = h.part((node) => node.mode === 'regular' && node.brandId === 'casio');
  h.context.selectedMemoryPartId = browse.id;
  h.context.restorePlaylistSelection();
  assert.equal(h.context.selectedMemoryPartId, browse.id);
  h.context.selectedMemoryPartId = '';
  h.nodes.runPart.dataset.partitionSignature = 'stale-signature';
  h.context.restorePlaylistSelection();
  assert.equal(h.context.selectedMemoryPartId, '');
  assert.equal(h.context.selectedLaunchPlaylist(), null);
});
