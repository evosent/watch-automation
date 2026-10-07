import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { mergeRuntimeSnapshot } from '../extension/run-progress-utils.js';
import { canonicalAccountingIndex, accountingSnapshotFreshness } from '../extension/accounting-ui-utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidepanelSource = await readFile(path.join(root, 'extension', 'sidepanel.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = sidepanelSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = sidepanelSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return sidepanelSource.slice(start, end);
}

function createPanelHarness() {
  const elements = new Map();
  const element = (id, value = '') => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value,
        textContent: '',
        title: '',
        hidden: false,
        style: {},
        attributes: {},
        setAttribute(name, next) { this.attributes[name] = String(next); },
        closest() { return { hidden: false }; }
      });
    }
    return elements.get(id);
  };
  element('runLimit', '100');
  const state = {
    fastResponse: null,
    fullResponse: null,
    previewCandidateCount: 34
  };
  const sandbox = {
    runtime: { state: 'IDLE', workerCount: 4, slots: [] },
    accountingSnapshot: null,
    mergeRuntimeSnapshot,
    canonicalAccountingIndex,
    accountingSnapshotFreshness,
    RUN_STATE_LABELS: {
      IDLE: 'Ожидание', RUNNING: 'В работе', STARTING: 'Запуск', DRAINING: 'Завершение',
      RECONCILING: 'Сверка', PAUSED: 'Пауза', DONE: 'Завершено', STOPPED: 'Остановлено'
    },
    $: (id) => element(id),
    launchQueueEntries: () => Array.from({ length: state.previewCandidateCount }, (_, index) => ({ sourceId: String(index) })),
    requestRuntimeFast: async () => state.fastResponse,
    requestRuntime: async () => state.fullResponse,
    refreshRunDiagnosticsAtBoundary() {},
    renderHealth() {},
    renderSlotGrid() {},
    renderLogs() {},
    updateActionButtons() {},
    countdown: () => '',
    sentenceCase: (value) => String(value || ''),
    elapsedRunClock: () => 0,
    formatDuration: () => '0:00',
    filterFromInputs: () => ({}),
    normalizeWatchFilter: (value) => value || {},
    filterEntries: () => [],
    filterLabel: () => '',
    compact: (value) => String(value || ''),
    normalizeWorkerCount: (value) => value,
    normalizeInputMode: (value) => value,
    DEFAULT_INPUT_MODE: 'two',
    normalizeRateLimitPauseMinutes: (value) => value,
    renderGenerationMemory() {},
    renderAll() {},
    applyGenerationHistory() {},
    applyGenerationMemory() {},
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array
  };
  const context = createContext(sandbox);
  const declarations = [
    sliceBetween('function acceptRuntimeSnapshot(', '\nlet promptText = '),
    sliceBetween('async function refreshRuntimeFast()', '\nfunction shortTime('),
    sliceBetween('function renderRunStatus(', '\nfunction compact('),
    sliceBetween('async function refreshRuntime()', '\nasync function currentHostWindowId(')
  ].join('\n');
  runInContext(declarations, context);
  return { context, elements, state };
}

function expectProgress(harness, count, percent) {
  assert.equal(harness.elements.get('runProgressCount').textContent, count);
  assert.equal(harness.elements.get('runProgressPercent').textContent, percent);
  assert.equal(harness.elements.get('runProgressTrack').attributes['aria-valuetext'], count);
}

test('fast status updates retain current-run progress and describe the counted result', async () => {
  const harness = createPanelHarness();
  const { context, elements, state } = harness;
  context.acceptRuntimeSnapshot({
    operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', status: 'RUNNING',
    startedAt: '2026-10-06T08:00:00.000Z', runtimeSequence: 10,
    runTotal: 100, runCompleted: 66, runRemaining: 34
  });
  context.renderRunStatus();
  expectProgress(harness, '66 из 100', '66%');

  for (let sequence = 11; sequence < 61; sequence += 1) {
    state.fastResponse = {
      ok: true,
      value: {
        runtime: {
          operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', status: 'RUNNING',
          currentAction: `Статус ${sequence}`, runtimeSequence: sequence,
          runTotal: 0, runCompleted: 0, runRemaining: 0
        }
      }
    };
    assert.equal(await context.refreshRuntimeFast(), true);
    expectProgress(harness, '66 из 100', '66%');
  }

  const description = 'Результаты текущего запуска: подтверждённые PNG; спецификации проверяются отдельно';
  assert.equal(elements.get('runProgressCount').title, description);
  assert.equal(elements.get('runProgressTrack').title, description);
  assert.equal(elements.get('runProgressTrack').attributes['aria-label'], description);
});

test('new ready-progress runs describe completed PNG plus verified specification results', () => {
  const harness = createPanelHarness();
  harness.context.acceptRuntimeSnapshot({
    operationId: 'run-ready', progressRunId: 'run-ready', state: 'RUNNING',
    startedAt: '2026-10-06T08:00:00.000Z', runtimeSequence: 1,
    progressCompletionMode: 'ready', runTotal: 10, runCompleted: 3, runRemaining: 7
  });
  harness.context.renderRunStatus();

  const description = 'Готово в этом запуске: сохранённый PNG и проверенная спецификация привязаны к модели.';
  assert.equal(harness.elements.get('runProgressCount').textContent, '3 из 10');
  assert.equal(harness.elements.get('runProgressCount').title, description);
  assert.equal(harness.elements.get('runProgressTrack').attributes['aria-label'], description);
  assert.equal(harness.elements.get('runAverage').textContent, '0:00 / результат');
  assert.match(harness.elements.get('runAverage').title, /PNG плюс проверенная спецификация/);
});

test('older full refresh cannot replace a newer fast snapshot', async () => {
  const harness = createPanelHarness();
  const { context, state } = harness;
  context.acceptRuntimeSnapshot({
    operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', startedAt: '2026-10-06T08:00:00.000Z',
    runtimeSequence: 20, runTotal: 100, runCompleted: 60, runRemaining: 40
  });
  state.fastResponse = {
    ok: true,
    value: { runtime: {
      operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', currentAction: 'Новый статус',
      runtimeSequence: 22, runTotal: 100, runCompleted: 66, runRemaining: 34
    } }
  };
  await context.refreshRuntimeFast();
  expectProgress(harness, '66 из 100', '66%');

  state.fullResponse = {
    ok: true,
    value: { runtime: {
      operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', currentAction: 'Устаревший статус',
      runtimeSequence: 21, runTotal: 100, runCompleted: 61, runRemaining: 39
    }, logs: [] }
  };
  await context.refreshRuntime();
  expectProgress(harness, '66 из 100', '66%');
  assert.equal(context.runtime.currentAction, 'Новый статус');
});

test('pause, resume and stop preserve the launch denominator; a new launch gets a smaller plan', async () => {
  const harness = createPanelHarness();
  const { context, elements, state } = harness;
  context.acceptRuntimeSnapshot({
    operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', startedAt: '2026-10-06T08:00:00.000Z',
    runtimeSequence: 30, runTotal: 100, runCompleted: 66, runRemaining: 34
  });

  for (const snapshot of [
    { operationId: 'run-a', progressRunId: 'run-a', state: 'PAUSED', pauseReason: 'USER', runtimeSequence: 31 },
    { operationId: 'run-a', progressRunId: 'run-a', state: 'RUNNING', runtimeSequence: 32, runTotal: 100, runCompleted: 66, runRemaining: 34 },
    { operationId: null, progressRunId: 'run-a', state: 'STOPPED', startedAt: '2026-10-06T08:00:00.000Z',
      runtimeSequence: 33, runTotal: 100, runCompleted: 66, runRemaining: 34 }
  ]) {
    state.fastResponse = { ok: true, value: { runtime: snapshot } };
    await context.refreshRuntimeFast();
    expectProgress(harness, '66 из 100', '66%');
  }

  state.previewCandidateCount = 34;
  state.fastResponse = { ok: true, value: { runtime: {
    operationId: null, progressRunId: null, state: 'IDLE', startedAt: null,
    runtimeSequence: 34, runTotal: 0, runCompleted: 0, runRemaining: 0
  } } };
  await context.refreshRuntimeFast();
  expectProgress(harness, '0 из 34', '0%');

  state.fastResponse = { ok: true, value: { runtime: {
    operationId: 'run-b', progressRunId: 'run-b', state: 'RUNNING', startedAt: '2026-10-06T09:00:00.000Z',
    runtimeSequence: 35, runTotal: 34, runCompleted: 0, runRemaining: 34
  } } };
  await context.refreshRuntimeFast();
  expectProgress(harness, '0 из 34', '0%');
  assert.equal(elements.get('runProgressTrack').attributes['aria-valuemax'], '34');
});

test('initial runtime storage is loaded through the same snapshot merger', () => {
  assert.match(sidepanelSource, /get\(\['queue', 'run', 'runtime', 'job'/);
  assert.match(sidepanelSource, /if \(stored\.runtime\) acceptRuntimeSnapshot\(stored\.runtime\)/);

  const harness = createPanelHarness();
  harness.context.acceptRuntimeSnapshot({
    operationId: 'stored-run', progressRunId: 'stored-run', state: 'PAUSED',
    startedAt: '2026-10-06T08:00:00.000Z', runtimeSequence: 5,
    runTotal: 100, runCompleted: 66, runRemaining: 34
  });
  harness.context.renderRunStatus();
  expectProgress(harness, '66 из 100', '66%');
});
