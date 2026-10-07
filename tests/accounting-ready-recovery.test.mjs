import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const workerSource = await readFile(fileURLToPath(new URL('../extension/service-worker.js', import.meta.url)), 'utf8');

function productionFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(workerSource);
  assert.ok(start, `production service worker exports local function ${name}`);
  const next = /^(?:async )?function \w+\(/m.exec(workerSource.slice(start.index + start[0].length));
  const end = next ? start.index + start[0].length + next.index : workerSource.length;
  return workerSource.slice(start.index, end);
}

function helperContext(names, additional = {}) {
  const context = {
    Date, Promise, Set, Map, Number, String, Object, Array, Boolean,
    scheduledRetriesForRun: () => [],
    clockTime: (value) => String(value),
    recordRunEvent: (run, type, payload) => {
      run.testEvents ||= [];
      run.testEvents.push({ type, ...payload });
    },
    ...additional
  };
  vm.createContext(context);
  for (const name of names) {
    vm.runInContext(productionFunction(name), context, { filename: `service-worker.${name}.js` });
  }
  return context;
}

test('ready completion mode keeps queue.done facts-incomplete work pending and protects its live owner', () => {
  const context = helperContext(['plannedTaskIsCompleted', 'pendingPlannedIds']);
  const run = {
    progressCompletionMode: 'ready',
    plannedIds: ['already-ready', 'facts-incomplete', 'owned-facts', 'ordinary-pending'],
    completedTaskIds: ['already-ready'],
    postprocessTabs: {
      '44': { tabId: 44, entryId: 'owned-facts', generationId: 'gen-owned', factsJobId: 'facts-owned' }
    }
  };
  const entries = [
    { sourceId: 'already-ready', status: 'done', factsStatus: 'ok' },
    // Queue `done` only confirms that a PNG is saved. READY-mode completion
    // waits for its facts task to be explicitly completed as well.
    { sourceId: 'facts-incomplete', status: 'done', factsStatus: 'pending' },
    { sourceId: 'owned-facts', status: 'done', factsStatus: 'pending' },
    { sourceId: 'ordinary-pending', status: 'pending' }
  ];

  assert.equal(context.plannedTaskIsCompleted(run, 'facts-incomplete', 'done'), false);
  assert.deepEqual(Array.from(context.pendingPlannedIds(run, entries)), ['facts-incomplete', 'ordinary-pending']);
  assert.deepEqual(Array.from(context.pendingPlannedIds(run, entries, new Set(['ordinary-pending']))), ['facts-incomplete']);
});

test('resume reconciliation turns an ownerless verified saved PNG into an exact facts task', () => {
  const context = helperContext(
    ['reconcileReadyRunTaskPlan', 'plannedTaskIsCompleted', 'pendingPlannedIds', 'plannedTaskForRun', 'applyPlannedTaskToSlot'],
    {
      REGENERATION_QUEUE_ID: 'regeneration',
      groupEntries: (queue, groupId) => queue?.groups?.[groupId] || []
    }
  );
  const targetRevision = {
    generationId: 'generation-17',
    factsJobId: 'facts-job-17',
    outputPath: 'results/Casio/model-17.png',
    outputHash: 'A'.repeat(64),
    chatUrl: 'https://chatgpt.com/c/conversation-17',
    imageUrlFingerprint: 'image-fingerprint-17'
  };
  const run = {
    progressCompletionMode: 'ready',
    groupId: 'in_sale_good',
    plannedIds: ['sku-17'],
    plannedTasks: [{ taskId: 'sku-17', sourceId: 'sku-17', kind: 'generate' }],
    plannedTaskKinds: { 'sku-17': 'generate' },
    imagePlannedIds: ['sku-17'],
    completedTaskIds: [],
    slots: {},
    // The prior postprocess owner disappeared. Resume must reconstruct the
    // facts task from the canonical, positively verified artifact record.
    postprocessTabs: {}
  };
  const queue = { groups: { in_sale_good: [{
    sourceId: 'sku-17', skuKey: 'sku-17', fileName: 'model-17.png', status: 'done'
  }] } };
  const snapshot = {
    revision: 29,
    reconciliationComplete: true,
    verificationAvailable: true,
    stale: false,
    entries: [{
      skuKey: 'sku-17',
      sourcePresent: true,
      identityStatus: 'OK',
      status: 'NEEDS_FACTS',
      activeAttempt: { active: false },
      artifactVerification: { status: 'VERIFIED' },
      actionRevision: targetRevision
    }],
    candidates: [{ skuKey: 'sku-17', task: 'facts', targetRevision }]
  };

  const result = context.reconcileReadyRunTaskPlan(run, queue, snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(Array.from(run.imagePlannedIds), []);
  assert.deepEqual(Array.from(context.pendingPlannedIds(run, queue.groups.in_sale_good)), ['sku-17']);
  assert.deepEqual({ ...run.plannedTasks[0] }, {
    taskId: 'sku-17',
    sourceId: 'sku-17',
    kind: 'facts',
    generationId: 'generation-17',
    factsJobId: 'facts-job-17',
    outputPath: 'results/Casio/model-17.png',
    outputHash: 'a'.repeat(64),
    chatUrl: 'https://chatgpt.com/c/conversation-17',
    imageUrlFingerprint: 'image-fingerprint-17'
  });

  const slot = {};
  const task = context.applyPlannedTaskToSlot(slot, run, 'sku-17');
  assert.equal(task.kind, 'facts');
  assert.equal(slot.taskKind, 'facts');
  assert.equal(slot.savedFactsTask, true);
  assert.equal(slot.status, 'FACTS_STARTING');
  assert.equal(slot.generationId, targetRevision.generationId);
  assert.equal(slot.factsJobId, targetRevision.factsJobId);
  assert.equal(slot.outputPath, targetRevision.outputPath);
  assert.equal(slot.outputHash, targetRevision.outputHash.toLowerCase());
  assert.equal(slot.chatUrl, targetRevision.chatUrl);
});

test('resume reconciliation blocks facts work when saved artifact verification is ambiguous', () => {
  const context = helperContext(['reconcileReadyRunTaskPlan'], {
    REGENERATION_QUEUE_ID: 'regeneration',
    groupEntries: (queue, groupId) => queue?.groups?.[groupId] || []
  });
  const run = {
    progressCompletionMode: 'ready', groupId: 'in_sale_good', plannedIds: ['sku-18'],
    plannedTasks: [{ taskId: 'sku-18', sourceId: 'sku-18', kind: 'generate' }],
    completedTaskIds: [], slots: {}, postprocessTabs: {}
  };
  const queue = { groups: { in_sale_good: [{ sourceId: 'sku-18', skuKey: 'sku-18' }] } };
  const targetRevision = {
    generationId: 'generation-18', factsJobId: 'facts-job-18', outputPath: 'results/model-18.png',
    outputHash: 'b'.repeat(64), chatUrl: 'https://chatgpt.com/c/conversation-18'
  };
  const snapshot = {
    reconciliationComplete: true, verificationAvailable: true, stale: false,
    entries: [{ skuKey: 'sku-18', sourcePresent: true, identityStatus: 'OK', status: 'NEEDS_FACTS',
      activeAttempt: { active: false }, artifactVerification: { status: 'MISSING' }, actionRevision: targetRevision }],
    candidates: [{ skuKey: 'sku-18', task: 'facts', targetRevision }]
  };

  const result = context.reconcileReadyRunTaskPlan(run, queue, snapshot);
  assert.equal(result.ok, false);
  assert.match(result.blocked.join(' '), /привязка сохранённого изображения.*не подтверждена/);
  assert.equal(run.plannedTasks[0].kind, 'generate');
  assert.deepEqual(Array.from(run.completedTaskIds), []);
});

test('legacy run completion continues to use queue.done while ready mode uses task IDs', () => {
  const context = helperContext(['plannedTaskIsCompleted', 'pendingPlannedIds']);
  const entries = [
    { sourceId: 'done-png', status: 'done', factsStatus: 'pending' },
    { sourceId: 'failed', status: 'error' },
    { sourceId: 'waiting', status: 'pending' }
  ];
  const legacy = { plannedIds: ['done-png', 'failed', 'waiting'] };
  assert.deepEqual(Array.from(context.pendingPlannedIds(legacy, entries)), ['failed', 'waiting']);

  const readyMode = { ...legacy, progressCompletionMode: 'ready', completedTaskIds: [] };
  assert.deepEqual(Array.from(context.pendingPlannedIds(readyMode, entries)), ['done-png', 'failed', 'waiting']);
});

test('stalled-batch recovery requeues PNG-done facts work in READY mode without erasing its result', () => {
  const context = helperContext([
    'plannedTaskIsCompleted', 'pendingStalledBatchRecoveryIds', 'preserveStalledBatchSavedResult',
    'releaseStalledBatchPostprocessOwners'
  ]);
  const entries = [
    { sourceId: 'ready', status: 'done', factsStatus: 'ok', generationId: 'gen-ready' },
    { sourceId: 'facts-pending', status: 'done', factsStatus: 'pending', generationId: 'gen-pending' },
    { sourceId: 'generate-pending', status: 'running' }
  ];
  const readyRun = {
    progressCompletionMode: 'ready',
    plannedIds: entries.map((entry) => entry.sourceId),
    completedTaskIds: ['ready']
  };

  assert.deepEqual(Array.from(context.pendingStalledBatchRecoveryIds(readyRun, entries)), [
    'facts-pending', 'generate-pending'
  ]);
  assert.equal(context.preserveStalledBatchSavedResult(readyRun, 'facts-pending', entries[1]), true);
  assert.equal(context.preserveStalledBatchSavedResult(readyRun, 'generate-pending', entries[2]), false);
  assert.equal(context.preserveStalledBatchSavedResult(readyRun, 'ready', entries[0]), false);

  const legacyRun = { plannedIds: entries.map((entry) => entry.sourceId) };
  assert.deepEqual(Array.from(context.pendingStalledBatchRecoveryIds(legacyRun, entries)), ['generate-pending']);
  assert.equal(context.preserveStalledBatchSavedResult(legacyRun, 'facts-pending', entries[1]), false);

  readyRun.postprocessTabs = {
    '201': { tabId: 201, entryId: 'facts-pending', generationId: 'gen-pending', factsJobId: 'facts-pending-job', outputHash: 'c'.repeat(64) },
    '202': { tabId: 202, entryId: 'ready', generationId: 'gen-ready', factsJobId: 'facts-ready-job' }
  };
  readyRun.factsProgress = {};
  const released = context.releaseStalledBatchPostprocessOwners(readyRun, [201, 202], '2026-10-06T10:00:00.000Z');
  assert.deepEqual(Array.from(released, (item) => item.tabId), [201, 202]);
  assert.deepEqual(Object.keys(readyRun.postprocessTabs), []);
  assert.equal(readyRun.factsProgress['facts-pending-job'].stage, 'QUEUED');
  assert.equal(readyRun.factsProgress['facts-pending-job'].outputHash, 'c'.repeat(64));
  assert.equal(readyRun.factsProgress['facts-ready-job'], undefined);
});

test('draining READY-mode run with three of five tasks ends with two incomplete, never 100 percent', () => {
  const context = helperContext(['hasLiveSlotWork', 'hasUnresolvedSlotErrors', 'finalizeDrainingRun']);
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const run = {
    operationId: 'ready-run',
    groupId: 'in_sale_good',
    state: 'DRAINING',
    status: 'DRAINING',
    progressCompletionMode: 'ready',
    plannedIds: ids,
    completedTaskIds: ['a', 'b', 'c'],
    pendingIds: [],
    factsProgress: {},
    slots: {},
    postprocessTabs: {},
    recoveryTabs: {}
  };
  const queue = { groups: { in_sale_good: ids.map((sourceId) => ({ sourceId, status: 'done' })) } };

  assert.equal(context.finalizeDrainingRun(run, queue), true);
  assert.equal(run.state, 'DONE');
  assert.equal(run.status, 'DONE_WITH_FACTS_ERRORS');
  assert.match(run.currentAction, /Готово 3 из 5/);
  assert.match(run.currentAction, /незавершённых результатов: 2/);
  assert.doesNotMatch(run.currentAction, /100%|Все .* сохранены/);
  const event = run.testEvents.find((item) => item.type === 'run_completed');
  assert.equal(event.plannedCount, 5);
  assert.equal(event.completedCount, 3);
  assert.equal(event.pendingCount, 2);
});
