import { mergeDiagnosticSnapshots } from './diagnostic-outbox-utils.js';
import { runDiagnosticHeader } from './run-diagnostics-utils.js';

export async function completeRunDiagnostic(operationId, { storage, readArchive, readOutbox, version = null }) {
  let archiveError = null;
  let outboxReadError = null;
  // Read the durable handoff source first. If the worker acknowledges/deletes
  // its rows while exporting, the subsequent archive read already sees them.
  // Parallel reads could see the archive before the write and outbox after ACK.
  const [pending, local] = await Promise.all([
    readOutbox(operationId).catch(error => { outboxReadError = String(error?.message || error); return null; }),
    storage.get(['run', 'queue'])
  ]);
  const archive = await readArchive(operationId).catch(error => {
    archiveError = String(error?.message || error); return null;
  });
  const live = local.run?.operationId === operationId ? {
    operationId, header: runDiagnosticHeader(local.run, local.queue, version), records: local.run.eventJournal || []
  } : null;
  const combined = mergeDiagnosticSnapshots(archive, pending, live);
  if (!combined) {
    if (archiveError || outboxReadError) throw new Error(archiveError || outboxReadError);
    return null;
  }
  return { run: combined.header, events: combined.records,
    archiveError: archiveError || pending?.archiveError || null, outboxReadError };
}

export async function listCompleteRunDiagnosticHeaders({ storage, listArchives, readOutbox, version = null, limit = 500 }) {
  // Keep the same handoff order as the event export. An outbox-only run must
  // remain selectable after Reset even if IndexedDB is temporarily unavailable.
  const pending = await readOutbox().catch(() => []);
  const [archived, local] = await Promise.all([
    listArchives({ limit }).catch(() => []), storage.get(['run', 'queue'])
  ]);
  const byId = new Map();
  for (const header of archived) byId.set(header.operationId, { header, records: [] });
  for (const snapshot of pending) byId.set(snapshot.operationId,
    mergeDiagnosticSnapshots(byId.get(snapshot.operationId), snapshot));
  if (local.run?.operationId) {
    const live = { operationId: local.run.operationId,
      header: runDiagnosticHeader(local.run, local.queue, version), records: local.run.eventJournal || [] };
    byId.set(live.operationId, mergeDiagnosticSnapshots(byId.get(live.operationId), live));
  }
  return [...byId.values()].map(snapshot => snapshot.header)
    .sort((a, b) => String(b.startedAt || b.updatedAt || '').localeCompare(String(a.startedAt || a.updatedAt || '')));
}

export async function latestDiagnosticOperationId(ports) {
  return (await listCompleteRunDiagnosticHeaders(ports))[0]?.operationId || null;
}

