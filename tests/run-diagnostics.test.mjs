import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diagnosticCategoryForType,
  runDiagnosticHeader,
  sanitizeRunDiagnosticEvent
} from '../extension/run-diagnostics-utils.js';
import {
  getRunDiagnostic,
  listRunDiagnostics,
  saveRunDiagnostics
} from '../extension/idb.js';

test('run diagnostic events keep decision context while excluding prompt and page payloads', () => {
  const event = sanitizeRunDiagnosticEvent({
    operationId: 'run-test-sanitize',
    sequence: 3,
    at: '2026-09-29T12:00:00.000Z',
    type: 'run_stop_blocked',
    reason: 'png_not_verified',
    slotId: 2,
    prompt: 'private prompt',
    latestAssistantText: 'large page response',
    html: '<main>page</main>'
  });

  assert.equal(event.category, 'error');
  assert.equal(event.reason, 'png_not_verified');
  assert.equal(event.slotId, 2);
  assert.equal('prompt' in event, false);
  assert.equal('latestAssistantText' in event, false);
  assert.equal('html' in event, false);
  assert.equal(diagnosticCategoryForType('rate_limit_pause'), 'decision');
});

test('run diagnostic headers and event streams are archived independently by operationId', async () => {
  const operationId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const run = {
    operationId,
    startedAt: '2026-09-29T12:00:00.000Z',
    state: 'PAUSED',
    status: 'PAUSED_ON_ERROR',
    pauseReason: 'ERROR',
    groupId: 'watches',
    filterLabel: 'В продаже · Casio',
    workerCount: 2,
    runLimit: 4,
    plannedIds: ['item-a', 'item-b'],
    pendingIds: ['item-b'],
    eventSequence: 2,
    eventCount: 2,
    eventJournal: [
      { operationId, sequence: 1, at: '2026-09-29T12:00:01.000Z', type: 'run_started' },
      { operationId, sequence: 2, at: '2026-09-29T12:01:00.000Z', type: 'run_paused_on_error' }
    ]
  };
  const queue = { groups: { watches: [
    { sourceId: 'item-a', status: 'done' },
    { sourceId: 'item-b', status: 'pending' }
  ] } };
  const header = runDiagnosticHeader(run, queue, '0.3.test');
  const events = run.eventJournal.map((event) => sanitizeRunDiagnosticEvent(event, {
    operationId,
    sequence: event.sequence
  }));

  assert.equal(header.plannedCount, 2);
  assert.equal(header.completedCount, 1);
  await saveRunDiagnostics(header, events);
  await saveRunDiagnostics(header, events.slice(1));

  const archive = await getRunDiagnostic(operationId);
  assert.equal(archive.run.operationId, operationId);
  assert.equal(archive.events.length, 2);
  assert.deepEqual(archive.events.map((event) => event.sequence), [1, 2]);
  assert.ok((await listRunDiagnostics({ limit: 500 })).some((item) => item.operationId === operationId));
});

test('diagnostic completion counts match planned IDs across filtered queue group keys', () => {
  const run = {
    operationId: 'run-filtered-group',
    groupId: 'filter:in_sale:good:casio',
    plannedIds: ['sku-a', 'sku-b', 'sku-c'],
    diagnosticsLastKnownCompletedCount: 0,
    eventJournal: [
      { type: 'output_verified', entryId: 'sku-c' },
      { type: 'output_verified', entryId: 'outside-plan' }
    ]
  };
  const queue = { groups: {
    in_sale_good: [
      { sourceId: 'sku-a', status: 'done' },
      { sourceId: 'sku-b', status: 'done' },
      { sourceId: 'sku-c', status: 'running' },
      { sourceId: 'outside-plan', status: 'done' }
    ]
  } };

  const header = runDiagnosticHeader(run, queue);
  assert.equal(header.completedCount, 3);
  assert.equal(header.pendingCount, 0);

  const eventOnlyHeader = runDiagnosticHeader({
    ...run,
    eventJournal: [{ type: 'output_verified', entryId: 'sku-b' }]
  }, null);
  assert.equal(eventOnlyHeader.completedCount, 1);
  assert.equal(eventOnlyHeader.pendingCount, 2);
});

test('an archived manual storage pause remains distinguishable from a timed or inferred upload cooldown', () => {
  const header = runDiagnosticHeader({ operationId: 'manual-storage', state: 'PAUSED',
    pauseReason: 'UPLOAD_LIMIT', uploadCooldownActive: true, uploadLimitDetected: true,
    uploadManualPause: true, uploadPauseSettled: true, uploadLimitAutoResume: false,
    rateLimitPauseUntil: null, plannedIds: [] });
  assert.equal(header.uploadManualPause, true);
  assert.equal(header.uploadLimitDetected, true);
  assert.equal(header.uploadPauseSettled, true);
  assert.equal(header.uploadLimitAutoResume, false);
  assert.equal(header.rateLimitPauseUntil, null);
  assert.equal(runDiagnosticHeader({ operationId: 'inferred', uploadCooldownActive: true,
    uploadLimitDetected: false, plannedIds: [] }).uploadLimitDetected, false);
});
