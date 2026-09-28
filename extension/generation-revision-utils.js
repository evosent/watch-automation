export function revisionTimestamp(record) {
  return Date.parse(record?.completedAt || record?.downloadedAt || record?.createdAt || '') || 0;
}

export function latestGenerationRevisions(records = []) {
  const latest = new Map();
  const counts = new Map();
  for (const record of records || []) {
    if (!record?.generationId || !record?.sourceId || !record?.outputPath) continue;
    const sourceId = String(record.sourceId);
    counts.set(sourceId, Number(counts.get(sourceId) || 0) + 1);
    if (record?.reviewStatus === 'rejected') continue;
    const previous = latest.get(sourceId);
    const timestampDelta = revisionTimestamp(record) - revisionTimestamp(previous);
    const deterministicTieBreak = String(record.generationId).localeCompare(String(previous?.generationId || ''));
    if (!previous || timestampDelta > 0 || (timestampDelta === 0 && deterministicTieBreak > 0)) latest.set(sourceId, record);
  }
  return new Map([...latest].map(([sourceId, record]) => [sourceId, {
    record,
    versionCount: counts.get(sourceId) || 1
  }]));
}

export function verifiedRevisionMatchesEvent(event, revision, operationId) {
  if (!event || event.type !== 'output_verified' || !event.generationId || !event.entryId || !revision) return false;
  return String(revision.operationId || '') === String(operationId || '')
    && String(revision.generationId || '') === String(event.generationId)
    && String(revision.sourceId || '') === String(event.entryId)
    && String(revision.outputPath || '') === String(event.outputPath || '')
    && (!event.sha256 || String(revision.outputHash || '').toLowerCase() === String(event.sha256).toLowerCase());
}

export function factsBelongToRevision(revision, facts) {
  if (!revision || !facts) return false;
  if (facts.generationId && facts.generationId !== revision.generationId) return false;
  if (facts.factsJobId && revision.factsJobId && facts.factsJobId !== revision.factsJobId) return false;
  if (facts.outputHash && revision.outputHash && facts.outputHash !== revision.outputHash) return false;
  return true;
}

export function immutableRevisionTuple(revision) {
  return {
    generationId: revision?.generationId || null,
    sourceId: revision?.sourceId || null,
    outputPath: revision?.outputPath || null,
    outputHash: revision?.outputHash || null,
    chatUrl: revision?.chatUrl || revision?.facts?.chatUrl || null,
    facts: revision?.facts || null,
    completedAt: revision?.completedAt || revision?.downloadedAt || null
  };
}

// A worker slot is reusable, but a revision belongs to exactly one lease/SKU.
// Keep this list in one place so resume and ordinary queue claims cannot
// accidentally carry an old image, OCR job or page context into a new item.
export function freshSlotRevisionFields() {
  return {
    generationId: null,
    previousGenerationId: undefined,
    factsJobId: null,
    outputFileName: null,
    outputGroupId: null,
    chatUrl: null,
    recipeHash: null,
    profileId: null,
    profileVersion: null,
    preparedForSubmit: false,
    preparedAt: null,
    pageRunAcceptedAt: null,
    lastSendClickedAt: null,
    rendererBootstrappedAt: null,
    rendererBootstrapVisibility: null,
    noResponseSince: null,
    autoRefreshGenerationId: null,
    autoRefreshAt: null
  };
}

export function canAuditSlot(slot) {
  if (!slot?.entryId || !slot?.tabId || slot.downloadId) return false;
  if (['STOPPED', 'DONE'].includes(slot.status)) return false;
  if (slot.finalCheckPending) return true;
  // Old persisted runs predate pageRunAcceptedAt, but a submitted prompt is
  // already safe to inspect after an extension update/restart.
  if (!slot.pageRunAcceptedAt && !slot.generationSubmittedAt) return false;
  return !['PAUSED', 'WAITING_LAUNCH'].includes(slot.status);
}
