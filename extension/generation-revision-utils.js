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
    lastHandledFailure: null,
    lastSendClickedAt: null,
    physicalSendAtMs: null,
    physicalSendLeaseId: null,
    rejectedSendAtMs: null,
    pageSubmissionLeaseId: null,
    pageGenerationSubmitted: null,
    pageProbeAssistantCount: null,
    pageProbeChatUrl: null,
    pageProbeAt: null,
    submissionObservationDeadlineAt: null,
    observationExpired: false,
    rendererBootstrappedAt: null,
    rendererBootstrapVisibility: null,
    noResponseSince: null,
    autoRefreshGenerationId: null,
    autoRefreshAt: null,
    legacyProbeRefreshLeaseId: null,
    legacyObservationStartedAt: null,
    legacyObservationDeadlineAt: null,
    legacyProbeRefreshAt: null,
    revisionPersistFailures: 0,
    revisionPersistRetryAt: null,
    revisionPersistBlocked: false
  };
}

export function currentLeasePhysicalSend(slot) {
  if (!slot) return false;
  const clickedAt = Date.parse(slot.lastSendClickedAt || '') || 0;
  const preparedAt = Date.parse(slot.preparedAt || '') || 0;
  const reportedAt = Number(slot.physicalSendAtMs || 0);
  const reportedForLease = Boolean(slot.leaseId)
    && String(slot.physicalSendLeaseId || '') === String(slot.leaseId);
  // Keep the physical receipt, but a known before-assistant rate rejection
  // cannot protect a nonexistent generation. A later click is independent.
  const rejectedAt = Number(slot.rejectedSendAtMs || 0);
  return reportedForLease && Number.isFinite(reportedAt) && reportedAt > Math.max(0, rejectedAt)
    || clickedAt > Math.max(0, rejectedAt) && (preparedAt === 0 || clickedAt >= preparedAt);
}

export function pageProbeConfirmsUnsubmitted(slot, probe) {
  if (!slot?.leaseId || !probe?.leaseId
    || String(slot.leaseId) !== String(probe.leaseId)
    || (String(slot.pageSubmissionLeaseId || '') === String(slot.leaseId)
      && slot.pageGenerationSubmitted === true)
    || probe.generationSubmitted !== false
    || Number(probe.assistantCount) !== 0
    || String(probe.chatUrl || '').trim()
    || String(slot.chatUrl || '').trim()
    || Number(slot.assistantCount || 0) !== 0
    || Number(probe.physicalSendAtMs || 0) > Math.max(0, Number(slot.rejectedSendAtMs || 0))
    || slot.generationSubmittedAt || slot.downloadId
    || currentLeasePhysicalSend(slot)) return false;
  return true;
}

export function canAuditSlot(slot) {
  if (!slot?.entryId || !slot?.tabId || slot.downloadId) return false;
  if (slot.observationExpired === true) return false;
  if (['STOPPED', 'DONE'].includes(slot.status)) return false;
  if (slot.finalCheckPending) return true;
  // pageRunAcceptedAt means the page accepted preparation. It allows a probe,
  // but it is never evidence that Send was clicked. Submission is determined
  // separately from a current-lease Send marker or an explicit page report.
  if (!slot.pageRunAcceptedAt && !slot.generationSubmittedAt) return false;
  return !['PAUSED', 'WAITING_LAUNCH'].includes(slot.status);
}
