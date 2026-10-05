// Persistent active-time clock for automation runs. The worker owns mutations;
// the side panel can use elapsedRunClock() to render from the persisted fields.
const ACTIVE_RUN_STATES = new Set(['RUNNING', 'STARTING', 'DRAINING']);
const FROZEN_STATUSES = new Set(['RATE_LIMIT_PAUSE', 'RETRY_BACKOFF']);
const FROZEN_RECOVERY_STAGES = new Set(['CLOSING', 'WAITING', 'RESTARTING', 'INSPECTING', 'REOPENING']);

const PAUSE_EVENTS = new Set([
  'run_pause_requested',
  'run_pause_applied',
  'run_stop_requested',
  'run_paused_on_error',
  'rate_limit_pause',
  'image_limit_pause',
  'run_retry_backoff_scheduled',
  'stalled_batch_recovery_started',
  'stalled_batch_recovery_waiting',
  'conversation_load_recovery_started',
  'run_stop_accepted',
  'run_completed'
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function eventsFor(run) {
  const events = Array.isArray(run?.eventJournal) ? run.eventJournal
    : Array.isArray(run?.recentEvents) ? run.recentEvents : [];
  return events
    .map((event, index) => ({ event, at: timestampMs(event?.at), index }))
    .filter((item) => item.at != null)
    .sort((left, right) => left.at - right.at || left.index - right.index);
}

function terminalRun(run) {
  return ['DONE', 'STOPPED'].includes(String(run?.state || '').toUpperCase());
}

function stopRequestedAfterContinue(run, events = eventsFor(run)) {
  let latestStopAt = null;
  let latestResumeAt = null;
  for (const { event, at } of events) {
    if (event?.type === 'run_stop_requested') latestStopAt = at;
    if (event?.type === 'run_resumed') latestResumeAt = at;
  }
  return Boolean(run?.stopBlocked) || (latestStopAt != null && (latestResumeAt == null || latestStopAt > latestResumeAt));
}

function clockEligible(run, now = Date.now()) {
  if (!run || terminalRun(run) || run.clockStopped === true) return false;
  const state = String(run.state || '').toUpperCase();
  if (!ACTIVE_RUN_STATES.has(state)) return false;

  const status = String(run.status || '').toUpperCase();
  if (FROZEN_STATUSES.has(status) || status.startsWith('PAUSED') || status.includes('RECOVERY')) return false;
  if (String(run.pauseReason || '').trim()) return false;
  if (Number(run.rateLimitPauseUntil || 0) > now || status === 'RATE_LIMIT_PAUSE') return false;
  if (run.imageLimitDetected === true) return false;

  const stalledStage = String(run.stalledBatchRecovery?.stage || '').toUpperCase();
  if (FROZEN_RECOVERY_STAGES.has(stalledStage)) return false;
  const conversationStage = String(run.conversationRecovery?.stage || '').toUpperCase();
  if (FROZEN_RECOVERY_STAGES.has(conversationStage)) return false;
  // New clocks persist the Stop latch directly; avoid sorting the diagnostic
  // journal on every UI refresh or worker publish. Legacy clocks still infer
  // a pending Stop from the event history once during migration.
  if (Number(run.clockVersion) >= 1 && finiteNumber(run.clockAccumulatedMs) != null) {
    return !run.stopBlocked;
  }
  return !stopRequestedAfterContinue(run);
}

function latestEventTime(events, types) {
  let latest = null;
  for (const { event, at } of events) {
    if (types.has(event?.type)) latest = at;
  }
  return latest;
}

function inactiveBoundary(run, now, events = eventsFor(run)) {
  if (terminalRun(run)) {
    const finished = timestampMs(run.finishedAt)
      ?? latestEventTime(events, new Set(['run_stop_accepted', 'run_completed']));
    if (finished != null) return Math.min(now, finished);
  }

  const recoveryStage = String(run.stalledBatchRecovery?.stage || '').toUpperCase();
  if (FROZEN_RECOVERY_STAGES.has(recoveryStage)) {
    const recoveryAt = timestampMs(run.stalledBatchRecovery?.waitStartedAt)
      ?? timestampMs(run.stalledBatchRecovery?.triggeredAt)
      ?? latestEventTime(events, new Set(['stalled_batch_recovery_started', 'stalled_batch_recovery_waiting']));
    if (recoveryAt != null) return Math.min(now, recoveryAt);
  }
  const conversationStage = String(run.conversationRecovery?.stage || '').toUpperCase();
  if (FROZEN_RECOVERY_STAGES.has(conversationStage)) {
    const recoveryAt = timestampMs(run.conversationRecovery?.startedAt)
      ?? latestEventTime(events, new Set(['conversation_load_recovery_started']));
    if (recoveryAt != null) return Math.min(now, recoveryAt);
  }

  const eventPauseAt = latestEventTime(events, PAUSE_EVENTS);
  const cooldownAt = timestampMs(run.rateLimitPauseStartedAt);
  const activityAt = timestampMs(run.lastActivityAt);
  const stopAt = run.stopBlocked ? timestampMs(run.stopBlocked.at) : null;
  const boundaries = [eventPauseAt, cooldownAt, stopAt, activityAt].filter((value) => value != null && value <= now);
  if (boundaries.length) return Math.max(...boundaries);
  // For an old paused run with no usable boundary, freezing at its last known
  // active timestamp avoids charging an arbitrarily long worker sleep.
  return null;
}

function legacyStopLatch(run, events) {
  return terminalRun(run) || stopRequestedAfterContinue(run, events);
}

function migrateLegacyClock(run, now) {
  const startedAt = timestampMs(run?.startedAt);
  const events = eventsFor(run);
  const stopped = legacyStopLatch(run, events);
  if (startedAt == null) {
    return { accumulatedMs: 0, activeSinceMs: null, stopped };
  }

  let accumulatedMs = 0;
  let activeSinceMs = startedAt;
  for (const { event, at } of events) {
    const type = String(event?.type || '');
    if (type === 'run_started') {
      if (activeSinceMs == null) activeSinceMs = at;
      continue;
    }
    if (PAUSE_EVENTS.has(type)) {
      if (activeSinceMs != null && at >= activeSinceMs) accumulatedMs += at - activeSinceMs;
      activeSinceMs = null;
      continue;
    }
    const resumes = type === 'run_resumed'
      || type === 'scheduled_retry_due'
      || (type === 'rate_limit_resume' && event.paused !== true);
    if (resumes && activeSinceMs == null) activeSinceMs = at;
  }

  const active = !stopped && clockEligible({ ...run, clockStopped: false }, now);
  if (active) {
    if (activeSinceMs == null) {
      // The journal may be truncated or missing a resume event. Start at the
      // last persisted activity boundary rather than backdating across sleep.
      activeSinceMs = timestampMs(run.lastActivityAt) ?? now;
    }
    return { accumulatedMs: Math.max(0, accumulatedMs), activeSinceMs, stopped: false };
  }

  if (activeSinceMs != null) {
    const boundary = inactiveBoundary(run, now, events) ?? activeSinceMs;
    accumulatedMs += Math.max(0, boundary - activeSinceMs);
  }
  return {
    accumulatedMs: Math.max(0, accumulatedMs),
    activeSinceMs: null,
    stopped
  };
}

function clockFields(run, now) {
  const storedAccumulated = finiteNumber(run?.clockAccumulatedMs);
  if (Number(run?.clockVersion) >= 1 && storedAccumulated != null) {
    return {
      accumulatedMs: Math.max(0, storedAccumulated),
      activeSinceMs: timestampMs(run.clockActiveSinceMs),
      stopped: run.clockStopped === true
    };
  }
  return migrateLegacyClock(run, now);
}

function applyClockFields(run, fields) {
  if (!run || typeof run !== 'object') return fields;
  run.clockVersion = 1;
  run.clockAccumulatedMs = Math.max(0, fields.accumulatedMs);
  run.clockActiveSinceMs = fields.activeSinceMs;
  run.clockStopped = fields.stopped === true;
  return fields;
}

/** Bring the persisted clock fields in line with the run's current state. */
export function syncRunClock(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return 0;
  const fields = clockFields(run, now);
  let accumulatedMs = fields.accumulatedMs;
  let activeSinceMs = fields.activeSinceMs;
  let stopped = fields.stopped;
  const terminal = terminalRun(run);
  const active = !stopped && clockEligible({ ...run, clockStopped: false }, now);

  if (activeSinceMs != null && !active) {
    const boundary = inactiveBoundary(run, now);
    const endAt = terminal ? (timestampMs(run.finishedAt) ?? now) : (boundary ?? activeSinceMs);
    accumulatedMs += Math.max(0, Math.min(now, endAt) - activeSinceMs);
    activeSinceMs = null;
  } else if (active && activeSinceMs == null) {
    activeSinceMs = now;
  }

  if (terminal) {
    stopped = true;
    activeSinceMs = null;
  }
  applyClockFields(run, { accumulatedMs, activeSinceMs, stopped });
  return elapsedRunClock(run, now);
}

/** Read elapsed active time without mutating persisted state. */
export function elapsedRunClock(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return null;
  const fields = clockFields(run, now);
  if (fields.activeSinceMs == null || fields.stopped || !clockEligible({ ...run, clockStopped: fields.stopped }, now)) {
    return Math.max(0, fields.accumulatedMs);
  }
  return Math.max(0, fields.accumulatedMs + Math.max(0, now - fields.activeSinceMs));
}

/** Settle an active interval before the worker changes state to PAUSED. */
export function pauseRunClock(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return 0;
  // This helper is called at the transition boundary, which can be after the
  // caller has already changed `state` or `status`. Settle through `now`
  // directly instead of letting syncRunClock infer an older fallback boundary.
  const fields = clockFields(run, now);
  let accumulatedMs = Math.max(0, fields.accumulatedMs);
  if (fields.activeSinceMs != null && !fields.stopped) {
    accumulatedMs += Math.max(0, now - fields.activeSinceMs);
  }
  applyClockFields(run, { accumulatedMs, activeSinceMs: null, stopped: fields.stopped });
  return Math.max(0, Number(run.clockAccumulatedMs || 0));
}

/** Resume only on an explicit Continue or an automatic cooldown completion. */
export function resumeRunClock(run, now = Date.now()) {
  if (!run || typeof run !== 'object' || terminalRun(run)) return 0;
  syncRunClock(run, now);
  run.clockStopped = false;
  run.clockActiveSinceMs = now;
  run.clockVersion = 1;
  return elapsedRunClock(run, now);
}

/** Latch elapsed time as soon as Stop is requested, including blocked stops. */
export function stopRunClock(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return 0;
  pauseRunClock(run, now);
  run.clockStopped = true;
  run.clockActiveSinceMs = null;
  run.clockVersion = 1;
  return Math.max(0, Number(run.clockAccumulatedMs || 0));
}
