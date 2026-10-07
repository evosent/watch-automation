import { sanitizeRunDiagnosticEvent } from './run-diagnostics-utils.js';

export const RUN_DIAGNOSTIC_OUTBOX_KEY = 'runDiagnosticOutbox';
export const RUN_DIAGNOSTIC_OUTBOX_SCHEMA_VERSION = 1;

function safeHeader(header, operationId) {
  const source = header && typeof header === 'object' ? header : {};
  const safe = sanitizeRunDiagnosticEvent({ ...source, operationId, sequence: 0, type: 'outbox_header' });
  const result = { operationId };
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(safe, key) && !['sequence', 'type', 'category', 'at'].includes(key)) result[key] = safe[key];
  }
  return result;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const header = snapshot.header || snapshot.run || {};
  const operationId = String(snapshot.operationId || header.operationId || '');
  if (!operationId) return null;
  const records = [];
  const sourceRecords = snapshot.records || snapshot.events || [];
  for (const record of Array.isArray(sourceRecords) ? sourceRecords : []) {
    const sequence = Number(record?.sequence || 0);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) continue;
    if (record.operationId && String(record.operationId) !== operationId) continue;
    records.push(sanitizeRunDiagnosticEvent({ ...record, operationId, sequence }));
  }
  const snapshotSequence = Number(snapshot.maxSequence || 0);
  const headerSequence = Number(header.eventCount || 0);
  return { operationId, header: safeHeader(header, operationId), records,
    maxSequence: Math.max(0, Number.isSafeInteger(snapshotSequence) ? snapshotSequence : 0,
      Number.isSafeInteger(headerSequence) ? headerSequence : 0,
      ...records.map((record) => record.sequence)) };
}

// Arguments are ordered from oldest to newest. The same event identity is
// [operationId, sequence]; a fresh header can update state without new events.
export function mergeDiagnosticSnapshots(...snapshots) {
  let operationId = null;
  let header = {};
  let headerSequence = -1;
  let maxSequence = 0;
  const records = new Map();
  for (const source of snapshots.flat().filter(Boolean)) {
    const snapshot = normalizeSnapshot(source);
    if (!snapshot) continue;
    if (operationId && snapshot.operationId !== operationId) {
      throw new Error('Cannot merge diagnostic snapshots from different runs');
    }
    operationId = snapshot.operationId;
    // A delayed old flush can arrive after a newer transition. It may fill
    // missing rows but must not move the archived run header backwards.
    if (snapshot.maxSequence >= headerSequence) {
      header = { ...header, ...snapshot.header };
      headerSequence = snapshot.maxSequence;
    }
    maxSequence = Math.max(maxSequence, snapshot.maxSequence);
    for (const record of snapshot.records) records.set(record.sequence, record);
  }
  if (!operationId) return null;
  return { operationId, header, records: [...records.values()].sort((a, b) => a.sequence - b.sequence), maxSequence };
}

function compactRecords(snapshot, maxRecords) {
  if (snapshot.records.length <= maxRecords) return snapshot;
  const capacity = maxRecords - 1;
  const important = snapshot.records.filter((record) => record.category !== 'step');
  const selected = important.slice(-capacity);
  if (selected.length < capacity) selected.push(...snapshot.records
    .filter((record) => record.category === 'step').slice(-(capacity - selected.length)));
  const retained = new Set(selected.map((record) => record.sequence));
  const dropped = snapshot.records.filter((record) => !retained.has(record.sequence));
  const ranges = [];
  const types = {};
  let droppedDecisionCount = 0;
  let lostEventCount = 0;
  for (const record of dropped) {
    const previous = ranges.at(-1);
    if (previous && previous.through + 1 === record.sequence) previous.through = record.sequence;
    else ranges.push({ from: record.sequence, through: record.sequence });
    types[record.type] = (types[record.type] || 0) + 1;
    droppedDecisionCount += record.category === 'decision' ? 1 : 0;
    lostEventCount += Number(record.lostEventCount || 1);
  }
  const gap = sanitizeRunDiagnosticEvent({
    operationId: snapshot.operationId,
    sequence: dropped.at(-1).sequence,
    at: new Date().toISOString(),
    type: 'diagnostics_gap',
    reason: 'durable_outbox_capacity',
    missingFromSequence: dropped[0].sequence,
    missingThroughSequence: dropped.at(-1).sequence,
    missingRanges: ranges,
    missingRangeCount: ranges.length,
    lostEventCount,
    droppedDecisionCount,
    droppedTypes: types,
    retainedCount: selected.length,
    capacity: maxRecords
  });
  return { ...snapshot, records: [...selected, gap].sort((a, b) => a.sequence - b.sequence) };
}

function fingerprint(value) { return JSON.stringify(value); }

// Only the short storage operations are serialized. IndexedDB may be slow or
// unavailable, so its await must not prevent new decisions reaching storage.
export function createDiagnosticOutbox({ storage, archive, maxRecordsPerRun = 4000, maxDrainBatches = 64 } = {}) {
  if (!storage?.get || !storage?.set || typeof archive !== 'function') {
    throw new Error('Diagnostic outbox requires storage.get/set and an archive function');
  }
  const recordLimit = Number(maxRecordsPerRun);
  const batchLimit = Number(maxDrainBatches);
  const capacity = Math.max(2, Math.floor(Number.isFinite(recordLimit) ? recordLimit : 4000));
  const drainLimit = Math.max(1, Math.floor(Number.isFinite(batchLimit) ? batchLimit : 64));
  let localChain = Promise.resolve();
  let drainInFlight = null;
  const serial = (callback) => {
    const operation = localChain.then(callback);
    localChain = operation.catch(() => {});
    return operation;
  };
  async function load() {
    const saved = (await storage.get(RUN_DIAGNOSTIC_OUTBOX_KEY))?.[RUN_DIAGNOSTIC_OUTBOX_KEY];
    const runs = Object.create(null);
    for (const [operationId, value] of Object.entries(saved?.runs || {})) {
      const snapshot = normalizeSnapshot(value);
      if (!snapshot || snapshot.operationId !== operationId) continue;
      runs[operationId] = { ...snapshot,
        archiveError: value.archiveError || null,
        archiveFailedAt: value.archiveFailedAt || null };
    }
    return { schemaVersion: RUN_DIAGNOSTIC_OUTBOX_SCHEMA_VERSION, runs };
  }
  async function save(state) {
    await storage.set({ [RUN_DIAGNOSTIC_OUTBOX_KEY]: state });
  }
  async function persist(source) {
    const incoming = normalizeSnapshot(source);
    if (!incoming) throw new Error('Diagnostic outbox snapshot requires an operationId');
    return serial(async () => {
      const state = await load();
      const previous = state.runs[incoming.operationId];
      const merged = compactRecords(mergeDiagnosticSnapshots(previous, incoming), capacity);
      state.runs[incoming.operationId] = { ...merged,
        archiveError: previous?.archiveError || null, archiveFailedAt: previous?.archiveFailedAt || null };
      await save(state);
      return structuredClone(state.runs[incoming.operationId]);
    });
  }
  async function read(operationId = null) {
    return serial(async () => {
      const state = await load();
      return structuredClone(operationId == null ? Object.values(state.runs) : state.runs[String(operationId)] || null);
    });
  }
  async function performDrain() {
    const summary = { persistedRuns: 0, persistedEvents: 0, remainingRuns: 0, failures: [] };
    const failed = new Set();
    const persistedRuns = new Set();
    for (let batch = 0; batch < drainLimit; batch += 1) {
      const snapshot = await serial(async () => {
        const state = await load();
        return structuredClone(Object.values(state.runs).find((value) => !failed.has(value.operationId)) || null);
      });
      if (!snapshot) break;
      try {
        await archive(snapshot.header, snapshot.records);
      } catch (error) {
        const message = String(error?.message || error || 'Run diagnostic archive failed').slice(0, 1200);
        failed.add(snapshot.operationId);
        summary.failures.push({ operationId: snapshot.operationId, error: message });
        await serial(async () => {
          const state = await load();
          const current = state.runs[snapshot.operationId];
          if (!current) return;
          current.archiveError = message;
          current.archiveFailedAt = new Date().toISOString();
          await save(state);
        });
        continue;
      }
      await serial(async () => {
        const state = await load();
        const current = state.runs[snapshot.operationId];
        if (!current) return;
        const acknowledged = new Map(snapshot.records.map((record) => [record.sequence, fingerprint(record)]));
        current.records = current.records.filter((record) => acknowledged.get(record.sequence) !== fingerprint(record));
        const sameHeader = fingerprint(current.header) === fingerprint(snapshot.header);
        if (!current.records.length && sameHeader) delete state.runs[snapshot.operationId];
        else {
          current.archiveError = null;
          current.archiveFailedAt = null;
        }
        await save(state);
      });
      persistedRuns.add(snapshot.operationId);
      summary.persistedEvents += snapshot.records.length;
    }
    summary.persistedRuns = persistedRuns.size;
    summary.remainingRuns = (await read()).length;
    return summary;
  }
  function drain() {
    if (drainInFlight) return drainInFlight;
    drainInFlight = performDrain().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }
  return { persist, drain, read };
}

