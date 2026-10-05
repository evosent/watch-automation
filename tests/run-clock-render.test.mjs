import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { elapsedRunClock } from '../extension/run-clock-utils.js';

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing function end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('run status render retains active elapsed and average after GET_RUNTIME_FAST shortens run snapshot', async () => {
  const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const formatSource = functionSource(panel, 'function formatDuration(', 'function renderRunStatus(');
  const renderSource = functionSource(panel, 'function renderRunStatus(', 'function compact(');
  const elements = new Map();
  const element = () => ({
    textContent: '',
    title: '',
    value: '',
    style: {},
    setAttribute() {}
  });
  let fakeNow = Date.now();
  const FakeDate = class extends Date { static now() { return fakeNow; } };
  const context = {
    Date: FakeDate,
    runtime: null,
    RUN_STATE_LABELS: { RUNNING: 'РАБОТАЕТ', PAUSED: 'ПАУЗА' },
    elapsedRunClock,
    countdown: () => '',
    $: (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  };
  runInNewContext(`${formatSource}\n${renderSource}\nglobalThis.renderStatus = renderRunStatus;`, context);

  const startedAt = new Date(fakeNow - 5_000).toISOString();
  const fullRuntime = {
    operationId: 'render-clock',
    state: 'RUNNING',
    status: 'RUNNING',
    startedAt,
    clockVersion: 1,
    clockAccumulatedMs: 0,
    clockActiveSinceMs: fakeNow - 5_000,
    clockStopped: false,
    runTotal: 4,
    runCompleted: 2,
    run: {
      operationId: 'render-clock',
      state: 'RUNNING',
      status: 'RUNNING',
      startedAt,
      clockVersion: 1,
      clockAccumulatedMs: 0,
      clockActiveSinceMs: fakeNow - 5_000,
      clockStopped: false
    }
  };
  context.runtime = fullRuntime;
  context.renderStatus();
  const elapsedBeforeFastRefresh = elements.get('runElapsed').textContent;
  const averageBeforeFastRefresh = elements.get('runAverage').textContent;
  assert.equal(elapsedBeforeFastRefresh, '0:05');

  fakeNow += 600_000;
  context.runtime = {
    ...fullRuntime,
    state: 'PAUSED',
    status: 'PAUSED',
    pauseReason: 'USER',
    clockAccumulatedMs: 5_000,
    clockActiveSinceMs: null,
    run: { operationId: 'render-clock', state: 'PAUSED', pauseReason: 'USER' }
  };
  context.renderStatus();
  assert.equal(elements.get('runElapsed').textContent, elapsedBeforeFastRefresh);
  assert.equal(elements.get('runAverage').textContent, averageBeforeFastRefresh);
});
