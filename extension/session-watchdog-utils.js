export const SESSION_STALL_TIMEOUT_MS = 10 * 60_000;
export const SESSION_WATCHDOG_INTERVAL_MS = 30_000;

export function sessionWatchdogBlock(run, now = Date.now(), locks = {}) {
  if (!run?.operationId || !(run.plannedIds || []).length) return { reason: 'no_run' };
  const unfinishedFacts = run.status === 'DONE_WITH_FACTS_ERRORS';
  if (['STOPPED', 'RESET'].includes(String(run.state)) || (run.state === 'DONE' && !unfinishedFacts)) {
    return { reason: 'finished' };
  }
  if (run.clockStopped || run.stopBlocked || run.pauseReason === 'USER') return { reason: 'user_pause' };
  if (locks.manualExtensionUpdateLock?.active || locks.resultsImportJournal) return { reason: 'application_operation' };
  if (run.uploadManualPause) return { reason: 'storage_full' };
  const errorClass = String(run.error?.code || run.error?.errorClass || run.pauseReason || '').toUpperCase();
  if (['AUTH_REQUIRED', 'SECURITY_CHALLENGE'].includes(errorClass)) return { reason: 'account_attention' };
  const quotaUntil = Number(run.rateLimitPauseUntil || 0);
  // An inferred upload outage is not proof of a server quota. It must remain
  // eligible for the last-resort recovery instead of hiding for three hours.
  const confirmedQuota = run.imageLimitDetected === true || run.uploadLimitDetected === true
    || (quotaUntil > now && !run.uploadCooldownActive);
  if (confirmedQuota && quotaUntil > now) return { reason: 'confirmed_quota', dueAt: quotaUntil };
  const launchUntil = Math.max(0, ...Object.values(run.slots || {})
    .filter(slot => slot?.preparedForSubmit && slot?.status === 'READY_TO_SEND')
    .map(slot => Number(slot.launchWaitUntil || 0)));
  if (launchUntil > now && Number(run.generationPauseMinutes || 0) * 60_000 >= SESSION_STALL_TIMEOUT_MS) {
    return { reason: 'configured_launch_pause', dueAt: launchUntil };
  }
  return null;
}

export function ensureSessionWatchdog(run, now = Date.now()) {
  if (!run?.operationId) return null;
  if (!run.sessionWatchdog) {
    const usefulEvents = (run.eventJournal || []).filter(event => event.type === 'output_verified'
      || (event.type === 'facts_stage' && event.stage === 'SAVED'));
    const lastAt = Date.parse(usefulEvents.at(-1)?.at || run.startedAt || '');
    run.sessionWatchdog = { lastUsefulAt: new Date(Number.isFinite(lastAt) ? Math.min(lastAt, now) : now).toISOString(),
      armedAt: null, blockedReason: null, resultKeys: [], restartCount: Number(run.sessionRestartCount || 0) };
  }
  return run.sessionWatchdog;
}

export function noteSessionUsefulProgress(run, type, data = {}, now = Date.now()) {
  if (type !== 'output_verified' && !(type === 'facts_stage' && data.stage === 'SAVED')) return false;
  const state = ensureSessionWatchdog(run, now);
  if (!state) return false;
  const key = `${type}:${data.entryId || ''}:${data.generationId || ''}:${data.factsJobId || ''}`;
  if (state.resultKeys.includes(key)) return false;
  state.resultKeys.push(key);
  state.lastUsefulAt = new Date(now).toISOString();
  state.lastUsefulKind = type === 'output_verified' ? 'photo_saved' : 'specification_saved';
  return true;
}

export function sessionWatchdogDecision(run, now = Date.now(), locks = {}) {
  const state = ensureSessionWatchdog(run, now);
  const blocked = sessionWatchdogBlock(run, now, locks);
  if (!state) return { due: false, blocked };
  if (blocked) return { due: false, blocked };
  // A legitimate pause must end with a fresh observation window. The worker
  // persists this transition before an overdue watchdog may start a reset.
  if (state.blockedReason) return { due: false, blocked: null, needsArm: true };
  const anchor = Math.max(Date.parse(state.lastUsefulAt || '') || now, Number(state.armedAt || 0));
  const idleMs = Math.max(0, now - anchor);
  return { due: idleMs >= SESSION_STALL_TIMEOUT_MS, idleMs, lastUsefulAt: state.lastUsefulAt,
    dueAt: anchor + SESSION_STALL_TIMEOUT_MS };
}

