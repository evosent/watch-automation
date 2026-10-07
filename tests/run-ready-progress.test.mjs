import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRunProgress, mergeRuntimeSnapshot } from '../extension/run-progress-utils.js';

test('ready-task progress waits for bound facts rather than counting a saved PNG twice', () => {
  const run = { operationId: 'launch', progressCompletionMode: 'ready', plannedIds: ['png', 'facts'], completedTaskIds: [] };
  const entries = [{ sourceId: 'png', status: 'done', factsStatus: 'pending' },
    { sourceId: 'facts', status: 'done', factsStatus: 'error' }];
  assert.equal(syncRunProgress(run, entries).runCompleted, 0);
  run.completedTaskIds.push('facts');
  assert.equal(syncRunProgress(run, entries).runCompleted, 1);
  run.completedTaskIds.push('png', 'unrelated', 'facts');
  assert.equal(syncRunProgress(run, null).runCompleted, 2);
  assert.equal(syncRunProgress(run, null).runRemaining, 0);
});
test('34 remaining tasks form a fixed launch despite 66 accepted results in the part', () => {
  const ids = Array.from({ length: 100 }, (_, index) => `model-${index}`);
  const planned = ids.slice(66);
  const run = { operationId: 'part3', progressCompletionMode: 'ready', plannedIds: planned,
    completedTaskIds: ['model-99', ...ids.slice(0, 66)] };
  const summary = syncRunProgress(run, ids.map(sourceId => ({ sourceId, status: 'done' })));
  assert.equal(summary.runTotal, 34);
  assert.equal(summary.runCompleted, 1);
  assert.equal(summary.runRemaining, 33);
});
test('ready-task progress persists across status-only publications, stop and recovery', () => {
  const run = { operationId: 'recovered', originOperationId: 'first', progressCompletionMode: 'ready',
    plannedIds: ['a', 'b'], completedTaskIds: ['a'] };
  let runtime = { state: 'RUNNING', operationId: 'first', ...syncRunProgress(run, []) };
  delete run.completedTaskIds;
  for (let index = 0; index < 30; index++) {
    runtime = mergeRuntimeSnapshot(runtime, { state: index % 2 ? 'WAITING' : 'RUNNING',
      currentAction: 'status', ...syncRunProgress(run, null) });
    assert.equal(runtime.runCompleted, 1);
    assert.equal(runtime.runTotal, 2);
  }
  assert.equal(mergeRuntimeSnapshot(runtime, { state: 'STOPPED' }).runCompleted, 1);
});
test('legacy running sessions retain their established PNG completion contract', () => {
  const run = { operationId: 'legacy', plannedIds: ['a', 'b'] };
  assert.equal(syncRunProgress(run, [{ sourceId: 'a', status: 'done', factsStatus: 'pending' }]).runCompleted, 1);
});
