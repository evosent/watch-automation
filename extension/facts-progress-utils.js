const TERMINAL_FACTS_STAGES = new Set(['SAVED', 'ERROR']);

export function factsStageMatchesOwner(message = {}, owner = null) {
  if (!owner) return false;
  const checks = [
    ['entryId', 'entryId'],
    ['factsJobId', 'factsJobId'],
    ['generationId', 'generationId']
  ];
  for (const [messageKey, ownerKey] of checks) {
    const expected = String(owner[ownerKey] || '');
    const received = String(message[messageKey] || '');
    if (expected && expected !== received) return false;
  }
  const expectedHash = String(owner.outputHash || '').toLowerCase();
  const receivedHash = String(message.outputHash || '').toLowerCase();
  return !expectedHash || !receivedHash || expectedHash === receivedHash;
}

export function savedFactsStageMatchesReleasedOwner(message = {}, previous = null, tabId = null) {
  return Boolean(previous && Number(previous.tabId || 0) === Number(tabId || 0)
    && Number(tabId || 0) > 0 && factsStageMatchesOwner(message, previous));
}

export function selectFactsProgressForSlot(slot, jobs = []) {
  if (!slot || !Array.isArray(jobs)) return null;
  const slotId = Number(slot.slotId);
  const currentFactsJobId = String(slot.factsJobId || '');
  const currentGenerationId = String(slot.generationId || '');

  if (currentFactsJobId) {
    return jobs.find((job) => String(job?.factsJobId || '') === currentFactsJobId
      && (!currentGenerationId || String(job?.generationId || '') === currentGenerationId)) || null;
  }

  // A slot with a current SKU/revision must never inherit another generation's
  // OCR status merely because both generations used the same worker slot.
  if (slot.entryId) return null;

  const forSlot = jobs.filter((job) => Number(job?.slotId) === slotId);
  if (!forSlot.length) return null;
  const active = forSlot.filter((job) => !TERMINAL_FACTS_STAGES.has(String(job?.stage || '').toUpperCase()));
  return [...(active.length ? active : forSlot)]
    .sort((left, right) => Number(right?.stageAtMs || 0) - Number(left?.stageAtMs || 0))[0] || null;
}
