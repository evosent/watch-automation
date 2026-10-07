import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticOutbox, mergeDiagnosticSnapshots, RUN_DIAGNOSTIC_OUTBOX_KEY
} from '../extension/diagnostic-outbox-utils.js';
import { saveRunDiagnostics, getRunDiagnostic } from '../extension/idb.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storageFake(initial = {}) {
  let values = structuredClone(initial);
  let rejectWrites = false;
  return {
    async get(key) { await Promise.resolve(); return { [key]: structuredClone(values[key]) }; },
    async set(patch) {
      await Promise.resolve();
      if (rejectWrites) throw new Error('Local storage unavailable');
      values = { ...values, ...structuredClone(patch) };
    },
    inspect() { return structuredClone(values); },
    rejectWrites(value) { rejectWrites = value; }
  };
}

function event(sequence, type = 'run_pause_applied', extra = {}) {
  return { operationId: 'run-a', sequence, type, at: `2026-10-06T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`, ...extra };
}

function snapshot(records = [], patch = {}) {
  const operationId = patch.operationId || 'run-a';
  return { operationId, header: { operationId, state: 'PAUSED', eventCount: records.at(-1)?.sequence || 0,
    startedAt: '2026-10-06T00:00:00.000Z', ...patch },
    records: records.map((record) => ({ ...record, operationId })) };
}

function archiveFake() {
  const calls = [];
  const archive = async (header, records) => { calls.push(structuredClone({ header, records })); };
  return { archive, calls };
}

test('significant decisions are stored locally before any archive write and survive worker recreation', async () => {
  const storage = storageFake();
  const writes = archiveFake();
  const first = createDiagnosticOutbox({ storage, archive: writes.archive });
  await first.persist(snapshot([event(1, 'session_reset_requested'), event(2, 'session_reset_completed')]));
  assert.equal(writes.calls.length, 0);
  assert.equal(storage.inspect()[RUN_DIAGNOSTIC_OUTBOX_KEY].runs['run-a'].records.length, 2);
  // The live run can already be cleared; the separate outbox retains outcomes.
  await storage.set({ run: null });
  const restarted = createDiagnosticOutbox({ storage, archive: writes.archive });
  assert.deepEqual((await restarted.read('run-a')).records.map((row) => row.type),
    ['session_reset_requested', 'session_reset_completed']);
  const result = await restarted.drain();
  assert.equal(result.persistedEvents, 2);
  assert.equal(await restarted.read('run-a'), null);
});

test('an unavailable archive retains the entire payload and failure reason across recreation', async () => {
  const storage = storageFake();
  const first = createDiagnosticOutbox({ storage, archive: async () => { throw new Error('IDB timed out'); } });
  await first.persist(snapshot([event(1, 'rate_limit_pause'), event(2, 'run_resumed')]));
  const failure = await first.drain();
  assert.equal(failure.failures[0].error, 'IDB timed out');
  assert.equal(failure.remainingRuns, 1);
  const saved = await first.read('run-a');
  assert.equal(saved.archiveError, 'IDB timed out');
  assert.ok(saved.archiveFailedAt);
  assert.deepEqual(saved.records.map((row) => row.sequence), [1, 2]);
  const writes = archiveFake();
  const recreated = createDiagnosticOutbox({ storage, archive: writes.archive });
  await recreated.drain();
  assert.deepEqual(writes.calls[0].records.map((row) => row.sequence), [1, 2]);
  assert.equal(await recreated.read('run-a'), null);
});

test('an archive await does not block incoming local decisions or erase them on acknowledgement', async () => {
  const storage = storageFake();
  const gate = deferred();
  const entered = deferred();
  const calls = [];
  const outbox = createDiagnosticOutbox({ storage, maxDrainBatches: 1,
    archive: async (header, records) => { calls.push(structuredClone({ header, records })); entered.resolve(); await gate.promise; } });
  await outbox.persist(snapshot([event(1)]));
  const draining = outbox.drain();
  await entered.promise;
  await outbox.persist(snapshot([event(2, 'run_resumed')], { state: 'RUNNING' }));
  assert.deepEqual((await outbox.read('run-a')).records.map((row) => row.sequence), [1, 2]);
  gate.resolve();
  const result = await draining;
  assert.equal(result.remainingRuns, 1);
  const pending = await outbox.read('run-a');
  assert.deepEqual(pending.records.map((row) => row.sequence), [2]);
  assert.equal(pending.header.state, 'RUNNING');
  await outbox.drain();
  assert.deepEqual(calls.map((call) => call.records.map((row) => row.sequence)), [[1], [2]]);
  assert.equal(await outbox.read('run-a'), null);
});

test('a newer header without new events is preserved while an earlier header is archived', async () => {
  const storage = storageFake();
  const gate = deferred();
  const entered = deferred();
  const calls = [];
  const outbox = createDiagnosticOutbox({ storage, maxDrainBatches: 1,
    archive: async (header, records) => { calls.push(structuredClone({ header, records })); entered.resolve(); await gate.promise; } });
  await outbox.persist(snapshot([event(1)]));
  const draining = outbox.drain();
  await entered.promise;
  await outbox.persist(snapshot([], { state: 'RUNNING', eventCount: 1 }));
  gate.resolve();
  await draining;
  const current = await outbox.read('run-a');
  assert.equal(current.header.state, 'RUNNING');
  assert.equal(current.records.length, 0);
  await outbox.drain();
  assert.equal(calls[1].header.state, 'RUNNING');
});

test('a changed record at an acknowledged sequence is retained for the next archive write', async () => {
  const storage = storageFake();
  const gate = deferred();
  const entered = deferred();
  const calls = [];
  const outbox = createDiagnosticOutbox({ storage, maxDrainBatches: 1,
    archive: async (header, records) => { calls.push(structuredClone(records)); entered.resolve(); await gate.promise; } });
  await outbox.persist(snapshot([event(1, 'recovery_deferred', { reason: 'downloading' })]));
  const draining = outbox.drain();
  await entered.promise;
  await outbox.persist(snapshot([event(1, 'recovery_deferred', { reason: 'download_completed' })]));
  gate.resolve();
  await draining;
  assert.equal((await outbox.read('run-a')).records[0].reason, 'download_completed');
  await outbox.drain();
  assert.equal(calls[1][0].reason, 'download_completed');
});

test('simultaneous local writes merge without lost updates', async () => {
  const storage = storageFake();
  const writes = archiveFake();
  const outbox = createDiagnosticOutbox({ storage, archive: writes.archive });
  await Promise.all(Array.from({ length: 20 }, (_, index) => outbox.persist(snapshot([event(index + 1)]))));
  assert.deepEqual((await outbox.read('run-a')).records.map((row) => row.sequence),
    Array.from({ length: 20 }, (_, index) => index + 1));
});

test('events from separate runs remain independent even when sequence numbers match', async () => {
  const storage = storageFake();
  const writes = archiveFake();
  const outbox = createDiagnosticOutbox({ storage, archive: writes.archive });
  await outbox.persist(snapshot([event(1)]));
  await outbox.persist(snapshot([event(1, 'image_limit_pause')], { operationId: 'run-b' }));
  assert.equal((await outbox.read()).length, 2);
  const result = await outbox.drain();
  assert.equal(result.persistedRuns, 2);
  assert.deepEqual(writes.calls.map((call) => [call.header.operationId, call.records[0].type]),
    [['run-a', 'run_pause_applied'], ['run-b', 'image_limit_pause']]);
});

test('export merges archive, durable outbox and live journal by sequence with the latest header', () => {
  const merged = mergeDiagnosticSnapshots(
    { run: { operationId: 'run-a', state: 'RUNNING', eventCount: 2 }, events: [event(1), event(2)] },
    snapshot([event(2), event(3, 'session_reset_requested')]),
    snapshot([event(3, 'session_reset_requested'), event(4, 'session_reset_completed')], { state: 'RESET' })
  );
  assert.deepEqual(merged.records.map((row) => row.sequence), [1, 2, 3, 4]);
  assert.equal(merged.header.state, 'RESET');
  assert.equal(merged.maxSequence, 4);
});

test('merging different run identities fails explicitly', () => {
  assert.throws(() => mergeDiagnosticSnapshots(snapshot([event(1)]),
    snapshot([event(1)], { operationId: 'run-b' })), /different runs/);
});

test('a delayed older snapshot can fill missing events without reverting the run header', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  await outbox.persist(snapshot([event(3, 'run_resumed')], { state: 'RUNNING' }));
  await outbox.persist(snapshot([event(1, 'run_pause_requested'), event(2, 'run_pause_applied')], { state: 'PAUSED' }));
  const saved = await outbox.read('run-a');
  assert.equal(saved.header.state, 'RUNNING');
  assert.equal(saved.header.eventCount, 3);
  assert.deepEqual(saved.records.map((row) => row.sequence), [1, 2, 3]);
});

test('malformed event arrays and sequence metadata cannot poison a later valid snapshot', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  await outbox.persist({ operationId: 'run-a', header: { operationId: 'run-a', eventCount: 'invalid' },
    records: { unexpected: 'object' }, maxSequence: Infinity });
  await outbox.persist(snapshot([event(1)]));
  assert.equal((await outbox.read('run-a')).maxSequence, 1);
});

test('repeated drain requests share one archive operation', async () => {
  const storage = storageFake();
  const gate = deferred();
  let calls = 0;
  const outbox = createDiagnosticOutbox({ storage, archive: async () => { calls += 1; await gate.promise; } });
  await outbox.persist(snapshot([event(1)]));
  const a = outbox.drain();
  const b = outbox.drain();
  assert.equal(a, b);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('capacity pressure drops repetitive steps before any recovery decisions and records the gap', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {}, maxRecordsPerRun: 5 });
  await outbox.persist(snapshot([
    event(1, 'run_pause_applied'), event(2, 'page_state'), event(3, 'page_state'),
    event(4, 'session_reset_requested'), event(5, 'page_state'), event(6, 'page_state'),
    event(7, 'session_reset_completed'), event(8, 'run_resumed')
  ]));
  const saved = await outbox.read('run-a');
  assert.equal(saved.records.length, 5);
  assert.deepEqual(saved.records.filter((row) => row.type !== 'diagnostics_gap').map((row) => row.sequence), [1, 4, 7, 8]);
  const gap = saved.records.find((row) => row.type === 'diagnostics_gap');
  assert.equal(gap.reason, 'durable_outbox_capacity');
  assert.equal(gap.lostEventCount, 4);
  assert.equal(gap.droppedDecisionCount, 0);
  assert.deepEqual(gap.missingRanges, [{ from: 2, through: 3 }, { from: 5, through: 6 }]);
});

test('if critical decisions alone exceed capacity the loss is explicitly marked', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {}, maxRecordsPerRun: 3 });
  await outbox.persist(snapshot([event(1), event(2), event(3), event(4)]));
  const rows = (await outbox.read('run-a')).records;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.filter((row) => row.type !== 'diagnostics_gap').map((row) => row.sequence), [3, 4]);
  assert.equal(rows.find((row) => row.type === 'diagnostics_gap').droppedDecisionCount, 2);
});

test('headers and records exclude page bodies, prompts and attachments but preserve decision context', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  await outbox.persist(snapshot([event(1, 'upload_limit_pause', {
    reason: 'file_quota', prompt: 'private', html: '<body>private</body>', attachments: ['private'],
    latestAssistantText: 'private response', until: 123
  })], { prompt: 'private header', conversationRecovery: { stage: 'WAITING', dueAt: 123, html: 'private' } }));
  const saved = await outbox.read('run-a');
  assert.equal(saved.records[0].reason, 'file_quota');
  assert.equal(saved.records[0].until, 123);
  for (const key of ['prompt', 'html', 'attachments', 'latestAssistantText']) assert.equal(key in saved.records[0], false);
  assert.equal('prompt' in saved.header, false);
  assert.deepEqual(saved.header.conversationRecovery, { stage: 'WAITING', dueAt: 123 });
});

test('read returns a detached snapshot that cannot modify durable state', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  await outbox.persist(snapshot([event(1)]));
  const copy = await outbox.read('run-a');
  copy.records.length = 0;
  copy.header.state = 'DAMAGED';
  assert.equal((await outbox.read('run-a')).records.length, 1);
  assert.equal((await outbox.read('run-a')).header.state, 'PAUSED');
});

test('one run archive failure does not prevent another run being archived', async () => {
  const storage = storageFake();
  const savedIds = [];
  const outbox = createDiagnosticOutbox({ storage, archive: async (header) => {
    if (header.operationId === 'run-a') throw new Error('First run write failed');
    savedIds.push(header.operationId);
  } });
  await outbox.persist(snapshot([event(1)]));
  await outbox.persist(snapshot([event(1)], { operationId: 'run-b' }));
  const result = await outbox.drain();
  assert.deepEqual(savedIds, ['run-b']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.remainingRuns, 1);
  assert.equal((await outbox.read('run-a')).records.length, 1);
});

test('a local write failure propagates and the serialized queue remains usable', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  storage.rejectWrites(true);
  await assert.rejects(outbox.persist(snapshot([event(1)])), /Local storage unavailable/);
  storage.rejectWrites(false);
  await outbox.persist(snapshot([event(2)]));
  assert.deepEqual((await outbox.read('run-a')).records.map((row) => row.sequence), [2]);
});

test('a failed acknowledgement write keeps previously persisted payload available after recreation', async () => {
  const storage = storageFake();
  let calls = 0;
  const first = createDiagnosticOutbox({ storage, archive: async () => { calls += 1; storage.rejectWrites(true); } });
  await first.persist(snapshot([event(1, 'session_reset_completed')]));
  await assert.rejects(first.drain(), /Local storage unavailable/);
  storage.rejectWrites(false);
  const second = createDiagnosticOutbox({ storage, archive: async () => { calls += 1; } });
  assert.equal((await second.read('run-a')).records[0].type, 'session_reset_completed');
  await second.drain();
  assert.equal(calls, 2);
  assert.equal(await second.read('run-a'), null);
});

test('invalid or foreign event identities are discarded without corrupting the run', async () => {
  const storage = storageFake();
  const outbox = createDiagnosticOutbox({ storage, archive: async () => {} });
  await outbox.persist({ operationId: 'run-a', header: { operationId: 'run-a' }, records: [
    event(1), event(-1), event(0), event(2.5), event(3, 'run_resumed', { operationId: 'foreign' })
  ] });
  assert.deepEqual((await outbox.read('run-a')).records.map((row) => row.sequence), [1]);
});

test('a successful retry clears archive failure metadata and pending records', async () => {
  const storage = storageFake();
  let shouldFail = true;
  const outbox = createDiagnosticOutbox({ storage, archive: async () => { if (shouldFail) throw new Error('Transient DB error'); } });
  await outbox.persist(snapshot([event(1)]));
  await outbox.drain();
  await outbox.persist(snapshot([event(2, 'run_resumed')]));
  assert.equal((await outbox.read('run-a')).archiveError, 'Transient DB error');
  shouldFail = false;
  const result = await outbox.drain();
  assert.equal(result.failures.length, 0);
  assert.equal(await outbox.read('run-a'), null);
});

test('real IndexedDB archive receives reset decisions after the live run has been cleared', async () => {
  const operationId = `outbox-real-idb-${Date.now()}-${Math.random()}`;
  const storage = storageFake();
  const first = createDiagnosticOutbox({ storage, archive: saveRunDiagnostics });
  await first.persist(snapshot([event(1, 'session_reset_requested'), event(2, 'session_reset_completed'),
    event(3, 'session_watchdog_restart_completed')], { operationId, state: 'RESET' }));
  await storage.set({ run: null });
  const recreated = createDiagnosticOutbox({ storage, archive: saveRunDiagnostics });
  await recreated.drain();
  const actual = await getRunDiagnostic(operationId);
  assert.equal(actual.run.state, 'RESET');
  assert.deepEqual(actual.events.map((row) => row.type),
    ['session_reset_requested', 'session_reset_completed', 'session_watchdog_restart_completed']);
  assert.deepEqual(actual.events.map((row) => row.sequence), [1, 2, 3]);
});

