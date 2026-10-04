export const RUN_DIAGNOSTICS_SCHEMA_VERSION = 1;

const OMIT_KEYS = /prompt|html|dom|snapshot|base64|dataurl|imagedata|binary|blob|screenshot|responsebody|attachments?|bodytext|(?:latest)?(?:assistant|user).*text/i;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2400;

function sanitizeValue(value, key = '', depth = 0) {
  if (OMIT_KEYS.test(String(key))) return undefined;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, '', depth + 1))
      .filter((item) => item !== undefined);
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const sanitized = sanitizeValue(childValue, childKey, depth + 1);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

export function sanitizeRunDiagnosticEvent(event, { operationId = null, sequence = null } = {}) {
  const safe = sanitizeValue(event) || {};
  return {
    schemaVersion: RUN_DIAGNOSTICS_SCHEMA_VERSION,
    operationId: String(operationId || event?.operationId || ''),
    sequence: Number(sequence ?? event?.sequence ?? 0),
    at: String(event?.at || new Date().toISOString()),
    type: String(event?.type || 'unknown'),
    category: diagnosticCategoryForType(event?.type),
    ...safe
  };
}

export function diagnosticCategoryForType(type) {
  const value = String(type || '').toLowerCase();
  if (/error|failed|mismatch|timeout|blocked|gap/.test(value)) return 'error';
  if (/pause|stop|reset|resume|retry|recover|limit|ignore|decision|scheduled/.test(value)) return 'decision';
  if (/download|output|facts|revision|completed|verified/.test(value)) return 'result';
  return 'step';
}

function completedPlannedIdsFromQueue(plannedIds, queue) {
  const planned = new Set(plannedIds.map((id) => String(id)));
  const doneIds = new Set();
  for (const entries of Object.values(queue?.groups || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const sourceId = String(entry?.sourceId || '');
      if (sourceId && planned.has(sourceId) && String(entry?.status || '').toLowerCase() === 'done') {
        doneIds.add(sourceId);
      }
    }
  }
  return doneIds;
}

export function runDiagnosticHeader(run, queue = null, extensionVersion = null) {
  if (!run?.operationId) return null;
  const plannedIds = Array.isArray(run.plannedIds) ? run.plannedIds : [];
  const planned = new Set(plannedIds.map((id) => String(id)));
  const verifiedEventIds = new Set((Array.isArray(run.eventJournal) ? run.eventJournal : [])
    .filter((event) => event?.type === 'output_verified' && event?.entryId != null)
    .map((event) => String(event.entryId))
    .filter((entryId) => planned.has(entryId)));
  const queueCompletedIds = queue?.groups
    ? completedPlannedIdsFromQueue(plannedIds, queue)
    : new Set();
  const verifiedCompletedIds = new Set([...queueCompletedIds, ...verifiedEventIds]);
  const observedCompleted = Math.max(
    Number(run.diagnosticsLastKnownCompletedCount || 0),
    verifiedCompletedIds.size
  );
  const completedCount = Math.min(planned.size, observedCompleted);
  const activeSlots = Object.values(run.slots || {}).filter((slot) => slot?.entryId
    && !['IDLE', 'DONE', 'STOPPED', 'PAUSED'].includes(String(slot.status || '').toUpperCase())).length;
  const lastEvent = Array.isArray(run.eventJournal) ? run.eventJournal.at(-1) : null;
  return sanitizeValue({
    schemaVersion: RUN_DIAGNOSTICS_SCHEMA_VERSION,
    operationId: String(run.operationId),
    extensionVersion: extensionVersion || null,
    buildId: run.buildId || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    state: run.state || null,
    status: run.status || null,
    pauseReason: run.pauseReason || null,
    filter: run.filter || null,
    filterLabel: run.filterLabel || null,
    groupId: run.groupId || null,
    runQueueMode: run.runQueueMode || null,
    coverageMode: run.coverageMode || null,
    configuration: {
      workerCount: Number(run.workerCount || 0),
      runLimit: Number(run.runLimit || 0),
      inputMode: run.inputMode || null,
      generationPauseMinutes: Number(run.generationPauseMinutes || 0),
      generationJitterSeconds: Number(run.generationJitterSeconds || 0),
      rateLimitPauseMinutes: Number(run.rateLimitPauseMinutes || 0)
    },
    plannedCount: plannedIds.length,
    completedCount,
    pendingCount: Math.max(0, plannedIds.length - completedCount),
    activeSlotCount: activeSlots,
    eventCount: Number(run.eventSequence || run.eventCount || 0),
    lastEventAt: lastEvent?.at || null,
    lastActivityAt: run.lastActivityAt || null,
    currentAction: run.currentAction || null,
    error: run.error?.message || run.error || null,
    stopBlocked: run.stopBlocked || null,
    rateLimitPauseUntil: run.rateLimitPauseUntil || null,
    rateLimitReason: run.rateLimitReason || null,
    stalledBatchRecovery: run.stalledBatchRecovery || null,
    conversationRecovery: run.conversationRecovery || null,
    factsErrorCount: Object.values(run.factsProgress || {}).filter((job) => String(job?.stage || '').toUpperCase() === 'ERROR').length,
    diagnosticsPersistenceError: run.diagnosticsPersistenceError || null
  }) || {};
}
