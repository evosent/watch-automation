import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticOutbox, mergeDiagnosticSnapshots } from '../extension/diagnostic-outbox-utils.js';
import {
  completeRunDiagnostic, listCompleteRunDiagnosticHeaders, latestDiagnosticOperationId
} from '../extension/diagnostic-export-utils.js';

function storageFake(initial = {}) {
  let values = structuredClone(initial);
  return {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .map(key => [key, structuredClone(values[key]) ])); },
    async set(patch) { values = { ...values, ...structuredClone(patch) }; }
  };
}

function row(sequence, type = 'session_reset_completed') {
  return { operationId: 'run-a', sequence, type, at: '2026-10-06T00:10:00.000Z' };
}

function pending(records = [row(2)], patch = {}) {
  const operationId = patch.operationId || 'run-a';
  return { operationId, header: { operationId, startedAt: '2026-10-06T00:00:00.000Z', state: 'RESET',
    eventCount: records.at(-1)?.sequence || 0, ...patch }, records: records.map(event => ({ ...event, operationId })) };
}

test('event export cannot fall between the archive write and durable outbox acknowledgement', async () => {
  const storage = storageFake({ run: null, queue: { groups: {} } });
  let archived = { run: { operationId: 'run-a', eventCount: 1, state: 'PAUSED' },
    events: [row(1, 'session_reset_requested')] };
  const calls = [];
  const outbox = createDiagnosticOutbox({ storage, archive: async (header, records) => {
    const combined = mergeDiagnosticSnapshots(archived, { header, records });
    archived = { run: combined.header, events: combined.records };
  } });
  await outbox.persist(pending());
  const result = await completeRunDiagnostic('run-a', { storage,
    readOutbox: async id => {
      calls.push('outbox');
      // Simulate the ACK transfer completing before the outbox read returns.
      await outbox.drain();
      assert.equal(await outbox.read(id), null);
      return null;
    },
    readArchive: async () => { calls.push('archive'); return structuredClone(archived); }
  });
  assert.deepEqual(calls, ['outbox', 'archive']);
  assert.deepEqual(result.events.map(event => event.sequence), [1, 2]);
  assert.equal(result.run.state, 'RESET');
});

test('run list also survives the transfer from an outbox-only run to the archive', async () => {
  const storage = storageFake({ run: null });
  let archived = [];
  const outbox = createDiagnosticOutbox({ storage, archive: async header => { archived = [structuredClone(header)]; } });
  await outbox.persist(pending());
  const runs = await listCompleteRunDiagnosticHeaders({ storage,
    readOutbox: async () => { await outbox.drain(); return outbox.read(); },
    listArchives: async () => structuredClone(archived) });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].operationId, 'run-a');
});

test('after live Reset and archive failure the complete durable outcome remains exportable', async () => {
  const storage = storageFake({ run: null });
  const outbox = createDiagnosticOutbox({ storage, archive: async () => { throw new Error('Archive unavailable'); } });
  await outbox.persist(pending([row(1, 'session_reset_requested'), row(2)]));
  await outbox.drain();
  const result = await completeRunDiagnostic('run-a', { storage,
    readOutbox: id => outbox.read(id), readArchive: async () => { throw new Error('Archive unavailable'); } });
  assert.deepEqual(result.events.map(event => event.type), ['session_reset_requested', 'session_reset_completed']);
  assert.equal(result.archiveError, 'Archive unavailable');
  assert.equal(result.run.state, 'RESET');
});

test('export deduplicates overlapping archive, outbox and live events without reverting the header', async () => {
  const live = { operationId: 'run-a', plannedIds: ['a'], state: 'RUNNING', eventSequence: 4,
    startedAt: '2026-10-06T00:00:00.000Z', eventJournal: [row(3), row(4, 'run_resumed')] };
  const storage = storageFake({ run: live, queue: { groups: { watches: [{ sourceId: 'a', status: 'done' }] } } });
  const result = await completeRunDiagnostic('run-a', { storage,
    readArchive: async () => ({ run: { operationId: 'run-a', state: 'PAUSED', eventCount: 2 }, events: [row(1), row(2)] }),
    readOutbox: async () => pending([row(2), row(3)]) });
  assert.deepEqual(result.events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.equal(result.run.state, 'RUNNING');
  assert.equal(result.run.eventCount, 4);
});

test('a failed outbox read still permits archived diagnostics and exposes the read failure', async () => {
  const result = await completeRunDiagnostic('run-a', { storage: storageFake({ run: null }),
    readArchive: async () => ({ run: { operationId: 'run-a', eventCount: 1 }, events: [row(1)] }),
    readOutbox: async () => { throw new Error('Local outbox read failed'); } });
  assert.equal(result.events.length, 1);
  assert.equal(result.outboxReadError, 'Local outbox read failed');
});

test('a missing archive and no live or durable run reports the original archive failure', async () => {
  await assert.rejects(completeRunDiagnostic('run-a', { storage: storageFake({ run: null }),
    readArchive: async () => { throw new Error('Archive unavailable'); }, readOutbox: async () => null }), /Archive unavailable/);
});

test('the latest run selector includes durable-only runs after Reset and during archive failure', async () => {
  const recent = pending([row(2)], { operationId: 'newest-run', startedAt: '2026-10-06T00:00:00.000Z' });
  const storage = storageFake({ run: null });
  const latest = await latestDiagnosticOperationId({ storage, readOutbox: async () => [recent],
    listArchives: async () => { throw new Error('Archive unavailable'); } });
  assert.equal(latest, 'newest-run');
});

test('list headers do not regress when a stale pending snapshot overlaps a newer archive', async () => {
  const runs = await listCompleteRunDiagnosticHeaders({ storage: storageFake({ run: null }),
    readOutbox: async () => [pending([row(2)], { state: 'PAUSED' })],
    listArchives: async () => [{ operationId: 'run-a', state: 'RESET', eventCount: 4,
      startedAt: '2026-10-06T00:00:00.000Z' }] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'RESET');
  assert.equal(runs[0].eventCount, 4);
});

test('an empty archive and outbox produce an empty list and null latest selection', async () => {
  const ports = { storage: storageFake({ run: null }), readOutbox: async () => [], listArchives: async () => [] };
  assert.deepEqual(await listCompleteRunDiagnosticHeaders(ports), []);
  assert.equal(await latestDiagnosticOperationId(ports), null);
});

