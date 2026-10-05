import './facts-json-utils.js';
import {
  QUEUE_GROUP_IDS,
  REGENERATION_QUEUE_ID,
  RUN_PART_SIZE,
  WATCH_BRAND_FILTERS,
  applyGenerationHistory,
  applyGenerationMemory,
  filterFromQueueGroup,
  filteredWatchEntries,
  factsMetadataProjections,
  generationMemoryRecordFromEntry,
  generationMemoryStatusForQueueStatus,
  ensureGenerationOutputFileName,
  groupIdForWatchFilter,
  historyRecordFromEntry,
  GENERATION_MEMORY_STATUSES,
  normalizeCoverageMode,
  normalizeGenerationMemoryStatus,
  normalizeRunLimit,
  normalizeWatchFilter,
  normalizeWorkerCount,
  queuePartPlan,
  queueEntriesForPart,
  pendingEntryIdsForFilter,
  parseFilterSelectionId,
  queueGroupsFromCatalog,
  modelCatalogRecordsFromGroups,
  queueStatusForGenerationMemoryStatus,
  referenceDescriptorForPath,
  sourceIdFor,
  sourceVariantIdFor,
  sanitizeFilename,
  watchFilterLabel
} from './queue-utils.js';
import {
  getAsset, getAssetKeys, replaceAssets, getOutputDirectoryHandle,
  getGenerationFacts, getModelCatalog,
  getGenerationRevision, getAllGenerationRevisions, getAllModelCatalog, upsertGenerationRevision,
  beginGenerationRevision, cancelUnsubmittedGenerationRevision,
  persistGenerationImageRevision, persistGenerationFactsRevision,
  rejectGenerationRevision, saveRunDiagnostics, mergeResultsDatabase
} from './idb.js';
import { transferableRevision, planResultsMerge, resultsImportPreview } from './results-transfer-utils.js';
import { buildInputPlan, normalizeInputMode, DEFAULT_INPUT_MODE } from './input-plan.js';
import {
  verifiedRevisionMatchesEvent,
  freshSlotRevisionFields,
  canAuditSlot,
  currentLeasePhysicalSend,
  pageProbeConfirmsUnsubmitted
} from './generation-revision-utils.js';
import { factsStageMatchesOwner, savedFactsStageMatchesReleasedOwner } from './facts-progress-utils.js';
import {
  normalizedRepairQueue,
  upsertRepairQueueItem,
  selectRepairQueueEntries,
  excludeRepairQueueEntries
} from './repair-queue-utils.js';
import { brandPromptPath, buildGenerationPrompt, detectBrandProfile, resolveTitleSpec } from './prompt-profiles.js';
import { runDiagnosticHeader, sanitizeRunDiagnosticEvent } from './run-diagnostics-utils.js';
import { syncRunClock, elapsedRunClock, pauseRunClock, resumeRunClock, stopRunClock } from './run-clock-utils.js';
import {
  AUTOMATION_ERROR_CLASSES,
  CONVERSATION_LOAD_RECOVERY_DELAY_MS,
  SLOT_PHASES,
  classifyAutomationError,
  coalescedPauseDeadline,
  imageLimitResumeAt,
  generationId,
  isMeaningfulProgress,
  normalizeGenerationJitterSeconds,
  normalizeGenerationPauseMinutes,
  normalizeRateLimitIgnoreMinutes,
  isRateLimitIgnored,
  isUserPauseCancellation,
  resolveGenerationPause,
  retryDelayMs,
  scheduledRunRetries,
  stableHash,
  shouldRefreshUnresponsiveGeneration,
  isStalledUnsubmittedPreparation,
  shouldRefreshStalledGeneration,
  shouldExpireSubmittedObservation,
  PREPARATION_STALL_AFTER_MS,
  SUBMITTED_STALL_REFRESH_AFTER_MS,
  findStalledBatchRecoveryCandidate,
  shouldTripAttachmentFailureCircuitBreaker,
  STALLED_BATCH_RECOVERY_DELAY_MS
} from './reliability-utils.js';

const DEFAULT_WORKERS = 4;
const AUTOMATION_URL = 'https://chatgpt.com/?watch_automation=1';
const AUTOMATION_SESSION_KEY = '__watch_automation_tab_v1';
const AUTOMATION_CONTEXT_KEY = '__watch_automation_context_v2';
const AUTOMATION_CONTENT_SCRIPT_FILES = [
  'automation-gate.js',
  'dom-recorder.js',
  'selector-resolver.js',
  'overlay.js',
  'facts-json-utils.js',
  'chatgpt-adapter.js',
  'content-script.js'
];
const AUDIT_ALARM_NAME = 'watch-automation-generation-audit';
const AUDIT_INTERVAL_MS = 5000;
const GENERATION_SEND_ALARM_PREFIX = 'watch-automation-generation-send:';
const FOCUS_AUDIT_INTERVAL_MS = 30000;
// A content script can be present and answer PING while a later message is
// stuck behind a page modal or an obsolete listener. Bound every transport
// request so one slot cannot remain STARTING forever.
const TAB_MESSAGE_TIMEOUT_MS = 30000;
const PREPARE_PAGE_TIMEOUT_MS = 300000;
// An error can appear before ChatGPT finishes mounting the image. Keep the
// failed slot observable for the same 15-minute window as a regular generation.
const FINAL_CHECK_TIMEOUT_MS = 900000;
const MAX_AUTOMATIC_PREPARATION_RECOVERIES = 2;
const MAX_ARTIFACT_REVISION_PERSIST_FAILURES = 3;
const RATE_LIMIT_PAUSE_MS = 180000;
const DEFAULT_RATE_LIMIT_PAUSE_MINUTES = RATE_LIMIT_PAUSE_MS / 60000;
const MIN_RATE_LIMIT_PAUSE_MINUTES = 1;
const MAX_RATE_LIMIT_PAUSE_MINUTES = 30;
const RATE_LIMIT_RESUME_ALARM_NAME = 'watch-automation-rate-limit-resume';
const CONVERSATION_LOAD_RECOVERY_ALARM_NAME = 'watch-automation-conversation-load-recovery';
const STALLED_BATCH_RECOVERY_ALARM_NAME = 'watch-automation-stalled-batch-recovery';
const REVISION_FACTS_RECOVERY_ALARM_NAME = 'watch-automation-revision-facts-recovery';
const DEV_RELOAD_ALARM_NAME = 'watch-automation-dev-reload';
const DEV_RELOAD_STATUS_URL = 'http://127.0.0.1:17321/status';
const DEV_RELOAD_POLL_TIMEOUT_MS = 1200;
const DEV_UPDATE_STATUS_URL = 'http://127.0.0.1:17321/update/status';
const DEV_UPDATE_START_URL = 'http://127.0.0.1:17321/update';
const DEV_UPDATE_APPLY_URL = 'http://127.0.0.1:17321/update/apply';
const DEV_CONTROL_URL = 'http://127.0.0.1:17321/control';
const DEV_LOCAL_INPUT_FILES_URL = 'http://127.0.0.1:17321/local-input-files';
const DEV_LOCAL_INPUT_FILE_URL = 'http://127.0.0.1:17321/local-input-file';
const DEV_CONTROL_POLL_TIMEOUT_MS = 1200;
const DOM_EVENT_ENDPOINT = 'http://127.0.0.1:17321/dom-events';
const DOM_EVENT_BUFFER_LIMIT = 250;
const DOM_EVENT_POST_TIMEOUT_MS = 4000;
const DIAGNOSTIC_ENDPOINT = 'http://127.0.0.1:17321/diagnostics';
const CLEAR_DIAGNOSTICS_ENDPOINT = 'http://127.0.0.1:17321/clear-diagnostics';
const OUTPUT_VERIFY_ENDPOINT = 'http://127.0.0.1:17321/output-verify';
const OUTPUT_DELETE_ENDPOINT = 'http://127.0.0.1:17321/output-delete';
const OUTPUT_ARCHIVE_REVISION_ENDPOINT = 'http://127.0.0.1:17321/output-archive-revision';
// Transport probes are deliberately shorter than the generation timeout. A
// single disconnected tab must never block observations from the other slots.
const SLOT_PROBE_TIMEOUT_MS = 8000;
const GLOBAL_NO_PROGRESS_WINDOW_MS = 300000;
const MAX_RUN_EVENTS = 600;
const RUN_CLOCK_PAUSE_EVENTS = new Set([
  'run_pause_requested', 'run_pause_applied', 'run_paused_on_error',
  'rate_limit_pause', 'image_limit_pause', 'run_retry_backoff_scheduled',
  'stalled_batch_recovery_started', 'stalled_batch_recovery_waiting',
  'conversation_load_recovery_started', 'run_stop_accepted', 'run_completed'
]);
const OUTPUT_VERIFY_TIMEOUT_MS = 2000;
const EXTENSION_BUILD_ID = '2026-10-05.3';
const PROMPT_PIPELINE_VERSION = '6';
const FACTS_EXTRACTOR_VERSION = 4;
const POSTPROCESS_SEND_GAP_MS = 3000;
const FACTS_START_ACK_TIMEOUT_MS = 8000;
const FACTS_FAST_PULSE_INTERVAL_MS = 1500;
const REVISION_FACTS_RECOVERY_TIMEOUT_MS = 60000;
const REVISION_FACTS_RECOVERY_CONCURRENCY = 3;
const MAX_POSTPROCESS_TABS = 3;
const DOM_DIAGNOSTICS_MODES = Object.freeze({
  OFF: 'off',
  ERRORS: 'errors',
  FULL: 'full'
});
const DEFAULT_DOM_DIAGNOSTICS_MODE = DOM_DIAGNOSTICS_MODES.OFF;
const RECOVERY_ACTIVE_STATES = new Set(['WAITING_ASSISTANT', 'GENERATING', 'WAITING_IMAGE', 'RATE_LIMIT_PAUSE']);
let stateChain = Promise.resolve();
let auditTimer = null;
let auditInFlight = null;
let auditMonitorDesired = false;
let auditMonitorEpoch = 0;
let auditAlarmKnownPresent = false;
let auditAlarmReconcilePromise = null;
let auditTimerGeneration = 0;
let factsPulseTimer = null;
let factsPulseInFlight = null;
let launchChain = Promise.resolve();
// Lightweight mutex for the physical Send click only. Postprocess requests must
// not sit behind the much longer generation launch scheduler.
let physicalSendChain = Promise.resolve();
let launchRunId = null;
let lastLaunchAt = 0;
let lastAnySendAt = 0;
// De-duplicate one logical Send task per slot while the MV3 worker is alive.
// If the worker is suspended, this map disappears; the persisted
// rateLimitRetryNeeded flag reconstructs the lost task on alarm wake-up.
const activeLaunchTasks = new Map();
const imageLimitTasks = new Map();
const activeFactsSendTasks = new Map();
const revisionFactsRecoveryTasks = new Map();
const conversationRecoveryRuns = new Set();
const stalledBatchRecoveryRuns = new Set();
// In-memory bridge between chrome.downloads.download() and the deferred state
// write. It lets DOWNLOAD_GENERATED return immediately without risking a very
// fast download completing before slot.downloadId reaches storage.
const activeDownloadClaims = new Map();
const activeDownloadFinalizations = new Set();
const postprocessCapacityReservations = new Map();
// Worker tabs are intentionally allocated in parallel. The only globally
// serialized operation in the generation pipeline is the real Send click.
let inputFilePromiseCache = new Map();
let devReloadPollInFlight = false;
let manualUpdateApplyInFlight = null;
let devControlPollInFlight = false;
let devControlClientIdentityCache = null;
let devControlClientIdentityPromise = null;
let domBridgeChain = Promise.resolve();
let domBridgeRetryAt = 0;
let diagnosticBridgeChain = Promise.resolve();
let diagnosticBridgeRetryAt = 0;
let domDiagnosticsModeCache = DEFAULT_DOM_DIAGNOSTICS_MODE;
// Telemetry must never sit on the critical generation path. Buffer log rows
// briefly and persist them in batches instead of doing one chrome.storage
// read/write for every DOM step in every worker tab.
let pendingLogEntries = [];
let logFlushTimer = null;
let logFlushChain = Promise.resolve();
const pendingRunDiagnosticSnapshots = new Map();
const runDiagnosticPersistenceState = new Map();
let runDiagnosticsFlushTimer = null;
let runDiagnosticsFlushDueAt = 0;
let runDiagnosticsFlushInFlight = false;
const RUN_DIAGNOSTICS_FLUSH_DELAY_MS = 300;
const RUN_DIAGNOSTICS_RETRY_BASE_MS = 30000;
const RUN_DIAGNOSTICS_RETRY_MAX_MS = 5 * 60_000;
// Resolve one host window for concurrent worker starts. Worker tabs belong to
// the window that owns the side panel; the promise prevents races while saving it.
let automationWindowPromise = null;
let automationWindowPromiseRunId = null;
let interruptedRecoveryPromise = null;
let resetRunPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomDiagnosticsMode(value) {
  const normalized = String(value || '').toLowerCase();
  return Object.values(DOM_DIAGNOSTICS_MODES).includes(normalized)
    ? normalized
    : DEFAULT_DOM_DIAGNOSTICS_MODE;
}

async function broadcastDomDiagnosticsMode(mode) {
  const normalized = normalizeDomDiagnosticsMode(mode);
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }).catch(() => []);
  await Promise.all(tabs
    .filter((tab) => tab.id != null)
    .map((tab) => sendTabMessage(tab.id, {
      type: 'SET_DOM_DIAGNOSTICS',
      mode: normalized
    }, 3000).catch(() => null)));
}

async function setDomDiagnosticsMode(value) {
  const mode = normalizeDomDiagnosticsMode(value);
  domDiagnosticsModeCache = mode;
  await chrome.storage.local.set({ domDiagnosticsMode: mode });
  if (mode === DOM_DIAGNOSTICS_MODES.OFF) {
    await chrome.storage.local.remove([
      'domObservationBuffer',
      'domObservationStats',
      'lastDiagnostic',
      'diagnosticBridgeSent'
    ]);
  }
  await broadcastDomDiagnosticsMode(mode);
  return { mode };
}

async function clearDomDiagnostics() {
  await chrome.storage.local.remove([
    'domObservationBuffer',
    'domObservationStats',
    'lastDiagnostic',
    'diagnosticBridgeSent'
  ]);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEV_CONTROL_POLL_TIMEOUT_MS);
  let watcher = { ok: false, unavailable: true };
  try {
    const response = await fetch(CLEAR_DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal
    });
    watcher = response.ok ? await response.json() : { ok: false, status: response.status };
  } catch (_) {
    // The extension remains usable when the optional local watcher is stopped.
  } finally {
    clearTimeout(timeoutId);
  }
  return { ok: true, watcher };
}

function randomInt(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  if (upper <= lower) return lower;
  const random = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000
    : Math.random();
  return lower + Math.floor(random * (upper - lower + 1));
}

function finalCheckDeadline() {
  return Date.now() + FINAL_CHECK_TIMEOUT_MS;
}

function normalizeRateLimitPauseMinutes(value, fallback = DEFAULT_RATE_LIMIT_PAUSE_MINUTES) {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_RATE_LIMIT_PAUSE_MINUTES;
  const resolved = Number.isFinite(numeric) && numeric > 0 ? numeric : safeFallback;
  return Math.min(MAX_RATE_LIMIT_PAUSE_MINUTES, Math.max(MIN_RATE_LIMIT_PAUSE_MINUTES, Math.round(resolved)));
}

function rateLimitPauseMs(run = null) {
  return normalizeRateLimitPauseMinutes(run?.rateLimitPauseMinutes) * 60000;
}

function scheduleRateLimitResume(operationId, pauseUntil) {
  if (!operationId || !pauseUntil || !chrome.alarms?.create) return;
  const when = Math.max(Date.now() + 1000, Number(pauseUntil));
  Promise.resolve(chrome.alarms.create(RATE_LIMIT_RESUME_ALARM_NAME, { when })).catch(() => {});
}

async function restoreRateLimitResumeAlarm() {
  const { run } = await getStored();
  if (!run || ['STOPPED', 'DONE'].includes(run.state)) return;
  const pauseUntil = Number(run.rateLimitPauseUntil || 0);
  if (pauseUntil > 0) scheduleRateLimitResume(run.operationId, pauseUntil);
}

async function rehydrateWorkerWake() {
  // MV3 service workers are routinely suspended between events. That is not a
  // browser/extension restart and must never turn a live unattended run into a
  // manual PAUSED state. Recreate only the in-memory tasks that suspension can
  // lose; persisted slot/page ownership remains authoritative.
  const importState = await chrome.storage.local.get('resultsImportJournal');
  if (importState.resultsImportJournal) {
    await completeResultsImport();
    return;
  }
  const stored = await getStored();
  if (stored.sessionResetIntent) {
    void resumeInterruptedSessionReset(stored.sessionResetIntent).catch((error) => appendLog(
      'Не удалось завершить запрошенный сброс после пробуждения расширения', { error: error.message }
    ));
    return;
  }
  const run = stored.run;
  if (!run) return;
  const batchRecoveryStage = String(run.stalledBatchRecovery?.stage || '').toUpperCase();
  const preparationStallWaiting = run.stalledBatchRecovery?.kind === 'PREPARATION_STALL'
    && batchRecoveryStage === 'WAITING';
  if (run.stalledBatchRecovery?.kind === 'PREPARATION_STALL'
    && ['CLOSING', 'RESTARTING'].includes(batchRecoveryStage)) {
    void resumePreparationStallRecovery().catch((error) => appendLog('Ошибка восстановления подготовки', { error: error.message }));
    return;
  }
  if (run.state === 'PAUSED' && preparationStallWaiting) {
    scheduleStalledBatchRecovery(run.operationId, Number(run.stalledBatchRecovery.dueAt || 0) || Date.now() + 1000);
  }
  if (run.stalledBatchRecovery?.kind !== 'PREPARATION_STALL'
    && ['CLOSING', 'WAITING', 'RESTARTING'].includes(batchRecoveryStage)) {
    void restoreStalledBatchRecovery(run.operationId).catch((error) => appendLog(
      'Ошибка восстановления отложенного перезапуска рабочих вкладок', { error: error.message }
    ));
    return;
  }
  if (batchRecoveryStage === 'FAILED' && run.stalledBatchRecovery?.kind !== 'PREPARATION_STALL') return;
  if (run.state === 'PAUSED' && preparationStallWaiting
    && !hasObservationWork(run) && !hasScheduledRunRetries(run, stored.queue)) return;
  const conversationStage = String(run.conversationRecovery?.stage || '').toUpperCase();
  if (conversationStage === 'INSPECTING') {
    void beginConversationLoadRecovery(run.operationId, {
      slotId: run.conversationRecovery?.triggerSlotId,
      entryId: run.conversationRecovery?.triggerEntryId
    });
    return;
  }
  if (['WAITING', 'REOPENING'].includes(conversationStage)) {
    void (async () => {
      await closeConversationRecoveryTabs(run.operationId);
      if (conversationStage === 'WAITING' && Number(run.conversationRecovery.dueAt || 0) > Date.now()) {
        scheduleConversationLoadRecovery(run.operationId, run.conversationRecovery.dueAt);
      } else {
        await resumeConversationLoadRecovery(run.operationId);
      }
    })().catch(async (error) => {
      await failConversationLoadRecovery(run.operationId,
        `Не удалось закрыть прежние рабочие вкладки перед восстановлением: ${error.message}`,
        { attempt: Number(run.conversationRecovery?.attempts || 0) });
    });
    return;
  }
  if (run.state === 'PAUSED' && run.imageLimitDetected === true
    && Object.values(run.slots || {}).some((slot) => slot.entryId && !slot.downloadId)) {
    void pauseForImageLimit(run.operationId, { text: run.rateLimitReason },
      Number(run.rateLimitPauseUntil || 0) || Date.now() + RATE_LIMIT_PAUSE_MS)
      .catch((error) => appendLog('Ошибка восстановления паузы лимита изображений', { error: error.message }));
    return;
  }
  if ((['DRAINING', 'DONE'].includes(run.state) || (run.state === 'PAUSED' && run.status === 'PAUSED_ON_ERROR'
      && String(run.pauseReason || '').toUpperCase() !== 'USER'))
    && Object.values(run.slots || {}).some((slot) => (
    slot.entryId && slot.preparedForSubmit && !slotGenerationSubmitted(slot)
  ))) {
    await pauseStalledPreparedSlots(run.operationId);
    return;
  }
  if (run.state === 'PAUSED'
    && (run.status === 'PAUSED_RECOVERING' || (run.status === 'PAUSED_ON_ERROR' && !run.unresolvedError))
    && !hasObservationWork(run) && !hasScheduledRunRetries(run, stored.queue)) {
    await scheduleInterruptedRunRecovery('Сверка завершённых результатов');
    return;
  }
  if (run.state === 'PAUSED' && shouldKeepAuditMonitor(run, stored.queue)) {
    startAuditMonitor();
    if (hasScheduledRunRetries(run, stored.queue)) await processDueScheduledRetries(run.operationId);
    return;
  }
  if (!['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) return;

  // A real extension update changes the page/worker contract. Use the cautious
  // reconciliation path only for that case, not for an ordinary worker wake.
  if (String(run.buildId || '') !== EXTENSION_BUILD_ID) {
    await scheduleInterruptedRunRecovery(`Обновление расширения: ${run.buildId || 'старый build'} → ${EXTENSION_BUILD_ID}`);
    return;
  }

  const pauseUntil = Number(run.rateLimitPauseUntil || 0);
  if (pauseUntil > Date.now()) {
    scheduleRateLimitResume(run.operationId, pauseUntil);
    if (hasObservationWork(run)) startAuditMonitor();
    return;
  }
  if (pauseUntil > 0) {
    // The alarm may have fired while the worker was cold. Resume idempotently;
    // activeLaunchTasks de-duplicates any task reconstructed twice.
    await resumeAfterRateLimitPause();
    return;
  }

  if (hasObservationWork(run)) startAuditMonitor();
  if (run.state !== 'RUNNING') return;
  for (const slot of Object.values(run.slots || {})) {
    const unsubmitted = Boolean(slot.entryId)
      && !slot.generationSubmittedAt
      && !slot.downloadId
      && !slot.finalCheckPending;
    if (!unsubmitted || slot.preparedForSubmit !== true || !slot.tabId
      || !['READY_TO_SEND', 'WAITING_LAUNCH'].includes(String(slot.status || '').toUpperCase())) continue;
    void submitPreparedSlot(run.operationId, slot.slotId, slot.entryId, slot.tabId)
      .catch((error) => pauseRunOnError(run.operationId, error, {
        slotId: slot.slotId,
        entryId: slot.entryId,
        tabId: slot.tabId,
        errorClass: classifyAutomationError(error)
      }));
  }
}

function clockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function makeLeaseId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `lease-${Date.now()}-${stableHash(`${Date.now()}-${Math.random()}`)}`;
}

function ensureSlotGenerationIdentity(run, slot, entry, generationMemory = null) {
  if (!run?.operationId || !slot?.leaseId || !entry?.sourceId) return null;
  const expected = generationId(entry.sourceId, `${run.operationId}-${slot.leaseId}`);
  if (slot.generationId && slot.generationId !== expected) {
    throw new Error('Slot generation identity does not match its current SKU and lease');
  }
  slot.generationId = expected;
  if (slot.previousGenerationId === undefined) {
    slot.previousGenerationId = generationMemory?.items?.[entry.sourceId]?.generationId
      || entry.generationId
      || null;
  }
  return slot.generationId;
}

function recordRunEvent(run, type, data = {}) {
  if (!run) return;
  const eventAtMs = Date.now();
  if (type === 'run_stop_requested') stopRunClock(run, eventAtMs);
  else if (RUN_CLOCK_PAUSE_EVENTS.has(type)) pauseRunClock(run, eventAtMs);
  const events = Array.isArray(run.eventJournal) ? run.eventJournal : [];
  let sequence = Number(run.eventSequence || 0);
  if (events.some((event) => !Number(event?.sequence))) {
    if (!events.length) sequence = Math.max(sequence, Number(run.eventCount || 0));
    for (const event of events) {
      if (!Number(event?.sequence)) {
        event.sequence = ++sequence;
        event.operationId = run.operationId || null;
      } else {
        sequence = Math.max(sequence, Number(event.sequence));
      }
    }
  } else if (events.length) {
    sequence = Math.max(sequence, Number(events.at(-1)?.sequence || 0));
  } else {
    sequence = Math.max(sequence, Number(run.eventCount || 0));
  }
  sequence += 1;
  const at = new Date(eventAtMs).toISOString();
  const startedAtMs = Date.parse(run.startedAt || '');
  const previousEventAtMs = Date.parse(events.at(-1)?.at || '');
  events.push({
    ...data,
    at,
    type,
    operationId: run.operationId || null,
    sequence,
    elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.parse(at) - startedAtMs) : null,
    sincePreviousEventMs: Number.isFinite(previousEventAtMs) ? Math.max(0, Date.parse(at) - previousEventAtMs) : null
  });
  run.eventJournal = events.slice(-MAX_RUN_EVENTS);
  run.eventSequence = sequence;
  run.eventCount = sequence;
}

function scheduleRunDiagnosticsFlush(delayMs = RUN_DIAGNOSTICS_FLUSH_DELAY_MS) {
  const dueAt = Date.now() + Math.max(0, Number(delayMs || 0));
  if (runDiagnosticsFlushTimer && runDiagnosticsFlushDueAt <= dueAt) return;
  if (runDiagnosticsFlushTimer) clearTimeout(runDiagnosticsFlushTimer);
  runDiagnosticsFlushDueAt = dueAt;
  runDiagnosticsFlushTimer = setTimeout(() => {
    runDiagnosticsFlushTimer = null;
    runDiagnosticsFlushDueAt = 0;
    void flushQueuedRunDiagnostics();
  }, Math.max(0, dueAt - Date.now()));
}

function queueRunDiagnostics(run, queue = null) {
  if (!run?.operationId) return;
  const events = Array.isArray(run.eventJournal) ? run.eventJournal : [];
  let sequence = Number(run.eventSequence || 0);
  if (events.some((event) => !Number(event?.sequence))) {
    if (!events.length) sequence = Math.max(sequence, Number(run.eventCount || 0));
    for (const event of events) {
      if (!Number(event?.sequence)) {
        event.sequence = ++sequence;
        event.operationId = run.operationId;
      } else {
        sequence = Math.max(sequence, Number(event.sequence));
        event.operationId ||= run.operationId;
      }
    }
  } else if (events.length) {
    sequence = Math.max(sequence, Number(events.at(-1)?.sequence || 0));
  } else {
    sequence = Math.max(sequence, Number(run.eventCount || 0));
  }
  run.eventSequence = sequence;
  run.eventCount = sequence;

  const operationId = String(run.operationId);
  const state = runDiagnosticPersistenceState.get(operationId) || {
    persistedSequence: Math.max(0, Number(run.diagnosticsPersistedSequence || 0)),
    headerFingerprint: run.diagnosticsHeaderFingerprint || null,
    failures: 0,
    retryAt: 0,
    error: null,
    failedAt: null
  };
  run.diagnosticsPersistedSequence = Math.max(Number(run.diagnosticsPersistedSequence || 0), state.persistedSequence);
  run.diagnosticsHeaderFingerprint = state.headerFingerprint || run.diagnosticsHeaderFingerprint || null;
  run.diagnosticsPersistenceError = state.error || null;
  run.diagnosticsPersistenceFailedAt = state.failedAt || null;
  const header = runDiagnosticHeader(run, queue, chrome.runtime.getManifest?.().version || null);
  run.diagnosticsLastKnownCompletedCount = Number(header.completedCount || 0);
  run.diagnosticsLastKnownPendingCount = Number(header.pendingCount || 0);
  const headerFingerprint = JSON.stringify(header);
  const persistedSequence = Math.max(0, Number(state.persistedSequence || 0));
  const pendingEvents = events
    .filter((event) => Number(event.sequence) > persistedSequence)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (!pendingEvents.length && headerFingerprint === state.headerFingerprint) return;

  const records = [];
  const firstSequence = Number(pendingEvents[0]?.sequence || 0);
  if (firstSequence > persistedSequence + 1) {
    records.push(sanitizeRunDiagnosticEvent({
      operationId: run.operationId,
      sequence: firstSequence - 1,
      at: new Date().toISOString(),
      type: 'diagnostics_gap',
      missingFromSequence: persistedSequence + 1,
      missingThroughSequence: firstSequence - 1,
      reason: 'Earlier events left the live journal before they were archived.'
    }));
  }
  records.push(...pendingEvents.map((event) => sanitizeRunDiagnosticEvent(event, {
    operationId: run.operationId,
    sequence: event.sequence
  })));

  const maxSequence = Math.max(persistedSequence, ...records.map((event) => Number(event.sequence || 0)));
  pendingRunDiagnosticSnapshots.set(operationId, { operationId, header, records, maxSequence, headerFingerprint });
  runDiagnosticPersistenceState.set(operationId, state);
  scheduleRunDiagnosticsFlush(state.retryAt > Date.now() ? state.retryAt - Date.now() : RUN_DIAGNOSTICS_FLUSH_DELAY_MS);
}

async function flushQueuedRunDiagnostics() {
  if (runDiagnosticsFlushInFlight) return;
  runDiagnosticsFlushInFlight = true;
  try {
    while (pendingRunDiagnosticSnapshots.size) {
      const now = Date.now();
      const ready = [...pendingRunDiagnosticSnapshots.entries()].find(([operationId]) => (
        Number(runDiagnosticPersistenceState.get(operationId)?.retryAt || 0) <= now
      ));
      if (!ready) {
        const nextRetryAt = Math.min(...[...pendingRunDiagnosticSnapshots.keys()].map((operationId) => (
          Number(runDiagnosticPersistenceState.get(operationId)?.retryAt || now)
        )));
        scheduleRunDiagnosticsFlush(Math.max(0, nextRetryAt - now));
        break;
      }
      const [operationId, snapshot] = ready;
      const state = runDiagnosticPersistenceState.get(operationId) || { persistedSequence: 0, failures: 0, retryAt: 0 };
      pendingRunDiagnosticSnapshots.delete(operationId);
      try {
        await saveRunDiagnostics(snapshot.header, snapshot.records);
        const nextState = {
          ...state,
          persistedSequence: Math.max(Number(state.persistedSequence || 0), snapshot.maxSequence),
          headerFingerprint: snapshot.headerFingerprint,
          failures: 0,
          retryAt: 0,
          error: null,
          failedAt: null
        };
        runDiagnosticPersistenceState.set(operationId, nextState);
        await chrome.storage.local.remove('runDiagnosticsPersistenceError').catch(() => {});
      } catch (error) {
        const failures = Math.max(0, Number(state.failures || 0)) + 1;
        const retryMs = Math.min(RUN_DIAGNOSTICS_RETRY_MAX_MS,
          RUN_DIAGNOSTICS_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 4)));
        const failedAt = new Date().toISOString();
        const errorMessage = String(error?.message || error).slice(0, 1200);
        const nextState = { ...state, failures, retryAt: Date.now() + retryMs, error: errorMessage, failedAt };
        runDiagnosticPersistenceState.set(operationId, nextState);
        const queued = pendingRunDiagnosticSnapshots.get(operationId);
        if (!queued || queued.maxSequence <= snapshot.maxSequence) pendingRunDiagnosticSnapshots.set(operationId, snapshot);
        await chrome.storage.local.set({ runDiagnosticsPersistenceError: {
          operationId, error: errorMessage, failedAt, retryAt: nextState.retryAt
        } }).catch(() => {});
        scheduleRunDiagnosticsFlush(retryMs);
        break;
      }
    }
  } finally {
    runDiagnosticsFlushInFlight = false;
    if (pendingRunDiagnosticSnapshots.size && !runDiagnosticsFlushTimer) {
      const now = Date.now();
      const nextRetryAt = Math.min(...[...pendingRunDiagnosticSnapshots.keys()].map((operationId) => (
        Math.max(now, Number(runDiagnosticPersistenceState.get(operationId)?.retryAt || 0))
      )));
      scheduleRunDiagnosticsFlush(Math.max(0, nextRetryAt - now));
    }
  }
}

// Keep diagnostics out of the automation's control path. saveRunAndQueue() is
// called for frequent slot heartbeats; an IndexedDB stall must never hold up a
// Send, download finalization, pause, or reset operation.
async function flushRunDiagnosticsSafely(run, queue) {
  queueRunDiagnostics(run, queue);
}

async function setSlotPhase(runId, slotId, phase, extra = {}) {
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== runId) return;
    const slot = run.slots?.[slotId];
    if (!slot) return;
    const previous = slot.phase || slot.status;
    // The page can acknowledge PROMPT_SENT before the worker finishes the
    // transport bookkeeping below. Never downgrade a confirmed submission
    // back to the transient SENDING phase in that race window.
    const submittedPhase = [
      SLOT_PHASES.PROMPT_SENT,
      SLOT_PHASES.GENERATING,
      SLOT_PHASES.OBSERVING,
      SLOT_PHASES.IMAGE_FOUND,
      SLOT_PHASES.DOWNLOADING,
      SLOT_PHASES.VERIFYING_FILE,
      SLOT_PHASES.DONE
    ];
    const preserveSubmitted = phase === SLOT_PHASES.SENDING
      && (slot.generationSubmittedAt || submittedPhase.includes(String(slot.phase || slot.status || '').toUpperCase()));
    const nextPhase = preserveSubmitted ? (slot.phase || slot.status) : phase;
    slot.phase = nextPhase;
    Object.assign(slot, extra);
    slot.lastHeartbeatAt = new Date().toISOString();
    if (previous !== nextPhase || Object.keys(extra).length) {
      recordRunEvent(run, 'slot_phase', { slotId, entryId: slot.entryId, from: previous, to: nextPhase, ...extra });
    }
    run.currentAction = `${nextPhase}: ${entryDisplayName(groupEntries(stored.queue, run.groupId).find((entry) => entry.sourceId === slot.entryId), slot)}`;
    run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(run, stored.queue, stored.history, stored.generationMemory);
    await publishRun(run, stored.queue);
  });
}

function referenceCandidatesForRole(role, brandProfile = 'generic') {
  const profile = String(brandProfile || 'generic');
  if (role === 'template' || role === 'ozonMap') {
    return [`${role}:${profile}`, role];
  }
  if (role === 'storeLogo') return ['storeLogo'];
  return [];
}

function selectedReferenceRecord(queue, role, brandProfile = 'generic') {
  const refs = queue?.refs || {};
  for (const storageKey of referenceCandidatesForRole(role, brandProfile)) {
    if (refs[storageKey]) return { storageKey, record: refs[storageKey] };
  }
  return null;
}

function referenceRecipeDescriptor(queue, role, brandProfile = 'generic') {
  const selected = selectedReferenceRecord(queue, role, brandProfile);
  return {
    role,
    storageKey: selected?.storageKey || null,
    fingerprint: selected?.record?.contentHash || selected?.record?.fingerprint || null,
    name: selected?.record?.name || null
  };
}

function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

async function verifyDownloadedArtifact(downloadItem, entry = null, fallbackVerify = null) {
  const filename = String(downloadItem?.filename || '');
  const fileSize = Number(downloadItem?.fileSize || 0);
  const bytes = fileSize > 0 ? fileSize : Number(downloadItem?.bytesReceived || 0);
  const isPngPath = /\.png$/i.test(filename);
  if (!downloadItem || downloadItem.state !== 'complete' || !isPngPath || bytes <= 0) {
    return {
      valid: false,
      verified: false,
      reason: downloadItem?.state !== 'complete' ? `download_state:${downloadItem?.state || 'missing'}` : 'empty_or_non_png',
      filename,
      bytes
    };
  }
  try {
    const query = new URLSearchParams({
      path: filename,
      expected: String(entry?.outputFileName || '')
    });
    const response = await fetchWithTimeout(`${OUTPUT_VERIFY_ENDPOINT}?${query.toString()}`, {}, OUTPUT_VERIFY_TIMEOUT_MS);
    if (response.ok) {
      const payload = await response.json();
      const width = Number(payload.width || 0);
      const height = Number(payload.height || 0);
      const warnings = [];
      if (payload.valid === false) {
        return { ...payload, valid: false, verified: true, verificationMode: 'watcher' };
      }
      if (width && height) {
        const ratio = width / height;
        if (width < 512 || height < 512) {
          return { ...payload, valid: false, verified: true, verificationMode: 'watcher', reason: `image_too_small:${width}x${height}` };
        }
        if (Math.abs(ratio - 0.75) > 0.035) warnings.push(`aspect_ratio:${ratio.toFixed(4)} (ожидается около 3:4)`);
      }
      if (!/^[a-f0-9]{64}$/i.test(String(payload.sha256 || ''))) {
        throw new Error('Локальная проверка не вернула SHA-256 PNG');
      }
      return {
        ...payload,
        valid: payload.valid !== false,
        verified: payload.valid !== false,
        verificationMode: 'watcher',
        qualityWarnings: warnings
      };
    }
  } catch (_) {
    // Continue with an independent page-side hash only when the watcher is
    // unavailable or returned an incomplete verification record.
  }
  if (typeof fallbackVerify === 'function') {
    try {
      const fallback = await fallbackVerify();
      const sha256 = String(fallback?.sha256 || '').toLowerCase();
      const sourceBytes = Number(fallback?.bytes || 0);
      if (fallback?.valid === true && /^[a-f0-9]{64}$/.test(sha256)
        && sourceBytes > 0 && (fileSize <= 0 || sourceBytes === fileSize)) {
        return {
          ...fallback,
          valid: true,
          verified: true,
          verificationMode: 'page-source',
          sha256,
          filename,
          bytes: sourceBytes
        };
      }
      if (fallback?.valid === false) {
        return { ...fallback, verified: true, verificationMode: 'page-source', filename, bytes };
      }
    } catch (_) {}
  }
  return {
    valid: false,
    verified: false,
    verificationMode: 'downloads-api',
    reason: 'sha256_unavailable',
    filename,
    bytes
  };
}

function resetLaunchScheduler(operationId) {
  launchRunId = operationId;
  launchChain = Promise.resolve();
  physicalSendChain = Promise.resolve();
  lastLaunchAt = 0;
  lastAnySendAt = 0;
  activeLaunchTasks.clear();
  activeFactsSendTasks.clear();
}

function ensureLaunchScheduler(operationId) {
  if (launchRunId === operationId) return;
  launchRunId = operationId;
  launchChain = Promise.resolve();
  physicalSendChain = Promise.resolve();
  lastLaunchAt = 0;
  lastAnySendAt = 0;
  activeLaunchTasks.clear();
  activeFactsSendTasks.clear();
}


function normalizeChatConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== 'https://chatgpt.com') return null;
    if (!/^\/c\/[^/?#]+/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return null;
  }
}

function conversationRecoveryIsBlocked(run) {
  return ['INSPECTING', 'WAITING', 'REOPENING', 'FAILED'].includes(String(run?.conversationRecovery?.stage || '').toUpperCase());
}

function scheduleConversationLoadRecovery(operationId, dueAt) {
  if (!operationId || !dueAt || !chrome.alarms?.create) return;
  Promise.resolve(chrome.alarms.create(CONVERSATION_LOAD_RECOVERY_ALARM_NAME, {
    when: Math.max(Date.now() + 1000, Number(dueAt))
  })).catch(() => {});
}

function scheduleStalledBatchRecovery(operationId, dueAt) {
  if (!operationId || !dueAt || !chrome.alarms?.create) return;
  Promise.resolve(chrome.alarms.create(STALLED_BATCH_RECOVERY_ALARM_NAME, {
    when: Math.max(Date.now() + 1000, Number(dueAt))
  })).catch(() => {});
}

function chatTabFingerprint(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== 'https://chatgpt.com') return null;
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return null;
  }
}

async function captureStalledBatchTabTargets(run) {
  const slots = Object.values(run?.slots || {}).filter((slot) => Number(slot?.tabId || 0) > 0);
  const targets = await Promise.all(slots.map(async (slot) => {
    const tabId = Number(slot.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = String(tab?.url || tab?.pendingUrl || '');
    if (!tab || !/^https:\/\/chatgpt\.com\//i.test(url)) return null;
    return {
      tabId,
      slotId: Number(slot.slotId),
      entryId: slot.entryId || null,
      windowId: Number(tab.windowId || 0) || null,
      urlFingerprint: chatTabFingerprint(url)
    };
  }));
  return targets.filter(Boolean);
}

async function closeStalledBatchRecoveryTabs(operationId) {
  const { run } = await getStored();
  if (!run || run.operationId !== operationId) return { closed: 0, failed: [] };
  const recovery = run.stalledBatchRecovery;
  const targets = Array.isArray(recovery?.closeTabs) ? recovery.closeTabs : [];
  const failed = [];
  const unsafe = [];
  let closed = 0;
  for (const target of targets) {
    const tabId = Number(target?.tabId || 0);
    if (!tabId) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    const url = String(tab.url || tab.pendingUrl || '');
    if (!/^https:\/\/chatgpt\.com\//i.test(url)
      || (target.windowId && Number(tab.windowId) !== Number(target.windowId))
      || (target.urlFingerprint && chatTabFingerprint(url) !== target.urlFingerprint)) {
      unsafe.push(tabId);
      continue;
    }
    await sendTabMessage(tabId, { type: 'STOP' }, 1500).catch(() => null);
    await chrome.tabs.remove(tabId).catch(() => null);
    if (await chrome.tabs.get(tabId).catch(() => null)) failed.push(tabId);
    else closed += 1;
  }
  return { closed, failed, unsafe };
}

async function activateStalledBatchRecoveryWait(operationId) {
  let dueAt = 0;
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== operationId
      || String(run.stalledBatchRecovery?.stage || '').toUpperCase() !== 'CLOSING') return;
    const now = Date.now();
    dueAt = now + STALLED_BATCH_RECOVERY_DELAY_MS;
    run.stalledBatchRecovery.stage = 'WAITING';
    run.stalledBatchRecovery.waitStartedAt = new Date(now).toISOString();
    run.stalledBatchRecovery.dueAt = dueAt;
    run.currentAction = `Рабочие вкладки закрыты. Через 5 минут продолжу незавершённые модели (${clockTime(dueAt)})`;
    run.lastActivityAt = new Date(now).toISOString();
    recordRunEvent(run, 'stalled_batch_recovery_waiting', {
      dueAt, returnedCount: run.stalledBatchRecovery.requeuedIds?.length || 0
    });
    await saveRunAndQueue(run, stored.queue);
    await publishRun(run, stored.queue);
  });
  if (dueAt) scheduleStalledBatchRecovery(operationId, dueAt);
  return dueAt;
}

async function failStalledBatchRecovery(operationId, error) {
  const message = String(error?.message || error || 'Не удалось автоматически продолжить прогон').slice(0, 1200);
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== operationId
      || !['CLOSING', 'WAITING', 'RESTARTING'].includes(String(run.stalledBatchRecovery?.stage || '').toUpperCase())) return;
    run.stalledBatchRecovery.stage = 'FAILED';
    run.stalledBatchRecovery.failedAt = new Date().toISOString();
    run.stalledBatchRecovery.error = message;
    run.state = 'PAUSED';
    run.status = 'PAUSED_ON_ERROR';
    run.pauseReason = 'STALLED_BATCH';
    run.unresolvedError = true;
    run.error = { message };
    run.currentAction = `Автоперезапуск не удался: ${message}. Прогресс сохранён; можно продолжить вручную.`;
    run.lastActivityAt = new Date().toISOString();
    recordRunEvent(run, 'stalled_batch_recovery_failed', {
      failedAt: run.stalledBatchRecovery.failedAt,
      stage: 'FAILED',
      error: message,
      returnedCount: run.stalledBatchRecovery.requeuedIds?.length || 0
    });
    await saveRunAndQueue(run, stored.queue);
    await publishRun(run, stored.queue);
  });
  if (chrome.alarms?.clear) await chrome.alarms.clear(STALLED_BATCH_RECOVERY_ALARM_NAME).catch(() => {});
  await appendLog('Автоматический перезапуск рабочего набора остановлен с ошибкой', { operationId, error: message });
}

async function resumeStalledBatchRecovery() {
  const initial = await getStored();
  if (initial.run?.stalledBatchRecovery?.kind === 'PREPARATION_STALL') return resumePreparationStallRecovery();
  const operationId = initial.run?.operationId;
  if (!operationId) return { skipped: true };
  if (stalledBatchRecoveryRuns.has(operationId)) {
    const current = initial.run.stalledBatchRecovery || {};
    scheduleStalledBatchRecovery(operationId, Number(current.dueAt || 0) || Date.now() + 5000);
    return { skipped: true, inFlight: true };
  }
  stalledBatchRecoveryRuns.add(operationId);
  try {
    let run = initial.run;
    let recovery = run.stalledBatchRecovery || {};
    let stage = String(recovery.stage || '').toUpperCase();
    if (!['CLOSING', 'WAITING', 'RESTARTING'].includes(stage)) return { skipped: true };

    if (stage === 'CLOSING') {
      const closed = await closeStalledBatchRecoveryTabs(operationId);
      if (closed.unsafe.length) {
        await failStalledBatchRecovery(operationId,
          `Рабочие вкладки изменились и оставлены открытыми: ${closed.unsafe.join(', ')}.`);
        return { failed: true, unsafeTabIds: closed.unsafe };
      }
      if (closed.failed.length) {
        scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
        return { deferred: true, failedTabIds: closed.failed };
      }
      await activateStalledBatchRecoveryWait(operationId);
      const refreshed = await getStored();
      run = refreshed.run;
      recovery = run?.stalledBatchRecovery || {};
      stage = String(recovery.stage || '').toUpperCase();
    } else if (stage === 'WAITING') {
      const closed = await closeStalledBatchRecoveryTabs(operationId);
      if (closed.unsafe.length) {
        await failStalledBatchRecovery(operationId,
          `Рабочие вкладки изменились во время паузы и оставлены открытыми: ${closed.unsafe.join(', ')}.`);
        return { failed: true, unsafeTabIds: closed.unsafe };
      }
      if (closed.failed.length) {
        scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
        return { deferred: true, failedTabIds: closed.failed };
      }
    }

    if (!run || run.operationId !== operationId || !['WAITING', 'RESTARTING'].includes(stage)) return { skipped: true };
    const dueAt = Number(recovery.dueAt || 0);
    if (stage === 'WAITING' && dueAt > Date.now()) {
      scheduleStalledBatchRecovery(operationId, dueAt);
      return { waiting: true, dueAt };
    }

    if (stage === 'WAITING') {
      await withStateLock(async () => {
        const stored = await getStored();
        const current = stored.run;
        if (!current || current.operationId !== operationId
          || String(current.stalledBatchRecovery?.stage || '').toUpperCase() !== 'WAITING'
          || Number(current.stalledBatchRecovery?.dueAt || 0) > Date.now()) return;
        current.stalledBatchRecovery.stage = 'RESTARTING';
        current.stalledBatchRecovery.restartingAt = new Date().toISOString();
        current.currentAction = 'Пятиминутный отдых завершён. Восстанавливаю очередь незавершённых моделей…';
        current.lastActivityAt = new Date().toISOString();
        await saveRunAndQueue(current, stored.queue);
        await publishRun(current, stored.queue);
      });
      const refreshed = await getStored();
      run = refreshed.run;
      recovery = run?.stalledBatchRecovery || {};
      stage = String(recovery.stage || '').toUpperCase();
      if (stage === 'WAITING' && Number(recovery.dueAt || 0) > Date.now()) {
        scheduleStalledBatchRecovery(operationId, Number(recovery.dueAt));
        return { waiting: true, dueAt: Number(recovery.dueAt) };
      }
    }

    await resumeRun({ stalledBatchRecoveryInternal: true });
    if (chrome.alarms?.clear) await chrome.alarms.clear(STALLED_BATCH_RECOVERY_ALARM_NAME).catch(() => {});
    await appendLog('Прогон автоматически продолжен после пятиминутного отдыха', { operationId });
    return { resumed: true, operationId };
  } catch (error) {
    await failStalledBatchRecovery(operationId, error);
    return { failed: true, error: error.message };
  } finally {
    stalledBatchRecoveryRuns.delete(operationId);
  }
}

// Preparation has no server result to wait for. Persist the recovery intent
// before closing drafts so worker suspension cannot strand a half-reset run.
async function schedulePreparationStallRecovery(operationId, entryIds = []) {
  const plan = await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== operationId || ['DONE', 'STOPPED'].includes(run.state)
      || run.clockStopped || run.stopBlocked
      || ['USER', 'RESTART', 'IMAGE_LIMIT'].includes(run.pauseReason)) return { skipped: true };
    const recovery = run.stalledBatchRecovery;
    if (['CLOSING', 'WAITING', 'RESTARTING'].includes(recovery?.stage)) {
      return recovery.kind === 'PREPARATION_STALL' ? { scheduled: true } : { skipped: true };
    }
    const attempts = Number(run.preparationRecoveryAttempts || 0);
    const exhausted = attempts >= MAX_AUTOMATIC_PREPARATION_RECOVERIES;
    run.preparationRecoveryAttempts = exhausted ? attempts : attempts + 1;
    run.stalledBatchRecovery = {
      kind: 'PREPARATION_STALL', stage: 'CLOSING',
      attempts: run.preparationRecoveryAttempts, exhausted,
      triggeredAt: new Date().toISOString(), dueAt: null,
      triggerEntryIds: [...new Set(entryIds.map(String))]
    };
    run.state = 'PAUSED';
    run.status = 'PAUSED_ON_ERROR';
    run.pauseReason = 'ERROR';
    recordRunEvent(run, 'stalled_batch_recovery_started', {
      kind: 'PREPARATION_STALL', attempts: run.preparationRecoveryAttempts,
      exhausted, entryIds: run.stalledBatchRecovery.triggerEntryIds
    });
    await saveRunAndQueue(run, stored.queue);
    await publishRun(run, stored.queue);
    return { scheduled: !exhausted, terminal: exhausted };
  });
  if (!plan.skipped) {
    scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
    await resumePreparationStallRecovery();
  }
  return plan;
}

async function resumePreparationStallRecovery() {
  const initial = await getStored();
  const operationId = initial.run?.operationId;
  if (!operationId || initial.run.stalledBatchRecovery?.kind !== 'PREPARATION_STALL') return { skipped: true };
  if (stalledBatchRecoveryRuns.has(operationId)) {
    scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
    return { skipped: true, inFlight: true };
  }
  stalledBatchRecoveryRuns.add(operationId);
  try {
    let run = initial.run;
    if (run.clockStopped || run.stopBlocked || run.pauseReason !== 'ERROR'
      || run.state !== 'PAUSED') return { skipped: true };
    if (run.stalledBatchRecovery.stage === 'CLOSING') {
      // pauseRun releases only conclusively unsent drafts; real Send leases,
      // downloads and verified results retain their existing ownership.
      await pauseRun('ERROR', operationId);
      await withStateLock(async () => {
        const stored = await getStored();
        const current = stored.run;
        if (!current || current.operationId !== operationId || current.clockStopped
          || current.stopBlocked || current.pauseReason !== 'ERROR'
          || current.stalledBatchRecovery?.stage !== 'CLOSING') return;
        const recovery = current.stalledBatchRecovery;
        recovery.requeuedIds = [...(current.pendingIds || [])];
        recovery.stage = recovery.exhausted ? 'FAILED' : 'WAITING';
        recovery.waitStartedAt = new Date().toISOString();
        recovery.dueAt = recovery.exhausted ? null : Date.now() + STALLED_BATCH_RECOVERY_DELAY_MS;
        current.attachmentFailureBaselineAt = recovery.waitStartedAt;
        for (const entry of groupEntries(stored.queue, current.groupId)) {
          if (!current.pendingIds.includes(entry.sourceId)) continue;
          entry.autoRetryPending = false;
          entry.nextRetryAt = null;
        }
        current.currentAction = recovery.exhausted
          ? 'Повторные ошибки подготовки: автоматические попытки исчерпаны. Прогресс сохранён; требуется проверка и Продолжить.'
          : `Ошибка подготовки. Очередь сохранена; продолжу через 5 минут (${clockTime(recovery.dueAt)}).`;
        recordRunEvent(current, recovery.exhausted ? 'preparation_recovery_exhausted' : 'stalled_batch_recovery_waiting', {
          kind: 'PREPARATION_STALL', dueAt: recovery.dueAt, attempts: recovery.attempts,
          returnedCount: recovery.requeuedIds.length
        });
        await saveRunAndQueue(current, stored.queue, stored.history, stored.generationMemory);
        await publishRun(current, stored.queue);
      });
      run = (await getStored()).run;
    }
    if (!run || run.operationId !== operationId || run.clockStopped || run.stopBlocked
      || run.pauseReason !== 'ERROR' || run.state !== 'PAUSED') return { skipped: true };
    if (!['WAITING', 'RESTARTING'].includes(run.stalledBatchRecovery.stage)) return { skipped: true };
    const dueAt = Number(run.stalledBatchRecovery.dueAt || 0);
    if (run.stalledBatchRecovery.stage === 'WAITING' && dueAt > Date.now()) {
      scheduleStalledBatchRecovery(operationId, dueAt);
      return { waiting: true, dueAt };
    }
    await withStateLock(async () => {
      const stored = await getStored();
      if (stored.run?.operationId !== operationId || stored.run.clockStopped || stored.run.stopBlocked
        || stored.run.pauseReason !== 'ERROR' || stored.run.stalledBatchRecovery?.stage !== 'WAITING') return;
      stored.run.stalledBatchRecovery.stage = 'RESTARTING';
      await saveRunAndQueue(stored.run, stored.queue);
    });
    const latest = (await getStored()).run;
    if (latest?.operationId !== operationId || latest.clockStopped || latest.stopBlocked
      || latest.stalledBatchRecovery?.stage !== 'RESTARTING') return { skipped: true };
    await resumeRun({ preparationStallRecoveryInternal: true });
    return { resumed: true };
  } catch (error) {
    await failStalledBatchRecovery(operationId, error);
    return { failed: true, error: error.message };
  } finally {
    stalledBatchRecoveryRuns.delete(operationId);
  }
}

async function restoreStalledBatchRecovery(operationId) {
  const { run } = await getStored();
  if (!run || run.operationId !== operationId) return { skipped: true };
  const stage = String(run.stalledBatchRecovery?.stage || '').toUpperCase();
  if (!['CLOSING', 'WAITING', 'RESTARTING'].includes(stage)) return { skipped: true };
  return resumeStalledBatchRecovery();
}

async function closeConversationRecoveryTabs(operationId) {
  const { run } = await getStored();
  if (!run || run.operationId !== operationId) return { closed: 0 };
  const stage = String(run.conversationRecovery?.stage || '').toUpperCase();
  if (!['WAITING', 'REOPENING'].includes(stage)) return { closed: 0 };
  const tabs = Array.isArray(run.conversationRecovery?.closeTabs) ? run.conversationRecovery.closeTabs : [];
  const failures = [];
  let closed = 0;
  for (const saved of tabs) {
    const tabId = Number(saved?.tabId || 0);
    if (!tabId) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    if (Number(tab.windowId) !== Number(saved.windowId)
      || chatTabFingerprint(tab.url || tab.pendingUrl) !== saved.urlFingerprint) {
      failures.push(tabId);
      continue;
    }
    await chrome.tabs.remove(tabId).catch(() => {});
    if (await chrome.tabs.get(tabId).catch(() => null)) failures.push(tabId);
    else closed += 1;
  }
  if (failures.length) throw new Error(`вкладки ${failures.join(', ')} изменились или не закрылись`);
  return { closed };
}

async function failConversationLoadRecovery(operationId, message, { attempt = null } = {}) {
  if (chrome.alarms?.clear) await chrome.alarms.clear(CONVERSATION_LOAD_RECOVERY_ALARM_NAME).catch(() => {});
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== operationId || ['DONE', 'STOPPED'].includes(run.state)) return;
    const previous = run.conversationRecovery || {};
    run.conversationRecovery = {
      ...previous,
      stage: 'FAILED',
      attempts: Number(attempt ?? previous.attempts ?? 0),
      failedAt: new Date().toISOString(),
      error: String(message || 'Не удалось восстановить разговоры ChatGPT').slice(0, 1200)
    };
    run.state = 'PAUSED';
    run.status = 'PAUSED_ON_ERROR';
    run.pauseReason = 'CONVERSATION_LOAD';
    run.unresolvedError = true;
    run.error = { message: run.conversationRecovery.error };
    run.currentAction = `${run.conversationRecovery.error} Вкладки и задания сохранены; можно продолжить вручную или выполнить сброс.`;
    run.lastActivityAt = new Date().toISOString();
    recordRunEvent(run, 'conversation_load_recovery_failed', {
      failedAt: run.conversationRecovery.failedAt,
      attempt: run.conversationRecovery.attempts,
      error: run.conversationRecovery.error,
      inspectedCount: run.conversationRecovery.inspectedCount || 0,
      closedCount: run.conversationRecovery.closedCount || 0
    });
    await saveRunAndQueue(run, stored.queue, stored.history, stored.generationMemory);
    await publishRun(run, stored.queue);
  });
  await appendLog('Восстановление разговора ChatGPT остановлено; состояние сохранено', { operationId, message });
}

async function beginConversationLoadRecovery(operationId, signal = null) {
  if (conversationRecoveryRuns.has(operationId)) return { skipped: true, inFlight: true };
  conversationRecoveryRuns.add(operationId);
  try {
    return await beginConversationLoadRecoveryInternal(operationId, signal);
  } catch (error) {
    const stored = await getStored().catch(() => ({ run: null }));
    await failConversationLoadRecovery(operationId,
      `Не удалось подготовить безопасное восстановление разговоров: ${error.message}`,
      { attempt: Number(stored.run?.conversationRecovery?.attempts || 0) });
    return { failed: true, error: error.message };
  } finally {
    conversationRecoveryRuns.delete(operationId);
  }
}

async function beginConversationLoadRecoveryInternal(operationId, signal = null) {
  let initial = await getStored();
  let run = initial.run;
  if (!run || run.operationId !== operationId || ['DONE', 'STOPPED'].includes(run.state)) return { skipped: true };
  let previousRecovery = run.conversationRecovery || {};
  let previousStage = String(previousRecovery.stage || '').toUpperCase();
  if (['WAITING', 'REOPENING', 'FAILED'].includes(previousStage)) return { skipped: true, stage: previousStage };
  const previousAttempts = Number(previousRecovery.attempts || 0);
  if (previousAttempts >= 1) {
    await failConversationLoadRecovery(operationId,
      `Ошибка «Не удалось загрузить этот разговор ChatGPT» появилась повторно после автоматического восстановления${signal?.entryId ? ` (${signal.entryId})` : ''}.`,
      { attempt: previousAttempts });
    return { failed: true, repeated: true };
  }

  if (previousStage !== 'INSPECTING') {
    const claimed = await withStateLock(async () => {
      const stored = await getStored();
      const current = stored.run;
      if (!current || current.operationId !== operationId || ['DONE', 'STOPPED'].includes(current.state)) return false;
      const stage = String(current.conversationRecovery?.stage || '').toUpperCase();
      if (['INSPECTING', 'WAITING', 'REOPENING', 'FAILED'].includes(stage)) return false;
      current.conversationRecovery = {
        ...(current.conversationRecovery || {}),
        stage: 'INSPECTING',
        attempts: Number(current.conversationRecovery?.attempts || 0),
        inspectionStartedAt: new Date().toISOString(),
        triggerSlotId: signal?.slotId ?? null,
        triggerEntryId: signal?.entryId ?? null
      };
      current.state = 'PAUSED';
      current.status = 'CONVERSATION_RECOVERY';
      current.pauseReason = 'CONVERSATION_LOAD';
      current.unresolvedError = false;
      current.stopBlocked = null;
      current.currentAction = 'ChatGPT сообщил, что разговор не загрузился. Проверяю ссылки и состояние отправленных генераций; новые запросы пока не запускаются.';
      current.lastActivityAt = new Date().toISOString();
      await saveRunAndQueue(current, stored.queue);
      await publishRun(current, stored.queue);
      return true;
    });
    if (!claimed) return { skipped: true, inFlight: true };
    initial = await getStored();
    run = initial.run;
    previousRecovery = run?.conversationRecovery || previousRecovery;
    previousStage = String(previousRecovery.stage || '').toUpperCase();
  }

  const entries = groupEntries(initial.queue, run.groupId);
  const submittedJobs = new Map();
  const unsafeReasons = [];
  for (const slot of Object.values(run.slots || {})) {
    if (slot.tabId) {
      const tab = await chrome.tabs.get(Number(slot.tabId)).catch(() => null);
      if (tab) {
        const actualChatUrl = normalizeChatConversationUrl(tab.url || tab.pendingUrl);
        const savedChatUrl = normalizeChatConversationUrl(slot.chatUrl);
        const urlFingerprint = chatTabFingerprint(tab.url || tab.pendingUrl);
        const expectedWindowId = Number(run.automationWindowId || 0);
        if (!urlFingerprint || (expectedWindowId && Number(tab.windowId) !== expectedWindowId)) {
          unsafeReasons.push(`Вкладка ${Number(slot.slotId) + 1} больше не соответствует сохранённой рабочей вкладке.`);
        }
        if (slot.entryId && slotGenerationSubmitted(slot) && !actualChatUrl && !savedChatUrl) {
          unsafeReasons.push(`Для отправленной модели во вкладке ${Number(slot.slotId) + 1} не удалось подтвердить ссылку разговора.`);
        }
        if (slot.entryId && slotGenerationSubmitted(slot) && actualChatUrl && savedChatUrl
          && chatTabFingerprint(actualChatUrl) !== chatTabFingerprint(savedChatUrl)) {
          unsafeReasons.push(`Ссылка разговора во вкладке ${Number(slot.slotId) + 1} изменилась после отправки модели.`);
        }
      }
    }
    if (!slot.entryId || !slotGenerationSubmitted(slot)) continue;
    const entry = entries.find((item) => item.sourceId === slot.entryId);
    if (!entry || entry.status === 'done') continue;
    const tab = slot.tabId ? await chrome.tabs.get(Number(slot.tabId)).catch(() => null) : null;
    const actualChatUrl = normalizeChatConversationUrl(tab?.url || tab?.pendingUrl);
    const savedChatUrl = normalizeChatConversationUrl(slot.chatUrl);
    const chatUrl = actualChatUrl || savedChatUrl;
    if (actualChatUrl && savedChatUrl
      && chatTabFingerprint(actualChatUrl) !== chatTabFingerprint(savedChatUrl)) {
      unsafeReasons.push(`Ссылка разговора для уже отправленной модели «${entryDisplayName(entry, slot)}» изменилась.`);
      continue;
    }
    let generationIdValue = slot.generationId;
    try {
      generationIdValue ||= ensureSlotGenerationIdentity(run, slot, entry, initial.generationMemory);
    } catch (_) {}
    const submittedAtMs = Date.parse(slot.generationSubmittedAt || slot.lastSendClickedAt || '');
    if (!chatUrl || !slot.leaseId || !generationIdValue || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) {
      unsafeReasons.push(`Для уже отправленной модели «${entryDisplayName(entry, slot)}» не хватает ссылки чата или подтверждённого идентификатора отправки.`);
      continue;
    }
    submittedJobs.set(`${Number(slot.slotId)}:${slot.entryId}`, {
      slotId: Number(slot.slotId),
      entryId: slot.entryId,
      chatUrl,
      generationId: generationIdValue,
      leaseId: slot.leaseId,
      submittedAtMs,
      baselineAssistantCount: Number(slot.baselineAssistantCount || 0),
      oldTabId: Number(slot.tabId || 0) || null,
      outputFileName: slot.outputFileName || slot.lastEntryName || null,
      modelName: slot.lastModelName || entry.modelName || null
    });
  }
  if (unsafeReasons.length) {
    await failConversationLoadRecovery(operationId,
      `${unsafeReasons[0]} Автоматически закрывать вкладки опасно, поэтому они остались открыты.`,
      { attempt: previousAttempts });
    return { failed: true, unsafe: true };
  }

  const cancelledRevisions = [];
  const commit = await withStateLock(async () => {
    const stored = await getStored();
    const currentRun = stored.run;
    if (!currentRun || currentRun.operationId !== operationId || ['DONE', 'STOPPED'].includes(currentRun.state)) return null;
    const stage = String(currentRun.conversationRecovery?.stage || '').toUpperCase();
    if (['WAITING', 'REOPENING', 'FAILED'].includes(stage)) return null;
    const history = normalizeHistory(stored.history);
    const memory = normalizeGenerationMemory(stored.generationMemory);
    await reconcileRunVerifiedRevisions(currentRun, stored.queue, history, memory);
    const currentEntries = groupEntries(stored.queue, currentRun.groupId);
    const recoverySlots = [];
    const toClose = [];
    const closeTabRecords = [];
    for (const slot of Object.values(currentRun.slots || {})) {
      if (slot.tabId) {
        const tabId = Number(slot.tabId);
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) {
          const urlFingerprint = chatTabFingerprint(tab.url || tab.pendingUrl);
          const expectedWindowId = Number(currentRun.automationWindowId || 0);
          if (!urlFingerprint || (expectedWindowId && Number(tab.windowId) !== expectedWindowId)) {
            return { unsafe: `Рабочая вкладка ${Number(slot.slotId) + 1} изменилась во время сверки; её оставили открытой.` };
          }
          const submitted = slot.entryId && slotGenerationSubmitted(slot)
            ? submittedJobs.get(`${Number(slot.slotId)}:${slot.entryId}`)
            : null;
          const currentChatUrl = normalizeChatConversationUrl(tab.url || tab.pendingUrl);
          if (submitted && currentChatUrl
            && chatTabFingerprint(currentChatUrl) !== chatTabFingerprint(submitted.chatUrl)) {
            return { unsafe: `Ссылка разговора во вкладке ${Number(slot.slotId) + 1} изменилась во время сверки; её оставили открытой.` };
          }
          toClose.push(tabId);
          closeTabRecords.push({ tabId, windowId: Number(tab.windowId), urlFingerprint });
        }
      }
      if (!slot.entryId) continue;
      const entry = currentEntries.find((item) => item.sourceId === slot.entryId);
      if (!entry || entry.status === 'done') {
        slot.tabId = null;
        slot.entryId = null;
        slot.status = 'IDLE';
        slot.phase = SLOT_PHASES.IDLE;
        slot.downloadId = null;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.finalCheckAttempts = 0;
        slot.failed = false;
        Object.assign(slot, freshSlotRevisionFields());
        continue;
      }
      const sent = slotGenerationSubmitted(slot);
      const key = `${Number(slot.slotId)}:${slot.entryId}`;
      const submitted = submittedJobs.get(key);
      if (sent && (!submitted
        || slot.leaseId !== submitted.leaseId
        || (slot.generationId && slot.generationId !== submitted.generationId)
        || Date.parse(slot.generationSubmittedAt || slot.lastSendClickedAt || '') !== submitted.submittedAtMs)) {
        return { unsafe: `Идентификатор отправки модели «${entryDisplayName(entry, slot)}» изменился во время сверки; её оставили в сохранённом состоянии.` };
      }
      if (sent && submitted) {
        slot.chatUrl = submitted.chatUrl;
        slot.generationId = submitted.generationId;
        slot.tabId = null;
        slot.status = 'OBSERVING';
        slot.phase = SLOT_PHASES.OBSERVING;
        slot.finalCheckPending = true;
        slot.finalCheckDeadlineAt = Number(slot.finalCheckDeadlineAt || 0) > Date.now()
          ? slot.finalCheckDeadlineAt : finalCheckDeadline();
        slot.finalCheckAttempts = 0;
        slot.noResponseSince = null;
        slot.failed = false;
        recoverySlots.push(submitted);
        continue;
      }
      if (entry.status !== 'done') {
        entry.status = 'pending';
        entry.lastError = null;
        entry.errorClass = null;
        entry.nextRetryAt = null;
        entry.generationStartedAt = null;
        setGenerationMemoryStatus(memory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic', generationStartedAt: null, lastError: null, lastRunId: operationId
        });
      }
      if (slot.generationId) cancelledRevisions.push({ generationId: slot.generationId, sourceId: slot.entryId });
      slot.tabId = null;
      slot.entryId = null;
      slot.status = 'IDLE';
      slot.phase = SLOT_PHASES.IDLE;
      slot.downloadId = null;
      slot.launchWaitUntil = null;
      slot.finalCheckPending = false;
      slot.finalCheckDeadlineAt = null;
      slot.finalCheckAttempts = 0;
      slot.failed = false;
      slot.rateLimitRetryNeeded = false;
      Object.assign(slot, freshSlotRevisionFields());
    }
    const protectedIds = new Set(recoverySlots.map((item) => item.entryId));
    const plannedIds = new Set(Array.isArray(currentRun.plannedIds) ? currentRun.plannedIds : []);
    currentRun.pendingIds = currentEntries
      .filter((entry) => plannedIds.has(entry.sourceId) && entry.status !== 'done' && !protectedIds.has(entry.sourceId))
      .map((entry) => entry.sourceId);
    const now = Date.now();
    currentRun.conversationRecovery = {
      stage: 'WAITING',
      attempts: previousAttempts + 1,
      startedAt: new Date(now).toISOString(),
      dueAt: now + CONVERSATION_LOAD_RECOVERY_DELAY_MS,
      error: 'ChatGPT временно не загрузил разговор. Проверю сохранённые чаты после паузы в 2 минуты.',
      triggerSlotId: signal?.slotId ?? null,
      triggerEntryId: signal?.entryId ?? null,
      slots: recoverySlots,
      closeTabs: closeTabRecords
    };
    currentRun.state = 'PAUSED';
    currentRun.status = 'CONVERSATION_RECOVERY';
    currentRun.pauseReason = 'CONVERSATION_LOAD';
    currentRun.unresolvedError = false;
    currentRun.stopBlocked = null;
    currentRun.error = null;
    currentRun.currentAction = 'Обнаружена ошибка загрузки разговора ChatGPT. Рабочие вкладки закрываются; через 2 минуты открою их и проверю уже отправленные генерации.';
    currentRun.lastActivityAt = new Date().toISOString();
    recordRunEvent(currentRun, 'conversation_load_recovery_started', {
      triggerSlotId: signal?.slotId ?? null,
      triggerEntryId: signal?.entryId ?? null,
      submittedCount: recoverySlots.length,
      requeuedCount: currentRun.pendingIds.length
    });
    await saveRunAndQueue(currentRun, stored.queue, history, memory);
    await publishRun(currentRun, stored.queue);
    return { tabIds: [...new Set(toClose.filter((id) => id > 0))], recoverySlots };
  });
  if (!commit) return { skipped: true };
  if (commit.unsafe) {
    await failConversationLoadRecovery(operationId, commit.unsafe, { attempt: previousAttempts });
    return { failed: true, unsafe: true };
  }

  await Promise.all(cancelledRevisions.map(({ generationId: id, sourceId }) =>
    cancelUnsubmittedGenerationRevision(id, sourceId, 'conversation_load_recovery_before_send').catch(() => {})));
  let closeError = null;
  try {
    await Promise.all(commit.tabIds.map((tabId) => sendTabMessage(tabId, { type: 'STOP' }, 2000).catch(() => null)));
    await closeConversationRecoveryTabs(operationId);
  } catch (error) {
    closeError = error;
  }
  if (closeError) {
    await failConversationLoadRecovery(operationId,
      `Не получилось безопасно закрыть рабочие вкладки (${closeError.message}). Восстановление остановлено; сохранённые задания доступны для ручной сверки.`,
      { attempt: previousAttempts + 1 });
    return { failed: true, error: closeError.message };
  }
  const current = await getStored();
  if (current.run?.operationId === operationId && current.run.conversationRecovery?.stage === 'WAITING') {
    scheduleConversationLoadRecovery(operationId, current.run.conversationRecovery.dueAt);
    await appendLog('Рабочие вкладки ChatGPT закрыты для восстановления разговора', {
      operationId,
      reopenAt: current.run.conversationRecovery.dueAt,
      submittedCount: commit.recoverySlots.length,
      tabCount: commit.tabIds.length
    });
  }
  return { waiting: true, dueAt: current.run?.conversationRecovery?.dueAt || null };
}

async function resumeConversationLoadRecovery(operationId = null) {
  const initial = await getStored();
  const run = initial.run;
  const recovery = run?.conversationRecovery;
  const stage = String(recovery?.stage || '').toUpperCase();
  if (!run || (operationId && run.operationId !== operationId) || !['WAITING', 'REOPENING'].includes(stage)) return { skipped: true };
  if (stage === 'WAITING' && Number(recovery.dueAt || 0) > Date.now()) {
    scheduleConversationLoadRecovery(run.operationId, recovery.dueAt);
    return { waiting: true, dueAt: recovery.dueAt };
  }

  await closeConversationRecoveryTabs(run.operationId);
  await withStateLock(async () => {
    const stored = await getStored();
    if (!stored.run || stored.run.operationId !== run.operationId) return;
    const currentStage = String(stored.run.conversationRecovery?.stage || '').toUpperCase();
    if (!['WAITING', 'REOPENING'].includes(currentStage)) return;
    stored.run.conversationRecovery.stage = 'REOPENING';
    stored.run.conversationRecovery.reopeningAt ||= new Date().toISOString();
    stored.run.currentAction = 'Пауза завершена. Повторно открываю сохранённые разговоры и сверяю уже отправленные генерации.';
    await saveRunAndQueue(stored.run, stored.queue);
    await publishRun(stored.run, stored.queue);
  });

  try {
    const host = await ensureAutomationWindow(run.operationId);
    const latest = await getStored();
    const snapshotSlots = latest.run?.conversationRecovery?.slots || [];
    const opened = [];
    for (let index = 0; index < snapshotSlots.length; index += 1) {
      const saved = snapshotSlots[index];
      const current = await getStored();
      if (current.run?.operationId !== run.operationId
        || String(current.run.conversationRecovery?.stage || '').toUpperCase() !== 'REOPENING') return { skipped: true };
      const slot = current.run.slots?.[saved.slotId];
      if (!slot || slot.entryId !== saved.entryId) continue;
      let tab = slot.tabId ? await chrome.tabs.get(Number(slot.tabId)).catch(() => null) : null;
      const wantedUrl = normalizeChatConversationUrl(saved.chatUrl);
      if (!wantedUrl) throw new Error(`У слота ${Number(saved.slotId) + 1} нет сохранённой ссылки на разговор.`);
      if (!tab || normalizeChatConversationUrl(tab.url || tab.pendingUrl) !== wantedUrl) {
        if (index > 0) await sleep(900);
        tab = await chrome.tabs.create({
          windowId: host.windowId,
          url: automationConversationUrl(wantedUrl),
          active: false
        });
        await withStateLock(async () => {
          const stored = await getStored();
          if (stored.run?.operationId !== run.operationId
            || String(stored.run.conversationRecovery?.stage || '').toUpperCase() !== 'REOPENING') return;
          const latestSlot = stored.run.slots?.[saved.slotId];
          if (!latestSlot || latestSlot.entryId !== saved.entryId) return;
          latestSlot.tabId = tab.id;
          latestSlot.chatUrl = wantedUrl;
          latestSlot.status = 'OBSERVING';
          latestSlot.phase = SLOT_PHASES.OBSERVING;
          const recoverySlot = stored.run.conversationRecovery?.slots?.find((item) => (
            Number(item.slotId) === Number(saved.slotId) && item.entryId === saved.entryId
          ));
          if (recoverySlot) {
            recoverySlot.reopenedTabId = tab.id;
            recoverySlot.reopenedAt = new Date().toISOString();
          }
          await saveRunAndQueue(stored.run, stored.queue);
        });
      }
      await waitTabReady(tab.id, 90000);
      await markTabAsAutomation(tab.id, {
        operationId: run.operationId,
        slotId: saved.slotId,
        entryId: saved.entryId
      });
      opened.push({ saved, tabId: tab.id });
    }

    const probes = await Promise.all(opened.map(async ({ saved, tabId }) => {
      try {
        const response = await sendTabMessage(tabId, {
          type: 'CHECK_GENERATION',
          operationId: run.operationId,
          slotId: saved.slotId,
          entryId: saved.entryId,
          leaseId: saved.leaseId,
          generationId: saved.generationId,
          outputFileName: saved.outputFileName,
          modelName: saved.modelName,
          submittedAtMs: saved.submittedAtMs,
          baselineAssistantCount: saved.baselineAssistantCount,
          recover: true
        }, TAB_MESSAGE_TIMEOUT_MS);
        return { saved, tabId, value: response?.value || {}, error: null };
      } catch (error) {
        return { saved, tabId, value: null, error };
      }
    }));
    const failedProbe = probes.find((item) => item.error
      || item.value?.state === 'CONVERSATION_LOAD_ERROR');
    if (failedProbe) {
      const label = failedProbe.value?.error || failedProbe.error?.message || 'разговор всё ещё не загружается';
      await failConversationLoadRecovery(run.operationId,
        `После одной попытки переоткрытия ChatGPT не восстановил разговор: ${String(label).slice(0, 700)}. Повторный автоматический цикл отключён.`,
        { attempt: Number(recovery.attempts || 1) });
      return { failed: true, reason: label };
    }

    await withStateLock(async () => {
      const stored = await getStored();
      if (!stored.run || stored.run.operationId !== run.operationId) return;
      const currentRecovery = stored.run.conversationRecovery;
      if (String(currentRecovery?.stage || '').toUpperCase() !== 'REOPENING') return;
      for (const item of probes) {
        const slot = stored.run.slots?.[item.saved.slotId];
        if (!slot || slot.entryId !== item.saved.entryId) continue;
        slot.tabId = item.tabId;
        slot.chatUrl = item.saved.chatUrl;
        slot.status = 'OBSERVING';
        slot.phase = SLOT_PHASES.OBSERVING;
        slot.finalCheckPending = true;
        slot.finalCheckDeadlineAt = Number(slot.finalCheckDeadlineAt || 0) > Date.now()
          ? slot.finalCheckDeadlineAt : finalCheckDeadline();
        slot.lastCheckState = item.value?.state || 'UNKNOWN';
        slot.lastCheckError = item.value?.error || null;
        slot.noResponseSince = null;
      }
      currentRecovery.stage = 'COMPLETED';
      currentRecovery.completedAt = new Date().toISOString();
      currentRecovery.error = null;
      stored.run.state = 'PAUSED';
      stored.run.status = 'PAUSED_RECOVERING';
      stored.run.pauseReason = 'CONVERSATION_LOAD';
      stored.run.unresolvedError = false;
      stored.run.error = null;
      stored.run.currentAction = 'Сохранённые чаты открылись. Продолжаю с уже отправленных генераций и запускаю следующие модели.';
      stored.run.lastActivityAt = new Date().toISOString();
      recordRunEvent(stored.run, 'conversation_load_recovery_completed', { reopenedCount: opened.length });
      await saveRunAndQueue(stored.run, stored.queue);
      await publishRun(stored.run, stored.queue);
    });
    if (chrome.alarms?.clear) await chrome.alarms.clear(CONVERSATION_LOAD_RECOVERY_ALARM_NAME).catch(() => {});
    await resumeRun({ conversationRecoveryInternal: true });
    await appendLog('Сохранённые разговоры восстановлены; генерационные промпты повторно не отправлялись', {
      operationId: run.operationId,
      reopenedCount: opened.length
    });
    return { recovered: true, reopenedCount: opened.length };
  } catch (error) {
    await failConversationLoadRecovery(run.operationId,
      `Не удалось безопасно переоткрыть и проверить сохранённые разговоры: ${error.message}`,
      { attempt: Number(recovery.attempts || 1) });
    return { failed: true, error: error.message };
  }
}

function automationConversationUrl(value) {
  const normalized = normalizeChatConversationUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.searchParams.set('watch_automation', '1');
  return url.toString();
}

function factsProgressSummaries(run) {
  return Object.values(run?.factsProgress || {})
    .filter((item) => item?.factsJobId && item?.entryId)
    .sort((a, b) => Number(a.slotId ?? 999) - Number(b.slotId ?? 999) || Number(b.stageAtMs || 0) - Number(a.stageAtMs || 0))
    .map((item) => ({
      factsJobId: item.factsJobId,
      entryId: item.entryId,
      generationId: item.generationId || null,
      outputPath: item.outputPath || null,
      outputHash: item.outputHash || null,
      entryName: item.entryName || null,
      modelName: item.modelName || null,
      slotId: Number.isFinite(Number(item.slotId)) ? Number(item.slotId) : null,
      tabId: Number(item.tabId || 0) || null,
      stage: item.stage || 'QUEUED',
      stageAt: item.stageAt || null,
      stageAtMs: Number(item.stageAtMs || 0) || null,
      startedAt: item.startedAt || null,
      startedAtMs: Number(item.startedAtMs || 0) || null,
      waitUntil: Number(item.waitUntil || 0) || null,
      chatUrl: normalizeChatConversationUrl(item.chatUrl),
      error: item.error || null
    }));
}

async function updateFactsStage(message, sender, overrides = {}) {
  const operationId = String(overrides.operationId || message?.operationId || '');
  const entryId = String(overrides.entryId || message?.entryId || '');
  const factsJobId = String(overrides.factsJobId || message?.factsJobId || '');
  if (!operationId || !entryId || !factsJobId) return { ignored: true };
  const stage = String(overrides.stage || message?.stage || 'QUEUED').toUpperCase();
  const incomingAtMs = Number(overrides.stageAtMs || message?.stageAtMs || Date.now());
  const incomingStartedAtMs = Number(overrides.startedAtMs || message?.startedAtMs || incomingAtMs);
  const tabId = Number(overrides.tabId || sender?.tab?.id || message?.tabId || 0) || null;
  const slotIdRaw = overrides.slotId ?? message?.slotId;
  const slotId = Number.isFinite(Number(slotIdRaw)) ? Number(slotIdRaw) : null;
  let summary = null;
  await withStateLock(async () => {
    const { run } = await chrome.storage.local.get('run');
    if (!run || run.operationId !== operationId) return;
    const stageTabId = Number(overrides.tabId || sender?.tab?.id || message?.tabId || 0) || null;
    const postprocessOwner = stageTabId ? run.postprocessTabs?.[String(stageTabId)] || null : null;
    const slotOwner = stageTabId
      ? Object.values(run.slots || {}).find((slot) => Number(slot?.tabId || 0) === stageTabId && slot?.entryId === entryId) || null
      : null;
    const identityOwner = postprocessOwner || slotOwner;
    const previous = run.factsProgress?.[factsJobId] || null;
    const stageIdentity = {
      ...message,
      entryId,
      factsJobId,
      generationId: overrides.generationId ?? message?.generationId,
      outputHash: overrides.outputHash ?? message?.outputHash
    };
    // A completed revision may release its OCR tab just before the SAVED UI
    // update obtains this lock. Retain that terminal update for the same tab,
    // generation and facts job; never accept a different revision by slot.
    if (stageTabId && !factsStageMatchesOwner(stageIdentity, identityOwner)
      && !(stage === 'SAVED' && !identityOwner
        && savedFactsStageMatchesReleasedOwner(stageIdentity, previous, stageTabId))) return;
    run.factsProgress ||= {};
    if (previous && Number(previous.stageAtMs || 0) > incomingAtMs) return;
    if (!previous && stage === 'QUEUED' && slotId != null) {
      // Keep at most one visible facts lifecycle per worker slot. Terminal
      // stages remain visible until that slot starts its next postcheck.
      for (const [key, value] of Object.entries(run.factsProgress)) {
        if (key !== factsJobId && Number(value?.slotId) === slotId) delete run.factsProgress[key];
      }
    }
    const generationIdValue = overrides.generationId || message?.generationId || identityOwner?.generationId || previous?.generationId || null;
    const outputPath = overrides.outputPath || message?.outputPath || identityOwner?.outputPath || previous?.outputPath || null;
    const outputHash = overrides.outputHash || message?.outputHash || identityOwner?.outputHash || previous?.outputHash || null;
    const chatUrl = normalizeChatConversationUrl(overrides.chatUrl || message?.chatUrl || previous?.chatUrl);
    run.factsProgress[factsJobId] = {
      ...(previous || {}),
      factsJobId,
      entryId,
      generationId: generationIdValue,
      outputPath,
      outputHash,
      entryName: overrides.entryName || message?.entryName || previous?.entryName || null,
      modelName: overrides.modelName || message?.modelName || previous?.modelName || null,
      slotId: slotId != null ? slotId : (previous?.slotId ?? null),
      tabId: stageTabId || previous?.tabId || null,
      stage,
      stageAt: new Date(incomingAtMs).toISOString(),
      stageAtMs: incomingAtMs,
      startedAt: previous?.startedAt || new Date(incomingStartedAtMs).toISOString(),
      startedAtMs: Number(previous?.startedAtMs || incomingStartedAtMs),
      waitUntil: Number(overrides.waitUntil || message?.waitUntil || 0) || null,
      chatUrl: chatUrl || previous?.chatUrl || null,
      userTurnId: overrides.userTurnId || message?.userTurnId || previous?.userTurnId || null,
      baselineAssistantCount: Number(overrides.baselineAssistantCount ?? message?.baselineAssistantCount ?? previous?.baselineAssistantCount ?? 0),
      baselineUserCount: Number(overrides.baselineUserCount ?? message?.baselineUserCount ?? previous?.baselineUserCount ?? 0),
      error: overrides.error || message?.error || null
    };
    if (postprocessOwner && postprocessOwner.entryId === entryId && postprocessOwner.factsJobId === factsJobId) {
      postprocessOwner.userTurnId = run.factsProgress[factsJobId].userTurnId;
      postprocessOwner.baselineAssistantCount = run.factsProgress[factsJobId].baselineAssistantCount;
      postprocessOwner.baselineUserCount = run.factsProgress[factsJobId].baselineUserCount;
    }
    await chrome.storage.local.set({ run });
    summary = factsProgressSummaries(run);
  });
  if (summary) await updateRuntime({ factsJobs: summary });
  if (!['SAVED', 'ERROR'].includes(stage)) startFactsPulseMonitor(100);
  return { ok: true };
}

async function requestFactsSendPermit(message, sender) {
  const operationId = String(message?.operationId || '');
  const entryId = String(message?.entryId || '');
  const factsJobId = String(message?.factsJobId || '');
  if (!operationId || !entryId || !factsJobId) throw new Error('Некорректный запрос Send-разрешения постпроверки');
  const taskKey = `${operationId}:${factsJobId}`;
  const existing = activeFactsSendTasks.get(taskKey);
  if (existing) return existing;
  ensureLaunchScheduler(operationId);

  // Do NOT append facts to launchChain. launchChain contains generation-specific
  // 8-12 second spacing, tab messaging and state bookkeeping; a postcheck that
  // is already ready to click Send must not wait behind that queue. The much
  // smaller physicalSendChain protects only the shared click spacing.
  const task = physicalSendChain.then(async () => {
    const first = await chrome.storage.local.get('run');
    const run = first.run;
    if (!run || run.operationId !== operationId || !['RUNNING', 'DRAINING', 'PAUSED'].includes(run.state)) {
      throw new Error('Постпроверка отменена: запуск больше не активен');
    }
    const ownedBySlot = Object.values(run.slots || {}).some((slot) => slot?.entryId === entryId && slot?.factsJobId === factsJobId);
    const ownedByPostprocess = Object.values(run.postprocessTabs || {}).some((item) => item?.entryId === entryId && item?.factsJobId === factsJobId);
    if (!ownedBySlot && !ownedByPostprocess) throw new Error('Постпроверка потеряла владение карточкой');
    const pauseUntil = Number(run.rateLimitPauseUntil || 0);
    if (pauseUntil > Date.now()) {
      return { granted: false, reason: 'rate_limit_pause', retryAt: pauseUntil };
    }
    const persistedAny = Math.max(
      Number(run.lastAnySendAt || 0),
      Number(run.lastGenerationLaunchAt || 0),
      Number(run.lastPostprocessSendAt || 0)
    );
    const previousAny = Math.max(lastAnySendAt, persistedAny);
    const waitMs = previousAny ? Math.max(0, previousAny + POSTPROCESS_SEND_GAP_MS - Date.now()) : 0;
    if (waitMs > 0) {
      // This stage write is telemetry only; never make the Send permit depend
      // on the large persisted run snapshot. The page already emitted the live
      // status and the durable stage is written asynchronously.
      void updateFactsStage(message, sender, { stage: 'WAITING_SEND_GATE', waitUntil: Date.now() + waitMs });
      await sleep(waitMs);
    }
    const latest = await chrome.storage.local.get('run');
    if (!latest.run || latest.run.operationId !== operationId || !['RUNNING', 'DRAINING', 'PAUSED'].includes(latest.run.state)) {
      throw new Error('Постпроверка отменена перед Send');
    }
    const latestPauseUntil = Number(latest.run.rateLimitPauseUntil || 0);
    if (latestPauseUntil > Date.now()) {
      return { granted: false, reason: 'rate_limit_pause', retryAt: latestPauseUntil };
    }
    const reservedAtMs = Date.now();
    lastAnySendAt = Math.max(lastAnySendAt, reservedAtMs);
    // Persist the reservation, but do not block the physical click on storage.
    // The in-memory chain is authoritative while this worker is awake; the
    // persisted timestamp is only recovery state for an MV3 suspension.
    void withStateLock(async () => {
      const current = await chrome.storage.local.get('run');
      if (!current.run || current.run.operationId !== operationId) return;
      current.run.lastAnySendAt = Math.max(Number(current.run.lastAnySendAt || 0), reservedAtMs);
      current.run.lastPostprocessSendAt = Math.max(Number(current.run.lastPostprocessSendAt || 0), reservedAtMs);
      await chrome.storage.local.set({ run: current.run });
    });
    return { granted: true, reservedAtMs, waitMs };
  });
  let tracked;
  tracked = task.finally(() => {
    if (activeFactsSendTasks.get(taskKey) === tracked) activeFactsSendTasks.delete(taskKey);
  });
  activeFactsSendTasks.set(taskKey, tracked);
  physicalSendChain = tracked.catch(() => {});
  return tracked;
}

async function markLaunchWaiting(operationId, slotId, entryId, waitMs) {
  let waitUntil = null;
  await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    const slot = run?.slots?.[slotId];
    if (!run || run.operationId !== operationId || slot?.entryId !== entryId) return;
    slot.status = 'WAITING_LAUNCH';
    slot.launchWaitUntil = Date.now() + Math.max(0, Number(waitMs || 0));
    waitUntil = slot.launchWaitUntil;
    slot.lastActivityAt = new Date().toISOString();
    run.currentAction = `Ожидаю интервал ${Math.ceil(waitMs / 1000)} с: ${entryDisplayName(groupEntries(queue, run.groupId).find((entry) => entry.sourceId === entryId), slot)}`;
    run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(run, queue);
    await publishRun(run, queue);
  });
  // A several-minute setTimeout cannot be the sole owner of this wait in MV3.
  // The persisted deadline survives worker suspension; this alarm wakes the
  // prepared slot at that deadline. Short waits keep the existing fast path.
  if (waitUntil && waitMs >= 30000 && chrome.alarms?.create) {
    await chrome.alarms.create(`${GENERATION_SEND_ALARM_PREFIX}${operationId}:${slotId}`, { when: waitUntil });
  }
}

async function detectRateLimitDialogs(operationId) {
  const { run } = await getStored();
  if (!run || run.operationId !== operationId) return null;
  const slots = Object.values(run.slots || {})
    .filter((slot) => slot.tabId)
    .sort((a, b) => Number(a.slotId || 0) - Number(b.slotId || 0));
  for (const slot of slots) {
    try {
      const response = await sendTabMessage(slot.tabId, {
        type: 'CHECK_RATE_LIMIT',
        operationId,
        slotId: slot.slotId,
        entryId: slot.entryId,
        forceDismiss: isRateLimitIgnored(run.rateLimitIgnoreUntil)
      });
      if (response?.ok && response.value?.detected) {
        return { slotId: slot.slotId, tabId: slot.tabId, ...response.value };
      }
    } catch (_) {}
  }
  return null;
}

async function pauseNewLaunchesForRateLimit(operationId, details = {}) {
  const imageResumeAt = imageLimitResumeAt(details.text || details.reason);
  if (imageResumeAt) return pauseForImageLimit(operationId, details, imageResumeAt);
  // Several observers can report the same modal within one audit cycle:
  // content-script, adapter and the worker audit all probe the page. Treat
  // those reports as one incident. The cooldown starts at the first signal
  // and is never extended by duplicate reports while it is still active.
  let pauseUntil = 0;
  let pauseStartedAt = 0;
  let firstDetection = false;
  let changed = false;
  let pauseMinutes = DEFAULT_RATE_LIMIT_PAUSE_MINUTES;
  await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    if (!run || run.operationId !== operationId || ['STOPPED', 'DONE'].includes(run.state)) return;
    const now = Date.now();
    pauseMinutes = normalizeRateLimitPauseMinutes(run.rateLimitPauseMinutes);
    run.rateLimitPauseMinutes = pauseMinutes;
    const pauseMs = pauseMinutes * 60000;
    const previousUntil = Number(run.rateLimitPauseUntil || 0);
    firstDetection = previousUntil <= now;
    pauseStartedAt = firstDetection ? now : now - pauseMs;
    pauseUntil = coalescedPauseDeadline(previousUntil, now, pauseMs);
    run.rateLimitPauseUntil = pauseUntil;
    if (firstDetection) run.rateLimitPauseStartedAt = new Date(now).toISOString();
    run.rateLimitReason = details.text || details.reason || 'Слишком много запросов';
    run.status = 'RATE_LIMIT_PAUSE';
    run.currentAction = `Пауза новых запусков до ${clockTime(run.rateLimitPauseUntil)}`;
    run.lastActivityAt = new Date().toISOString();
    if (firstDetection) {
      recordRunEvent(run, 'rate_limit_pause', {
        startedAt: new Date(now).toISOString(),
        until: run.rateLimitPauseUntil,
        durationMs: pauseMs,
        durationMinutes: pauseMinutes,
        slotId: details.slotId ?? null
      });
    } else {
      recordRunEvent(run, 'rate_limit_duplicate', {
        until: run.rateLimitPauseUntil,
        slotId: details.slotId ?? null
      });
    }
    for (const slot of Object.values(run.slots || {})) {
      // A rate-limit pause blocks only future submissions. Already submitted
      // generations continue to be observed and downloaded normally.
      const launchPending = ['STARTING', 'PREPARING', 'UPLOADING', 'WAITING_LAUNCH', 'SENDING'].includes(String(slot.status || '').toUpperCase())
        || slot.phase === SLOT_PHASES.WAITING_LAUNCH;
      if (slot.entryId && !slot.downloadId && !slot.finalCheckPending && !slot.generationSubmittedAt && launchPending) {
        slot.phase = SLOT_PHASES.RATE_LIMIT_PAUSE;
        // This flag is persisted on purpose. MV3 may suspend the service
        // worker during a multi-minute cooldown and discard the in-memory
        // launchChain promise. On alarm wake-up every unsubmitted launch must
        // therefore be reconstructible from storage.
        slot.rateLimitRetryNeeded = true;
      }
    }
    changed = firstDetection;
    await saveRunAndQueue(run, queue);
    await publishRun(run, queue);
  });
  if (changed) {
    scheduleRateLimitResume(operationId, pauseUntil);
    await appendLog(`Обнаружено ограничение запросов. Отправка новых генераций приостановлена на ${pauseMinutes} мин`, {
      startedAt: new Date(pauseStartedAt).toISOString(),
      until: new Date(pauseUntil).toISOString(),
      durationMinutes: pauseMinutes,
      slotId: details.slotId ?? null
    });
  }
  return pauseUntil;
}

function pauseForImageLimit(operationId, details, parsedResumeAt) {
  const existing = imageLimitTasks.get(operationId);
  if (existing) return existing;
  const task = (async () => {
    let pauseUntil = 0;
    let alreadySettled = false;
    await withStateLock(async () => {
      const stored = await getStored();
      const { run, queue } = stored;
      if (!run || run.operationId !== operationId || ['DONE', 'STOPPED'].includes(run.state)) return;
      if (run.imageLimitDetected === true
        && !Object.values(run.slots || {}).some((slot) => slot.entryId && !slot.downloadId)) {
        pauseUntil = Number(run.rateLimitPauseUntil || 0);
        alreadySettled = true;
        return;
      }
      const existingImageDeadline = run.imageLimitDetected === true
        ? Number(run.rateLimitPauseUntil || 0) : 0;
      pauseUntil = Math.max(existingImageDeadline, parsedResumeAt,
        parsedResumeAt <= Date.now() ? Date.now() + 60000 : 0);
      run.state = 'PAUSED';
      run.status = 'RATE_LIMIT_PAUSE';
      run.pauseReason = run.pauseReason === 'USER' ? 'USER' : 'IMAGE_LIMIT';
      run.imageLimitDetected = true;
      run.rateLimitPauseUntil = pauseUntil;
      run.rateLimitPauseStartedAt ||= new Date().toISOString();
      run.rateLimitReason = details.text || 'Достигнут лимит создания изображений';
      run.rateLimitIgnoreUntil = null;
      run.currentAction = `Лимит изображений. Проверяю готовые результаты; очередь возобновится в ${clockTime(pauseUntil)}`;
      run.lastActivityAt = new Date().toISOString();
      recordRunEvent(run, 'image_limit_pause', {
        until: pauseUntil, slotId: details.slotId ?? null, text: run.rateLimitReason
      });
      await saveRunAndQueue(run, queue);
      await publishRun(run, queue);
    });
    if (!pauseUntil) return null;
    scheduleRateLimitResume(operationId, pauseUntil);
    if (alreadySettled) return pauseUntil;

    // Inspect every occupied tab, including ones started after the first
    // limited tab. A visible completed image is downloaded before release.
    const snapshot = await getStored();
    await quickProbeReadyResultsBeforeReset(snapshot.run).catch(() => {});
    const downloadDeadline = Date.now() + 30000;
    while (Date.now() < downloadDeadline) {
      await reconcileActiveDownloads().catch(() => {});
      const current = await getStored();
      if (!current.run || current.run.operationId !== operationId
        || !Object.values(current.run.slots || {}).some((slot) => slot.downloadId)) break;
      await sleep(1000);
    }

    const released = await withStateLock(async () => {
      const stored = await getStored();
      const { run, queue } = stored;
      if (!run || run.operationId !== operationId || run.imageLimitDetected !== true) return null;
      const history = normalizeHistory(stored.history);
      const memory = normalizeGenerationMemory(stored.generationMemory);
      const entries = groupEntries(queue, run.groupId);
      const tabIds = [];
      const cancelled = [];
      const returned = [];
      for (const slot of Object.values(run.slots || {})) {
        if (!slot.entryId || slot.downloadId) continue;
        const entry = entries.find((item) => item.sourceId === slot.entryId);
        if (slot.tabId) tabIds.push(slot.tabId);
        if (entry?.status !== 'done') {
          returned.push(slot.entryId);
          entry.status = 'pending';
          entry.retryCount = 0;
          entry.lastError = null;
          entry.errorClass = null;
          entry.nextRetryAt = null;
          entry.generationStartedAt = null;
          setGenerationMemoryStatus(memory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
            statusSource: 'automatic', generationStartedAt: null, lastError: null,
            lastRunId: run.operationId, retryCount: 0, errorClass: null, nextRetryAt: null
          });
          delete history.items[slot.entryId];
          delete history.ignored[slot.entryId];
          if (slot.generationId) cancelled.push({ generationId: slot.generationId, sourceId: slot.entryId });
        }
        slot.tabId = null;
        slot.entryId = null;
        slot.status = 'IDLE';
        slot.phase = SLOT_PHASES.IDLE;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.rateLimitRetryNeeded = false;
        slot.lastCheckError = null;
        slot.failed = false;
        slot.launchWaitUntil = null;
        Object.assign(slot, freshSlotRevisionFields());
      }
      const planned = new Set(run.plannedIds || []);
      const occupied = new Set(Object.values(run.slots || {}).map((slot) => slot.entryId).filter(Boolean));
      run.pendingIds = entries.filter((entry) => planned.has(entry.sourceId)
        && entry.status !== 'done' && !occupied.has(entry.sourceId)).map((entry) => entry.sourceId);
      run.currentAction = `Лимит изображений. ${returned.length} моделей возвращено в очередь. Продолжу в ${clockTime(pauseUntil)}`;
      recordRunEvent(run, 'image_limit_requeued', { entryIds: returned });
      await saveRunAndQueue(run, queue, history, memory);
      await publishRun(run, queue);
      const protectedTabs = new Set([
        ...Object.keys(run.postprocessTabs || {}).map(Number),
        ...Object.keys(run.recoveryTabs || {}).map(Number)
      ]);
      return { tabIds: tabIds.filter((tabId) => !protectedTabs.has(Number(tabId))), cancelled, returned };
    });
    if (!released) return pauseUntil;
    await Promise.all(released.cancelled.map(({ generationId, sourceId }) =>
      cancelUnsubmittedGenerationRevision(generationId, sourceId, 'image_limit_without_output').catch(() => {})));
    await Promise.all(released.tabIds.map(async (tabId) => {
      await sendTabMessage(tabId, { type: 'STOP' }).catch(() => null);
      await chrome.tabs.remove(tabId).catch(() => null);
    }));
    await closeAutomationWindowIfEmpty(operationId);
    await appendLog('Лимит создания изображений: незавершённые модели возвращены в очередь', {
      until: new Date(pauseUntil).toISOString(), returned: released.returned.length
    });
    return pauseUntil;
  })().finally(() => imageLimitTasks.delete(operationId));
  imageLimitTasks.set(operationId, task);
  return task;
}

function armRateLimitIgnoreWindow(run, pauseStartedAt = run?.rateLimitPauseStartedAt, now = Date.now()) {
  if (!run) return false;
  const pauseKey = String(pauseStartedAt || run.rateLimitPauseUntil || '');
  if (run.rateLimitIgnoreAfterPause === pauseKey) return false;
  const ignoreMinutes = normalizeRateLimitIgnoreMinutes(run.rateLimitIgnoreMinutes);
  run.rateLimitIgnoreMinutes = ignoreMinutes;
  run.rateLimitIgnoreAfterPause = pauseKey;
  run.rateLimitIgnoreUntil = ignoreMinutes > 0 ? now + ignoreMinutes * 60000 : null;
  run.rateLimitIgnoredSlots = [];
  if (ignoreMinutes > 0) {
    recordRunEvent(run, 'rate_limit_ignore_window', {
      pauseKey,
      startedAt: new Date(now).toISOString(),
      until: new Date(run.rateLimitIgnoreUntil).toISOString(),
      durationMinutes: ignoreMinutes
    });
  }
  return true;
}

async function ignoreRateLimitDuringWindow(operationId, details = {}) {
  let ignored = false;
  await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    if (!run || run.operationId !== operationId) return;
    const now = Date.now();
    const expiredPause = Number(run.rateLimitPauseUntil || 0);
    const pauseKey = String(run.rateLimitPauseStartedAt || expiredPause || '');
    if (expiredPause > 0 && expiredPause <= now && run.rateLimitIgnoreAfterPause !== pauseKey) {
      armRateLimitIgnoreWindow(run, run.rateLimitPauseStartedAt || expiredPause, now);
      await saveRunAndQueue(run, queue);
      await publishRun(run, queue);
    }
    if (!isRateLimitIgnored(run.rateLimitIgnoreUntil, now)) return;
    ignored = true;
    const slotId = details.slotId == null ? 'unknown' : String(details.slotId);
    const seen = new Set((run.rateLimitIgnoredSlots || []).map(String));
    if (seen.has(slotId)) return;
    seen.add(slotId);
    run.rateLimitIgnoredSlots = [...seen];
    recordRunEvent(run, 'rate_limit_ignored', {
      slotId: details.slotId ?? null,
      tabId: details.tabId ?? null,
      text: details.text || null,
      ignoreUntil: run.rateLimitIgnoreUntil
    });
    await saveRunAndQueue(run, queue);
    await publishRun(run, queue);
  });
  return ignored;
}

async function waitForRateLimitClear(operationId) {
  while (true) {
    const { run } = await getStored();
    if (!run || run.operationId !== operationId || run.state !== 'RUNNING') {
      throw new Error('Запуск генерации отменён: очередь больше не активна');
    }
    const pauseUntil = Number(run.rateLimitPauseUntil || 0);
    if (pauseUntil > Date.now()) {
      await sleep(Math.min(1000, pauseUntil - Date.now()));
      continue;
    }
    if (pauseUntil > 0 && run.rateLimitIgnoreAfterPause !== String(run.rateLimitPauseStartedAt || pauseUntil)) {
      await withStateLock(async () => {
        const current = await getStored();
        if (!current.run || current.run.operationId !== operationId) return;
        armRateLimitIgnoreWindow(current.run, current.run.rateLimitPauseStartedAt || pauseUntil);
        await saveRunAndQueue(current.run, current.queue);
        await publishRun(current.run, current.queue);
      });
      continue;
    }
    const detected = await detectRateLimitDialogs(operationId);
    if (detected) {
      if (!imageLimitResumeAt(detected.text) && await ignoreRateLimitDuringWindow(operationId, detected)) continue;
      await pauseNewLaunchesForRateLimit(operationId, detected);
      continue;
    }
    if (run.status === 'RATE_LIMIT_PAUSE') {
      await withStateLock(async () => {
        const current = await getStored();
        if (!current.run || current.run.operationId !== operationId) return;
        current.run.rateLimitPauseUntil = null;
        current.run.rateLimitPauseStartedAt = null;
        current.run.rateLimitReason = null;
        current.run.status = hasUnresolvedSlotErrors(current.run) ? 'RUNNING_WITH_ERRORS' : 'RUNNING';
        current.run.currentAction = 'Ограничение снято. Продолжаю очередь.';
        current.run.lastActivityAt = new Date().toISOString();
        await saveRunAndQueue(current.run, current.queue);
        await publishRun(current.run, current.queue);
      });
    }
    return;
  }
}

async function resumeAfterRateLimitPause() {
  const initial = await getStored();
  const initialRun = initial.run;
  if (!initialRun || ['STOPPED', 'DONE'].includes(initialRun.state)) return;

  // The alarm can fire while the image-limit sweep is still downloading a
  // finished result and returning the remaining slots to the queue.
  if (imageLimitTasks.has(initialRun.operationId)) {
    scheduleRateLimitResume(initialRun.operationId, Date.now() + 5000);
    return;
  }

  const pauseUntil = Number(initialRun.rateLimitPauseUntil || 0);
  if (!pauseUntil) return;
  if (pauseUntil > Date.now()) {
    scheduleRateLimitResume(initialRun.operationId, pauseUntil);
    return;
  }

  let restart = false;
  const retryAssignments = [];
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== initialRun.operationId || ['STOPPED', 'DONE'].includes(run.state)) return;
    const currentPauseUntil = Number(run.rateLimitPauseUntil || 0);
    if (currentPauseUntil > Date.now()) {
      scheduleRateLimitResume(run.operationId, currentPauseUntil);
      return;
    }

    const wasImageLimit = run.imageLimitDetected === true;
    if (!wasImageLimit) {
      armRateLimitIgnoreWindow(run, run.rateLimitPauseStartedAt || currentPauseUntil);
    }
    run.imageLimitDetected = false;
    run.rateLimitPauseUntil = null;
    run.rateLimitPauseStartedAt = null;
    run.rateLimitReason = null;
    run.rateLimitPauseMinutes = normalizeRateLimitPauseMinutes(run.rateLimitPauseMinutes);
    const pausedByUserOrRestart = run.state === 'PAUSED'
      && ['USER', 'RESTART'].includes(String(run.pauseReason || '').toUpperCase());
    run.status = pausedByUserOrRestart
      ? (hasObservationWork(run) ? 'PAUSED_RECOVERING' : 'PAUSED')
      : (hasUnresolvedSlotErrors(run) ? 'RUNNING_WITH_ERRORS' : 'RUNNING');
    run.currentAction = pausedByUserOrRestart
      ? 'Ограничение снято. Очередь остаётся на паузе; уже отправленные генерации продолжаю досматривать.'
      : 'Ограничение снято. Возобновляю очередь.';
    run.lastActivityAt = new Date().toISOString();
    recordRunEvent(run, 'rate_limit_resume', { paused: pausedByUserOrRestart });
    for (const slot of Object.values(run.slots || {})) {
      const unsubmitted = Boolean(slot.entryId)
        && !slot.generationSubmittedAt
        && !slot.downloadId
        && !slot.finalCheckPending;
      const persistedDeferredLaunch = slot.rateLimitRetryNeeded === true
        || slot.phase === SLOT_PHASES.RATE_LIMIT_PAUSE
        || (slot.preparedForSubmit === true && ['READY_TO_SEND', 'WAITING_LAUNCH', 'SENDING'].includes(String(slot.status || '').toUpperCase()));
      if (!pausedByUserOrRestart && unsubmitted && persistedDeferredLaunch) {
        const prepared = slot.preparedForSubmit === true && Number(slot.tabId || 0) > 0;
        // Keep retryNeeded set until ChatGPT actually accepts the prompt. If
        // the MV3 worker is suspended again between this alarm and the click,
        // the next recovery pass still has a durable reason to resubmit.
        slot.rateLimitRetryNeeded = true;
        slot.status = prepared ? 'READY_TO_SEND' : 'STARTING';
        slot.phase = prepared ? SLOT_PHASES.WAITING_LAUNCH : SLOT_PHASES.PREPARING;
        slot.lastActivityAt = new Date().toISOString();
        retryAssignments.push({ slotId: slot.slotId, entryId: slot.entryId, tabId: slot.tabId || null, prepared });
      } else if (slot.phase === SLOT_PHASES.RATE_LIMIT_PAUSE) {
        slot.phase = slot.generationSubmittedAt || slot.finalCheckPending || slot.downloadId
          ? SLOT_PHASES.OBSERVING
          : (slot.preparedForSubmit ? SLOT_PHASES.WAITING_LAUNCH : SLOT_PHASES.PREPARING);
        if (!slot.generationSubmittedAt && slot.preparedForSubmit) slot.status = 'READY_TO_SEND';
      }
    }

    // If the last active slot ended before the cooldown expired, the regular
    // replacement path has already gone idle. Re-enter resumeRun so pending
    // items receive fresh assignments without duplicating completed entries.
    const plannedIds = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
    const hasUnfinishedPlanned = groupEntries(stored.queue, run.groupId).some((entry) => (
      plannedIds.has(entry.sourceId) && entry.status !== 'done'
    ));

    if (run.state === 'PAUSED') {
      restart = !['USER', 'RESTART'].includes(String(run.pauseReason || '').toUpperCase());
    } else if (run.state === 'RUNNING' && !hasLiveSlotWork(run) && hasUnfinishedPlanned) {
      run.state = 'PAUSED';
      run.status = 'PAUSED_ON_ERROR';
      run.pauseReason = 'RATE_LIMIT_IDLE';
      restart = true;
    } else if (run.state === 'RUNNING' && !hasLiveSlotWork(run) && !hasUnfinishedPlanned) {
      finalizeDrainingRun(run, stored.queue);
    }
    await saveRunAndQueue(run, stored.queue);
    await appendLog('Пауза ограничения запросов завершена', {
      restart,
      retryAssignments: retryAssignments.map((item) => item.slotId)
    });
    await publishRun(run, stored.queue);
  });

  if (restart && !retryAssignments.length) {
    await resumeRun();
  } else {
    const { run } = await getStored();
    if (run && ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) startAuditMonitor();
    if (run && ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) {
      for (const assignment of retryAssignments) {
        if (assignment.prepared && assignment.tabId) {
          void submitPreparedSlot(run.operationId, assignment.slotId, assignment.entryId, assignment.tabId)
            .catch((error) => pauseRunOnError(run.operationId, error, {
              slotId: assignment.slotId,
              entryId: assignment.entryId,
              tabId: assignment.tabId,
              errorClass: classifyAutomationError(error)
            }));
        } else {
          void executeSlot(run.operationId, assignment.slotId, assignment.entryId);
        }
      }
    }
  }
}

async function submitPreparedSlot(operationId, slotId, entryId, tabId) {
  const launchKey = `${operationId}:${slotId}:${entryId}`;
  const existingTask = activeLaunchTasks.get(launchKey);
  if (existingTask) return existingTask;

  ensureLaunchScheduler(operationId);
  const task = launchChain.then(async () => {
    // All expensive work (tab creation, attachments, prompt filling) happens
    // before this global gate. Only the actual Send click is serialized.
    await waitForRateLimitClear(operationId);
    const stored = await getStored();
    const run = stored.run;
    const slot = run?.slots?.[slotId];
    if (!run || run.operationId !== operationId || run.state !== 'RUNNING' || run.clockStopped || run.stopBlocked || slot?.entryId !== entryId) {
      throw new Error('Отправка генерации отменена: очередь больше не активна');
    }
    if (!slot.preparedForSubmit) {
      throw new Error('Слот не подготовлен к отправке');
    }

    // The interval is measured strictly from the previous real Send click to
    // the next Send click. It must never delay opening tabs, uploading files
    // or filling prompts.
    const persistedLastLaunchAt = Number(run.lastGenerationLaunchAt || 0);
    const previousLaunchAt = Math.max(lastLaunchAt, persistedLastLaunchAt);
    const gap = previousLaunchAt
      ? resolveGenerationPause(slot.generationGapMs, run.generationPauseMinutes, run.generationJitterSeconds)
      : null;
    let generationGapMs = gap?.delayMs || 0;
    if (previousLaunchAt && !gap.reused) {
      await withStateLock(async () => {
        const current = await chrome.storage.local.get('run');
        const currentSlot = current.run?.slots?.[slotId];
        if (!current.run || current.run.operationId !== operationId || currentSlot?.entryId !== entryId) {
          throw new Error('Пауза генерации отменена: слот больше не владеет моделью');
        }
        if (currentSlot.generationGapMs == null || !Number.isFinite(Number(currentSlot.generationGapMs))) {
          currentSlot.generationGapMs = gap.delayMs;
          currentSlot.generationPauseFactor = gap.factor;
          currentSlot.generationPauseDirection = gap.direction;
          recordRunEvent(current.run, 'generation_pause_sampled', { slotId, entryId, delayMs: gap.delayMs, factor: gap.factor, direction: gap.direction });
          await chrome.storage.local.set({ run: current.run });
        }
        generationGapMs = Number(currentSlot.generationGapMs);
      });
    }
    const generationWaitMs = previousLaunchAt
      ? Math.max(0, previousLaunchAt + generationGapMs - Date.now())
      : 0;
    const previousAnySendAt = Math.max(
      lastAnySendAt,
      Number(run.lastAnySendAt || 0),
      Number(run.lastPostprocessSendAt || 0),
      persistedLastLaunchAt
    );
    const anySendWaitMs = previousAnySendAt
      ? Math.max(0, previousAnySendAt + POSTPROCESS_SEND_GAP_MS - Date.now())
      : 0;
    const waitMs = Math.max(generationWaitMs, anySendWaitMs);
    if (waitMs > 0) await markLaunchWaiting(operationId, slotId, entryId, waitMs);
    if (waitMs > 0) await sleep(waitMs);

    await waitForRateLimitClear(operationId);
    const beforeSend = await getStored();
    const beforeSlot = beforeSend.run?.slots?.[slotId];
    if (!beforeSend.run || beforeSend.run.operationId !== operationId || beforeSend.run.state !== 'RUNNING' || beforeSend.run.clockStopped || beforeSend.run.stopBlocked || beforeSlot?.entryId !== entryId || beforeSlot.leaseId !== slot.leaseId) {
      throw new Error('Отправка генерации отменена: очередь больше не активна');
    }
    if (!beforeSlot.preparedForSubmit) throw new Error('Подготовленная вкладка потеряла состояние READY_TO_SEND');

    // Re-check only the universal physical-Send spacing immediately before the
    // click. A facts prompt may have been sent while this generation task was
    // sleeping for its 8-12 second generation interval; without this tiny
    // shared gate the two clicks could collide.
    const physicalGateTask = physicalSendChain.then(async () => {
      const latest = await chrome.storage.local.get('run');
      if (!latest.run || latest.run.operationId !== operationId || latest.run.state !== 'RUNNING' || latest.run.clockStopped || latest.run.stopBlocked) {
        throw new Error('Отправка генерации отменена у физического Send-gate');
      }
      const previousAny = Math.max(
        lastAnySendAt,
        Number(latest.run.lastAnySendAt || 0),
        Number(latest.run.lastPostprocessSendAt || 0),
        Number(latest.run.lastGenerationLaunchAt || 0)
      );
      const extraWaitMs = previousAny
        ? Math.max(0, previousAny + POSTPROCESS_SEND_GAP_MS - Date.now())
        : 0;
      if (extraWaitMs > 0) await sleep(extraWaitMs);
      const reservedAtMs = Date.now();
      lastAnySendAt = Math.max(lastAnySendAt, reservedAtMs);
      return { reservedAtMs, extraWaitMs };
    });
    physicalSendChain = physicalGateTask.catch(() => {});
    const physicalGate = await physicalGateTask;

    await withStateLock(async () => {
      const latest = await getStored();
      const latestSlot = latest.run?.slots?.[slotId];
      if (!latest.run || latest.run.operationId !== operationId || latest.run.state !== 'RUNNING' || latest.run.clockStopped || latest.run.stopBlocked || latestSlot?.entryId !== entryId || latestSlot.leaseId !== slot.leaseId) {
        throw new Error('Отправка генерации отменена: очередь больше не активна');
      }
      latest.run.currentAction = `Нажимаю Send: ${entryDisplayName(groupEntries(latest.queue, latest.run.groupId).find((entry) => entry.sourceId === entryId), latestSlot)}`;
      latest.run.lastGenerationLaunchAt = Math.max(Number(latest.run.lastGenerationLaunchAt || 0), Number(physicalGate.reservedAtMs || Date.now()));
      latest.run.lastAnySendAt = Math.max(Number(latest.run.lastAnySendAt || 0), Number(physicalGate.reservedAtMs || Date.now()));
      latest.run.lastActivityAt = new Date().toISOString();
      latestSlot.status = 'SENDING';
      latestSlot.phase = SLOT_PHASES.SENDING;
      // We are about to perform a real retry now. A new rate-limit signal may
      // set this back to true asynchronously; the post-click persistence below
      // must respect that race instead of overwriting the recovered state.
      latestSlot.rateLimitRetryNeeded = false;
      latestSlot.launchWaitUntil = null;
      latestSlot.lastActivityAt = latest.run.lastActivityAt;
      await saveRunAndQueue(latest.run, latest.queue);
      await publishRun(latest.run, latest.queue);
    });

    // SUBMIT_PAGE_RUN returns immediately after ChatGPT accepted the Send
    // click; image monitoring continues asynchronously inside the page.
    const submitted = await sendToTab(tabId, {
      type: 'SUBMIT_PAGE_RUN',
      operationId,
      slotId,
      entryId,
      leaseId: slot.leaseId
    }, TAB_MESSAGE_TIMEOUT_MS);
    const sendClickedAt = Number(submitted?.sendClickedAtMs || submitted?.submittedAtMs || Date.now());
    lastLaunchAt = Math.max(lastLaunchAt, sendClickedAt);
    lastAnySendAt = Math.max(lastAnySendAt, sendClickedAt);
    if (chrome.alarms?.clear) void chrome.alarms.clear(`${GENERATION_SEND_ALARM_PREFIX}${operationId}:${slotId}`).catch(() => {});

    await withStateLock(async () => {
      const latest = await getStored();
      const latestSlot = latest.run?.slots?.[slotId];
      if (!latest.run || latest.run.operationId !== operationId || latestSlot?.entryId !== entryId || latestSlot.leaseId !== slot.leaseId) return;
      // The global spacing clock is the physical Send click, not the later DOM
      // acknowledgement that ChatGPT created a user turn.
      latest.run.lastGenerationLaunchAt = Math.max(Number(latest.run.lastGenerationLaunchAt || 0), sendClickedAt);
      latest.run.lastAnySendAt = Math.max(Number(latest.run.lastAnySendAt || 0), sendClickedAt);
      latest.run.lastActivityAt = new Date(sendClickedAt).toISOString();
      latestSlot.lastSendClickedAt = new Date(sendClickedAt).toISOString();
      latestSlot.physicalSendAtMs = sendClickedAt;
      latestSlot.physicalSendLeaseId = slot.leaseId;
      latestSlot.submissionObservationDeadlineAt ||= sendClickedAt + FINAL_CHECK_TIMEOUT_MS;
      // confirmSendAndMonitor runs in the page immediately after the physical
      // click. It can detect a rate-limit rejection and restore READY_TO_SEND
      // before this worker reaches its post-click write. Never stomp that
      // recovery state with a stale SENDING snapshot.
      const rateLimitRecovered = latestSlot.rateLimitRetryNeeded === true
        || latestSlot.phase === SLOT_PHASES.RATE_LIMIT_PAUSE;
      if (!rateLimitRecovered) {
        latestSlot.preparedForSubmit = false;
        latestSlot.status = 'SENDING';
        latestSlot.phase = SLOT_PHASES.SENDING;
      }
      latestSlot.launchWaitUntil = null;
      latestSlot.lastProgressAt = latest.run.lastActivityAt;
      recordRunEvent(latest.run, 'send_clicked', {
        slotId,
        entryId,
        clickedAt: latest.run.lastActivityAt,
        waitMs: waitMs + Number(physicalGate?.extraWaitMs || 0)
      });
      await saveRunAndQueue(latest.run, latest.queue);
      await publishRun(latest.run, latest.queue);
    });
    return { sendClickedAt, waitMs: waitMs + Number(physicalGate?.extraWaitMs || 0) };
  });
  let tracked;
  tracked = task.finally(() => {
    if (activeLaunchTasks.get(launchKey) === tracked) activeLaunchTasks.delete(launchKey);
  });
  activeLaunchTasks.set(launchKey, tracked);
  launchChain = tracked.catch(() => {});
  return tracked;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureDevReloadAlarm();
  scheduleRevisionFactsRecoveryAfterUpgrade().catch(() => {});
  scheduleInterruptedRunRecovery('Расширение было перезапущено');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.domDiagnosticsMode) return;
  const mode = normalizeDomDiagnosticsMode(changes.domDiagnosticsMode.newValue);
  domDiagnosticsModeCache = mode;
  if (mode === DOM_DIAGNOSTICS_MODES.OFF) {
    domBridgeRetryAt = Date.now() + 1000;
  }
});

function withStateLock(task) {
  const next = stateChain.then(task);
  stateChain = next.catch(() => {});
  return next;
}

async function getStored() {
  return chrome.storage.local.get([
    'job', 'queue', 'run', 'runtime', 'logs', 'lastDiagnostic', 'history', 'generationMemory', 'lastPreflight', 'domDiagnosticsMode',
    'sessionResetIntent'
  ]);
}

function normalizeHistory(value) {
  return {
    version: 1,
    items: { ...(value?.items || {}) },
    ignored: { ...(value?.ignored || {}) }
  };
}

function normalizeGenerationMemory(value) {
  return {
    version: 1,
    items: { ...(value?.items || {}) }
  };
}

function generationMemoryEntries(memory) {
  return Object.values(memory?.items || {});
}

function syncGenerationMemory(queue, rawMemory, rawHistory = null, rawRun = null) {
  const memory = normalizeGenerationMemory(rawMemory);
  const history = normalizeHistory(rawHistory);
  let changed = false;
  const seen = new Set();
  const activeRun = rawRun && ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(rawRun.state)
    ? rawRun
    : null;
  const now = new Date().toISOString();

  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of groupEntries(queue, groupId)) {
      if (!entry?.sourceId) continue;
      const sourceId = entry.sourceId;
      seen.add(sourceId);
      const previous = memory.items[sourceId] || null;
      const legacy = history.items[sourceId] || null;
      const fingerprintChanged = Boolean(
        previous?.fingerprint && entry.fingerprint && previous.fingerprint !== entry.fingerprint
      );
      const recipeChanged = Boolean(
        previous?.recipeHash && entry.recipeHash && previous.recipeHash !== entry.recipeHash
      );
      let status = previous
        ? normalizeGenerationMemoryStatus(previous.status)
        : (legacy ? GENERATION_MEMORY_STATUSES.READY : generationMemoryStatusForQueueStatus(entry.status));
      if (fingerprintChanged || recipeChanged) status = GENERATION_MEMORY_STATUSES.NOT_READY;
      if (status === GENERATION_MEMORY_STATUSES.RUNNING && !activeRun && previous?.statusSource !== 'manual') {
        status = GENERATION_MEMORY_STATUSES.NOT_READY;
      }
      const nextCandidate = generationMemoryRecordFromEntry(entry, {
        ...(previous || {}),
        status,
        sourcePresent: true,
        statusSource: previous?.statusSource || (legacy ? 'automatic' : 'automatic'),
        generatedAt: fingerprintChanged || recipeChanged ? null : (previous?.generatedAt || legacy?.generatedAt || entry.generatedAt || null),
        outputPath: fingerprintChanged || recipeChanged ? null : (previous?.outputPath || legacy?.outputPath || entry.outputPath || null),
        generationStartedAt: fingerprintChanged || recipeChanged ? null : (previous?.generationStartedAt || null),
        lastError: fingerprintChanged || recipeChanged ? null : (previous?.lastError || entry.lastError || null),
        outputHash: fingerprintChanged || recipeChanged ? null : (previous?.outputHash || entry.outputHash || null),
        outputWidth: fingerprintChanged || recipeChanged ? null : (previous?.outputWidth || entry.outputWidth || null),
        outputHeight: fingerprintChanged || recipeChanged ? null : (previous?.outputHeight || entry.outputHeight || null),
        verificationMode: fingerprintChanged || recipeChanged ? null : (previous?.verificationMode || entry.verificationMode || null),
        recipeHash: entry.recipeHash || previous?.recipeHash || null,
        profileId: previous?.profileId || entry.profileId || null,
        profileVersion: previous?.profileVersion || entry.profileVersion || null,
        attempt: Number(previous?.attempt ?? entry.attempt ?? 0),
        updatedAt: now,
        createdAt: previous?.createdAt || now
      });
      const comparable = (value) => {
        if (!value) return null;
        const copy = { ...value };
        delete copy.updatedAt;
        return copy;
      };
      const same = JSON.stringify(comparable(previous)) === JSON.stringify(comparable(nextCandidate));
      const next = same
        ? { ...nextCandidate, updatedAt: previous?.updatedAt || now }
        : nextCandidate;
      memory.items[sourceId] = next;
      if (!same) changed = true;
    }
  }
  // Keep records for models removed from the selected folder. They remain
  // visible in the memory panel and can be forgotten explicitly by the user.
  for (const record of generationMemoryEntries(memory)) {
    if (!record?.sourceId || seen.has(record.sourceId)) continue;
    if (record.sourcePresent !== false) {
      record.sourcePresent = false;
      record.updatedAt = now;
      changed = true;
    }
  }
  return { memory, changed };
}

function syncQueueWithHistory(queue, rawHistory, rawMemory = null, rawRun = null) {
  const history = normalizeHistory(rawHistory);
  const memoryResult = syncGenerationMemory(queue, rawMemory, history, rawRun);
  const memory = memoryResult.memory;
  let historyChanged = false;
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of groupEntries(queue, groupId)) {
      if (entry.status === 'done' && !history.items[entry.sourceId]) {
        history.items[entry.sourceId] = historyRecordFromEntry(entry);
        historyChanged = true;
      }
      const record = memory.items[entry.sourceId];
      if (record?.status === GENERATION_MEMORY_STATUSES.READY) {
        if (!history.items[entry.sourceId]) {
          history.items[entry.sourceId] = historyRecordFromEntry(entry, {
            generatedAt: record.generatedAt || undefined,
            outputPath: record.outputPath || null
          });
          historyChanged = true;
        }
        if (history.ignored[entry.sourceId]) {
          delete history.ignored[entry.sourceId];
          historyChanged = true;
        }
      }
    }
  }
  applyGenerationHistory(queue?.groups || {}, history);
  applyGenerationMemory(queue?.groups || {}, memory);
  return { queue, history, memory, historyChanged, memoryChanged: memoryResult.changed };
}

function recordCompletedEntry(history, entry, outputPath = null, memory = null, runId = null, factsReady = false) {
  delete history.ignored[entry.sourceId];
  history.items[entry.sourceId] = historyRecordFromEntry(entry, {
    generatedAt: entry.generatedAt || new Date().toISOString(),
    outputPath,
    outputHash: entry.outputHash || null,
    outputWidth: entry.outputWidth || null,
    outputHeight: entry.outputHeight || null,
    verificationMode: entry.verificationMode || null
  });
  if (memory) {
    const previous = memory.items[entry.sourceId] || {};
    memory.items[entry.sourceId] = generationMemoryRecordFromEntry(entry, {
      ...previous,
      status: factsReady
        ? GENERATION_MEMORY_STATUSES.READY
        : (entry.factsStatus === 'pending' ? GENERATION_MEMORY_STATUSES.FACTS_PENDING : GENERATION_MEMORY_STATUSES.IMAGE_SAVED),
      sourcePresent: true,
      statusSource: 'automatic',
      generationStartedAt: previous.generationStartedAt || null,
      generatedAt: entry.generatedAt || new Date().toISOString(),
      outputPath,
      outputHash: entry.outputHash || null,
      outputWidth: entry.outputWidth || null,
      outputHeight: entry.outputHeight || null,
      verificationMode: entry.verificationMode || null,
      lastError: null,
      errorClass: null,
      nextRetryAt: null,
      lastRunId: runId || previous.lastRunId || null,
      reviewStatus: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

async function reconcileRunVerifiedRevisions(run, queue, history, generationMemory) {
  const events = (run?.eventJournal || []).filter((item) => item?.type === 'output_verified' && item.generationId && item.entryId);
  if (!events.length) return 0;
  const laterRejected = new Set((run.eventJournal || [])
    .filter((item) => item?.type === 'gallery_reject' && item.generationId)
    .map((item) => String(item.generationId)));
  let repaired = 0;
  const revisions = await Promise.all(events.map((event) => getGenerationRevision(String(event.generationId)).catch(() => null)));
  for (const [index, event] of events.entries()) {
    if (laterRejected.has(String(event.generationId))) continue;
    const revision = revisions[index];
    if (!verifiedRevisionMatchesEvent(event, revision, run.operationId)) continue;
    const factsProgress = Object.values(run.factsProgress || {}).find((item) => (
      String(item?.generationId || '') === String(revision.generationId)
      && String(item?.factsJobId || '') === String(revision.factsJobId || '')
    ));
    if (factsProgress && revisionFactsAreComplete(revision)
      && !['SAVED', 'ERROR'].includes(String(factsProgress.stage || '').toUpperCase())) {
      factsProgress.stage = 'SAVED';
      factsProgress.stageAt = revision.factsSavedAt || new Date().toISOString();
      factsProgress.stageAtMs = Date.parse(factsProgress.stageAt) || Date.now();
      factsProgress.error = null;
    }
    const entry = findQueueEntry(queue, event.entryId);
    if (!entry) continue;
    const memoryRecord = generationMemory.items?.[entry.sourceId];
    if (entry.status === 'done'
      && entry.generationId === event.generationId
      && normalizeGenerationMemoryStatus(memoryRecord?.status) === GENERATION_MEMORY_STATUSES.READY
      && history.items?.[entry.sourceId]) continue;
    Object.assign(entry, {
      status: 'done',
      generationId: revision.generationId,
      previousGenerationId: revision.previousGenerationId || null,
      generatedAt: revision.completedAt || revision.downloadedAt || event.at || new Date().toISOString(),
      outputPath: revision.outputPath,
      outputHash: revision.outputHash || null,
      outputWidth: revision.outputWidth || null,
      outputHeight: revision.outputHeight || null,
      verificationMode: revision.verificationMode || null,
      recipeHash: revision.recipeHash || entry.recipeHash || null,
      profileId: revision.profileId || entry.profileId || null,
      profileVersion: revision.profileVersion || entry.profileVersion || null,
      chatUrl: revision.chatUrl || null,
      factsStatus: revisionFactsAreComplete(revision) ? 'ok' : (revision.factsStatus || revision.facts?.status || entry.factsStatus || 'pending'),
      factsWarnings: Array.isArray(revision.facts?.warnings) ? revision.facts.warnings : (entry.factsWarnings || []),
      lastError: null,
      errorClass: null,
      nextRetryAt: null
    });
    recordCompletedEntry(history, entry, revision.outputPath, generationMemory, run.operationId,
      revisionFactsAreComplete(revision));
    repaired += 1;
  }
  return repaired;
}

async function reconcilePersistedCurrentRevisions(queue, history, generationMemory, filterValue = {}) {
  const catalog = await getAllModelCatalog().catch(() => []);
  if (!catalog.length) return 0;
  const runFilter = normalizeWatchFilter(filterValue);
  const excludedSourceIds = new Set((filterValue?.excludeSourceIds || []).map((id) => String(id)));
  const groupId = queue?.repairQueue && queue.repairQueue.length && filterValue?.runQueueMode === REGENERATION_QUEUE_ID
    ? REGENERATION_QUEUE_ID
    : groupIdForWatchFilter(runFilter);
  const selectedEntries = new Map(groupEntries(queue, groupId).map((entry) => [String(entry.sourceId), entry]));
  let restored = 0;
  for (const model of catalog) {
    if (excludedSourceIds.has(String(model.skuKey || ''))) continue;
    const generationIdValue = String(model.currentGenerationId || '');
    if (!generationIdValue) continue;
    const revision = await getGenerationRevision(generationIdValue).catch(() => null);
    if (!revision || String(revision.sourceId || '') !== String(model.skuKey || '')
      || revision.reviewStatus === 'rejected'
      || !revision.outputPath
      || !/^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))) continue;
    const entry = selectedEntries.get(String(model.skuKey));
    if (!entry) continue;
    const selectedVariantId = String(entry.inputSourceId || entry.sourceVariantId || '');
    if (revision.sourceVariantId && selectedVariantId && String(revision.sourceVariantId) !== selectedVariantId) continue;
    if (revision.sourceHash && entry.sourceHash
      && String(revision.sourceHash).toLowerCase() !== String(entry.sourceHash).toLowerCase()) continue;
    if (revision.sourceFingerprint && entry.fingerprint && String(revision.sourceFingerprint) !== String(entry.fingerprint)) continue;
    const memoryRecord = generationMemory.items?.[entry.sourceId];
    if (entry.status === 'done' && String(entry.generationId || '') === generationIdValue
      && String(entry.outputPath || '') === String(revision.outputPath)
      && String(entry.outputHash || '').toLowerCase() === String(revision.outputHash).toLowerCase()
      && String(memoryRecord?.generationId || '') === generationIdValue
      && queueStatusForGenerationMemoryStatus(memoryRecord?.status) === 'done'
      && String(memoryRecord?.factsStatus || '') === String(revision.factsStatus || 'pending')
      && String(memoryRecord?.chatUrl || '') === String(revision.chatUrl || '')
      && (revisionFactsAreComplete(revision)
        ? memoryRecord?.status === GENERATION_MEMORY_STATUSES.READY
        : memoryRecord?.status !== GENERATION_MEMORY_STATUSES.READY)) continue;

    Object.assign(entry, {
      status: 'done',
      generationId: generationIdValue,
      previousGenerationId: revision.previousGenerationId || null,
      generatedAt: revision.completedAt || revision.downloadedAt || revision.createdAt || new Date().toISOString(),
      outputPath: revision.outputPath,
      outputFileName: revision.outputFileName || entry.outputFileName,
      outputHash: revision.outputHash,
      outputWidth: Number(revision.outputWidth || 0) || null,
      outputHeight: Number(revision.outputHeight || 0) || null,
      verificationMode: revision.verificationMode || null,
      recipeHash: revision.recipeHash || entry.recipeHash || null,
      profileId: revision.profileId || entry.profileId || null,
      profileVersion: revision.profileVersion || entry.profileVersion || null,
      chatUrl: revision.chatUrl || null,
      factsStatus: revisionFactsAreComplete(revision) ? 'ok' : (revision.factsStatus || 'pending'),
      factsWarnings: Array.isArray(revision.facts?.warnings) ? revision.facts.warnings : [],
      lastError: null,
      errorClass: null,
      nextRetryAt: null
    });
    recordCompletedEntry(history, entry, revision.outputPath, generationMemory, revision.operationId || null,
      revisionFactsAreComplete(revision));
    const repairedMemoryRecord = generationMemory.items?.[entry.sourceId];
    if (repairedMemoryRecord) {
      repairedMemoryRecord.generationId = generationIdValue;
      repairedMemoryRecord.previousGenerationId = revision.previousGenerationId || null;
      repairedMemoryRecord.factsStatus = revision.factsStatus || 'pending';
      repairedMemoryRecord.chatUrl = revision.chatUrl || null;
    }
    restored += 1;
  }
  return restored;
}

function revisionFactsAreComplete(revision) {
  const facts = revision?.facts;
  return Boolean(revision?.status === 'READY'
    && revision?.factsStatus === 'ok'
    && facts?.status === 'ok'
    && String(facts.generationId || '') === String(revision.generationId || '')
    && String(facts.factsJobId || '') === String(revision.factsJobId || '')
    && String(facts.outputHash || '').toLowerCase() === String(revision.outputHash || '').toLowerCase()
    && Boolean(revision?.outputPath && /^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))));
}

function setGenerationMemoryRecordStatus(memory, record, status, overrides = {}) {
  if (!memory || !record?.sourceId) return;
  const normalized = normalizeGenerationMemoryStatus(status);
  const previous = memory.items[record.sourceId] || record || {};
  const now = new Date().toISOString();
  const clearResult = normalized !== GENERATION_MEMORY_STATUSES.READY;
  const clearRetryState = normalized === GENERATION_MEMORY_STATUSES.READY
    || normalized === GENERATION_MEMORY_STATUSES.RUNNING;
  memory.items[record.sourceId] = {
    ...previous,
    status: normalized,
    sourcePresent: overrides.sourcePresent ?? previous.sourcePresent ?? true,
    statusSource: overrides.statusSource || 'automatic',
    generationStartedAt: overrides.generationStartedAt ?? previous.generationStartedAt ?? null,
    generatedAt: overrides.generatedAt ?? (clearResult ? null : (previous.generatedAt || null)),
    outputPath: overrides.outputPath ?? (clearResult ? null : (previous.outputPath || null)),
    outputHash: overrides.outputHash ?? (clearResult ? null : (previous.outputHash || null)),
    outputWidth: overrides.outputWidth ?? (clearResult ? null : (previous.outputWidth || null)),
    outputHeight: overrides.outputHeight ?? (clearResult ? null : (previous.outputHeight || null)),
    verificationMode: overrides.verificationMode ?? (clearResult ? null : (previous.verificationMode || null)),
    errorClass: overrides.errorClass ?? (clearRetryState ? null : (clearResult ? (previous.errorClass || null) : null)),
    nextRetryAt: overrides.nextRetryAt ?? (clearRetryState ? null : (clearResult ? (previous.nextRetryAt || null) : null)),
    retryCount: overrides.retryCount ?? Number(previous.retryCount || 0),
    lastError: overrides.lastError ?? (normalized === GENERATION_MEMORY_STATUSES.READY ? null : (previous.lastError || null)),
    lastRunId: overrides.lastRunId ?? previous.lastRunId ?? null,
    createdAt: previous.createdAt || now,
    updatedAt: now
  };
}

function setGenerationMemoryStatus(memory, entry, status, overrides = {}) {
  if (!memory || !entry?.sourceId) return;
  const previous = memory.items[entry.sourceId] || {};
  setGenerationMemoryRecordStatus(memory, {
    ...generationMemoryRecordFromEntry(entry, {
      ...previous,
      createdAt: previous.createdAt || new Date().toISOString()
    }),
    ...previous,
    sourceId: entry.sourceId,
    groupId: entry.groupId,
    relativePath: entry.relativePath,
    fileName: entry.fileName,
    modelName: entry.modelName,
    outputFileName: entry.outputFileName,
    fingerprint: entry.fingerprint,
    sourcePresent: true,
    retryCount: Number(entry.retryCount || previous.retryCount || 0)
  }, status, overrides);
}

async function discoverAutomationTabsForRun(run) {
  const mapped = new Map();
  if (!run?.operationId || !chrome.tabs?.query || !chrome.scripting?.executeScript) return mapped;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }).catch(() => []);
  await Promise.all(tabs.map(async (tab) => {
    if (tab?.id == null) return;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (markerKey, contextKey) => {
          try {
            const marked = sessionStorage.getItem(markerKey) === '1';
            const raw = sessionStorage.getItem(contextKey);
            let context = null;
            if (raw) {
              try { context = JSON.parse(raw); } catch (_) {}
            }
            return { marked, context };
          } catch (_) {
            return { marked: false, context: null };
          }
        },
        args: [AUTOMATION_SESSION_KEY, AUTOMATION_CONTEXT_KEY]
      });
      const value = result?.result || {};
      const context = value.context || {};
      if (!value.marked || context.operationId !== run.operationId) return;
      const slotId = Number(context.slotId);
      const entryId = String(context.entryId || '');
      if (!Number.isInteger(slotId) || !entryId) return;
      mapped.set(`${slotId}:${entryId}`, tab);
    } catch (_) {}
  }));
  return mapped;
}

async function releaseRetryableRecoveredSlots(runId, results, reason) {
  const retryable = new Map((results || [])
    .filter((item) => item?.retryable && item?.entryId != null)
    .map((item) => [`${Number(item.slotId)}:${item.entryId}`, item]));
  if (!retryable.size) return { released: 0 };

  const tabsToClose = [];
  let released = 0;
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== runId) return;
    stored.generationMemory = normalizeGenerationMemory(stored.generationMemory);
    for (const slot of Object.values(run.slots || {})) {
      if (!slot.entryId) continue;
      const key = `${Number(slot.slotId)}:${slot.entryId}`;
      const result = retryable.get(key);
      if (!result) continue;
      const entry = groupEntries(stored.queue, run.groupId).find((item) => item.sourceId === slot.entryId);
      if (slot.tabId) tabsToClose.push(slot.tabId);
      if (entry && entry.status !== 'done') {
        entry.status = 'pending';
        entry.lastError = result.state === 'ERROR' ? (slot.lastCheckError || 'Ошибка восстановленной вкладки') : null;
        setGenerationMemoryStatus(stored.generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic',
          generationStartedAt: null,
          lastError: entry.lastError,
          lastRunId: run.operationId
        });
      }
      slot.tabId = null;
      slot.entryId = null;
      slot.status = 'IDLE';
      slot.phase = SLOT_PHASES.IDLE;
      slot.downloadId = null;
      slot.launchWaitUntil = null;
      slot.finalCheckPending = false;
      slot.finalCheckDeadlineAt = null;
      slot.finalCheckAttempts = 0;
      slot.failed = false;
      slot.rateLimitRetryNeeded = false;
      slot.lastCheckState = null;
      slot.lastCheckError = null;
      slot.lastCheckAt = null;
      slot.lastResult = null;
      slot.lastEntryName = null;
      slot.lastModelName = null;
      Object.assign(slot, freshSlotRevisionFields());
      released += 1;
      recordRunEvent(run, 'recovery_slot_released', {
        slotId: result.slotId,
        entryId: result.entryId,
        state: result.state,
        reason
      });
    }

    const entries = groupEntries(stored.queue, run.groupId);
    const plannedIds = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
    const protectedIds = new Set(Object.values(run.slots || {}).filter((slot) => slot.entryId).map((slot) => slot.entryId));
    run.pendingIds = entries
      .filter((entry) => plannedIds.has(entry.sourceId) && entry.status !== 'done' && !protectedIds.has(entry.sourceId))
      .map((entry) => entry.sourceId);
    if (run.state === 'PAUSED' && !hasObservationWork(run)) {
      const userPaused = String(run.pauseReason || '').toUpperCase() === 'USER';
      run.status = userPaused ? 'PAUSED' : 'PAUSED_ON_RESTART';
      run.currentAction = userPaused
        ? 'Пауза пользователя сохранена. Вкладки без принятого запроса/результата закрыты.'
        : `${reason}. Восстановленные вкладки без принятого запроса/результата закрыты; можно продолжить очередь.`;
    }
    run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(run, stored.queue, stored.history, stored.generationMemory);
    await publishRun(run, stored.queue);
  });

  await Promise.all([...new Set(tabsToClose)].map(async (tabId) => {
    await sendTabMessage(tabId, { type: 'STOP' }).catch(() => null);
    await chrome.tabs.remove(tabId).catch(() => null);
  }));
  if (released) await appendLog('Освобождены восстановленные вкладки без активной генерации', { released, reason });
  return { released };
}

function scheduleInterruptedRunRecovery(reason) {
  if (interruptedRecoveryPromise) return interruptedRecoveryPromise;
  interruptedRecoveryPromise = recoverInterruptedRun(reason)
    .catch((error) => appendLog('Ошибка восстановления прерванного запуска', { reason, error: error.message }).catch(() => {}))
    .finally(() => { interruptedRecoveryPromise = null; });
  return interruptedRecoveryPromise;
}

async function waitForStartupReconciliation() {
  // Startup recovery is asynchronous in MV3. A Start/Continue click that races
  // it can otherwise create tabs while the recovery coroutine is simultaneously
  // re-binding/pausing the old run. Always let the startup reconciliation reach
  // a stable state before accepting a user control command.
  const pending = interruptedRecoveryPromise;
  if (pending) await pending;
}

async function reconcilePostprocessOwners(runSnapshot, reason = 'Перезапуск расширения') {
  if (!runSnapshot?.operationId) return { checked: 0, released: 0 };
  const owners = Object.values(runSnapshot.postprocessTabs || {})
    .filter((owner) => Number(owner?.tabId || 0) > 0 && owner?.entryId && owner?.factsJobId);
  if (!owners.length) return { checked: 0, released: 0 };
  const now = Date.now();
  let released = 0;
  for (const owner of owners) {
    const tabId = Number(owner.tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const chatTab = Boolean(tab && /^https:\/\/chatgpt\.com\//i.test(tab.url || tab.pendingUrl || ''));
    const startedAt = Date.parse(owner.startedAt || '') || 0;
    const deadline = Number(owner.recoveryDeadlineAt || 0) || (startedAt ? startedAt + FINAL_CHECK_TIMEOUT_MS : 0);
    const expired = deadline > 0 && now >= deadline;
    if (chatTab && !expired) {
      startFactsPulseMonitor(0);
      if (!Number(owner.recoveryDeadlineAt || 0)) {
        await withStateLock(async () => {
          const { run } = await chrome.storage.local.get('run');
          const current = run?.operationId === runSnapshot.operationId
            ? run.postprocessTabs?.[String(tabId)] : null;
          if (!current || current.entryId !== owner.entryId || current.factsJobId !== owner.factsJobId) return;
          current.recoveryDeadlineAt = deadline || (Date.now() + FINAL_CHECK_TIMEOUT_MS);
          await chrome.storage.local.set({ run });
        });
      }
      continue;
    }

    const revision = owner.generationId
      ? await getGenerationRevision(owner.generationId).catch(() => null)
      : null;
    const factsSaved = revision?.factsStatus === 'ok'
      && revision?.facts?.status === 'ok'
      && String(revision.facts.generationId || '') === String(owner.generationId || '')
      && String(revision.facts.factsJobId || '') === String(owner.factsJobId || '');
    const stageMessage = {
      operationId: runSnapshot.operationId,
      slotId: owner.slotId,
      tabId,
      entryId: owner.entryId,
      generationId: owner.generationId || null,
      factsJobId: owner.factsJobId,
      outputPath: owner.outputPath || null,
      outputHash: owner.outputHash || null,
      modelName: owner.modelName || owner.outputFileName || null,
      chatUrl: owner.chatUrl || null
    };
    await updateFactsStage(stageMessage, { tab: { id: tabId } }, {
      ...stageMessage,
      stage: factsSaved ? 'SAVED' : 'ERROR',
      error: factsSaved ? null : (chatTab
        ? 'Постпроверка автоматически завершена по тайм-ауту; PNG сохранён, характеристики можно повторить из галереи.'
        : 'Вкладка постпроверки потеряна; PNG сохранён, характеристики можно повторить из галереи.')
    }).catch(() => {});
    await cleanupPostprocessTab(runSnapshot.operationId, tabId);
    await withStateLock(async () => {
      const stored = await chrome.storage.local.get(['run', 'queue']);
      const { run, queue } = stored;
      if (run?.operationId !== runSnapshot.operationId) return;
      recordRunEvent(run, 'postprocess_owner_released', {
        slotId: Number(owner.slotId), entryId: owner.entryId,
        generationId: owner.generationId || null, factsJobId: owner.factsJobId,
        reason: chatTab ? 'postprocess_deadline_exceeded' : 'postprocess_tab_missing',
        factsSaved
      });
      if (!['RUNNING', 'DRAINING'].includes(run.state)) {
        run.currentAction = factsSaved
          ? `Постпроверка восстановлена: ${owner.modelName || owner.entryId}`
          : 'Зависшая постпроверка освобождена. Скачанные PNG сохранены; характеристики можно повторить в галерее.';
      }
      await saveRunAndQueue(run, queue);
      await publishRun(run, queue).catch(() => {});
    });
    released += 1;
  }
  if (released) await appendLog('Восстановлены зависшие/потерянные вкладки постпроверки', {
    operationId: runSnapshot.operationId, released, reason
  });
  return { checked: owners.length, released };
}

async function recoverInterruptedRun(reason) {
  const startupSnapshot = await getStored();
  if (startupSnapshot.sessionResetIntent) {
    await resumeInterruptedSessionReset(startupSnapshot.sessionResetIntent);
    return;
  }
  // A browser/worker restart may happen after chrome.downloads accepted the
  // artifact but before finishDownload persisted DONE. Reconcile those ids
  // before deciding that a missing ChatGPT tab means the source must retry.
  await reconcileActiveDownloads().catch((error) => appendLog('Не удалось восстановить активные скачивания', {
    reason,
    error: error.message
  }).catch(() => {}));
  let initial = await getStored();
  if (initial.run?.postprocessTabs && Object.keys(initial.run.postprocessTabs).length) {
    await reconcilePostprocessOwners(initial.run, reason);
    initial = await getStored();
  }
  const initialRun = initial.run;
  const initialMemory = normalizeGenerationMemory(initial.generationMemory);
  const recoveryStage = String(initialRun?.conversationRecovery?.stage || '').toUpperCase();
  if (initialRun && recoveryStage === 'INSPECTING') {
    await beginConversationLoadRecovery(initialRun.operationId, {
      slotId: initialRun.conversationRecovery?.triggerSlotId,
      entryId: initialRun.conversationRecovery?.triggerEntryId
    });
    return;
  }
  if (initialRun && ['WAITING', 'REOPENING'].includes(recoveryStage)) {
    try {
      await closeConversationRecoveryTabs(initialRun.operationId);
    } catch (error) {
      await failConversationLoadRecovery(initialRun.operationId,
        `Не удалось закрыть прежние рабочие вкладки перед восстановлением: ${error.message}`,
        { attempt: Number(initialRun.conversationRecovery?.attempts || 0) });
      return;
    }
    if (recoveryStage === 'WAITING' && Number(initialRun.conversationRecovery.dueAt || 0) > Date.now()) {
      scheduleConversationLoadRecovery(initialRun.operationId, initialRun.conversationRecovery.dueAt);
    } else {
      await resumeConversationLoadRecovery(initialRun.operationId);
    }
    return;
  }
  if (initialRun && ['DONE', 'STOPPED'].includes(initialRun.state)) {
    const orphaned = await discoverAutomationTabsForRun(initialRun);
    const tabIds = [...new Set([...orphaned.values()].map((tab) => Number(tab.id || 0)).filter(Boolean))];
    await Promise.all(tabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
    if (tabIds.length) await appendLog('Закрыты оставшиеся рабочие вкладки завершённого запуска', {
      operationId: initialRun.operationId,
      count: tabIds.length
    });
    if (initialRun.state === 'DONE') await withStateLock(async () => {
      const stored = await getStored();
      if (stored.run?.operationId !== initialRun.operationId || stored.run.state !== 'DONE') return;
      const history = normalizeHistory(stored.history);
      const memory = normalizeGenerationMemory(stored.generationMemory);
      await reconcileRunVerifiedRevisions(stored.run, stored.queue, history, memory);
      await saveRunAndQueue(stored.run, stored.queue, history, memory);
      await publishRun(stored.run, stored.queue);
    });
  }
  const hasOrphanedRunningMemory = Object.values(initialMemory.items || {})
    .some((record) => normalizeGenerationMemoryStatus(record.status) === GENERATION_MEMORY_STATUSES.RUNNING);
  if (!initialRun && hasOrphanedRunningMemory) {
    await resetRunAndRescan({
      reason: 'Найдены записи «В работе» без существующей сессии',
      automatic: true,
      salvageReady: false
    });
    return;
  }
  const buildChanged = Boolean(initialRun && String(initialRun.buildId || '') !== EXTENSION_BUILD_ID);
  if (buildChanged) await appendLog('Восстанавливаю сессию после обновления расширения без сброса очереди', {
    previousBuildId: initialRun.buildId || null,
    buildId: EXTENSION_BUILD_ID
  });
  const recoverableActiveState = ['RUNNING', 'STARTING', 'DRAINING'].includes(initialRun?.state);
  const recoverablePausedObservation = initialRun?.state === 'PAUSED' && hasObservationWork(initialRun);
  if (initialRun?.state === 'PAUSED' && !recoverablePausedObservation) {
    await withStateLock(async () => {
      const stored = await getStored();
      const run = stored.run;
      if (!run || run.operationId !== initialRun.operationId || run.state !== 'PAUSED') return;
      run.buildId = EXTENSION_BUILD_ID;
      const queue = stored.queue;
      const history = normalizeHistory(stored.history);
      const memory = normalizeGenerationMemory(stored.generationMemory);
      await reconcileRunVerifiedRevisions(run, queue, history, memory);
      await reconcilePersistedCurrentRevisions(queue, history, memory, {
        ...(run.filter || stored.job?.filters || {}),
        runQueueMode: run.groupId === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular'
      });
      const planned = new Set(run.plannedIds || []);
      run.pendingIds = groupEntries(queue, run.groupId)
        .filter((entry) => planned.has(entry.sourceId) && entry.status !== 'done')
        .map((entry) => entry.sourceId);
      clearResolvedRunError(run, queue);
      const imageLimitWaiting = run.pauseReason === 'IMAGE_LIMIT' && Number(run.rateLimitPauseUntil || 0) > Date.now();
      const blockedRevisionCount = Object.values(run.slots || {}).filter((slot) => slot.revisionPersistBlocked).length;
      run.status = imageLimitWaiting ? 'RATE_LIMIT_PAUSE' : (blockedRevisionCount || hasUnresolvedSlotErrors(run) ? 'PAUSED_ON_ERROR' : 'PAUSED');
      run.currentAction = imageLimitWaiting
        ? `Лимит изображений. Автоматически продолжу в ${clockTime(run.rateLimitPauseUntil)}`
        : (blockedRevisionCount
          ? `${blockedRevisionCount} PNG уже скачаны, но их ревизии требуют повтора записи. «Продолжить» повторит сохранение без генерации изображения.`
          : (run.pendingIds.length
            ? `Сохранённые результаты сверены. Осталось ${run.pendingIds.length} моделей; продолжение запустит только их.`
            : 'Сохранённые результаты сверены. Очередь завершена.'));
      await saveRunAndQueue(run, queue, history, memory);
      await publishRun(run, queue);
    });
    if (initialRun.pauseReason === 'IMAGE_LIMIT' && Number(initialRun.rateLimitPauseUntil || 0) > Date.now()) {
      scheduleRateLimitResume(initialRun.operationId, initialRun.rateLimitPauseUntil);
    } else if (initialRun.pauseReason === 'IMAGE_LIMIT') {
      await resumeAfterRateLimitPause();
    }
    return;
  }
  if (!initialRun || (!recoverableActiveState && !recoverablePausedObservation)) return;
  await updateRuntime({
    state: 'RECONCILING',
    status: 'RECOVERING',
    currentAction: 'Сверяю сохранённую сессию с реальными вкладками ChatGPT…',
    error: null,
    buildId: EXTENSION_BUILD_ID
  });
  const preserveImageLimitPause = initialRun.state === 'PAUSED'
    && String(initialRun.pauseReason || '').toUpperCase() === 'IMAGE_LIMIT'
    && Number(initialRun.rateLimitPauseUntil || 0) > Date.now();
  const preserveUserPause = initialRun.state === 'PAUSED'
    && String(initialRun.pauseReason || '').toUpperCase() === 'USER';

  const restoredTabs = await discoverAutomationTabsForRun(initialRun);
  const liveTabs = new Map();
  for (const slot of Object.values(initialRun.slots || {})) {
    if (!slot.entryId) continue;
    let tab = null;
    if (slot.tabId) {
      tab = await chrome.tabs.get(Number(slot.tabId)).catch(() => null);
      if (tab && !/^https:\/\/chatgpt\.com\//i.test(tab.url || tab.pendingUrl || '')) tab = null;
    }
    if (!tab) tab = restoredTabs.get(`${Number(slot.slotId)}:${slot.entryId}`) || null;
    if (tab?.id != null) liveTabs.set(Number(slot.slotId), tab);
  }

  let shouldResumeObservation = false;
  let recoveredRunId = null;
  const tabsToDiscard = [];
  await withStateLock(async () => {
    const stored = await getStored();
    let { run, queue, history, generationMemory } = stored;
    const stillRecoverable = ['RUNNING', 'STARTING', 'DRAINING'].includes(run?.state)
      || (run?.state === 'PAUSED' && hasObservationWork(run));
    if (!run || run.operationId !== initialRun.operationId || !stillRecoverable) return;
    run.buildId = EXTENSION_BUILD_ID;
    ({ queue, history, memory: generationMemory } = syncQueueWithHistory(
      queue,
      history,
      generationMemory,
      run
    ));
    const repairedCompleted = await reconcileRunVerifiedRevisions(run, queue, history, generationMemory);
    if (repairedCompleted) recordRunEvent(run, 'verified_revision_state_repaired', { count: repairedCompleted, reason: 'interrupted-run-recovery' });
    recoveredRunId = run.operationId;
    const message = `${reason}. Состояние рабочих вкладок перепроверено.`;

    for (const slot of Object.values(run.slots || {})) {
      if (!slot.entryId) continue;
      const entry = groupEntries(queue, run.groupId).find((item) => item.sourceId === slot.entryId);
      const liveTab = liveTabs.get(Number(slot.slotId)) || null;
      const submitted = slotGenerationSubmitted(slot);
      const ambiguousSend = ['SENDING'].includes(String(slot.status || '').toUpperCase())
        || slot.phase === SLOT_PHASES.SENDING;

      // Keep a completed download recoverable if IndexedDB failed to commit
      // its verified revision. Continue retries persistence from Downloads and
      // never resubmit the image-generation prompt for this item.
      if (slot.revisionPersistBlocked && slot.downloadId) {
        slot.tabId = null;
        slot.status = 'PAUSED';
        slot.phase = SLOT_PHASES.NEEDS_ATTENTION;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.failed = true;
        if (entry && entry.status !== 'done') entry.status = 'error';
        continue;
      }

      // If the worker died in the narrow window after clicking Send but before
      // PROMPT_SENT reached storage, SENDING is ambiguous: ChatGPT may already
      // have accepted the user turn. Preserve that live tab long enough for a
      // recovery probe instead of blindly duplicating the generation.
      if (liveTab && (submitted || ambiguousSend) && entry?.status !== 'done') {
        slot.tabId = liveTab.id;
        slot.status = slot.downloadId ? 'DOWNLOADING' : 'OBSERVING';
        slot.phase = slot.downloadId ? SLOT_PHASES.DOWNLOADING : SLOT_PHASES.OBSERVING;
        slot.lastResult = slot.downloadId ? 'DOWNLOADING' : 'OBSERVING';
        slot.lastCheckState = slot.downloadId ? 'DOWNLOADING' : (slot.lastCheckState || 'WAITING_IMAGE');
        slot.lastCheckError = null;
        slot.lastCheckAt = new Date().toISOString();
        slot.failed = false;
        slot.finalCheckPending = !slot.downloadId;
        slot.finalCheckDeadlineAt = slot.downloadId
          ? null
          : (Number(slot.finalCheckDeadlineAt || 0) > Date.now() ? slot.finalCheckDeadlineAt : finalCheckDeadline());
        slot.finalCheckAttempts = 0;
        entry.status = 'running';
        setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
          statusSource: 'automatic',
          generationStartedAt: slot.generationSubmittedAt || slot.lastActivityAt || new Date().toISOString(),
          lastError: null,
          lastRunId: run.operationId
        });
        shouldResumeObservation = true;
        continue;
      }

      if (liveTab?.id != null) tabsToDiscard.push(liveTab.id);
      if (entry && entry.status !== 'done') {
        entry.status = 'pending';
        entry.lastError = null;
        setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic',
          generationStartedAt: null,
          lastError: null,
          lastRunId: run.operationId
        });
      }
      slot.tabId = null;
      slot.entryId = null;
      slot.status = 'IDLE';
      slot.phase = SLOT_PHASES.IDLE;
      slot.lastResult = submitted ? 'INTERRUPTED' : null;
      slot.lastCheckState = submitted ? 'TAB_CLOSED' : null;
      slot.lastCheckError = submitted ? `${reason}: рабочая вкладка не восстановлена` : null;
      slot.downloadId = null;
      slot.launchWaitUntil = null;
      slot.finalCheckPending = false;
      slot.finalCheckDeadlineAt = null;
      slot.finalCheckAttempts = 0;
      slot.failed = false;
      slot.rateLimitRetryNeeded = false;
    }

    const entries = groupEntries(queue, run.groupId);
    const plannedIds = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
    run.pendingIds = entries
      .filter((entry) => plannedIds.has(entry.sourceId) && entry.status !== 'done')
      .filter((entry) => !Object.values(run.slots || {}).some((slot) => slot.entryId === entry.sourceId))
      .map((entry) => entry.sourceId);
    run.state = 'PAUSED';
    run.pauseReason = preserveImageLimitPause ? 'IMAGE_LIMIT' : (preserveUserPause ? 'USER' : 'RESTART');
    const blockedRevisionCount = Object.values(run.slots || {}).filter((slot) => slot.revisionPersistBlocked).length;
    run.status = preserveImageLimitPause ? 'RATE_LIMIT_PAUSE' : (blockedRevisionCount
      ? 'PAUSED_ON_ERROR'
      : (shouldResumeObservation
        ? 'PAUSED_RECOVERING'
        : (preserveUserPause ? 'PAUSED' : 'PAUSED_ON_RESTART')));
    run.error = null;
    run.currentAction = preserveImageLimitPause
      ? `Лимит изображений. Автоматически продолжу в ${clockTime(run.rateLimitPauseUntil)}`
      : (blockedRevisionCount
        ? `${blockedRevisionCount} PNG уже скачаны, но их ревизии требуют повтора записи. «Продолжить» повторит сохранение без генерации изображения.`
        : (shouldResumeObservation
          ? `${reason}. Досматриваю уже отправленные генерации; новые запросы не запускаю.`
          : (preserveUserPause
            ? 'Пауза пользователя восстановлена. Активных генераций для досмотра не осталось.'
            : `${reason}. Старые слоты освобождены, можно продолжить очередь.`)));
    run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(run, queue, history, generationMemory);
    await appendLog(message, { observing: shouldResumeObservation, discardedTabs: tabsToDiscard.length });
    await publishRun(run, queue);
  });

  await Promise.all([...new Set(tabsToDiscard)].map(async (tabId) => {
    await sendTabMessage(tabId, { type: 'STOP' }).catch(() => null);
    await chrome.tabs.remove(tabId).catch(() => null);
  }));
  if (preserveImageLimitPause && recoveredRunId) {
    scheduleRateLimitResume(recoveredRunId, initialRun.rateLimitPauseUntil);
  }

  if (shouldResumeObservation && recoveredRunId) {
    await ensureAutomationWindow(recoveredRunId).catch((error) => appendLog('Не удалось подготовить окно автоматизации после перезапуска', { error: error.message }));
    await moveRunTabsToAutomationWindow(recoveredRunId).catch((error) => appendLog('Не удалось изолировать рабочие вкладки после перезапуска', { error: error.message }));
    const latest = await getStored();
    if (latest.run?.operationId === recoveredRunId) {
      try {
        const recoveryResults = await recoverVisibleResults(latest.run, { forceReload: buildChanged });
        await releaseRetryableRecoveredSlots(recoveredRunId, recoveryResults, reason);
      } catch (error) {
        await appendLog('Не удалось досканировать восстановленные вкладки', { error: error.message });
      }
    }
    startAuditMonitor();
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureDevReloadAlarm();
  scheduleRevisionFactsRecoveryAfterUpgrade().catch(() => {});
  void (async () => {
    const stored = await getStored();
    if (stored.sessionResetIntent) {
      await resumeInterruptedSessionReset(stored.sessionResetIntent);
      return;
    }
    const { run } = stored;
    const batchStage = String(run?.stalledBatchRecovery?.stage || '').toUpperCase();
    if (['CLOSING', 'WAITING', 'RESTARTING', 'FAILED'].includes(batchStage)) {
      await rehydrateWorkerWake();
      return;
    }
    await scheduleInterruptedRunRecovery('Браузер был перезапущен');
  })().catch((error) => appendLog('Ошибка восстановления после запуска браузера', { error: error.message }));
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === DEV_RELOAD_ALARM_NAME) {
    Promise.all([
      pollDevReload('alarm'),
      pollDevControl('alarm'),
      reconcileManualExtensionUpdateLock().catch(() => {})
    ]).catch(() => {});
    return;
  }
  if (alarm.name === RATE_LIMIT_RESUME_ALARM_NAME) {
    resumeAfterRateLimitPause().catch((error) => appendLog('Ошибка автопродолжения после ограничения запросов', { error: error.message }));
    return;
  }
  if (alarm.name === CONVERSATION_LOAD_RECOVERY_ALARM_NAME) {
    resumeConversationLoadRecovery().catch((error) => appendLog(
      'Ошибка восстановления вкладок после ошибки загрузки разговора', { error: error.message }
    ));
    return;
  }
  if (alarm.name === STALLED_BATCH_RECOVERY_ALARM_NAME) {
    resumeStalledBatchRecovery().catch((error) => appendLog(
      'Ошибка автоматического продолжения после отдыха рабочих вкладок', { error: error.message }
    ));
    return;
  }
  if (alarm.name.startsWith(GENERATION_SEND_ALARM_PREFIX)) {
    rehydrateWorkerWake().catch((error) => appendLog('Ошибка возобновления отправки после паузы', { error: error.message }));
    return;
  }
  if (alarm.name === REVISION_FACTS_RECOVERY_ALARM_NAME) {
    recoverTimedOutRevisionFacts().catch((error) => appendLog('Ошибка восстановления готовых OCR-ответов', { error: error.message }));
    return;
  }
  if (alarm.name !== AUDIT_ALARM_NAME) return;
  auditActiveRun().catch((error) => appendLog('Ошибка фоновой проверки генераций', { error: error.message }));
});

function ensureDevReloadAlarm() {
  if (!chrome.alarms?.create) return;
  Promise.resolve(chrome.alarms.create(DEV_RELOAD_ALARM_NAME, { periodInMinutes: 0.5 })).catch(() => {});
}

function getDevControlClientIdentity() {
  if (devControlClientIdentityCache) return Promise.resolve(devControlClientIdentityCache);
  if (devControlClientIdentityPromise) return devControlClientIdentityPromise;
  devControlClientIdentityPromise = (async () => {
    const stored = await chrome.storage.local.get('devControlClientId');
    const clientId = String(stored.devControlClientId || globalThis.crypto?.randomUUID?.()
      || `watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (!stored.devControlClientId) await chrome.storage.local.set({ devControlClientId: clientId });
    devControlClientIdentityCache = {
      clientId,
      extensionId: String(chrome.runtime.id || ''),
      version: String(chrome.runtime.getManifest?.().version || '')
    };
    return devControlClientIdentityCache;
  })().finally(() => { devControlClientIdentityPromise = null; });
  return devControlClientIdentityPromise;
}

async function refreshChatGPTTabsAfterReload() {
  const stored = await chrome.storage.local.get('devAutoReload');
  const marker = stored.devAutoReload || {};
  if (marker.refreshTabsAfterReload !== true) return { ok: true, skipped: true };

  const { run } = await getStored();
  const protectedRun = runHasActiveAutomationWork(run);
  if (protectedRun) return { ok: true, deferred: true };

  // A source update must never reload the user's personal ChatGPT tabs. Only
  // tab IDs recorded by this run and located in the automation window are
  // eligible for refresh.
  const automationWindowId = Number(run?.automationWindowId || 0);
  const ownedTabIds = new Set(Object.values(run?.slots || {})
    .map((slot) => Number(slot.tabId || 0))
    .filter((tabId) => tabId > 0));
  const tabs = automationWindowId && ownedTabIds.size
    ? (await chrome.tabs.query({ windowId: automationWindowId }).catch(() => []))
      .filter((tab) => ownedTabIds.has(Number(tab.id)) && /^https:\/\/chatgpt\.com\//i.test(tab.url || ''))
    : [];
  await chrome.storage.local.set({
    devAutoReload: {
      ...marker,
      refreshTabsAfterReload: false,
      tabsRefreshedAt: new Date().toISOString(),
      tabsRefreshedCount: tabs.length
    }
  });
  let refreshed = 0;
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id == null) return;
    try {
      await chrome.tabs.reload(tab.id);
      refreshed += 1;
    } catch (_) {}
  }));
  if (refreshed) {
    await appendLog('После автообновления перезагружены вкладки автоматизации', {
      count: refreshed,
      windowId: automationWindowId
    });
  }
  return { ok: true, refreshed, windowId: automationWindowId || null };
}

async function initializeDevReloadState() {
  const version = chrome.runtime.getManifest?.().version || 'unknown';
  const stored = await chrome.storage.local.get(['devAutoReload', 'manualExtensionUpdateLock']);
  const marker = stored.devAutoReload || {};
  const suppressTabRefresh = marker.suppressNextTabRefresh === true
    || stored.manualExtensionUpdateLock?.active === true;
  if (marker.extensionVersion !== version) {
    await chrome.storage.local.set({
      devAutoReload: {
        ...marker,
        extensionVersion: version,
        refreshTabsAfterReload: !suppressTabRefresh,
        suppressNextTabRefresh: false,
        initializedAt: marker.initializedAt || new Date().toISOString()
      }
    });
  } else if (marker.suppressNextTabRefresh) {
    await chrome.storage.local.set({
      devAutoReload: { ...marker, refreshTabsAfterReload: false, suppressNextTabRefresh: false }
    });
  }
  return refreshChatGPTTabsAfterReload();
}

// Alarms survive worker suspension, but creating it at module start also covers
// profiles where Chrome did not emit onStartup after an extension reload.
ensureDevReloadAlarm();
initializeDevReloadState().catch(() => {});
reconcileManualExtensionUpdateLock().catch(() => {});
scheduleRevisionFactsRecoveryAfterUpgrade().catch(() => {});
restoreRateLimitResumeAlarm().catch(() => {});
// A cold MV3 worker wake is normal lifecycle, not an interrupted browser run.
// Rehydrate lost in-memory Send/audit tasks without forcing a manual Continue.
rehydrateWorkerWake().catch((error) => appendLog('Ошибка восстановления задач после пробуждения service worker', { error: error.message }).catch(() => {}));
startFactsPulseMonitor(250);
pollDevControl('startup').catch(() => {});

async function pollDevReload(source = 'poll') {
  if (devReloadPollInFlight) return { ok: false, skipped: true };
  devReloadPollInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEV_RELOAD_POLL_TIMEOUT_MS);
  try {
    const updateState = await chrome.storage.local.get(['manualExtensionUpdateLock', 'resultsImportJournal']).catch(() => ({}));
    if (updateState.resultsImportJournal) return { ok: true, deferred: true, reason: 'results_import' };
    if (updateState.manualExtensionUpdateLock?.active) {
      return { ok: true, deferred: true, reason: 'manual_update' };
    }
    const identity = await getDevControlClientIdentity();
    const identityQuery = new URLSearchParams(identity);
    const response = await fetch(`${DEV_RELOAD_STATUS_URL}?${identityQuery}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, unavailable: true };
    const status = await response.json();
    const revision = String(status?.revision || '');
    if (!revision) return { ok: false, unavailable: true };
    queueDomBridgeFlush();
    queueLastDiagnosticBridge();

    const stored = await chrome.storage.local.get('devAutoReload');
    const marker = stored.devAutoReload || {};
    if (!marker.revision) {
      await chrome.storage.local.set({
        devAutoReload: {
          ...marker,
          revision,
          initializedAt: new Date().toISOString(),
          source
        }
      });
      return { ok: true, initialized: true };
    }

    // A manual Stop is an explicit request to end the run and remain in the
    // current extension session. Consume any already-pending development
    // update at the first idle checkpoint instead of surprising the user with
    // a reload immediately after stopping. Later source changes still reload.
    if (marker.userStopPending) {
      const { run, runtime } = await getStored();
      if (runtime?.state === 'STOPPED' && !runHasActiveAutomationWork(run)) {
        await chrome.storage.local.set({
          devAutoReload: {
            ...marker,
            revision,
            pendingRevision: null,
            userStopPending: false,
            refreshTabsAfterReload: false,
            userStopAcknowledgedAt: new Date().toISOString(),
            source
          }
        });
        await updateRuntime({ devReloadPending: false });
        await appendLog('Отложенное автообновление пропущено после ручной остановки', {
          revision: revision.slice(0, 12)
        });
        return { ok: true, changed: true, suppressedAfterUserStop: true };
      }
    }
    if (marker.revision === revision && !marker.pendingRevision) {
      const tabRefresh = marker.refreshTabsAfterReload
        ? await refreshChatGPTTabsAfterReload()
        : null;
      return { ok: true, changed: false, tabRefresh };
    }

    const { run } = await getStored();
    const activeRun = runHasActiveAutomationWork(run);
    if (activeRun) {
      if (marker.pendingRevision !== revision) {
        await chrome.storage.local.set({
          devAutoReload: {
            ...marker,
            pendingRevision: revision,
            pendingSince: new Date().toISOString(),
            source
          }
        });
        await appendLog('Автообновление отложено до завершения текущего прогона', {
          revision: revision.slice(0, 12)
        });
        await updateRuntime({
          devReloadPending: true,
          currentAction: 'Обновление расширения отложено до безопасного состояния'
        });
      }
      return { ok: true, changed: true, deferred: true };
    }

    return await withStateLock(async () => {
      const latest = await chrome.storage.local.get(['manualExtensionUpdateLock', 'resultsImportJournal']);
      if (latest.resultsImportJournal) return { ok: true, deferred: true, reason: 'results_import' };
      if (latest.manualExtensionUpdateLock?.active) {
        return { ok: true, changed: true, deferred: true, reason: 'manual_update' };
      }
      await chrome.storage.local.set({
        devAutoReload: {
          ...marker,
          revision,
          pendingRevision: null,
          refreshTabsAfterReload: marker.suppressNextTabRefresh !== true,
          reloadedAt: new Date().toISOString(),
          source
        }
      });
      await appendLog('Автообновление расширения: перезагрузка', {
        revision: revision.slice(0, 12)
      });
      await updateRuntime({ devReloadPending: false });
      // Keep the call inside the active alarm/message event. A service-worker
      // timer scheduled after the event returns may be suspended by Chrome.
      try { chrome.runtime.reload(); } catch (_) {}
      return { ok: true, changed: true, reloading: true };
    });
  } catch (_) {
    return { ok: false, unavailable: true };
  } finally {
    clearTimeout(timeoutId);
    devReloadPollInFlight = false;
  }
}

async function requestLocalExtensionUpdate(url, method = 'GET') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  try {
    const client = await getDevControlClientIdentity();
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('extensionId', client.extensionId);
    requestUrl.searchParams.set('clientId', client.clientId);
    requestUrl.searchParams.set('version', client.version);
    const response = await fetch(requestUrl.toString(), {
      method,
      cache: 'no-store',
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || `Локальный сервис обновления ответил HTTP ${response.status}`);
      error.updateRequestRejected = true;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function clearManualExtensionUpdateLock({ clearRefreshSuppression = false } = {}) {
  await chrome.storage.local.remove('manualExtensionUpdateLock');
  if (clearRefreshSuppression) {
    const stored = await chrome.storage.local.get('devAutoReload');
    const marker = stored.devAutoReload || {};
    await chrome.storage.local.set({
      devAutoReload: { ...marker, refreshTabsAfterReload: false, suppressNextTabRefresh: false }
    });
  }
}

async function reconcileManualExtensionUpdateLock(status = null, installedState = null) {
  const stored = await chrome.storage.local.get('manualExtensionUpdateLock');
  const expectedLock = stored.manualExtensionUpdateLock;
  if (!expectedLock?.active) return { ok: true, skipped: true };
  let installed = installedState;
  let updateStatus = status;
  if (!updateStatus) {
    const response = await requestLocalExtensionUpdate(DEV_UPDATE_STATUS_URL);
    updateStatus = response?.status || null;
    installed = response?.installed || null;
  }
  return withStateLock(async () => {
    const current = await chrome.storage.local.get('manualExtensionUpdateLock');
    const lock = current.manualExtensionUpdateLock;
    if (!lock?.active) return { ok: true, skipped: true };
    if (lock.startedAt !== expectedLock.startedAt || lock.targetVersion !== expectedLock.targetVersion) {
      return { ok: true, pending: true, phase: updateStatus?.phase || 'unknown' };
    }
    const phase = String(updateStatus?.phase || '');
    const targetVersion = String(lock.targetVersion || '');
    const runningVersion = String(chrome.runtime.getManifest?.().version || '');
    const targetLoaded = Boolean(targetVersion
      && String(installed?.extensionVersion || '') === targetVersion
      && runningVersion === targetVersion);
    const finished = targetLoaded && ['complete', 'current', 'idle'].includes(phase);
    if (phase === 'error' || finished) {
      await clearManualExtensionUpdateLock({ clearRefreshSuppression: phase === 'error' });
      return { ok: true, cleared: true, phase };
    }
    return { ok: true, pending: true, phase: phase || 'unknown' };
  });
}

async function assertManualExtensionUpdateNotApplying() {
  const importState = await chrome.storage.local.get('resultsImportJournal');
  if (importState.resultsImportJournal) throw new Error('Завершается импорт результатов. Дождись его завершения в галерее.');
  const stored = await chrome.storage.local.get('manualExtensionUpdateLock');
  if (!stored.manualExtensionUpdateLock?.active) return;
  try {
    const response = await requestLocalExtensionUpdate(DEV_UPDATE_STATUS_URL);
    await reconcileManualExtensionUpdateLock(response?.status || null, response?.installed || null);
  } catch (_) {}
  const current = await chrome.storage.local.get('manualExtensionUpdateLock');
  if (!current.manualExtensionUpdateLock?.active) return;
  throw new Error('Установка обновления расширения ещё выполняется. Дождись её завершения в разделе «Сервис».');
}

async function startManualExtensionUpdate() {
  await assertManualExtensionUpdateNotApplying();
  const { run } = await getStored();
  if (runHasActiveAutomationWork(run)) throw new Error('Перед обновлением дождись завершения прогона или останови его.');
  const response = await requestLocalExtensionUpdate(DEV_UPDATE_START_URL, 'POST');
  return response.status || {};
}

function applyManualExtensionUpdate(targetVersion = '') {
  if (manualUpdateApplyInFlight) return manualUpdateApplyInFlight;
  manualUpdateApplyInFlight = (async () => {
    const claim = await withStateLock(async () => {
      const { run } = await getStored();
      if (runHasActiveAutomationWork(run)) return { deferred: true, reason: 'Рабочие вкладки ещё заняты.' };
      const stored = await chrome.storage.local.get(['manualExtensionUpdateLock', 'devAutoReload', 'resultsImportJournal']);
      if (stored.resultsImportJournal) throw new Error('Дождись завершения импорта результатов');
      const previous = stored.manualExtensionUpdateLock;
      if (previous?.active && previous.targetVersion && targetVersion && previous.targetVersion !== targetVersion) {
        return { deferred: true, reason: 'Завершается установка другого пакета.' };
      }
      const lock = {
        active: true,
        targetVersion: String(targetVersion || previous?.targetVersion || ''),
        startedAt: previous?.active ? previous.startedAt : new Date().toISOString()
      };
      await chrome.storage.local.set({
        manualExtensionUpdateLock: lock,
        devAutoReload: { ...(stored.devAutoReload || {}), refreshTabsAfterReload: false, suppressNextTabRefresh: true }
      });
      return { lock };
    });
    if (claim.deferred) return claim;
    try {
      const response = await requestLocalExtensionUpdate(DEV_UPDATE_APPLY_URL, 'POST');
      return { started: true, status: response.status || {} };
    } catch (error) {
      // A disconnect can follow an accepted POST. Only an explicit HTTP
      // rejection proves that applying the prepared package did not start.
      if (error?.updateRequestRejected) {
        await withStateLock(async () => {
          const stored = await chrome.storage.local.get('manualExtensionUpdateLock');
          if (stored.manualExtensionUpdateLock?.startedAt === claim.lock.startedAt) {
            await clearManualExtensionUpdateLock({ clearRefreshSuppression: true });
          }
        });
      }
      throw error;
    }
  })().finally(() => { manualUpdateApplyInFlight = null; });
  return manualUpdateApplyInFlight;
}

async function getManualExtensionUpdateStatus() {
  const response = await requestLocalExtensionUpdate(DEV_UPDATE_STATUS_URL);
  const status = response?.status || {};
  if (status.phase === 'ready') {
    const applyResult = await applyManualExtensionUpdate(status.latestVersion || '');
    if (applyResult.deferred) return { status, installed: response?.installed || null, deferred: true, reason: applyResult.reason };
    return { status: applyResult.status || status, installed: response?.installed || null, applying: applyResult.started === true };
  }
  const lockState = await reconcileManualExtensionUpdateLock(status, response?.installed || null).catch(() => null);
  if (lockState?.pending && ['complete', 'current', 'idle'].includes(String(status.phase || ''))) {
    return {
      status: { ...status, phase: 'restarting', message: 'Ожидаю загрузки обновлённой версии расширения.' },
      installed: response?.installed || null
    };
  }
  return { status, installed: response?.installed || null };
}

function runHasActiveAutomationWork(run) {
  return Boolean(run && (
    ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)
    || (run.state === 'PAUSED' && Number(run.rateLimitPauseUntil || 0) > Date.now())
    || hasLiveSlotWork(run)
    || Object.values(run.slots || {}).some((slot) => slot.entryId && slot.tabId)
  ));
}

async function postControlResult(command, result, controlClient = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEV_CONTROL_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEV_CONTROL_URL}/result`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: command.id,
        clientId: controlClient.clientId || null,
        extensionId: controlClient.extensionId || null,
        version: controlClient.version || null,
        ok: result.ok === true,
        value: result.value ?? null,
        error: result.ok === true ? null : result.error || 'Команда завершилась с ошибкой'
      }),
      signal: controller.signal
    });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function applyControlJobPatch(payload = {}) {
  const filterKeys = ['saleStatus', 'quality', 'brand'];
  const hasFilterPatch = Boolean(payload.filters && typeof payload.filters === 'object')
    || filterKeys.some((key) => payload[key] != null);
  const keys = ['queueGroup', 'runLimit', 'workerCount', 'coverageMode', 'generationPauseMinutes', 'generationJitterSeconds', 'runQueueMode', 'runPart', 'runPartSignature'];
  if (!keys.some((key) => payload[key] != null) && !hasFilterPatch) return;
  const stored = await chrome.storage.local.get('job');
  if (!stored.job) throw new Error('Сохранённая конфигурация прогона отсутствует');
  const nextJob = { ...stored.job };
  let filter = normalizeWatchFilter(
    nextJob.filters || parseFilterSelectionId(nextJob.queueGroup) || filterFromQueueGroup(nextJob.queueGroup)
  );
  if (payload.queueGroup != null) {
    const queueGroup = String(payload.queueGroup);
    if (!QUEUE_GROUP_IDS.includes(queueGroup)) throw new Error(`Неизвестный список: ${queueGroup}`);
    nextJob.queueGroup = queueGroup;
    filter = filterFromQueueGroup(queueGroup);
  }
  if (hasFilterPatch) {
    filter = normalizeWatchFilter({
      ...filter,
      ...(payload.filters || {}),
      ...(payload.saleStatus != null ? { saleStatus: payload.saleStatus } : {}),
      ...(payload.quality != null ? { quality: payload.quality } : {}),
      ...(payload.brand != null ? { brand: payload.brand } : {})
    });
    nextJob.filters = filter;
    nextJob.queueGroup = groupIdForWatchFilter(filter);
  } else {
    nextJob.filters = filter;
  }
  if (payload.runLimit != null) nextJob.runLimit = Math.min(RUN_PART_SIZE, normalizeRunLimit(payload.runLimit, nextJob.runLimit || RUN_PART_SIZE));
  if (payload.workerCount != null) nextJob.workerCount = normalizeWorkerCount(payload.workerCount, nextJob.workerCount || DEFAULT_WORKERS);
  if (payload.coverageMode != null) nextJob.coverageMode = normalizeCoverageMode(payload.coverageMode);
  if (payload.runQueueMode != null) {
    const mode = String(payload.runQueueMode);
    if (!['regular', REGENERATION_QUEUE_ID].includes(mode)) throw new Error(`Неизвестная очередь: ${mode}`);
    nextJob.runQueueMode = mode;
  }
  if (payload.runPart != null) {
    const runPart = Number(payload.runPart);
    if (!Number.isSafeInteger(runPart) || runPart < 1) throw new Error('Номер части очереди должен быть положительным целым числом');
    nextJob.runPart = runPart;
  }
  if (payload.runPartSignature != null) nextJob.runPartSignature = String(payload.runPartSignature || '');
  if ((hasFilterPatch || payload.queueGroup != null || payload.runQueueMode != null) && payload.runPart == null) {
    nextJob.runPart = null;
    nextJob.runPartSignature = '';
  }
  if (payload.generationPauseMinutes != null) nextJob.generationPauseMinutes = normalizeGenerationPauseMinutes(payload.generationPauseMinutes);
  if (payload.generationJitterSeconds != null) nextJob.generationJitterSeconds = normalizeGenerationJitterSeconds(payload.generationJitterSeconds);
  await chrome.storage.local.set({ job: nextJob });
}

async function executeControlCommand(command) {
  const payload = command?.payload && typeof command.payload === 'object' ? command.payload : {};
  if (command.command === 'STATUS') {
    const stored = await getStored();
    const [referenceKeys, watchKeys] = await Promise.all([
      getAssetKeys('ref:').catch(() => []),
      getAssetKeys('watch:').catch(() => [])
    ]);
    return {
      runtime: stored.runtime || null,
      summary: stored.run ? runSummary(stored.run, stored.queue) : null,
      runDiagnostics: stored.run ? {
        operationId: stored.run.operationId || null,
        startedAt: stored.run.startedAt || null,
        lastActivityAt: stored.run.lastActivityAt || null,
        eventJournal: Array.isArray(stored.run.eventJournal) ? stored.run.eventJournal.slice(-100) : [],
        postprocessOwners: Object.values(stored.run.postprocessTabs || {}).map((owner) => ({
          tabId: Number(owner.tabId || 0) || null,
          entryId: owner.entryId || null,
          generationId: owner.generationId || null,
          factsJobId: owner.factsJobId || null,
          startedAt: owner.startedAt || null,
          lastPulseAt: owner.lastPulseAt || null,
          pulseState: owner.pulseState || null,
          pulseError: owner.pulseError || null,
          recoveryDeadlineAt: Number(owner.recoveryDeadlineAt || 0) || null
        }))
      } : null,
      job: stored.job ? {
        queueGroup: stored.job.queueGroup || null,
        filters: stored.job.filters || filterFromQueueGroup(stored.job.queueGroup),
        coverageMode: normalizeCoverageMode(stored.job.coverageMode),
        runQueueMode: stored.job.runQueueMode === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular',
        runPart: stored.job.runPart || null,
        runPartSignature: stored.job.runPartSignature || null,
        runLimit: stored.job.runLimit || null,
        workerCount: stored.job.workerCount || null
      } : null,
      assets: {
        references: referenceKeys.map((key) => String(key).slice('ref:'.length)),
        watchCount: watchKeys.length
      },
      logs: Array.isArray(stored.logs) ? stored.logs.slice(-100) : []
    };
  }
  if (command.command === 'IMPORT_REFERENCES') return importLocalReferences();
  if (command.command === 'START') {
    await applyControlJobPatch(payload);
    if (payload.fresh === true) {
      const stored = await getStored();
      if (stored.run && !['PAUSED', 'STOPPED', 'DONE'].includes(stored.run.state)) {
        throw new Error('Нельзя начать новый прогон, пока текущий ещё активен');
      }
      // A stopped run can retain observation markers for failed slots. For an
      // explicit fresh start those old pages are intentionally discarded:
      // they belong to the dedicated automation window and must not block a
      // clean test run forever.
      if (stored.run && hasLiveSlotWork(stored.run)) {
        const windowId = Number(stored.run.automationWindowId || 0);
        const owned = stored.run.automationWindowOwned === true;
        if (owned && windowId && chrome.windows?.remove) {
          await chrome.windows.remove(windowId).catch(() => {});
        } else {
          const tabIds = Object.values(stored.run.slots || {}).map((slot) => Number(slot.tabId || 0)).filter((id) => id > 0);
          await Promise.all(tabIds.map((id) => chrome.tabs.remove(id).catch(() => {})));
        }
      }
      await chrome.storage.local.set({ run: null });
    }
    return startOrResumeRun();
  }
  if (command.command === 'RESUME') {
    await applyControlJobPatch(payload);
    return resumeRun();
  }
  if (command.command === 'STOP') {
    const expectedOperationId = String(payload.expectedOperationId || '');
    if (expectedOperationId) {
      const { run } = await chrome.storage.local.get('run');
      if (run?.operationId !== expectedOperationId) {
        throw new Error(`Остановка отменена: ожидался прогон ${expectedOperationId}, активен ${run?.operationId || 'пусто'}`);
      }
    }
    return stopRun();
  }
  throw new Error(`Неизвестная команда: ${command.command}`);
}

async function pollDevControl(source = 'poll') {
  if (devControlPollInFlight) return { ok: false, skipped: true };
  devControlPollInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEV_CONTROL_POLL_TIMEOUT_MS);
  try {
    const stored = await chrome.storage.local.get('devControlLastId');
    const after = Number(stored.devControlLastId || 0);
    const controlClient = await getDevControlClientIdentity();
    const query = new URLSearchParams({ after: String(after), ...controlClient });
    const response = await fetch(`${DEV_CONTROL_URL}?${query}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, unavailable: true };
    const payload = await response.json();
    const commands = Array.isArray(payload?.commands)
      ? payload.commands.sort((left, right) => Number(left.id || 0) - Number(right.id || 0))
      : [];
    const completed = [];
    for (const command of commands) {
      const id = Number(command.id || 0);
      if (!id || id <= after) continue;
      let result;
      try {
        result = { ok: true, value: await executeControlCommand(command) };
        await appendLog(`Локальная команда выполнена: ${command.command}`, { commandId: id, source });
      } catch (error) {
        result = { ok: false, error: error?.message || String(error) };
        await appendLog(`Локальная команда завершилась ошибкой: ${command.command}`, { commandId: id, error: result.error, source });
      }
      await postControlResult(command, result, controlClient);
      await chrome.storage.local.set({ devControlLastId: id });
      completed.push({ id, ok: result.ok, error: result.error || null });
    }
    return { ok: true, completed };
  } catch (_) {
    return { ok: false, unavailable: true };
  } finally {
    clearTimeout(timeoutId);
    devControlPollInFlight = false;
  }
}

function normalizeDomObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const observation = {
    schemaVersion: Number(value.schemaVersion || 1),
    sessionId: String(value.sessionId || 'unknown-session').slice(0, 120),
    sequence: Number(value.sequence || 0),
    timestamp: String(value.timestamp || new Date().toISOString()),
    eventType: String(value.eventType || 'unknown').slice(0, 80),
    href: String(value.href || '').slice(0, 800),
    title: String(value.title || '').slice(0, 300),
    context: value.context && typeof value.context === 'object' ? {
      operationId: value.context.operationId || null,
      slotId: value.context.slotId ?? null,
      entryId: value.context.entryId || null,
      entryName: String(value.context.entryName || '').slice(0, 300) || null
    } : {},
    stateHash: String(value.stateHash || '').slice(0, 80),
    phase: String(value.phase || value.semanticSnapshot?.phase || '').slice(0, 80) || undefined,
    mutations: Array.isArray(value.mutations) ? value.mutations.slice(0, 120) : undefined,
    action: value.action && typeof value.action === 'object' ? value.action : undefined,
    semanticSnapshot: value.semanticSnapshot && typeof value.semanticSnapshot === 'object'
      ? value.semanticSnapshot
      : undefined,
    visibility: value.visibility || undefined
  };
  let serialized = JSON.stringify(observation);
  if (serialized.length > 260000 && observation.semanticSnapshot) {
    observation.semanticSnapshot = {
      ...observation.semanticSnapshot,
      bodyText: String(observation.semanticSnapshot.bodyText || '').slice(0, 2500),
      elements: Array.isArray(observation.semanticSnapshot.elements)
        ? observation.semanticSnapshot.elements.slice(0, 120)
        : []
    };
    serialized = JSON.stringify(observation);
  }
  if (serialized.length > 300000) return null;
  return observation;
}

function domObservationKey(value) {
  return `${value?.sessionId || 'session'}:${Number(value?.sequence || 0)}`;
}

async function addDomObservations(observations = []) {
  const storedMode = await chrome.storage.local.get('domDiagnosticsMode');
  domDiagnosticsModeCache = normalizeDomDiagnosticsMode(storedMode.domDiagnosticsMode);
  if (domDiagnosticsModeCache === DOM_DIAGNOSTICS_MODES.OFF) {
    return { accepted: 0, disabled: true };
  }
  const normalized = observations.map(normalizeDomObservation).filter(Boolean);
  if (!normalized.length) return { accepted: 0 };
  const stored = await chrome.storage.local.get(['domObservationBuffer', 'domObservationStats']);
  const previous = Array.isArray(stored.domObservationBuffer) ? stored.domObservationBuffer : [];
  const merged = new Map(previous.map((item) => [domObservationKey(item), item]));
  for (const item of normalized) merged.set(domObservationKey(item), item);
  const buffer = [...merged.values()].slice(-DOM_EVENT_BUFFER_LIMIT);
  const stats = {
    received: Number(stored.domObservationStats?.received || 0) + normalized.length,
    lastReceivedAt: new Date().toISOString(),
    lastSessionId: normalized.at(-1)?.sessionId || stored.domObservationStats?.lastSessionId || null,
    lastSequence: normalized.at(-1)?.sequence || stored.domObservationStats?.lastSequence || 0
  };
  await chrome.storage.local.set({ domObservationBuffer: buffer, domObservationStats: stats });
  queueDomBridgeFlush();
  return { accepted: normalized.length, buffered: buffer.length };
}

function queueDomBridgeFlush() {
  if (domDiagnosticsModeCache === DOM_DIAGNOSTICS_MODES.OFF) return;
  if (Date.now() < domBridgeRetryAt) return;
  domBridgeChain = domBridgeChain
    .catch(() => {})
    .then(() => flushDomObservationBuffer())
    .catch(() => {});
}

async function flushDomObservationBuffer() {
  if (domDiagnosticsModeCache === DOM_DIAGNOSTICS_MODES.OFF) return;
  if (Date.now() < domBridgeRetryAt) return;
  const stored = await chrome.storage.local.get('domObservationBuffer');
  const buffer = Array.isArray(stored.domObservationBuffer) ? stored.domObservationBuffer : [];
  if (!buffer.length) return;
  const batch = buffer.slice(0, 24);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOM_EVENT_POST_TIMEOUT_MS);
  try {
    const response = await fetch(DOM_EVENT_ENDPOINT, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`DOM bridge HTTP ${response.status}`);
    const sent = new Set(batch.map(domObservationKey));
    const latest = await chrome.storage.local.get('domObservationBuffer');
    const remaining = (Array.isArray(latest.domObservationBuffer) ? latest.domObservationBuffer : [])
      .filter((item) => !sent.has(domObservationKey(item)));
    await chrome.storage.local.set({ domObservationBuffer: remaining });
    domBridgeRetryAt = 0;
    if (remaining.length) queueDomBridgeFlush();
  } catch (_) {
    domBridgeRetryAt = Date.now() + 5000;
  } finally {
    clearTimeout(timeoutId);
  }
}

function diagnosticKey(value = {}) {
  return [value.capturedAt, value.operationId, value.slotId, value.entryId, value.entryName]
    .map((item) => String(item ?? ''))
    .join('|');
}

function queueLastDiagnosticBridge() {
  if (domDiagnosticsModeCache === DOM_DIAGNOSTICS_MODES.OFF) return;
  chrome.storage.local.get(['lastDiagnostic', 'diagnosticBridgeSent'])
    .then(({ lastDiagnostic, diagnosticBridgeSent }) => {
      if (!lastDiagnostic || diagnosticKey(lastDiagnostic) === diagnosticBridgeSent) return;
      queueDiagnosticBridge(lastDiagnostic);
    })
    .catch(() => {});
}

function queueDiagnosticBridge(diagnostic) {
  if (domDiagnosticsModeCache === DOM_DIAGNOSTICS_MODES.OFF) return;
  const key = diagnosticKey(diagnostic);
  if (!key || Date.now() < diagnosticBridgeRetryAt) return;
  diagnosticBridgeChain = diagnosticBridgeChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get('diagnosticBridgeSent');
      if (stored.diagnosticBridgeSent === key) return;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DOM_EVENT_POST_TIMEOUT_MS);
      try {
        const response = await fetch(DIAGNOSTIC_ENDPOINT, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ diagnostic }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Diagnostic bridge HTTP ${response.status}`);
        await chrome.storage.local.set({ diagnosticBridgeSent: key });
        diagnosticBridgeRetryAt = 0;
      } catch (_) {
        diagnosticBridgeRetryAt = Date.now() + 5000;
      } finally {
        clearTimeout(timeoutId);
      }
    })
    .catch(() => {});
}

async function updateRuntime(patch) {
  const current = (await chrome.storage.local.get('runtime')).runtime || {};
  const runtime = { ...current, buildId: EXTENSION_BUILD_ID, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ runtime });
  try { await chrome.runtime.sendMessage({ type: 'RUNTIME_UPDATED', runtime }); } catch (_) {}
  return runtime;
}

function flushPendingLogsSoon(delayMs = 250) {
  if (logFlushTimer != null) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const batch = pendingLogEntries.splice(0);
    if (!batch.length) return;
    const task = logFlushChain.then(async () => {
      const { logs = [] } = await chrome.storage.local.get('logs');
      await chrome.storage.local.set({ logs: [...logs, ...batch].slice(-300) });
    });
    logFlushChain = task.catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

async function appendLog(message, extra = {}) {
  pendingLogEntries.push({ ts: new Date().toISOString(), message, ...extra });
  flushPendingLogsSoon();
  // Logging is observability, not a synchronization primitive. Callers may
  // await this function without delaying tab creation/upload/prompt filling.
  return true;
}

function groupEntries(queue, groupId) {
  let selectedEntries;
  if (groupId === REGENERATION_QUEUE_ID) {
    const bySourceId = new Map(filteredWatchEntries(queue?.groups || {}, {})
      .filter((entry) => entry?.sourceId)
      .map((entry) => [String(entry.sourceId), entry]));
    selectedEntries = (Array.isArray(queue?.repairQueue) ? queue.repairQueue : [])
      .map((item) => typeof item === 'string' ? item : item?.sourceId)
      .filter(Boolean)
      .map((sourceId) => bySourceId.get(String(sourceId)))
      .filter(Boolean);
  } else {
    const filter = parseFilterSelectionId(groupId) || filterFromQueueGroup(groupId);
    selectedEntries = filter ? filteredWatchEntries(queue?.groups || {}, filter) : [];
  }
  const all = QUEUE_GROUP_IDS.flatMap((id) => queue?.groups?.[id] || []);
  return selectedEntries.map((selected) => {
    const copies = all.filter((entry) => String(entry?.skuKey || sourceIdFor(
      entry?.groupId || 'in_sale_good', entry?.relativePath || entry?.fileName, entry?.modelName || entry?.fileName
    )) === String(selected.sourceId));
    if (!copies.length) return selected;
    let primary = copies.find((entry) => String(entry.groupId || '') === String(selected.groupId || '')) || copies[0];
    for (const entry of copies) {
      const membershipGroup = entry.groupId;
      Object.assign(entry, selected, { groupId: membershipGroup || selected.groupId });
    }
    primary.groupId = selected.groupId || primary.groupId;
    return primary;
  });
}

async function completeRepairQueueClaim(runId, sourceId, generationIdValue) {
  return withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== runId || run.groupId !== REGENERATION_QUEUE_ID) return false;
    const claimedAt = run.repairQueueClaims?.[sourceId];
    if (!claimedAt) return false;
    const queue = stored.queue || { groups: {}, repairQueue: [] };
    const items = normalizedRepairQueue(queue);
    const current = items.find((item) => item.sourceId === sourceId);
    if (!current || current.queuedAt !== claimedAt) return false;
    current.status = 'completed';
    current.completedAt = new Date().toISOString();
    current.completedGenerationId = generationIdValue || null;
    recordRunEvent(run, 'repair_queue_item_completed', { sourceId, generationId: generationIdValue });
    await saveRunAndQueue(run, queue, stored.history, stored.generationMemory);
    await publishRun(run, queue);
    return true;
  });
}

function slotGenerationSubmitted(slot) {
  if (!slot) return false;
  const status = String(slot.status || '').toUpperCase();
  const phase = String(slot.phase || '').toUpperCase();
  if (slot.generationSubmittedAt || slot.downloadId || currentLeasePhysicalSend(slot)) return true;
  const pageConfirmedCurrentLease = Boolean(slot.leaseId)
    && String(slot.pageSubmissionLeaseId || '') === String(slot.leaseId);
  if (pageConfirmedCurrentLease && slot.pageGenerationSubmitted === true) return true;
  if (pageConfirmedCurrentLease && slot.pageGenerationSubmitted === false
    && !slot.chatUrl
    && Number(slot.assistantCount || 0) <= Number(slot.baselineAssistantCount || 0)) return false;
  // A prepared draft can inherit stale presentation fields from older runs.
  // Those UI phases are not proof of a physical Send click.
  if (slot.preparedForSubmit === true && !currentSlotSendClicked(slot)) return false;

  // Compatibility for older snapshots without page lease evidence: retain
  // their observation status until a current page probe confirms it was unsent.
  return Boolean(
    slot.finalCheckPending
    || ['SENDING', 'PROMPT_SENT', 'WAITING_ASSISTANT', 'WAITING_GENERATION', 'GENERATING', 'WAITING_IMAGE', 'REQUESTING_DOWNLOAD', 'DOWNLOADING', 'OBSERVING'].includes(status)
    || [SLOT_PHASES.SENDING, SLOT_PHASES.PROMPT_SENT, SLOT_PHASES.GENERATING, SLOT_PHASES.OBSERVING, SLOT_PHASES.IMAGE_FOUND, SLOT_PHASES.DOWNLOADING, SLOT_PHASES.VERIFYING_FILE].includes(phase)
  );
}

function currentSlotSendClicked(slot) {
  const clickedAt = Date.parse(slot?.lastSendClickedAt || '') || 0;
  const preparedAt = Date.parse(slot?.preparedAt || '') || 0;
  return clickedAt > 0 && (preparedAt === 0 || clickedAt >= preparedAt);
}

async function pauseStalledPreparedSlots(operationId) {
  const cancelled = [];
  const obsoleteTabs = [];
  let finished = false;
  await withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (!run || run.operationId !== operationId
      || !['DRAINING', 'PAUSED', 'DONE'].includes(run.state)
      || String(run.pauseReason || '').toUpperCase() === 'USER') return;
    const queue = stored.queue;
    const history = normalizeHistory(stored.history);
    const memory = normalizeGenerationMemory(stored.generationMemory);
    const entries = groupEntries(queue, run.groupId);
    for (const slot of Object.values(run.slots || {})) {
      if (!slot.entryId || !slot.preparedForSubmit || slotGenerationSubmitted(slot)) continue;
      const entry = entries.find((item) => item.sourceId === slot.entryId);
      if (entry?.status === 'done') {
        if (slot.generationId) cancelled.push({ generationId: slot.generationId, sourceId: slot.entryId });
        if (slot.tabId) obsoleteTabs.push(slot.tabId);
        slot.entryId = null;
        slot.tabId = null;
        slot.status = 'DONE';
        slot.phase = SLOT_PHASES.DONE;
        slot.finalCheckPending = false;
        continue;
      }
      if (!entry) continue;
      if (slot.generationId) cancelled.push({ generationId: slot.generationId, sourceId: slot.entryId });
      entry.status = 'pending';
      entry.lastError = null;
      setGenerationMemoryStatus(memory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'automatic', generationStartedAt: null, lastError: null,
        lastRunId: run.operationId
      });
      slot.status = 'PAUSED';
      slot.phase = SLOT_PHASES.WAITING_LAUNCH;
      slot.finalCheckPending = false;
      slot.finalCheckDeadlineAt = null;
      slot.failed = false;
      slot.lastCheckError = null;
      slot.launchWaitUntil = null;
    }
    const planned = new Set(run.plannedIds || []);
    run.pendingIds = entries.filter((entry) => planned.has(entry.sourceId) && entry.status !== 'done')
      .map((entry) => entry.sourceId);
    const factsPending = Object.keys(run.postprocessTabs || {}).length > 0;
    finished = run.pendingIds.length === 0 && !factsPending;
    run.state = finished ? 'DONE' : (factsPending && !run.pendingIds.length ? 'DRAINING' : 'PAUSED');
    run.status = run.state;
    run.pauseReason = finished ? null : 'ERROR';
    run.unresolvedError = false;
    run.error = null;
    run.currentAction = finished
      ? 'Все модели сохранены; оставшиеся пустые рабочие вкладки закрываются.'
      : (run.pendingIds.length
        ? `${run.pendingIds.length} подготовленных моделей ожидают «Продолжить». Промпты ещё не отправлялись.`
        : 'Изображения сохранены. Дожидаюсь постпроверки характеристик.');
    recordRunEvent(run, 'unsent_slots_recovered', { entryIds: [...run.pendingIds] });
    await saveRunAndQueue(run, queue, history, memory);
    await publishRun(run, queue);
  });
  for (const item of cancelled) {
    await cancelUnsubmittedGenerationRevision(item.generationId, item.sourceId,
      'send_blocked_by_premature_draining').catch(() => {});
  }
  await Promise.all(obsoleteTabs.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  if (finished) await closeAutomationWindowIfEmpty(operationId);
}

function hasObservationWork(run) {
  return Object.keys(run?.postprocessTabs || {}).length > 0
    || Object.keys(run?.recoveryTabs || {}).length > 0
    || Object.values(run?.slots || {}).some((slot) => (
    slot.downloadId
    || (slot.observationExpired !== true && slot.finalCheckPending)
    || (slot.observationExpired !== true && slot.entryId && slot.tabId && slotGenerationSubmitted(slot))
  ));
}

function scheduledRetriesForRun(run, queue, now = Date.now()) {
  return scheduledRunRetries(run, groupEntries(queue, run?.groupId), now);
}

function hasScheduledRunRetries(run, queue, now = Date.now()) {
  return scheduledRetriesForRun(run, queue, now).length > 0;
}

function activeSlots(run) {
  return Object.values(run?.slots || {}).filter((slot) => (
    slot.entryId && (slot.finalCheckPending || !['IDLE', 'DONE', 'PAUSED', 'STOPPED'].includes(slot.status))
  )).length;
}

function hasLiveSlotWork(run) {
  const slotWork = Object.values(run?.slots || {}).some((slot) => (
    slot.finalCheckPending ||
    slot.downloadId ||
    (slot.entryId && !['IDLE', 'DONE', 'PAUSED', 'STOPPED'].includes(slot.status))
  ));
  const postprocessWork = Object.keys(run?.postprocessTabs || {}).length > 0;
  const recoveryWork = Object.keys(run?.recoveryTabs || {}).length > 0;
  return slotWork || postprocessWork || recoveryWork;
}

function shouldEnterFactsDraining(run, nextAssignment) {
  return !nextAssignment && !(run.pendingIds || []).length
    && !Object.values(run.slots || {}).some((slot) => slot.entryId)
    && Object.keys(run.postprocessTabs || {}).length > 0;
}

function hasUnresolvedSlotErrors(run) {
  return Boolean(run?.unresolvedError) || Object.values(run?.slots || {}).some((slot) => slot.failed && slot.entryId);
}

function clearResolvedRunError(run, queue) {
  if (!run?.unresolvedError) return;
  const planned = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
  const hasErrorEntry = groupEntries(queue, run.groupId).some((entry) => (
    planned.has(entry.sourceId) && entry.status === 'error'
  ));
  const hasFailedSlot = Object.values(run.slots || {}).some((slot) => slot.failed && slot.entryId);
  if (!hasErrorEntry && !hasFailedSlot) run.unresolvedError = false;
}

function finalizeDrainingRun(run, queue = null) {
  if (!run || !['RUNNING', 'DRAINING'].includes(run.state) || hasLiveSlotWork(run)) return false;
  const previousState = run.state;
  const previousStatus = run.status;
  const hasPending = Array.isArray(run.pendingIds) && run.pendingIds.length > 0;
  const scheduledRetries = queue ? scheduledRetriesForRun(run, queue) : [];
  if (!hasPending && scheduledRetries.length) {
    const nextRetry = scheduledRetries[0];
    run.state = 'RUNNING';
    run.status = 'RETRY_BACKOFF';
    run.finishedAt = null;
    run.currentAction = `Ожидаю безопасный повтор через ${clockTime(nextRetry.retryAt)}`;
    if (run.state !== previousState || run.status !== previousStatus) {
      recordRunEvent(run, 'run_retry_backoff_scheduled', {
        retryAt: nextRetry.retryAt,
        retryCount: scheduledRetries.length,
        pendingCount: Number(run.pendingIds?.length || 0)
      });
    }
    return true;
  }
  if (hasUnresolvedSlotErrors(run) || hasPending) {
    run.state = 'PAUSED';
    run.status = 'PAUSED_ON_ERROR';
    run.finishedAt = null;
    run.currentAction = hasPending
      ? 'Рабочие вкладки завершились с ошибками. Ожидается продолжение очереди.'
      : 'Проверка запущенных генераций завершена. Ожидается продолжение.';
    if (run.state !== previousState || run.status !== previousStatus) {
      recordRunEvent(run, 'run_paused_on_error', {
        pendingCount: Number(run.pendingIds?.length || 0),
        unresolvedError: Boolean(hasUnresolvedSlotErrors(run)),
        failedSlotCount: Object.values(run.slots || {}).filter((slot) => slot.failed && slot.entryId).length
      });
    }
  } else {
    const factsErrors = Object.values(run.factsProgress || {})
      .filter((facts) => String(facts?.stage || '').toUpperCase() === 'ERROR').length;
    run.state = 'DONE';
    run.status = factsErrors ? 'DONE_WITH_FACTS_ERRORS' : 'DONE';
    run.finishedAt ||= new Date().toISOString();
    run.rateLimitPauseUntil = null;
    run.rateLimitPauseStartedAt = null;
    run.rateLimitReason = null;
    run.error = null;
    run.currentAction = factsErrors
      ? `Фото скачаны. Ошибок спецификации: ${factsErrors}. Повторное чтение доступно в галерее.`
      : 'Все запущенные генерации скачаны, спецификации сохранены.';
    const planned = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
    const completedCount = (queue?.groups?.[run.groupId] || [])
      .filter((entry) => planned.has(entry.sourceId) && entry.status === 'done').length;
    recordRunEvent(run, 'run_completed', {
      plannedCount: planned.size,
      completedCount,
      pendingCount: Math.max(0, planned.size - completedCount),
      factsErrorCount: factsErrors,
      finishedAt: run.finishedAt
    });
  }
  return true;
}

function entryDisplayName(entry, slot = {}) {
  return entry?.fileName || entry?.modelName || slot.lastEntryName || slot.lastModelName || `слот ${Number(slot.slotId || 0) + 1}`;
}

function slotSummaries(run, queue) {
  return Object.values(run?.slots || {})
    .sort((a, b) => Number(a.slotId || 0) - Number(b.slotId || 0))
    .map((slot) => {
      const entry = groupEntries(queue, run?.groupId).find((item) => item.sourceId === slot.entryId);
      return {
        slotId: slot.slotId,
        tabId: slot.tabId || null,
        entryId: slot.entryId || null,
        entryName: slot.entryId ? entryDisplayName(entry, slot) : null,
        modelName: slot.entryId ? (entry?.modelName || slot.lastModelName || null) : null,
        status: slot.status || 'IDLE',
        phase: slot.phase || slot.status || SLOT_PHASES.IDLE,
        leaseId: slot.leaseId || null,
        generationId: slot.generationId || null,
        previousGenerationId: slot.previousGenerationId || null,
        attempt: Number(slot.attempt || 0),
        errorClass: slot.errorClass || null,
        nextRetryAt: slot.nextRetryAt || null,
        factsJobId: slot.factsJobId || null,
        lastHeartbeatAt: slot.lastHeartbeatAt || null,
        lastProbeAt: slot.lastProbeAt || null,
        lastProgressAt: slot.lastProgressAt || null,
        noResponseSince: slot.noResponseSince || null,
        checkFailures: Number(slot.checkFailures || 0),
        generationSubmittedAt: slot.generationSubmittedAt || null,
        assistantObservedAt: slot.assistantObservedAt || null,
        assistantCount: Number(slot.assistantCount || 0),
        imageCandidate: Boolean(slot.imageCandidate),
        resultFingerprint: slot.resultFingerprint || null,
        recipeHash: slot.recipeHash || null,
        profileId: slot.profileId || null,
        profileVersion: slot.profileVersion || null,
        downloadVerification: slot.downloadVerification || null,
        revisionPersistFailures: Number(slot.revisionPersistFailures || 0),
        revisionPersistRetryAt: slot.revisionPersistRetryAt || null,
        revisionPersistBlocked: slot.revisionPersistBlocked === true,
        lastCheckAt: slot.lastCheckAt || null,
        lastCheckState: slot.lastCheckState || null,
        lastCheckError: slot.lastCheckError || null,
        lastActivityAt: slot.lastActivityAt || null,
        lastResult: slot.lastResult || null,
        failed: Boolean(slot.failed),
        downloading: Boolean(slot.downloadId),
        launchWaitUntil: slot.launchWaitUntil || null,
        finalCheckPending: Boolean(slot.finalCheckPending),
        finalCheckDeadlineAt: slot.finalCheckDeadlineAt || null,
        finalCheckAttempts: Number(slot.finalCheckAttempts || 0),
        rateLimitRetryNeeded: Boolean(slot.rateLimitRetryNeeded),
        rendererBootstrappedAt: slot.rendererBootstrappedAt || null,
        rendererBootstrapVisibility: slot.rendererBootstrapVisibility || null
      };
    });
}

function shouldKeepAuditMonitor(run, queue) {
  if (!run || conversationRecoveryIsBlocked(run)) return false;
  if (['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) return true;
  return run.state === 'PAUSED'
    && (hasObservationWork(run) || hasScheduledRunRetries(run, queue));
}

function reconcileAuditAlarm() {
  if (!chrome.alarms || (!chrome.alarms.create && auditMonitorDesired)) return Promise.resolve();
  if (auditAlarmReconcilePromise) return auditAlarmReconcilePromise;

  let lastCheckedEpoch = auditMonitorEpoch;
  const syncPromise = (async () => {
    while (true) {
      const epoch = auditMonitorEpoch;
      const wanted = auditMonitorDesired;
      try {
        const existing = typeof chrome.alarms.get === 'function'
          ? await chrome.alarms.get(AUDIT_ALARM_NAME)
          : (auditAlarmKnownPresent ? { name: AUDIT_ALARM_NAME } : null);
        auditAlarmKnownPresent = Boolean(existing);
        if (epoch !== auditMonitorEpoch) continue;

        if (wanted && !existing) {
          await chrome.alarms.create(AUDIT_ALARM_NAME, { periodInMinutes: 0.5 });
          auditAlarmKnownPresent = true;
        } else if (!wanted && existing && chrome.alarms.clear) {
          await chrome.alarms.clear(AUDIT_ALARM_NAME);
          auditAlarmKnownPresent = false;
        }
      } catch {
        if (epoch !== auditMonitorEpoch) continue;
        lastCheckedEpoch = epoch;
        return;
      }

      lastCheckedEpoch = epoch;
      if (epoch === auditMonitorEpoch) return;
    }
  })();
  auditAlarmReconcilePromise = syncPromise;
  void syncPromise.finally(() => {
    if (auditAlarmReconcilePromise !== syncPromise) return;
    auditAlarmReconcilePromise = null;
    if (lastCheckedEpoch !== auditMonitorEpoch) void reconcileAuditAlarm();
  }).catch(() => {});
  return syncPromise;
}

function startAuditMonitor() {
  const newlyStarted = !auditMonitorDesired;
  if (newlyStarted) {
    auditMonitorDesired = true;
    auditMonitorEpoch += 1;
  }
  const alarmSync = reconcileAuditAlarm();
  // Publishing each probe must not replace the normal 5s cadence with a new
  // 250ms timer. The in-flight audit schedules its own next interval.
  if (newlyStarted || (!auditTimer && !auditInFlight)) scheduleAudit(250);
  return alarmSync;
}

function stopAuditMonitor() {
  if (auditMonitorDesired) {
    auditMonitorDesired = false;
    auditMonitorEpoch += 1;
  }
  auditTimerGeneration += 1;
  if (auditTimer) clearTimeout(auditTimer);
  auditTimer = null;
  return reconcileAuditAlarm();
}

function scheduleAudit(delay = AUDIT_INTERVAL_MS) {
  if (!auditMonitorDesired) return;
  const timerGeneration = ++auditTimerGeneration;
  if (auditTimer) clearTimeout(auditTimer);
  auditTimer = setTimeout(() => {
    if (!auditMonitorDesired || timerGeneration !== auditTimerGeneration) return;
    auditTimer = null;
    auditActiveRun()
      .catch((error) => appendLog('Ошибка фоновой проверки генераций', { error: error.message }))
      .finally(async () => {
        const { run, queue } = await getStored().catch(() => ({ run: null, queue: null }));
        if (timerGeneration !== auditTimerGeneration) return;
        if (shouldKeepAuditMonitor(run, queue)) scheduleAudit();
        else stopAuditMonitor();
      });
  }, delay);
}

function shouldWakeSlot(slot, now = Date.now()) {
  if (!['GENERATING', 'WAITING_IMAGE'].includes(slot?.lastCheckState)) return false;
  const lastFocusAt = Date.parse(slot.lastFocusAt || '');
  return !Number.isFinite(lastFocusAt) || now - lastFocusAt >= FOCUS_AUDIT_INTERVAL_MS;
}

function phaseForProbeState(state, { finalCheckPending = false, generationSubmitted = false, downloadId = null, preparedForSubmit = false } = {}) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'READY') return SLOT_PHASES.IMAGE_FOUND;
  if (normalized === 'DOWNLOADING') return SLOT_PHASES.DOWNLOADING;
  // A rate-limit dialog is a global send gate. A slot that already submitted
  // its prompt continues its own observation/download lifecycle.
  if (normalized === 'RATE_LIMIT_PAUSE') {
    if (downloadId || generationSubmitted || finalCheckPending) return finalCheckPending ? SLOT_PHASES.OBSERVING : SLOT_PHASES.GENERATING;
    return SLOT_PHASES.RATE_LIMIT_PAUSE;
  }
  if (normalized === 'CONVERSATION_LOAD_ERROR') return SLOT_PHASES.OBSERVING;
  if (normalized === 'ERROR') return finalCheckPending ? SLOT_PHASES.OBSERVING : SLOT_PHASES.NEEDS_ATTENTION;
  if (finalCheckPending) return SLOT_PHASES.OBSERVING;
  // CHECK_GENERATION also runs while uploads or prompt preparation are in
  // progress. A blank conversation naturally reports WAITING_ASSISTANT;
  // that state cannot advance an unsent slot into GENERATING.
  if (generationSubmitted === false && !downloadId) {
    if (['WAITING_ASSISTANT', 'WAITING_GENERATION', 'WAITING_IMAGE'].includes(normalized)) {
      return preparedForSubmit ? SLOT_PHASES.WAITING_LAUNCH : SLOT_PHASES.PREPARING;
    }
    if (normalized === 'GENERATING') return null;
  }
  if (['WAITING_ASSISTANT', 'GENERATING', 'WAITING_GENERATION', 'WAITING_IMAGE'].includes(normalized)) {
    return SLOT_PHASES.GENERATING;
  }
  return null;
}

async function wakeTabForAudit(operationId, candidate) {
  if (!chrome.tabs.get) return false;
  const target = await chrome.tabs.get(candidate.tabId).catch(() => null);
  if (!target) return false;

  const marked = await withStateLock(async () => {
    const stored = await getStored();
    const automationWindowId = Number(stored.run?.automationWindowId || 0);
    const slot = stored.run?.slots?.[candidate.slotId];
    if (!stored.run || stored.run.operationId !== operationId || slot?.entryId !== candidate.entryId) return false;
    if (automationWindowId && Number(target.windowId) !== automationWindowId) return false;
    const now = new Date().toISOString();
    slot.lastFocusAt = now;
    slot.focusCount = Number(slot.focusCount || 0) + 1;
    stored.run.currentAction = `Проверяю вкладку ${Number(candidate.slotId) + 1}: ${entryDisplayName(groupEntries(stored.queue, stored.run.groupId).find((entry) => entry.sourceId === candidate.entryId), slot)}`;
    stored.run.lastActivityAt = now;
    await saveRunAndQueue(stored.run, stored.queue);
    await publishRun(stored.run, stored.queue);
    return true;
  });
  if (!marked) return false;
  // Content scripts receive messages while their tabs stay in the
  // background. Auditing this way preserves the user's active window and
  // avoids the visible tab switching that used to happen every 30 seconds.
  return true;
}

function runSummary(run, queue) {
  const elapsedMs = elapsedRunClock(run, Date.now());
  const entries = groupEntries(queue, run?.groupId);
  const plannedIds = Array.isArray(run?.plannedIds) ? run.plannedIds : entries.map((entry) => entry.sourceId);
  const planned = entries.filter((entry) => plannedIds.includes(entry.sourceId));
  const filter = normalizeWatchFilter(
    run?.filter || parseFilterSelectionId(run?.groupId) || filterFromQueueGroup(run?.groupId)
  );
  return {
    operationId: run?.operationId || null,
    state: run?.state || null,
    status: run?.status || null,
    pauseReason: run?.pauseReason || null,
    imageLimitDetected: run?.imageLimitDetected === true,
    stalledBatchRecovery: run?.stalledBatchRecovery ? {
      stage: run.stalledBatchRecovery.stage || null,
      attempts: Number(run.stalledBatchRecovery.attempts || 0),
      triggeredAt: run.stalledBatchRecovery.triggeredAt || null,
      dueAt: Number(run.stalledBatchRecovery.dueAt || 0) || null,
      requeuedCount: Number(run.stalledBatchRecovery.requeuedCount
        || run.stalledBatchRecovery.requeuedIds?.length || 0),
      error: run.stalledBatchRecovery.error || null
    } : null,
    conversationRecovery: run?.conversationRecovery ? {
      stage: run.conversationRecovery.stage || null,
      attempts: Number(run.conversationRecovery.attempts || 0),
      startedAt: run.conversationRecovery.startedAt || null,
      dueAt: Number(run.conversationRecovery.dueAt || 0) || null,
      completedAt: run.conversationRecovery.completedAt || null,
      error: run.conversationRecovery.error || null,
      remaining: Array.isArray(run.conversationRecovery.slots) ? run.conversationRecovery.slots.length : 0
    } : null,
    stopBlocked: run?.stopBlocked ? {
      count: Number(run.stopBlocked.count || 0),
      at: run.stopBlocked.at || null,
      message: run.stopBlocked.message || null
    } : null,
    startedAt: run?.startedAt || null,
    finishedAt: run?.finishedAt || null,
    clockVersion: Number(run?.clockVersion || 0) || null,
    clockAccumulatedMs: run?.clockAccumulatedMs == null ? null : Math.max(0, Number(run.clockAccumulatedMs || 0)),
    clockActiveSinceMs: run?.clockActiveSinceMs ?? null,
    clockStopped: run?.clockStopped === true,
    elapsedMs,
    automationWindowId: run?.automationWindowId || null,
    queueGroup: run?.groupId || null,
    filter,
    filterLabel: run?.filterLabel || watchFilterLabel(filter),
    coverageMode: normalizeCoverageMode(run?.coverageMode),
    activeSlots: activeSlots(run),
    completed: entries.filter((entry) => entry.status === 'done').length,
    pending: entries.filter((entry) => entry.status !== 'done').length,
    runTotal: planned.length,
    runCompleted: planned.filter((entry) => entry.status === 'done').length,
    runRemaining: planned.filter((entry) => entry.status !== 'done').length,
    runLimit: run?.runLimit ?? null,
    runPart: run?.runPart ?? null,
    runPartCount: run?.runPartCount ?? null,
    runPartCandidateCount: run?.runPartCandidateCount ?? null,
    workerCount: normalizeWorkerCount(run?.workerCount, DEFAULT_WORKERS),
    inputMode: normalizeInputMode(run?.inputMode, DEFAULT_INPUT_MODE),
    rateLimitPauseMinutes: normalizeRateLimitPauseMinutes(run?.rateLimitPauseMinutes),
    rateLimitIgnoreMinutes: normalizeRateLimitIgnoreMinutes(run?.rateLimitIgnoreMinutes),
    rateLimitIgnoreUntil: run?.rateLimitIgnoreUntil || null,
    generationPauseMinutes: normalizeGenerationPauseMinutes(run?.generationPauseMinutes),
    generationJitterSeconds: normalizeGenerationJitterSeconds(run?.generationJitterSeconds),
    rateLimitPauseUntil: run?.rateLimitPauseUntil || null,
    rateLimitPauseStartedAt: run?.rateLimitPauseStartedAt || null,
    rateLimitReason: run?.rateLimitReason || null,
    error: run?.error?.message || null,
    currentAction: run?.currentAction || null,
    lastActivityAt: run?.lastActivityAt || null,
    lastCheckAt: run?.lastCheckAt || null,
    lastProgressAt: run?.lastProgressAt || null,
    noProgressSince: run?.noProgressSince || null,
    noProgressCycles: Number(run?.noProgressCycles || 0),
    eventCount: Number(run?.eventCount || run?.eventJournal?.length || 0),
    recentEvents: Array.isArray(run?.eventJournal) ? run.eventJournal.slice(-20) : [],
    buildId: run?.buildId || EXTENSION_BUILD_ID,
    factsJobs: factsProgressSummaries(run),
    slots: slotSummaries(run, queue)
  };
}

async function publishRun(run, queue) {
  await flushRunDiagnosticsSafely(run, queue);
  await updateRuntime({
    state: run.state,
    status: run.status || run.state,
    ...runSummary(run, queue),
    error: run.error?.message || null
  });
  if (shouldKeepAuditMonitor(run, queue)) startAuditMonitor();
  else stopAuditMonitor();
}

async function waitTabReady(tabId, timeout = 60000) {
  const start = Date.now();
  let fallbackInjected = false;
  let completeSince = 0;
  while (Date.now() - start < timeout) {
    // Manifest content scripts normally answer as soon as document_idle runs.
    // Probe with a short deadline: a loading background tab must never impose
    // a multi-second transport wait on the preparation of other tabs.
    const pong = await sendTabMessage(tabId, { type: 'PING' }, 750).catch(() => null);
    if (pong?.ok && pong.value?.ready) return pong.value;

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Рабочая вкладка была закрыта до подготовки');
    if (tab.status === 'complete') {
      if (!completeSince) completeSince = Date.now();
      // Give the manifest listener a brief chance to mount naturally. Only
      // then use scripting.executeScript as a recovery fallback.
      if (!fallbackInjected && Date.now() - completeSince >= 300) {
        fallbackInjected = await ensureAutomationScripts(tabId).catch(() => false);
      }
    }
    await sleep(150);
  }
  throw new Error('ChatGPT content script did not become ready');
}

async function ensureAutomationScripts(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (tab.status && tab.status !== 'complete')) return false;
  await markTabAsAutomation(tabId);
  const [current] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      ready: Boolean(window.WatchChatGPTAdapter && window.WatchSelectorResolver),
      supportsBatchUpload: typeof window.WatchChatGPTAdapter?.uploadFiles === 'function'
    })
  });
  if (current?.result?.ready === true && current.result.supportsBatchUpload === true) return true;
  if (current?.result?.ready === true && current.result.supportsBatchUpload !== true) {
    // A tab from a previous unpacked-extension build can answer PING while
    // still exposing the old adapter. Reload it before using the new batch
    // upload path; injecting a second listener stack would duplicate events.
    await chrome.tabs.reload(tabId);
    return false;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: AUTOMATION_CONTENT_SCRIPT_FILES
  });
  return true;
}

async function reloadTabForRecovery(tabId, slotId, {
  force = false, leaseId = null, entryId = null, conversationUrl = null
} = {}) {
  const beforeReload = await getStored();
  const automationWindowId = Number(beforeReload.run?.automationWindowId || 0);
  const marked = await withStateLock(async () => {
    const stored = await getStored();
    const slot = stored.run?.slots?.[slotId];
    if (!stored.run || slot?.tabId !== tabId
      || (entryId && slot.entryId !== entryId)
      || (leaseId && String(slot.leaseId || '') !== String(leaseId))) return false;
    slot.status = 'RECOVERING';
    slot.lastActivityAt = new Date().toISOString();
    stored.run.currentAction = `Переподключаю вкладку ${Number(slotId) + 1}`;
    stored.run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(stored.run, stored.queue);
    await publishRun(stored.run, stored.queue);
    return true;
  });
  if (!marked) return { skipped: true, staleLease: true };
  // Content scripts from the previous unpacked-extension version stay alive
  // in already-open tabs. A real reload injects the current script again and
  // also restores the chat from ChatGPT's conversation URL.
  const tab = await chrome.tabs.get(tabId);
  if (automationWindowId && Number(tab.windowId) !== automationWindowId) {
    throw new Error('Рабочая вкладка находится вне окна автоматизации');
  }
  const safeConversationUrl = normalizeChatConversationUrl(conversationUrl);
  if (safeConversationUrl && normalizeChatConversationUrl(tab.url || tab.pendingUrl) !== safeConversationUrl) {
    const latest = await getStored();
    const liveSlot = latest.run?.slots?.[slotId];
    if (latest.run?.operationId !== beforeReload.run?.operationId
      || liveSlot?.tabId !== tabId
      || (leaseId && String(liveSlot.leaseId || '') !== String(leaseId))) return { skipped: true, staleLease: true };
    await chrome.tabs.update(tabId, { url: safeConversationUrl });
    await waitTabReady(tabId, 60000);
    return { reloaded: true, navigatedToConversation: true };
  }
  if (!/^https:\/\/chatgpt\.com\//i.test(tab.url || '')) throw new Error('Рабочая вкладка больше не ведёт в ChatGPT');
  const slotContext = beforeReload.run?.slots?.[slotId];
  await markTabAsAutomation(tabId, slotContext?.entryId ? {
    operationId: beforeReload.run.operationId,
    slotId,
    entryId: slotContext.entryId
  } : null);
  // After a browser restart the current content scripts may already be alive.
  // Reuse them when possible; a forced reload is only the fallback for stale
  // scripts left behind by an unpacked-extension update.
  const ping = await sendTabMessage(tabId, { type: 'PING' }, 5000).catch(() => null);
  if (ping?.ok && !force) return;
  const latest = await getStored();
  const liveSlot = latest.run?.slots?.[slotId];
  if (latest.run?.operationId !== beforeReload.run?.operationId
    || liveSlot?.tabId !== tabId
    || (leaseId && String(liveSlot.leaseId || '') !== String(leaseId))) return { skipped: true, staleLease: true };
  await chrome.tabs.reload(tabId);
  await waitTabReady(tabId, 60000);
  return { reloaded: true };
}

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function sha256Blob(blob) {
  if (!blob || !crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestInputFile(sourceKey, { allowMissing = false } = {}) {
  // Shared references are identical for every worker. Decode/base64-encode a
  // source only once per run; six workers must not repeat the same multi-MB
  // IndexedDB -> ArrayBuffer -> base64 conversion six times.
  if (inputFilePromiseCache.has(sourceKey)) {
    const cached = await inputFilePromiseCache.get(sourceKey);
    if (!cached && !allowMissing) throw new Error(`Файл недоступен: ${sourceKey}. Выбери папки заново.`);
    return cached;
  }
  const promise = (async () => {
    const asset = await getAsset(sourceKey);
    if (!asset?.blob) return null;
    const type = String(asset.type || asset.blob.type || 'image/png');
    const buffer = await asset.blob.arrayBuffer();
    return {
      name: asset.name || 'input.png',
      type,
      size: Number(asset.size || asset.blob.size || 0),
      dataUrl: `data:${type};base64,${base64FromArrayBuffer(buffer)}`
    };
  })();
  inputFilePromiseCache.set(sourceKey, promise);
  try {
    const file = await promise;
    if (!file && !allowMissing) throw new Error(`Файл недоступен: ${sourceKey}. Выбери папки заново.`);
    return file;
  } catch (error) {
    inputFilePromiseCache.delete(sourceKey);
    throw error;
  }
}

async function requestInputFileFromCandidates(sourceKeys) {
  for (const sourceKey of sourceKeys) {
    const file = await requestInputFile(sourceKey, { allowMissing: true });
    if (file) return { file, sourceKey };
  }
  throw new Error(`Файл недоступен: ${sourceKeys.join(' или ')}. Выбери папку референсов заново.`);
}

async function runPreflight({ selectedIds = [], queueMode = null, partNumber = null, validateLaunchSelection = true } = {}) {
  const stored = await getStored();
  const job = stored.job || {};
  const queue = stored.queue || {};
  const inputPlan = buildInputPlan(job.inputMode);
  const requested = new Set((Array.isArray(selectedIds) ? selectedIds : [])
    .map((value) => String(value || '').trim()).filter(Boolean));
  const rawFilter = job.filters || parseFilterSelectionId(job.queueGroup) || filterFromQueueGroup(job.queueGroup);
  const filter = normalizeWatchFilter(rawFilter);
  const groupId = groupIdForWatchFilter(filter);
  const rawQueueMode = queueMode == null ? String(job.runQueueMode || '') : String(queueMode || '');
  const runQueueMode = rawQueueMode === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular';
  const selectedPartNumber = partNumber == null ? Number(job.runPart || 0) : Number(partNumber || 0);
  const filterIsExact = ['in_sale', 'not_in_sale'].includes(String(rawFilter?.saleStatus || ''))
    && ['good', 'bad'].includes(String(rawFilter?.quality || ''))
    && WATCH_BRAND_FILTERS.some((item) => item.id === String(rawFilter?.brand || '') && item.id !== 'all');
  const queueModeIsExact = ['regular', REGENERATION_QUEUE_ID].includes(rawQueueMode);
  const requestedRunLimit = Number(job.runLimit);
  const runLimitIsExact = Number.isSafeInteger(requestedRunLimit)
    && requestedRunLimit >= 1
    && requestedRunLimit <= RUN_PART_SIZE;
  const allEntries = [...new Map(QUEUE_GROUP_IDS.flatMap((id) => groupEntries(queue, id))
    .map((entry) => [entry.sourceId, entry])).values()];
  const filteredEntries = groupEntries(queue, groupId);
  const repairIds = new Set(normalizedRepairQueue(queue)
    .filter((item) => item.status !== 'completed')
    .map((item) => item.sourceId));
  const partitionUniverse = runQueueMode === REGENERATION_QUEUE_ID
    ? filteredEntries.filter((entry) => repairIds.has(String(entry.sourceId)))
    : filteredEntries;
  const partitionContext = `${runQueueMode}|${filter.saleStatus}|${filter.quality}|${filter.brand}`;
  const partPlan = queuePartPlan(partitionUniverse, RUN_PART_SIZE, partitionContext);
  const selectedPart = partPlan.parts.find((part) => part.partNumber === selectedPartNumber) || null;
  const partSelectionIsExact = Number.isSafeInteger(selectedPartNumber)
    && selectedPartNumber > 0
    && Boolean(selectedPart)
    && String(job.runPartSignature || '') === partPlan.signature;
  const launchSelectionIsValid = validateLaunchSelection === true
    ? (filterIsExact && queueModeIsExact && partSelectionIsExact && runLimitIsExact)
    : (partNumber == null || partSelectionIsExact);
  const usePart = validateLaunchSelection === true || partNumber != null;
  const pool = usePart
    ? (selectedPart?.entries || [])
    : (requested.size ? allEntries : filteredEntries);
  const scopeEntries = pool.filter((entry) => {
    const sourceId = String(entry.sourceId || '');
    if (requested.size && !requested.has(sourceId)) return false;
    if (runQueueMode === REGENERATION_QUEUE_ID) {
      if (!repairIds.has(sourceId)) return false;
      return !validateLaunchSelection || requested.size > 0 || entry.status !== 'running';
    }
    if (repairIds.has(sourceId)) return false;
    return !validateLaunchSelection || entry.status !== 'running';
  });

  const recipeHashes = new Map();
  for (const entry of scopeEntries) {
    try {
      recipeHashes.set(entry.sourceId, await computeEntryRecipeHash(job, queue, entry));
    } catch (_) {
      recipeHashes.set(entry.sourceId, null);
    }
  }
  const selectedEntries = scopeEntries.filter((entry) => {
    if (runQueueMode === REGENERATION_QUEUE_ID) return requested.size > 0 || entry.status !== 'running';
    if (entry.status !== 'done') return true;
    const expected = recipeHashes.get(entry.sourceId);
    // Older builds failed to persist entry.recipeHash after a successful
    // generation. A missing hash must not make the same first N products
    // regenerate forever. startOrResumeRun backfills the current recipe once.
    return Boolean(expected && entry.recipeHash && entry.recipeHash !== expected);
  });

  const referenceKeys = new Set(await getAssetKeys('ref:').catch(() => []));
  const watchKeys = new Set(await getAssetKeys('watch:').catch(() => []));
  const checks = [];
  const add = (id, label, ok, blocking = true, details = '') => checks.push({ id, label, ok: Boolean(ok), blocking, details });
  add(
    'launch-selection',
    'Очередь, фильтры и часть выбраны точно',
    launchSelectionIsValid,
    true,
    validateLaunchSelection !== true && partNumber == null
      ? 'продолжение ранее сохранённого прогона'
      : `очередь ${queueModeIsExact ? runQueueMode : 'не выбрана'} · ${filterIsExact ? watchFilterLabel(filter) : 'точная категория и бренд обязательны'} · часть ${selectedPartNumber || 'не выбрана'} из ${partPlan.partCount || 0} · фото за запуск ${runLimitIsExact ? requestedRunLimit : 'укажи 1–100'}`
  );
  const promptText = String(job.prompt || '');
  add('prompt', 'Промпт загружен', Boolean(promptText.trim()), true, 'Base Prompt v5.txt');
  add(
    'prompt-format',
    'Промпт поддерживает динамические референсы',
    /\{\{REF_TEMPLATE\}\}/.test(promptText) && /\{\{REF_WATCH\}\}/.test(promptText),
    true,
    `режим ${inputPlan.mode}: ${inputPlan.roles.join(' + ')}`
  );
  add('queue', 'Очередь содержит модели', Boolean(queue.groups && selectedEntries.length), true, `${selectedEntries.length} кандидатов`);

  const missingBrands = [];
  const checkedProfiles = new Set();
  for (const entry of scopeEntries) {
    const profile = detectBrandProfile(entry.modelName);
    if (!checkedProfiles.has(profile)) {
      checkedProfiles.add(profile);
      const missingRoles = inputPlan.roles
        .filter((role) => role !== 'watchReference')
        .filter((role) => !referenceCandidatesForRole(role, profile)
          .some((storageKey) => referenceKeys.has(`ref:${storageKey}`)));
      const refsOk = missingRoles.length === 0;
      if (!refsOk) missingBrands.push(profile);
      add(
        `refs:${profile}`,
        `Референсы ${profile}`,
        refsOk,
        true,
        refsOk ? `${inputPlan.count} входа: готово` : `нет: ${missingRoles.join(', ')}`
      );
    }
    const inputSourceId = String(entry.inputSourceId || entry.sourceVariantId || entry.sourceId);
    add(`watch:${entry.sourceId}`, `Фото ${entry.fileName}`, watchKeys.has(`watch:${inputSourceId}`), true, inputSourceId);
  }

  let watcherOk = false;
  try {
    const response = await fetchWithTimeout('http://127.0.0.1:17321/health', {}, 1500);
    watcherOk = response.ok;
  } catch (_) {}
  add('watcher', 'Файловый watcher', watcherOk, false, watcherOk ? 'онлайн' : 'офлайн: проверка PNG будет локальной/по Downloads API');

  const outputAccess = await outputDirectoryAccess().catch(() => ({ config: { mode: 'downloads' }, handle: null, permission: 'unknown' }));
  if (outputAccess.config.mode === 'custom') {
    add(
      'output-directory',
      'Папка результатов доступна для записи',
      Boolean(outputAccess.handle && outputAccess.permission === 'granted'),
      true,
      outputAccess.handle
        ? `${outputAccess.handle.name}: ${outputAccess.permission}`
        : 'выбери папку результатов заново'
    );
  } else {
    add('output-directory', 'Папка результатов: Downloads', true, false, 'Downloads/WatchAutomation');
  }

  const result = {
    checkedAt: new Date().toISOString(),
    filter,
    groupId,
    runQueueMode,
    runPart: selectedPartNumber || null,
    runPartCount: partPlan.partCount,
    runPartSize: partPlan.partSize,
    runPartSignature: partPlan.signature,
    partCandidates: selectedPart?.count || 0,
    queueCandidates: partPlan.total,
    inputMode: inputPlan.mode,
    inputRoles: [...inputPlan.roles],
    selectedIds: [...requested],
    candidates: selectedEntries.length,
    checks,
    missingBrands,
    recipeHash: stableHash({
      pipelineVersion: PROMPT_PIPELINE_VERSION,
      inputMode: inputPlan.mode,
      prompt: job.prompt || '',
      filter,
      selected: selectedEntries.map((entry) => ({
        sourceId: entry.sourceId,
        recipeHash: recipeHashes.get(entry.sourceId) || null
      }))
    }),
    ok: checks.filter((check) => check.blocking).every((check) => check.ok)
  };
  await chrome.storage.local.set({ lastPreflight: result });
  try { await chrome.runtime.sendMessage({ type: 'RUNTIME_UPDATED' }); } catch (_) {}
  return result;
}

async function importLocalReferences() {
  const current = await getStored();
  if (current.run && ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(current.run.state) && hasLiveSlotWork(current.run)) {
    throw new Error('Нельзя обновлять референсы во время активных генераций');
  }
  const indexResponse = await fetch(`${DEV_LOCAL_INPUT_FILES_URL}?kind=references`, { cache: 'no-store' });
  if (!indexResponse.ok) throw new Error(`Локальные референсы недоступны (HTTP ${indexResponse.status})`);
  const index = await indexResponse.json();
  const descriptors = new Map();
  for (const item of Array.isArray(index.files) ? index.files : []) {
    const descriptor = referenceDescriptorForPath(item.path);
    if (descriptor) descriptors.set(descriptor.storageKey, { ...item, descriptor });
  }
  if (!descriptors.size) throw new Error('В локальной папке не найдено распознаваемых референсов');
  const assets = [];
  for (const item of descriptors.values()) {
    const response = await fetch(`${DEV_LOCAL_INPUT_FILE_URL}?path=${encodeURIComponent(item.path)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Не удалось прочитать референс ${item.path} (HTTP ${response.status})`);
    const blob = await response.blob();
    const file = new File([blob], item.name, {
      type: response.headers.get('content-type') || blob.type || 'image/png',
      lastModified: Number(item.lastModified || Date.now())
    });
    assets.push({
      key: `ref:${item.descriptor.storageKey}`,
      file,
      relativePath: item.path
    });
  }
  await replaceAssets('ref:', assets);
  const stored = await getStored();
  const savedSelections = await chrome.storage.local.get('folderSelections');
  const queue = stored.queue || {
    version: 1,
    groups: Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => [groupId, []])),
    refs: {}
  };
  const importedReferenceEntries = [];
  for (const asset of assets) {
    importedReferenceEntries.push([asset.key.slice('ref:'.length), {
      name: asset.file.name,
      size: asset.file.size,
      lastModified: Number(asset.file.lastModified || 0),
      fingerprint: `${asset.file.size}:${asset.file.lastModified}:${asset.file.name}`,
      contentHash: await sha256Blob(asset.file),
      relativePath: asset.relativePath
    }]);
  }
  queue.refs = Object.fromEntries(importedReferenceEntries);
  const folderSelections = {
    ...(savedSelections.folderSelections || {}),
    references: {
      pathHint: 'WatchesScript/input-ref-images',
      fileCount: assets.length,
      savedAt: new Date().toISOString(),
      source: 'dev-local-import'
    }
  };
  await chrome.storage.local.set({ queue, folderSelections });
  await appendLog('Локальные брендовые референсы импортированы', {
    count: assets.length,
    keys: assets.map((asset) => asset.key.slice('ref:'.length))
  });
  try { await chrome.runtime.sendMessage({ type: 'RUNTIME_UPDATED' }); } catch (_) {}
  return { count: assets.length, keys: assets.map((asset) => asset.key.slice('ref:'.length)) };
}

const brandPromptCache = new Map();

async function loadBrandPrompt(modelName) {
  const promptPath = brandPromptPath(detectBrandProfile(modelName));
  if (!brandPromptCache.has(promptPath)) {
    const pending = fetch(chrome.runtime.getURL(promptPath), { cache: 'no-store' })
      .then((response) => response.ok ? response.text() : '')
      .catch(() => '');
    brandPromptCache.set(promptPath, pending);
  }
  return brandPromptCache.get(promptPath);
}

async function computeEntryRecipeHash(job, queue, entry, brandPromptOverride = null) {
  const inputPlan = buildInputPlan(job?.inputMode);
  const profileId = detectBrandProfile(entry?.modelName || entry?.fileName || '');
  const brandPrompt = brandPromptOverride == null
    ? await loadBrandPrompt(entry?.modelName || entry?.fileName || '')
    : String(brandPromptOverride || '');
  const renderedPrompt = buildGenerationPrompt(
    job?.prompt || '',
    entry?.modelName || entry?.fileName || '',
    brandPrompt,
    { inputPlan }
  );
  const references = inputPlan.roles
    .filter((role) => role !== 'watchReference')
    .map((role) => referenceRecipeDescriptor(queue, role, profileId));
  return stableHash({
    pipelineVersion: PROMPT_PIPELINE_VERSION,
    inputMode: inputPlan.mode,
    profileId,
    profileVersion: stableHash(brandPrompt || 'generic'),
    renderedPrompt,
    references,
    watch: {
      sourceId: entry?.sourceId || null,
      fingerprint: entry?.contentHash || entry?.fingerprint || entry?.sourceFingerprint || null,
      fileName: entry?.fileName || null
    }
  });
}

async function sendTabMessage(tabId, message, timeout = TAB_MESSAGE_TIMEOUT_MS) {
  let timeoutId;
  const request = chrome.tabs.sendMessage(tabId, message);
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Таймаут ответа вкладки (${timeout}ms)`)), timeout);
  });
  let response;
  try {
    response = await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
  return response;
}

async function sendToTab(tabId, message, timeout = TAB_MESSAGE_TIMEOUT_MS) {
  const response = await sendTabMessage(tabId, message, timeout);
  if (!response?.ok) throw new Error(response?.error?.message || response?.error || 'Ответ страницы неуспешен');
  return response.value;
}

async function saveRunAndQueue(run, queue, history = undefined, generationMemory = undefined) {
  if (run) syncRunClock(run, Date.now());
  for (const groupId of QUEUE_GROUP_IDS) {
    for (const entry of queue?.groups?.[groupId] || []) {
      const variantId = String(entry.inputSourceId || entry.sourceVariantId || '');
      const variant = (entry.variants || []).find((item) => String(item.sourceVariantId || item.variantId || '') === variantId);
      if (!variant) continue;
      for (const key of [
        'status', 'generationId', 'previousGenerationId', 'generatedAt', 'outputPath', 'outputHash',
        'outputWidth', 'outputHeight', 'verificationMode', 'recipeHash', 'profileId', 'profileVersion',
        'attempt', 'retryCount', 'lastError', 'errorClass', 'nextRetryAt', 'factsStatus', 'chatUrl'
      ]) {
        if (Object.hasOwn(entry, key)) variant[key] = entry[key];
      }
    }
  }
  const value = { run, queue };
  if (history !== undefined) value.history = history;
  if (generationMemory !== undefined) value.generationMemory = generationMemory;
  queueRunDiagnostics(run, queue);
  await chrome.storage.local.set(value);
}

function normalizedDownloadPath(value) {
  return String(value || '').replaceAll('\\', '/').toLowerCase();
}


function normalizeOutputDestination(value = {}) {
  return {
    mode: value?.mode === 'custom' ? 'custom' : 'downloads',
    folderName: value?.folderName || null,
    permission: value?.permission || 'unknown'
  };
}

async function getOutputDestination() {
  const stored = await chrome.storage.local.get('outputDestination');
  return normalizeOutputDestination(stored.outputDestination || {});
}

async function outputDirectoryAccess() {
  const config = await getOutputDestination();
  if (config.mode !== 'custom') return { config, handle: null, permission: 'not-needed' };
  const handle = await getOutputDirectoryHandle().catch(() => null);
  if (!handle) return { config, handle: null, permission: 'missing' };
  let permission = 'unknown';
  try {
    permission = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
  } catch (_) {}
  return { config: { ...config, folderName: handle.name || config.folderName }, handle, permission };
}

function hexFromBytes(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function verifyPngBlob(blob) {
  if (!(blob instanceof Blob) || blob.size <= 0) return { valid: false, verified: true, reason: 'empty_blob' };
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) {
    return { valid: false, verified: true, reason: 'not_png', bytes: bytes.length };
  }
  const view = new DataView(buffer);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!width || !height || width < 512 || height < 512) {
    return { valid: false, verified: true, reason: `image_too_small:${width}x${height}`, width, height, bytes: bytes.length };
  }
  const warnings = [];
  const ratio = width / height;
  if (Math.abs(ratio - 0.75) > 0.035) warnings.push(`aspect_ratio:${ratio.toFixed(4)} (ожидается около 3:4)`);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return {
    valid: true,
    verified: true,
    verificationMode: 'file-system-access',
    width,
    height,
    bytes: bytes.length,
    sha256: hexFromBytes(new Uint8Array(hash)),
    qualityWarnings: warnings
  };
}

async function blobFromGeneratedPayload(dataUrl, url) {
  const source = typeof dataUrl === 'string' && /^data:image\/png;base64,/i.test(dataUrl)
    ? dataUrl
    : String(url || '');
  if (!source) throw new Error('У изображения отсутствует URL для сохранения');
  const response = await fetch(source, { cache: 'no-store' });
  if (!response.ok && !source.startsWith('data:')) throw new Error(`Не удалось получить изображение: HTTP ${response.status}`);
  return response.blob();
}

async function writeGeneratedToCustomDirectory(entry, blob) {
  const access = await outputDirectoryAccess();
  if (access.config.mode !== 'custom') return null;
  if (!access.handle || access.permission !== 'granted') {
    const error = new Error('Нет разрешения на запись в выбранную папку результатов');
    error.code = 'OUTPUT_DIRECTORY_PERMISSION';
    throw error;
  }
  const verification = await verifyPngBlob(blob);
  if (!verification.valid) throw new Error(`PNG не прошёл проверку перед записью: ${verification.reason || 'invalid'}`);
  const groupName = sanitizeFilename(entry.groupId || 'results');
  const fileName = sanitizeFilename(entry.outputFileName);
  const groupHandle = await access.handle.getDirectoryHandle(groupName, { create: true });
  try {
    await groupHandle.getFileHandle(fileName, { create: false });
    throw new Error(`Путь ревизии уже занят: ${fileName}`);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
  const fileHandle = await groupHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  const written = await fileHandle.getFile();
  if (Number(written.size || 0) !== Number(blob.size || 0)) throw new Error('Размер записанного файла не совпадает с исходным PNG');
  return {
    outputPath: `custom://${access.handle.name}/${groupName}/${fileName}`,
    verification: { ...verification, filename: fileName, folderName: access.handle.name },
    folderName: access.handle.name,
    groupName,
    fileName,
  };
}


async function permissionForDirectoryHandle(handle, mode = 'readwrite') {
  if (!handle) return 'missing';
  try {
    return handle.queryPermission ? await handle.queryPermission({ mode }) : 'granted';
  } catch (_) {
    return 'unknown';
  }
}

async function artifactDirectoryHandles(record = null) {
  const customOutput = String(record?.outputPath || '').startsWith('custom://')
    || String(record?.artifactMode || '').toLowerCase() === 'custom';
  if (!customOutput) return [];
  const outputHandle = await getOutputDirectoryHandle().catch(() => null);
  return outputHandle ? [outputHandle] : [];
}

async function deleteArtifactFromDirectoryHandle(handle, groupId, outputFileName) {
  if (!handle) return false;
  const permission = await permissionForDirectoryHandle(handle, 'readwrite');
  if (permission !== 'granted') return false;
  const groupName = sanitizeFilename(groupId || 'results');
  const fileName = sanitizeFilename(outputFileName || '');
  if (!fileName) return false;
  try {
    const groupHandle = await handle.getDirectoryHandle(groupName, { create: false });
    await groupHandle.removeEntry(fileName);
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    throw error;
  }
}

async function deleteArtifactFromDownloads(record) {
  const expectedFileName = sanitizeFilename(record?.outputFileName || '');
  const expectedGroup = sanitizeFilename(record?.groupId || 'results');
  if (!expectedFileName) return { deleted: false, mode: 'downloads', reason: 'missing_filename' };
  let candidates = [];
  if (record?.downloadId != null) {
    const exact = await chrome.downloads.search({ id: Number(record.downloadId) }).catch(() => []);
    candidates.push(...exact);
  }
  if (!candidates.length) {
    const items = await chrome.downloads.search({ query: [expectedFileName], limit: 5000 }).catch(() => []);
    const suffix = normalizedDownloadPath(`WatchAutomation/${expectedGroup}/${expectedFileName}`);
    candidates = items.filter((item) => {
      const filename = normalizedDownloadPath(item?.filename || '');
      return filename.endsWith(suffix) || filename.endsWith(`/${normalizedDownloadPath(expectedFileName)}`);
    });
  }
  let deleted = false;
  for (const item of candidates) {
    try {
      if (chrome.downloads.removeFile) {
        await chrome.downloads.removeFile(Number(item.id));
        deleted = true;
      }
    } catch (_) {}
    try {
      if (chrome.downloads.erase) await chrome.downloads.erase({ id: Number(item.id) });
    } catch (_) {}
  }
  return { deleted, mode: 'downloads', count: candidates.length };
}

async function archiveOutputRevisionViaWatcher(record) {
  const outputPath = String(record?.outputPath || '').trim();
  if (!outputPath || !/watchautomation/i.test(outputPath)) {
    return { archived: 0, error: 'missing_revision_path' };
  }
  const expectedHash = String(record?.outputHash || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return { archived: 0, error: 'Некорректный SHA-256 ревизии; архивирование отменено.' };
  }
  try {
    const response = await fetchWithTimeout(OUTPUT_ARCHIVE_REVISION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: outputPath,
        expectedHash,
        archiveGroupId: record?.groupId || null
      })
    }, 6000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const watcherOutdated = response.status === 404
        || (response.status === 409 && /Для архивации ревизии нужен SHA-256 PNG/i.test(String(payload?.error || '')));
      return {
        archived: 0,
        error: watcherOutdated
          ? 'Локальный watcher не обновлён. Перезапусти START_AUTOGENERATION, затем повтори действие «Брак».'
          : (payload?.error || `http_${response.status}`)
      };
    }
    return {
      archived: Number(payload?.archived || 0),
      alreadyArchived: payload?.alreadyArchived === true,
      missing: payload?.missing === true,
      outputHash: payload?.outputHash || null,
      files: payload?.files || []
    };
  } catch (error) {
    return { archived: 0, error: error?.message || String(error) };
  }
}

async function archiveCustomOutputRevision(record) {
  const outputPath = String(record?.outputPath || '').trim();
  const expectedHash = String(record?.outputHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    return { archived: 0, mode: 'custom', error: 'У ревизии отсутствует проверенный SHA-256; архивирование отменено.' };
  }
  const parts = outputPath.replace(/^custom:\/\//i, '').split('/').filter(Boolean);
  if (!/^custom:\/\//i.test(outputPath) || parts.length < 3) {
    return { archived: 0, mode: 'custom', error: 'invalid_revision_path' };
  }
  const [folderName, ...relativeParts] = parts;
  if (relativeParts[0] === '_archive') {
    return { archived: 1, alreadyArchived: true, mode: 'custom', files: [{ from: outputPath, to: outputPath }] };
  }
  if (relativeParts.length !== 2) return { archived: 0, mode: 'custom', error: 'invalid_revision_path' };
  const [groupName, fileName] = relativeParts;
  const handle = await getOutputDirectoryHandle().catch(() => null);
  if (!handle || String(handle.name || '') !== folderName
    || await permissionForDirectoryHandle(handle, 'readwrite') !== 'granted') {
    return { archived: 0, mode: 'custom', error: 'custom_output_unavailable' };
  }
  try {
    const group = await handle.getDirectoryHandle(groupName, { create: false });
    const sourceHandle = await group.getFileHandle(fileName, { create: false });
    const sourceFile = await sourceHandle.getFile();
    const verification = await verifyPngBlob(sourceFile);
    if (!verification.valid || !verification.sha256) {
      return { archived: 0, mode: 'custom', error: 'Не удалось проверить PNG перед архивированием.' };
    }
    if (verification.sha256.toLowerCase() !== expectedHash) {
      return { archived: 0, mode: 'custom', error: 'PNG на диске уже относится к другой генерации; архивирование отменено.' };
    }
    const archiveRoot = await handle.getDirectoryHandle('_archive', { create: true });
    const archiveGroup = await archiveRoot.getDirectoryHandle(groupName, { create: true });
    const stamp = new Date(sourceFile.lastModified || Date.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
    let archivedName = `${stamp}__${fileName}`;
    let serial = 1;
    while (true) {
      try {
        await archiveGroup.getFileHandle(archivedName, { create: false });
        archivedName = `${stamp}-${serial}__${fileName}`;
        serial += 1;
      } catch (error) {
        if (error?.name === 'NotFoundError') break;
        throw error;
      }
    }
    const targetHandle = await archiveGroup.getFileHandle(archivedName, { create: true });
    const writable = await targetHandle.createWritable();
    await writable.write(sourceFile);
    await writable.close();
    const currentSourceFile = await sourceHandle.getFile();
    const currentVerification = await verifyPngBlob(currentSourceFile);
    if (!currentVerification.valid || currentVerification.sha256.toLowerCase() !== expectedHash) {
      await archiveGroup.removeEntry(archivedName).catch(() => {});
      return { archived: 0, mode: 'custom', error: 'PNG изменился во время архивации; исходник оставлен на месте.' };
    }
    await group.removeEntry(fileName);
    const to = `custom://${folderName}/_archive/${groupName}/${archivedName}`;
    return { archived: 1, mode: 'custom', outputHash: verification.sha256, files: [{ from: outputPath, to }] };
  } catch (error) {
    if (error?.name === 'NotFoundError') return { archived: 0, missing: true, mode: 'custom', files: [] };
    throw error;
  }
}

async function deleteArtifactViaWatcher(record) {
  const outputPath = String(record?.outputPath || '').trim();
  if (!outputPath || !/watchautomation/i.test(outputPath)) {
    return { deleted: false, mode: 'watcher', reason: 'missing_path' };
  }
  try {
    const response = await fetchWithTimeout(OUTPUT_DELETE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outputPath })
    }, 6000);
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload?.deleted) {
      return { deleted: true, mode: 'watcher', path: payload.path || outputPath };
    }
    return { deleted: false, mode: 'watcher', reason: payload?.error || `http_${response.status}` };
  } catch (error) {
    return { deleted: false, mode: 'watcher', reason: error?.message || String(error) };
  }
}

async function deleteGenerationArtifact(record) {
  if (String(record?.artifactMode || '').toLowerCase() === 'watcher') {
    const watcherDeletion = await deleteArtifactViaWatcher(record);
    if (watcherDeletion.deleted) return watcherDeletion;
  }
  const handles = await artifactDirectoryHandles(record);
  for (const handle of handles) {
    try {
      const deleted = await deleteArtifactFromDirectoryHandle(handle, record?.groupId, record?.outputFileName);
      if (deleted) return { deleted: true, mode: 'file-system-access', rootName: handle.name || null };
    } catch (error) {
      await appendLog('Галерея: ошибка удаления через File System Access', {
        sourceId: record?.sourceId || null,
        rootName: handle?.name || null,
        error: error?.message || String(error)
      });
    }
  }
  return deleteArtifactFromDownloads(record);
}

async function reviewGeneration(sourceId, decision, artifact = {}) {
  const normalizedDecision = String(decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(normalizedDecision)) throw new Error('Неизвестное решение проверки');
  return withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    const requestedSourceId = String(sourceId || '').trim();
    let queue = stored.queue || { groups: {} };
    let history = normalizeHistory(stored.history);
    let generationMemory = normalizeGenerationMemory(stored.generationMemory);

    // A filename is presentation metadata, never an identity key. Gallery
    // review must resolve through its SKU and immutable generationId only.
    const entry = requestedSourceId ? findQueueEntry(queue, requestedSourceId) : null;

    const sourceKey = entry?.sourceId || requestedSourceId;
    if (!sourceKey) throw new Error('Модель не указана');
    if (artifact?.sourceId && String(artifact.sourceId) !== sourceKey) {
      throw new Error('Галерея связала эту генерацию с другой моделью');
    }
    const activeSlot = Object.values(run?.slots || {}).find((slot) => slot?.entryId === sourceKey && !['IDLE', 'DONE', 'STOPPED'].includes(String(slot?.status || '').toUpperCase()));
    const activePostprocessOwner = Object.values(run?.postprocessTabs || {})
      .find((owner) => owner?.entryId === sourceKey) || null;
    const sourceRunInProgress = Boolean(activeSlot || activePostprocessOwner);
    const memoryRecord = generationMemory.items[sourceKey] || null;
    const baseRecord = memoryRecord || (entry ? generationMemoryRecordFromEntry(entry) : null) || {};
    const knownGenerationId = String(artifact?.generationId || memoryRecord?.generationId || entry?.generationId || '').trim();
    const rejectedGenerationId = knownGenerationId || (normalizedDecision === 'reject'
      ? generationId(sourceKey, `legacy-reject-${stableHash({
        outputPath: artifact?.outputPath || baseRecord.outputPath || entry?.outputPath || null,
        outputHash: artifact?.outputHash || baseRecord.outputHash || entry?.outputHash || null,
        generatedAt: baseRecord.generatedAt || entry?.generatedAt || null
      })}`)
      : null);
    const latestProjectionGenerationId = memoryRecord?.generationId || entry?.generationId || null;
    const runningGenerationId = activeSlot?.generationId || activePostprocessOwner?.generationId || null;
    const targetOwnsProjection = runningGenerationId
      ? runningGenerationId === rejectedGenerationId
      : Boolean(!rejectedGenerationId || !latestProjectionGenerationId || latestProjectionGenerationId === rejectedGenerationId);
    const targetRevision = rejectedGenerationId
      ? await getGenerationRevision(rejectedGenerationId).catch(() => null)
      : null;
    if (targetRevision?.sourceId && targetRevision.sourceId !== sourceKey) {
      throw new Error('Галерея связала эту генерацию с другой моделью');
    }
    if (normalizedDecision === 'reject') {
      if (!targetRevision) throw new Error('Для безопасной архивации нужна сохранённая ревизия; legacy-файл оставлен без изменений');
      if (!targetRevision.outputPath || !/^[a-f0-9]{64}$/i.test(String(targetRevision.outputHash || ''))) {
        throw new Error('У ревизии нет проверенной пары пути и SHA-256; архивирование отменено');
      }
      if (artifact?.generationId && String(artifact.generationId) !== String(targetRevision.generationId)) {
        throw new Error('Галерея отправила устаревшую ревизию; обнови список перед перегенерацией');
      }
      if (artifact?.outputPath && normalizedDownloadPath(artifact.outputPath) !== normalizedDownloadPath(targetRevision.outputPath)) {
        throw new Error('Путь PNG изменился после открытия галереи; архивирование отменено');
      }
      if (artifact?.outputHash && String(artifact.outputHash).toLowerCase() !== String(targetRevision.outputHash).toLowerCase()) {
        throw new Error('SHA-256 PNG не совпадает с ревизией; архивирование отменено');
      }
    }
    const record = {
      ...baseRecord,
      ...(targetRevision || {}),
      sourceId: sourceKey,
      generationId: rejectedGenerationId,
      groupId: targetRevision?.groupId || entry?.groupId || artifact?.groupId || baseRecord.groupId || null,
      outputFileName: targetRevision?.outputFileName || null,
      outputPath: targetRevision?.outputPath || null,
      outputHash: targetRevision?.outputHash || null,
      downloadId: targetRevision?.downloadId ?? null,
      artifactMode: targetRevision?.artifactMode || (String(targetRevision?.outputPath || '').startsWith('custom://') ? 'custom' : 'watcher'),
      modifiedAt: Number(artifact?.modifiedAt || 0) || null,
      bytes: Number(artifact?.bytes || 0) || null
    };
    if (!record.outputFileName) throw new Error('Не удалось определить PNG результата');

    const now = new Date().toISOString();
    let deletion = null;
    let archiveWarning = null;
    if (normalizedDecision === 'reject') {
      if (!record.outputPath) throw new Error('У этой ревизии не сохранён точный путь к PNG');
      deletion = String(record.outputPath).startsWith('custom://')
        ? await archiveCustomOutputRevision(record)
        : await archiveOutputRevisionViaWatcher(record);
      if (!Number(deletion?.archived || 0)) {
        archiveWarning = deletion?.error || (deletion?.missing === true
          ? 'PNG уже отсутствует в папке результатов'
          : 'PNG этой ревизии не найден');
      }
      const move = (deletion?.files || []).find((item) => normalizedDownloadPath(item?.from) === normalizedDownloadPath(record.outputPath)) || null;
      await rejectGenerationRevision(rejectedGenerationId, {
        reviewedAt: now,
        archivePath: move?.to || null,
        archiveHash: deletion?.outputHash || targetRevision.outputHash || null,
        archivedAt: move ? now : null,
        archiveReason: 'manual_reject',
        archiveMissing: deletion?.missing === true,
        archiveError: archiveWarning
      });
      const repairQueueItem = upsertRepairQueueItem(queue, sourceKey, rejectedGenerationId);

      if ((entry || memoryRecord) && targetOwnsProjection) {
        if (!sourceRunInProgress) {
          applyGenerationMemoryStatusChange(queue, history, generationMemory, sourceKey, GENERATION_MEMORY_STATUSES.NOT_READY, {
            statusSource: 'manual',
            lastError: 'Отклонено при визуальной проверке',
            errorClass: null,
            nextRetryAt: null
          });
          if (entry) {
            entry.outputHash = null;
            entry.outputWidth = null;
            entry.outputHeight = null;
            entry.verificationMode = null;
          }
          if (generationMemory.items[sourceKey]) {
            generationMemory.items[sourceKey].outputHash = null;
            generationMemory.items[sourceKey].outputWidth = null;
            generationMemory.items[sourceKey].outputHeight = null;
            generationMemory.items[sourceKey].verificationMode = null;
          }
        }
        if (generationMemory.items[sourceKey]) {
          generationMemory.items[sourceKey].reviewStatus = null;
          generationMemory.items[sourceKey].reviewedAt = now;
          generationMemory.items[sourceKey].reviewReason = 'manual_gallery_reject';
          generationMemory.items[sourceKey].factsStatus = null;
          generationMemory.items[sourceKey].factsUpdatedAt = null;
          generationMemory.items[sourceKey].factsError = null;
          generationMemory.items[sourceKey].factsWarnings = [];
        }
        if (entry) {
          entry.reviewStatus = null;
          entry.reviewedAt = now;
          entry.factsStatus = null;
          entry.factsUpdatedAt = null;
          entry.factsError = null;
          entry.factsWarnings = [];
        }
      }
      recordRunEvent(run, 'gallery_reject', {
        sourceId: sourceKey,
        generationId: rejectedGenerationId,
        repairQueuedAt: repairQueueItem.queuedAt,
        whileSourceRunning: sourceRunInProgress,
        deletionMode: deletion.mode || null,
        archiveWarning
      });
    } else {
      // Kept for backwards compatibility with older gallery builds. The new UI
      // no longer has a persistent "approved" state: a good file simply stays ready.
      if (generationMemory.items[sourceKey]) {
        generationMemory.items[sourceKey].reviewStatus = null;
        generationMemory.items[sourceKey].reviewedAt = null;
        generationMemory.items[sourceKey].reviewReason = null;
      }
      if (entry) {
        entry.reviewStatus = null;
        entry.reviewedAt = null;
      }
    }

    await saveRunAndQueue(run || null, queue, history, generationMemory);
    await appendLog(normalizedDecision === 'reject'
      ? 'Галерея: конкретная ревизия отправлена в архив и добавлена в очередь перегенерации брака'
      : 'Галерея: устаревшая отметка проверки очищена', {
      sourceId: sourceKey,
      generationId: rejectedGenerationId,
      decision: normalizedDecision,
      deletion
    });
    try { await chrome.runtime.sendMessage({ type: 'RUNTIME_UPDATED' }); } catch (_) {}
    return { sourceId: sourceKey, generationId: rejectedGenerationId, decision: normalizedDecision, deletion, archiveWarning };
  });
}

async function reconcileActiveDownloads() {
  const { run } = await getStored();
  if (!run || !['RUNNING', 'DRAINING', 'PAUSED'].includes(run.state)) return;
  for (const slot of Object.values(run.slots || {})) {
    if (!slot.downloadId) continue;
    if (slot.revisionPersistBlocked) continue;
    if (Number(slot.revisionPersistRetryAt || 0) > Date.now()) continue;
    let item;
    try {
      [item] = await chrome.downloads.search({ id: Number(slot.downloadId) });
    } catch (_) {
      continue;
    }
    if (!item) continue;
    if (item.state === 'complete') {
      await finishDownload(run.operationId, Number(slot.slotId), Number(slot.downloadId), item.filename || null);
    } else if (item.state === 'interrupted' || item.error) {
      await pauseRunOnError(
        run.operationId,
        new Error(`Ошибка скачивания: ${item.error || 'загрузка прервана'}`),
        { slotId: Number(slot.slotId), entryId: slot.entryId, downloadId: slot.downloadId }
      );
    }
  }
}

async function beginStalledBatchRecovery(operationId, candidate) {
  if (!operationId || !candidate || stalledBatchRecoveryRuns.has(operationId)) {
    return { skipped: true };
  }
  stalledBatchRecoveryRuns.add(operationId);
  try {
    let snapshot = await getStored();
    if (snapshot.run?.operationId !== operationId
      || !findStalledBatchRecoveryCandidate(snapshot.run, Date.now())) return { skipped: true };

    // A page may have rendered an image just before it stopped answering.
    // Trigger the normal download path first and wait for Chrome to settle it
    // before returning any still-incomplete source to the queue.
    await quickProbeReadyResultsBeforeReset(snapshot.run).catch(() => {});
    const downloadDeadline = Date.now() + 30000;
    while (Date.now() < downloadDeadline) {
      await reconcileActiveDownloads().catch(() => {});
      snapshot = await getStored();
      if (snapshot.run?.operationId !== operationId) return { skipped: true };
      const hasActiveDownload = Object.values(snapshot.run.slots || {}).some((slot) => slot.downloadId);
      if (!hasActiveDownload) break;
      await sleep(500);
    }
    snapshot = await getStored();
    if (snapshot.run?.operationId !== operationId) return { skipped: true };
    if (Object.values(snapshot.run.slots || {}).some((slot) => slot.downloadId)) {
      scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
      await appendLog('Перезапуск набора отложен: ожидаю завершения активного PNG', { operationId });
      return { deferred: true, downloadsPending: true };
    }

    const closeTabs = await captureStalledBatchTabTargets(snapshot.run);
    const referencedTabIds = [...new Set(Object.values(snapshot.run.slots || {})
      .map((slot) => Number(slot.tabId || 0))
      .filter((tabId) => tabId > 0))];
    if (closeTabs.length !== referencedTabIds.length) {
      await appendLog('Автоперезапуск отложен: рабочая вкладка изменила адрес, поэтому её оставляю открытой', {
        operationId,
        referencedTabIds
      });
      return { skipped: true, unsafeTabs: true };
    }

    const prepared = await withStateLock(async () => {
      const stored = await getStored();
      const run = stored.run;
      if (!run || run.operationId !== operationId) return { skipped: true };
      const currentCandidate = findStalledBatchRecoveryCandidate(run, Date.now());
      if (!currentCandidate) return { skipped: true };
      if (Object.values(run.slots || {}).some((slot) => slot.downloadId)) {
        return { deferred: true, downloadsPending: true };
      }
      const tabIds = new Set(closeTabs.map((item) => Number(item.tabId)));
      if (Object.values(run.slots || {}).some((slot) => Number(slot.tabId || 0) > 0
        && !tabIds.has(Number(slot.tabId)))) return { skipped: true, unsafeTabs: true };

      const history = normalizeHistory(stored.history);
      const generationMemory = normalizeGenerationMemory(stored.generationMemory);
      const entries = groupEntries(stored.queue, run.groupId);
      const plannedIds = Array.isArray(run.plannedIds) ? [...run.plannedIds] : [];
      const excludedFromCatalogReconcile = plannedIds.filter((entryId) => (
        entries.some((entry) => entry.sourceId === entryId && entry.status !== 'done')
      ));
      await reconcileRunVerifiedRevisions(run, stored.queue, history, generationMemory);
      await reconcilePersistedCurrentRevisions(stored.queue, history, generationMemory, {
        ...(run.filter || parseFilterSelectionId(run.groupId) || filterFromQueueGroup(run.groupId)),
        runQueueMode: run.groupId === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular',
        excludeSourceIds: excludedFromCatalogReconcile
      });

      const refreshedEntries = groupEntries(stored.queue, run.groupId);
      const returnedIds = plannedIds.filter((entryId) => {
        const entry = refreshedEntries.find((item) => item.sourceId === entryId);
        return entry && entry.status !== 'done';
      });
      if (!returnedIds.length) {
        run.pendingIds = [];
        finalizeDrainingRun(run, stored.queue);
        await saveRunAndQueue(run, stored.queue, history, generationMemory);
        await publishRun(run, stored.queue);
        return { completed: true };
      }

      const now = new Date().toISOString();
      const retryCountById = new Map();
      for (const entryId of returnedIds) {
        const entry = refreshedEntries.find((item) => item.sourceId === entryId);
        if (!entry) continue;
        retryCountById.set(entryId, Number(entry.retryCount || 0));
        entry.status = 'pending';
        entry.autoRetryPending = false;
        entry.lastError = null;
        entry.errorClass = null;
        entry.nextRetryAt = null;
        entry.generationStartedAt = null;
        delete history.items[entryId];
        history.ignored[entryId] = true;
        setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic',
          generationStartedAt: null,
          lastError: null,
          lastRunId: operationId,
          retryCount: Number(entry.retryCount || 0),
          errorClass: null,
          nextRetryAt: null
        });
      }

      for (const slot of Object.values(run.slots || {})) {
        const slotId = Number(slot.slotId);
        const releasedEntryId = slot.entryId || null;
        Object.assign(slot, freshSlotRevisionFields(), {
          tabId: null,
          entryId: null,
          leaseId: null,
          status: 'IDLE',
          phase: SLOT_PHASES.IDLE,
          preparedForSubmit: false,
          downloadId: null,
          launchWaitUntil: null,
          finalCheckPending: false,
          finalCheckDeadlineAt: null,
          finalCheckAttempts: 0,
          failed: false,
          lastCheckState: null,
          lastCheckError: null,
          checkFailures: 0,
          rateLimitRetryNeeded: false,
          lastResult: null,
          lastEntryName: null,
          lastModelName: null,
          generationSubmittedAt: null,
          lastActivityAt: now
        });
        recordRunEvent(run, 'stalled_batch_slot_released', {
          slotId,
          entryId: releasedEntryId,
          retryCount: releasedEntryId ? (retryCountById.get(releasedEntryId) ?? null) : null
        });
      }

      run.pendingIds = returnedIds;
      run.stalledBatchRecovery = {
        stage: 'CLOSING',
        attempts: Number(run.stalledBatchRecovery?.attempts || 0) + 1,
        triggeredAt: now,
        dueAt: null,
        triggerSlotId: currentCandidate.slotId,
        triggerEntryId: currentCandidate.entryId,
        noResponseSince: currentCandidate.noResponseSince,
        abnormalSlotIds: currentCandidate.abnormalSlotIds,
        requeuedIds: returnedIds,
        requeuedCount: returnedIds.length,
        closeTabs
      };
      run.state = 'PAUSED';
      run.status = 'STALLED_BATCH_RECOVERY';
      run.pauseReason = 'STALLED_BATCH';
      run.unresolvedError = false;
      run.error = null;
      run.stopBlocked = null;
      run.noProgressSince = null;
      run.noProgressCycles = 0;
      run.lastProgressAt = now;
      run.currentAction = `Вкладка ${currentCandidate.slotId + 1} молчит 15 минут; возвращаю ${returnedIds.length} незавершённых моделей в очередь и закрываю рабочие вкладки.`;
      run.lastActivityAt = now;
      recordRunEvent(run, 'stalled_batch_recovery_started', {
        triggerSlotId: currentCandidate.slotId,
        triggerEntryId: currentCandidate.entryId,
        abnormalSlotIds: currentCandidate.abnormalSlotIds,
        returnedIds
      });
      await saveRunAndQueue(run, stored.queue, history, generationMemory);
      await publishRun(run, stored.queue);
      return { triggered: true, requeuedCount: returnedIds.length };
    });

    if (!prepared?.triggered) return prepared || { skipped: true };
    stopAuditMonitor();
    const closed = await closeStalledBatchRecoveryTabs(operationId);
    if (closed.unsafe.length) {
      await failStalledBatchRecovery(operationId,
        `Рабочие вкладки изменились и оставлены открытыми: ${closed.unsafe.join(', ')}.`);
      return { triggered: true, failed: true, unsafeTabIds: closed.unsafe };
    }
    if (closed.failed.length) {
      scheduleStalledBatchRecovery(operationId, Date.now() + 5000);
      await appendLog('Не все рабочие вкладки закрылись; повторю закрытие через несколько секунд', {
        operationId,
        tabIds: closed.failed
      });
      return { triggered: true, deferred: true, failedTabIds: closed.failed };
    }
    await closeAutomationWindowIfEmpty(operationId);
    await activateStalledBatchRecoveryWait(operationId);
    await appendLog('Незавершённые модели возвращены в очередь; рабочие вкладки закрыты на 5 минут', {
      operationId,
      triggerSlotId: candidate.slotId,
      triggerEntryId: candidate.entryId,
      returnedCount: prepared.requeuedCount || 0
    });
    return { triggered: true, requeuedCount: prepared.requeuedCount || 0 };
  } finally {
    stalledBatchRecoveryRuns.delete(operationId);
  }
}

function isLegacyObservationWithoutSendEvidence(slot) {
  if (!slot?.entryId || !slot?.tabId || !slot?.leaseId || slot.downloadId) return false;
  const state = String(slot.status || slot.phase || '').toUpperCase();
  return (slot.finalCheckPending === true
      || ['OBSERVING', 'GENERATING', 'WAITING_GENERATION', 'WAITING_ASSISTANT'].includes(state))
    && !slot.generationSubmittedAt
    && !currentLeasePhysicalSend(slot)
    && !slot.chatUrl
    && Number(slot.assistantCount || 0) === 0;
}

function isLegacyObservationSlot(slot) {
  const status = String(slot?.status || slot?.phase || '').toUpperCase();
  return Boolean(slot?.entryId && slot?.tabId && !slot.downloadId
    && (slot.finalCheckPending === true
      || ['OBSERVING', 'GENERATING', 'WAITING_GENERATION', 'WAITING_ASSISTANT'].includes(status)));
}

function markObservationNeedsManualAttention(run, queue, generationMemory, slot, reason, now = Date.now()) {
  const entry = groupEntries(queue, run?.groupId).find((item) => item.sourceId === slot?.entryId);
  if (!run || !slot?.entryId || slot.downloadId || entry?.status === 'done') return false;
  const message = `${reason || 'Результат не удалось проверить автоматически'}. Чат и попытка сохранены; автоматическая повторная отправка отключена. Открой чат и продолжи после ручной проверки.`;
  slot.observationExpired = true;
  slot.finalCheckPending = false;
  slot.finalCheckDeadlineAt = null;
  slot.status = 'PAUSED';
  slot.phase = SLOT_PHASES.NEEDS_ATTENTION;
  slot.lastResult = 'NEEDS_ATTENTION';
  slot.lastCheckState = 'NEEDS_ATTENTION';
  slot.lastCheckError = message;
  slot.nextRetryAt = null;
  slot.failed = true;
  if (entry) {
    entry.status = 'error';
    entry.autoRetryPending = false;
    entry.nextRetryAt = null;
    entry.lastError = message;
    entry.errorClass = AUTOMATION_ERROR_CLASSES.TIMEOUT;
    setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
      statusSource: 'automatic',
      generationStartedAt: slot.generationSubmittedAt || slot.lastSendClickedAt || new Date(now).toISOString(),
      lastError: message,
      lastRunId: run.operationId,
      retryCount: Number(entry.retryCount || 0),
      errorClass: AUTOMATION_ERROR_CLASSES.TIMEOUT,
      nextRetryAt: null
    });
  }
  run.pendingIds = (Array.isArray(run.pendingIds) ? run.pendingIds : []).filter((id) => id !== slot.entryId);
  run.unresolvedError = true;
  run.error = { message };
  run.currentAction = `Ручная проверка нужна: ${entryDisplayName(entry, slot)}. Чат и результат сохранены.`;
  recordRunEvent(run, 'submitted_observation_needs_attention', {
    slotId: Number(slot.slotId),
    entryId: slot.entryId,
    generationId: slot.generationId || null,
    chatUrl: slot.chatUrl || null,
    reason: String(reason || 'observation_timeout').slice(0, 300),
    autoResend: false
  });
  return true;
}

function auditActiveRun() {
  if (auditInFlight) return auditInFlight;
  auditInFlight = (async () => {
    await reconcileActiveDownloads();
    await processDueScheduledRetries();
    const stored = await getStored();
    const { run, queue } = stored;
    if (!run || !(['RUNNING', 'DRAINING'].includes(run.state)
      || (run.state === 'PAUSED' && (hasObservationWork(run) || hasScheduledRunRetries(run, queue))))) return;

    // Facts extraction used to depend entirely on timers/MutationObserver in a
    // background ChatGPT renderer. Chrome can throttle those until the user
    // activates the tab. An external service-worker pulse forces a synchronous
    // DOM check every audit cycle and persists a ready JSON without requiring
    // any visible tab switch.
    await pulsePostprocessTabs(run).catch((error) => {
      void appendLog('Ошибка внешней проверки постпроцесса', { error: error?.message || String(error) });
    });

    const candidates = Object.values(run.slots || {}).filter((slot) => (
      canAuditSlot(slot)
      || (['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)
        && slot?.entryId && slot?.tabId && slot?.leaseId
        && !slot.downloadId && !slotGenerationSubmitted(slot)
        && isStalledUnsubmittedPreparation(slot, Date.now(), PREPARATION_STALL_AFTER_MS))
      || (run.state === 'PAUSED' && isLegacyObservationWithoutSendEvidence(slot))
    ));

    if (!candidates.length) {
      await withStateLock(async () => {
        const current = await getStored();
        if (!current.run || current.run.operationId !== run.operationId) return;
        if (finalizeDrainingRun(current.run, current.queue)) {
          await saveRunAndQueue(current.run, current.queue);
          await publishRun(current.run, current.queue);
        }
      });
      return;
    }

    const labels = candidates.map((slot) => entryDisplayName(
      groupEntries(queue, run.groupId).find((entry) => entry.sourceId === slot.entryId),
      slot
    ));
    const checkStartedAt = new Date().toISOString();
    await withStateLock(async () => {
      const current = await getStored();
      if (!current.run || current.run.operationId !== run.operationId) return;
      current.run.currentAction = `Проверяю готовность: ${labels.join(' · ')}`;
      current.run.lastCheckAt = checkStartedAt;
      await saveRunAndQueue(current.run, current.queue);
      await publishRun(current.run, current.queue);
    });

    const wakeCandidate = candidates
      .filter((slot) => shouldWakeSlot(slot))
      .sort((a, b) => Date.parse(a.lastFocusAt || '') - Date.parse(b.lastFocusAt || ''))[0];
    if (wakeCandidate) {
      await wakeTabForAudit(run.operationId, wakeCandidate).catch((error) => {
        appendLog('Не удалось временно активировать вкладку для проверки', {
          slotId: wakeCandidate.slotId,
          error: error.message
        }).catch(() => {});
      });
    }

    // Probe every active tab independently. Promise.allSettled keeps a
    // disconnected or modal-blocked page from delaying the other results.
    const results = await Promise.all(candidates.map(async (slot) => {
      try {
        const submittedAtMs = Date.parse(slot.generationSubmittedAt || slot.lastSendClickedAt || '')
          || Number(slot.physicalSendAtMs || 0);
        const response = await sendTabMessage(slot.tabId, {
          type: 'CHECK_GENERATION',
          operationId: run.operationId,
          slotId: slot.slotId,
          entryId: slot.entryId,
          leaseId: slot.leaseId || null,
          generationId: slot.generationId || null,
          outputFileName: slot.outputFileName || slot.lastEntryName || null,
          modelName: slot.lastModelName || null,
          submittedAtMs,
          baselineAssistantCount: Number(slot.baselineAssistantCount || 0),
          chatUrl: slot.chatUrl || null,
          recover: Boolean(slotGenerationSubmitted(slot) && slot.generationId && slot.leaseId && submittedAtMs > 0),
          recoverUnsubmitted: isLegacyObservationWithoutSendEvidence(slot),
          recoverObservationOnly: isLegacyObservationSlot(slot)
            && !isLegacyObservationWithoutSendEvidence(slot)
            && !slot.generationSubmittedAt && !slot.lastSendClickedAt && !(Number(slot.physicalSendAtMs || 0) > 0)
        }, SLOT_PROBE_TIMEOUT_MS);
        return { slot, response, error: null };
      } catch (error) {
        return { slot, response: null, error };
      }
    }));

    const pauseRequests = [];
    const rateLimitRequests = [];
    const conversationLoadFailures = [];
    const transportRefreshes = [];
    const safeUnsubmittedRepairs = [];
    const stalledPreparationEntryIds = new Set();
    const expiredAttentionSlotIds = [];
    let meaningfulProgress = false;
    let globalNoProgress = false;
    await withStateLock(async () => {
      const current = await getStored();
      if (!current.run || current.run.operationId !== run.operationId) return;
      current.history = normalizeHistory(current.history);
      current.generationMemory = normalizeGenerationMemory(current.generationMemory);
      const checkedAt = new Date().toISOString();
      for (const result of results) {
        const slot = current.run.slots?.[result.slot.slotId];
        if (!slot || slot.entryId !== result.slot.entryId || slot.leaseId !== result.slot.leaseId) continue;
        if (result.response?.ok && result.response.value?.leaseId
          && String(result.response.value.leaseId) !== String(slot.leaseId || '')) continue;
        if (slot.downloadId || ['DONE', 'STOPPED'].includes(slot.status)) continue;
        if (slot.status === 'PAUSED' && !slot.finalCheckPending) continue;
        slot.lastCheckAt = checkedAt;
        slot.lastProbeAt = checkedAt;
        slot.lastHeartbeatAt = checkedAt;
        if (result.response?.ok) {
          const value = result.response.value || {};
          const hadAssistantEvidence = Number(slot.assistantCount || 0) > Number(slot.baselineAssistantCount || 0);
          const hasCurrentLeaseProbe = Boolean(value.leaseId)
            && String(value.leaseId) === String(slot.leaseId || '');
          if (!hasCurrentLeaseProbe && isLegacyObservationSlot(slot)) {
            slot.lastCheckState = 'NO_CURRENT_LEASE';
            slot.lastCheckError = 'Ожидаю проверку страницы с текущей арендой слота';
            slot.legacyObservationStartedAt ||= checkedAt;
            const legacyDeadline = Number(slot.legacyObservationDeadlineAt || 0)
              || (Date.parse(slot.generationSubmittedAt || slot.lastSendClickedAt || '')
                || Number(slot.physicalSendAtMs || 0)
                || Date.parse(slot.legacyObservationStartedAt)) + FINAL_CHECK_TIMEOUT_MS;
            slot.legacyObservationDeadlineAt = legacyDeadline;
            const hasUnsentEvidence = isLegacyObservationWithoutSendEvidence(slot);
            const progressAt = Date.parse(slot.lastProgressAt || slot.generationSubmittedAt || slot.lastSendClickedAt
              || slot.legacyObservationStartedAt || '') || Date.now();
            const refreshDue = hasUnsentEvidence || Date.now() - progressAt >= SUBMITTED_STALL_REFRESH_AFTER_MS;
            if (refreshDue && String(slot.legacyProbeRefreshLeaseId || '') !== String(slot.leaseId)) {
              slot.legacyProbeRefreshLeaseId = String(slot.leaseId);
              slot.legacyProbeRefreshAt = checkedAt;
              transportRefreshes.push({
                slotId: slot.slotId, entryId: slot.entryId, tabId: slot.tabId,
                leaseId: slot.leaseId, chatUrl: slot.chatUrl || null,
                reason: hasUnsentEvidence ? 'legacy-unsubmitted-probe' : 'legacy-observation-probe'
              });
            }
            if (Date.now() >= legacyDeadline && markObservationNeedsManualAttention(
              current.run, current.queue, current.generationMemory, slot,
              'Страница не вернула проверку с текущей арендой за 15 минут', Date.now()
            )) expiredAttentionSlotIds.push(Number(slot.slotId));
            continue;
          }
          slot.noResponseSince = null;
          const reportedChatUrl = normalizeChatConversationUrl(value.chatUrl);
          slot.pageProbeChatUrl = reportedChatUrl;
          if (reportedChatUrl) slot.chatUrl = reportedChatUrl;
          if (value.leaseId && String(value.leaseId) === String(slot.leaseId || '')
            && typeof value.generationSubmitted === 'boolean') {
            slot.pageSubmissionLeaseId = String(value.leaseId);
            // Submission is monotonic within a lease. A transient/stale false
            // report cannot erase a prior exact-lease acceptance.
            if (value.generationSubmitted === true || slot.pageGenerationSubmitted !== true) {
              slot.pageGenerationSubmitted = value.generationSubmitted;
            }
            slot.pageProbeAt = checkedAt;
            slot.pageProbeAssistantCount = Number(value.assistantCount || 0);
            slot.pageProbeChatUrl = reportedChatUrl;
            if (Number(value.physicalSendAtMs || 0) > 0) {
              slot.physicalSendAtMs = Number(value.physicalSendAtMs);
              slot.physicalSendLeaseId = String(value.leaseId);
              slot.lastSendClickedAt = new Date(slot.physicalSendAtMs).toISOString();
              slot.submissionObservationDeadlineAt ||= slot.physicalSendAtMs + FINAL_CHECK_TIMEOUT_MS;
            }
          }
          const previousProbe = {
            state: slot.lastCheckState,
            assistantCount: Number(slot.assistantCount || 0),
            imageCandidate: Boolean(slot.imageCandidate),
            imageSource: slot.imageCandidateSource || null
          };
          const currentProbe = {
            state: value.state || 'UNKNOWN',
            assistantCount: Number(value.assistantCount || 0),
            imageCandidate: Boolean(value.imageCandidate),
            imageSource: value.src ? stableHash(String(value.src)) : null,
            progress: Boolean(value.progress)
          };
          if (currentProbe.progress || isMeaningfulProgress(previousProbe, currentProbe)) {
            meaningfulProgress = true;
            slot.lastProgressAt = checkedAt;
            slot.lastActivityAt = checkedAt;
            slot.assistantObservedAt = value.assistantCount > 0
              ? (slot.assistantObservedAt || checkedAt)
              : slot.assistantObservedAt;
          }
          slot.assistantCount = currentProbe.assistantCount;
          slot.imageCandidate = currentProbe.imageCandidate;
          slot.imageCandidateSource = currentProbe.imageSource;
          slot.lastCheckState = value.state || 'UNKNOWN';
          if (!hadAssistantEvidence && isLegacyObservationWithoutSendEvidence(slot)
            && pageProbeConfirmsUnsubmitted(slot, {
              ...value,
              leaseId: value.leaseId,
              generationSubmitted: value.generationSubmitted,
              assistantCount: value.assistantCount,
              chatUrl: reportedChatUrl,
              physicalSendAtMs: value.physicalSendAtMs
            })) {
            const entry = groupEntries(current.queue, current.run.groupId)
              .find((item) => item.sourceId === slot.entryId);
            if (entry && entry.status !== 'done') {
              entry.status = 'pending';
              entry.autoRetryPending = false;
              entry.lastError = null;
              entry.errorClass = null;
              entry.nextRetryAt = null;
              setGenerationMemoryStatus(current.generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
                statusSource: 'automatic', generationStartedAt: null, lastError: null,
                lastRunId: current.run.operationId
              });
              if (!(current.run.pendingIds || []).includes(entry.sourceId)) current.run.pendingIds.unshift(entry.sourceId);
            }
            safeUnsubmittedRepairs.push({
              slotId: Number(slot.slotId), entryId: slot.entryId, tabId: slot.tabId,
              leaseId: slot.leaseId, generationId: slot.generationId || null
            });
            recordRunEvent(current.run, 'legacy_unsubmitted_slot_repaired', {
              slotId: Number(slot.slotId), entryId: slot.entryId,
              leaseId: slot.leaseId, generationId: slot.generationId || null
            });
            slot.entryId = null;
            slot.leaseId = null;
            slot.tabId = null;
            slot.status = 'IDLE';
            slot.phase = SLOT_PHASES.IDLE;
            slot.downloadId = null;
            slot.finalCheckPending = false;
            slot.finalCheckDeadlineAt = null;
            slot.preparedForSubmit = false;
            slot.failed = false;
            Object.assign(slot, freshSlotRevisionFields());
            current.run.currentAction = `Восстановлена неподанная модель: ${entryDisplayName(entry, slot)}`;
            continue;
          }
          const probePhase = phaseForProbeState(value.state, {
            finalCheckPending: slot.finalCheckPending,
            generationSubmitted: typeof value.generationSubmitted === 'boolean'
              && String(value.leaseId || '') === String(slot.leaseId || '')
              ? value.generationSubmitted
              : slotGenerationSubmitted(slot),
            downloadId: slot.downloadId,
            preparedForSubmit: slot.preparedForSubmit
          });
          if (probePhase) slot.phase = probePhase;
          if (value.error) slot.lastCheckError = value.error;
          if (!slot.finalCheckPending) slot.lastCheckError = value.error || null;
          slot.checkFailures = 0;
          if (value.rateLimit === true || value.state === 'RATE_LIMIT_PAUSE') {
            rateLimitRequests.push({
              slotId: slot.slotId,
              tabId: slot.tabId,
              text: value.error || 'Слишком много запросов'
            });
          }
          if (value.state === 'CONVERSATION_LOAD_ERROR') {
            slot.status = 'OBSERVING';
            slot.phase = SLOT_PHASES.OBSERVING;
            slot.lastCheckError = value.error || 'Не удалось загрузить этот разговор ChatGPT';
            conversationLoadFailures.push({ slotId: slot.slotId, entryId: slot.entryId, error: slot.lastCheckError });
          }
          if (slotGenerationSubmitted(slot)
            && slot.chatUrl
            && shouldRefreshStalledGeneration(slot, Date.now(), SUBMITTED_STALL_REFRESH_AFTER_MS)
            && !transportRefreshes.some((item) => Number(item.slotId) === Number(slot.slotId))) {
            slot.autoRefreshGenerationId = slot.generationId;
            slot.autoRefreshAt = checkedAt;
            transportRefreshes.push({
              slotId: slot.slotId, entryId: slot.entryId, tabId: slot.tabId,
              leaseId: slot.leaseId, chatUrl: slot.chatUrl, reason: 'submitted-stall'
            });
          }
          if (slot.finalCheckPending) {
            slot.status = 'OBSERVING';
            slot.finalCheckAttempts = Number(slot.finalCheckAttempts || 0) + 1;
          } else if (value.state === 'ERROR') {
            pauseRequests.push({
              slotId: slot.slotId,
              entryId: slot.entryId,
              tabId: slot.tabId,
              message: value.error || 'Ошибка при проверке генерации',
              responseText: value.responseText || null,
              errorClass: value.errorClass || null
            });
          }
        } else {
          slot.lastCheckState = 'NO_RESPONSE';
          slot.lastCheckError = result.error?.message || result.response?.error?.message || 'Нет ответа вкладки';
          slot.noResponseSince ||= checkedAt;
          slot.checkFailures = Number(slot.checkFailures || 0) + 1;
          if (slot.checkFailures >= 3) slot.phase = SLOT_PHASES.TAB_LOST;
          if (slot.chatUrl && shouldRefreshUnresponsiveGeneration(slot)) {
            slot.autoRefreshGenerationId = slot.generationId;
            slot.autoRefreshAt = checkedAt;
            slot.checkFailures = 0;
            transportRefreshes.push({
              slotId: slot.slotId, entryId: slot.entryId, tabId: slot.tabId,
              leaseId: slot.leaseId, chatUrl: slot.chatUrl, reason: 'unresponsive-transport'
            });
          }
          if (slot.finalCheckPending) {
            slot.status = 'OBSERVING';
            slot.finalCheckAttempts = Number(slot.finalCheckAttempts || 0) + 1;
          } else if (slot.checkFailures >= 3 && !slotGenerationSubmitted(slot)) {
            pauseRequests.push({
              slotId: slot.slotId,
              entryId: slot.entryId,
              tabId: slot.tabId,
              message: `Вкладка не отвечает на проверку генерации: ${slot.lastCheckError}`
            });
          }
        }
        const deadlineAt = Number(slot.finalCheckDeadlineAt || 0);
        const resultState = result.response?.ok ? result.response.value?.state : null;
        // A page can acknowledge the download before the downloads API has
        // attached its id to the slot. Keep the observation lease alive for
        // either page-side download state to avoid expiring a successful
        // result during that short hand-off window.
        const downloadInProgress = ['READY', 'DOWNLOADING'].includes(resultState) || Boolean(slot.downloadId);
        if (!downloadInProgress && shouldExpireSubmittedObservation(slot, Date.now())) {
          if (markObservationNeedsManualAttention(
            current.run, current.queue, current.generationMemory, slot,
            'После отправки прошло 15 минут без скачанного результата', Date.now()
          )) expiredAttentionSlotIds.push(Number(slot.slotId));
        }
        if (slot.finalCheckPending && deadlineAt > 0 && Date.now() >= deadlineAt && !slot.downloadId && !downloadInProgress) {
          if (!slot.observationExpired && markObservationNeedsManualAttention(
            current.run, current.queue, current.generationMemory, slot,
            'Окно наблюдения завершено без найденного результата', Date.now()
          )) expiredAttentionSlotIds.push(Number(slot.slotId));
        }
        if (isStalledUnsubmittedPreparation(slot, Date.now(), PREPARATION_STALL_AFTER_MS)
          && !slotGenerationSubmitted(slot)) stalledPreparationEntryIds.add(String(slot.entryId));
      }
      current.run.lastCheckAt = checkedAt;
      if (meaningfulProgress) {
        current.run.lastProgressAt = checkedAt;
        current.run.lastActivityAt = checkedAt;
        current.run.noProgressSince = null;
        current.run.noProgressCycles = 0;
        recordRunEvent(current.run, 'progress', { checkedAt, slots: results.filter((item) => item.response?.ok).map((item) => item.slot.slotId) });
      } else {
        current.run.noProgressSince ||= checkedAt;
        current.run.noProgressCycles = Number(current.run.noProgressCycles || 0) + 1;
        const lastProgress = Date.parse(current.run.lastProgressAt || current.run.startedAt || checkedAt);
        const allProbesUnreachable = results.length > 0 && results.every((item) => !item.response?.ok);
        const rateLimitActive = Number(current.run.rateLimitPauseUntil || 0) > Date.now() || rateLimitRequests.length > 0;
        // A stable GENERATING/WAITING_IMAGE state is normal for image jobs and
        // must not be treated as a dead run. The global watchdog is now only a
        // transport watchdog: every worker tab must be unreachable for the
        // whole window before it can pause the run.
        globalNoProgress = current.run.state !== 'PAUSED'
          && !rateLimitActive
          && !transportRefreshes.length
          && allProbesUnreachable
          && Number.isFinite(lastProgress)
          && Date.now() - lastProgress >= GLOBAL_NO_PROGRESS_WINDOW_MS
          && candidates.length > 0;
      }
      if (expiredAttentionSlotIds.length) {
        current.run.currentAction = 'Некоторые отправленные генерации требуют ручной проверки; автоматическая повторная отправка отключена.';
      }
      finalizeDrainingRun(current.run, current.queue);
      await saveRunAndQueue(current.run, current.queue, current.history, current.generationMemory);
      await publishRun(current.run, current.queue);
    });

    await Promise.all(safeUnsubmittedRepairs.map(async (repair) => {
      await sendTabMessage(repair.tabId, {
        type: 'STOP', operationId: run.operationId, slotId: repair.slotId,
        entryId: repair.entryId, leaseId: repair.leaseId
      }).catch(() => null);
      if (repair.generationId) {
        await cancelUnsubmittedGenerationRevision(repair.generationId, repair.entryId,
          'legacy_probe_confirmed_not_submitted').catch(() => {});
      }
      const latest = await getStored();
      const stillOwned = Object.values(latest.run?.slots || {}).some((slot) => Number(slot.tabId) === Number(repair.tabId))
        || latest.run?.postprocessTabs?.[repair.tabId] || latest.run?.recoveryTabs?.[repair.tabId];
      if (latest.run?.operationId === run.operationId && !stillOwned) {
        const oldTab = await chrome.tabs.get(repair.tabId).catch(() => null);
        if (isAutomationChatTab(oldTab, latest.run.automationWindowId)
          && !normalizeChatConversationUrl(oldTab.url || oldTab.pendingUrl)) {
          await chrome.tabs.remove(repair.tabId).catch(() => {});
        }
      }
      if (!['RUNNING', 'STARTING', 'DRAINING'].includes(latest.run?.state)
        || latest.run?.operationId !== run.operationId) return;
      const next = await claimNext(run.operationId, repair.slotId);
      if (next) void executeSlot(run.operationId, next.slot.slotId, next.entry.sourceId);
    }));

    await Promise.all(transportRefreshes.map(async (item) => {
      try {
        await reloadTabForRecovery(item.tabId, item.slotId, {
          force: true, leaseId: item.leaseId, entryId: item.entryId,
          conversationUrl: item.chatUrl || null
        });
        await appendLog('Вкладка обновлена один раз; проверяю текущую аренду без повторной отправки', {
          operationId: run.operationId,
          slotId: item.slotId,
          entryId: item.entryId,
          reason: item.reason || 'unresponsive-transport'
        });
      } catch (error) {
        await appendLog('Не удалось обновить неотвечающую вкладку', {
          operationId: run.operationId,
          slotId: item.slotId,
          entryId: item.entryId,
          error: error.message
        });
      }
    }));

    if (conversationLoadFailures.length) {
      await beginConversationLoadRecovery(run.operationId, conversationLoadFailures[0]);
      return;
    }

    if (rateLimitRequests.length) {
      const signal = rateLimitRequests[0];
      if (imageLimitResumeAt(signal.text) || !await ignoreRateLimitDuringWindow(run.operationId, signal)) {
        await pauseNewLaunchesForRateLimit(run.operationId, signal);
      }
    }

    for (const failure of pauseRequests) {
      const error = new Error(failure.message);
      if (failure.responseText) error.responseText = failure.responseText;
      if (failure.errorClass) error.code = failure.errorClass;
      await pauseRunOnError(run.operationId, error, {
        slotId: failure.slotId,
        entryId: failure.entryId,
        tabId: failure.tabId,
        errorClass: failure.errorClass || undefined,
        terminalResponse: ['TEXT_ONLY', 'CLARIFICATION_REQUIRED', 'MODEL_REFUSAL', 'TOOL_UNAVAILABLE'].includes(String(failure.errorClass || '').toUpperCase())
      });
    }

    if (stalledPreparationEntryIds.size) {
      const recovery = await schedulePreparationStallRecovery(run.operationId, [...stalledPreparationEntryIds]);
      if (recovery?.scheduled || recovery?.terminal || recovery?.skipped) return;
    }

    const latest = await getStored();
    const stalledCandidate = findStalledBatchRecoveryCandidate(latest.run, Date.now());
    if (stalledCandidate) {
      const recovery = await beginStalledBatchRecovery(latest.run.operationId, stalledCandidate);
      if (recovery?.triggered || recovery?.deferred || recovery?.completed) return;
    }

    if (globalNoProgress) {
      await Promise.all(candidates.map((slot) => captureDiagnosticsFromTab(slot.tabId, {
        operationId: run.operationId,
        slotId: slot.slotId,
        entryId: slot.entryId,
        reason: 'global-no-progress'
      })));
      await pauseRunOnError(run.operationId, new Error('Нет прогресса ни в одной рабочей вкладке в течение 5 минут'), {
        errorClass: AUTOMATION_ERROR_CLASSES.TIMEOUT,
        globalNoProgress: true
      });
    }
  })().finally(() => {
    auditInFlight = null;
  });
  return auditInFlight;
}

async function claimNext(runId, slotId) {
  return withStateLock(async () => {
    const { run, queue, generationMemory: rawGenerationMemory, history: rawHistory } = await getStored();
    const generationMemory = normalizeGenerationMemory(rawGenerationMemory);
    const history = normalizeHistory(rawHistory);
    if (!run || run.operationId !== runId || run.state !== 'RUNNING' || run.clockStopped || run.stopBlocked) return null;
    const oldSlot = run.slots?.[slotId] || { slotId, tabId: null };
    if (oldSlot.entryId && !['IDLE', 'DONE', 'PAUSED'].includes(oldSlot.status)) return null;
    const entryId = run.pendingIds.shift();
    if (!entryId) {
      oldSlot.entryId = null;
      oldSlot.status = 'IDLE';
      oldSlot.phase = SLOT_PHASES.IDLE;
      oldSlot.launchWaitUntil = null;
      run.slots[slotId] = oldSlot;
      finalizeDrainingRun(run, queue);
      await saveRunAndQueue(run, queue, history, generationMemory);
      await publishRun(run, queue);
      return null;
    }
    const otherOwner = Object.values(run.slots || {}).find((slot) => (
      Number(slot.slotId) !== Number(slotId) && slot.entryId === entryId
    ));
    if (otherOwner) {
      run.pendingIds.unshift(entryId);
      run.state = 'PAUSED';
      run.status = 'PAUSED_ON_ERROR';
      run.unresolvedError = true;
      run.currentAction = `Остановлено повторное назначение ${entryId}: модель ещё закреплена за вкладкой ${Number(otherOwner.slotId) + 1}.`;
      await saveRunAndQueue(run, queue, history, generationMemory);
      await publishRun(run, queue);
      return null;
    }
    const entry = groupEntries(queue, run.groupId).find((item) => item.sourceId === entryId);
    if (!entry) throw new Error(`Очередь не содержит ${entryId}`);
    entry.status = 'running';
    entry.autoRetryPending = false;
    entry.lastError = null;
    entry.errorClass = null;
    entry.nextRetryAt = null;
    setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
      statusSource: 'automatic',
      generationStartedAt: new Date().toISOString(),
      lastError: null,
      lastRunId: run.operationId,
      retryCount: Number(entry.retryCount || 0),
      errorClass: null,
      nextRetryAt: null,
    });
    delete history.items[entry.sourceId];
    history.ignored[entry.sourceId] = true;
    const slot = {
      ...oldSlot,
      ...freshSlotRevisionFields(),
      tabId: null,
      slotId,
      entryId,
      status: 'STARTING',
      phase: SLOT_PHASES.PREPARING,
      leaseId: makeLeaseId(),
      attempt: Number(entry.retryCount || 0) + 1,
      errorClass: null,
      nextRetryAt: null,
      lastHeartbeatAt: new Date().toISOString(),
      lastProbeAt: null,
      lastProgressAt: new Date().toISOString(),
      generationSubmittedAt: null,
      assistantObservedAt: null,
      assistantCount: 0,
      imageCandidate: false,
      imageCandidateSource: null,
      resultFingerprint: null,
      downloadVerification: null,
      downloadId: null,
      lastEntryName: entry.fileName,
      lastModelName: entry.modelName,
      lastResult: null,
      lastCheckState: null,
      lastCheckError: null,
      checkFailures: 0,
      lastFocusAt: null,
      focusCount: 0,
      launchWaitUntil: null,
      generationGapMs: null,
      finalCheckPending: false,
      finalCheckDeadlineAt: null,
      finalCheckAttempts: 0,
      failed: false,
      rateLimitRetryNeeded: false,
      startedAt: new Date().toISOString()
    };
    recordRunEvent(run, 'slot_claimed', { slotId, entryId, leaseId: slot.leaseId, attempt: slot.attempt });
    run.slots[slotId] = slot;
    await saveRunAndQueue(run, queue, history, generationMemory);
    await publishRun(run, queue);
    return { entry, slot };
  });
}

async function processDueScheduledRetries(expectedRunId = null) {
  const plan = await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    if (!run || (expectedRunId && run.operationId !== expectedRunId)
      || run.clockStopped || run.stopBlocked
      || ['STOPPED', 'DONE'].includes(String(run.state || '').toUpperCase())) return null;
    const entries = groupEntries(queue, run.groupId);
    run.pendingIds ||= [];
    const due = scheduledRetriesForRun(run, queue)
      .filter((item) => item.due)
      .slice(0, Math.max(1, Number(run.workerCount || DEFAULT_WORKERS)));
    if (!due.length) return null;

    const generationMemory = normalizeGenerationMemory(stored.generationMemory);
    const history = normalizeHistory(stored.history);
    const releasedSlots = [];
    for (const retry of due) {
      const entry = entries.find((item) => item.sourceId === retry.entryId);
      if (!entry || entry.status !== 'error') continue;
      entry.status = 'pending';
      entry.autoRetryPending = false;
      entry.lastError = null;
      entry.errorClass = null;
      entry.nextRetryAt = null;
      setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'automatic',
        generationStartedAt: null,
        lastError: null,
        lastRunId: run.operationId,
        retryCount: Number(entry.retryCount || 0),
        errorClass: null,
        nextRetryAt: null
      });
      delete history.items[entry.sourceId];
      history.ignored[entry.sourceId] = true;
      if (!run.pendingIds.includes(entry.sourceId)) run.pendingIds.push(entry.sourceId);

      const slot = retry.slotId == null ? null : run.slots?.[String(retry.slotId)];
      if (slot?.entryId === entry.sourceId && String(slot.phase || '').toUpperCase() === 'RETRY_BACKOFF') {
        slot.entryId = null;
        slot.status = 'IDLE';
        slot.phase = SLOT_PHASES.IDLE;
        slot.failed = false;
        slot.errorClass = null;
        slot.nextRetryAt = null;
        slot.lastCheckError = null;
        releasedSlots.push(Number(slot.slotId));
      }
      recordRunEvent(run, 'scheduled_retry_due', {
        sourceId: entry.sourceId,
        retryAt: retry.retryAt,
        retryCount: Number(entry.retryCount || 0)
      });
    }

    if (!run.pendingIds.length) return null;
    if (run.state === 'PAUSED' || (run.state === 'RUNNING' && run.status === 'RETRY_BACKOFF')) {
      run.state = 'RUNNING';
      run.status = 'RUNNING';
      run.pauseReason = null;
      run.error = null;
      run.currentAction = 'Пауза повтора завершена. Продолжаю сохранённую очередь.';
      const planned = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
      run.unresolvedError = entries.some((entry) => planned.has(entry.sourceId)
        && entry.status === 'error' && entry.autoRetryPending !== true);
    }
    const freeSlots = Object.values(run.slots || {})
      .filter((slot) => !slot.downloadId && !slot.finalCheckPending
        && (!slot.entryId || ['IDLE', 'DONE', 'PAUSED'].includes(String(slot.status || '').toUpperCase()))
        && !slotGenerationSubmitted(slot))
      .map((slot) => Number(slot.slotId))
      .filter(Number.isFinite);
    for (const slotId of releasedSlots) if (!freeSlots.includes(slotId)) freeSlots.unshift(slotId);
    await saveRunAndQueue(run, queue, history, generationMemory);
    await appendLog('Истёкший RETRY_BACKOFF поставлен обратно в сохранённую очередь', {
      operationId: run.operationId,
      retries: due.map((item) => ({ entryId: item.entryId, retryAt: item.retryAt, slotId: item.slotId }))
    });
    await publishRun(run, queue);
    return { runId: run.operationId, slotIds: [...new Set(freeSlots)] };
  });

  if (!plan) return { resumed: false, started: 0 };
  let started = 0;
  for (const slotId of plan.slotIds) {
    const next = await claimNext(plan.runId, slotId).catch(() => null);
    if (!next) continue;
    started += 1;
    void executeSlot(plan.runId, next.slot.slotId, next.entry.sourceId);
  }
  if (started) startAuditMonitor();
  return { resumed: true, started };
}

function isAutomationChatTab(tab, windowId) {
  return Boolean(tab?.id != null)
    && Number(tab.windowId) === Number(windowId)
    && /^https:\/\/chatgpt\.com\//i.test(tab.url || tab.pendingUrl || '');
}

function ensureAutomationWindow(runId) {
  if (automationWindowPromise && automationWindowPromiseRunId === runId) return automationWindowPromise;
  automationWindowPromiseRunId = runId;
  automationWindowPromise = (async () => {
    if (!chrome.windows?.get) {
      throw new Error('Chrome Windows API недоступен');
    }
    const initial = await getStored();
    if (!initial.run || initial.run.operationId !== runId) {
      throw new Error('Запуск завершился до подключения окна автоматизации');
    }

    const savedWindowId = Number(initial.run.automationWindowId || 0);
    const preferredWindowId = Number(initial.run.preferredWindowId || 0);
    const preferred = preferredWindowId ? await chrome.windows.get(preferredWindowId).catch(() => null) : null;
    const saved = savedWindowId ? await chrome.windows.get(savedWindowId).catch(() => null) : null;
    const focused = !preferred && !saved ? await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null) : null;
    const host = preferred || saved || focused;
    if (!host?.id || host.type !== 'normal') throw new Error('Окно Chrome с панелью расширения недоступно. Открой панель и продолжи запуск.');
    const result = await withStateLock(async () => {
      const stored = await getStored();
      if (!stored.run || stored.run.operationId !== runId) return null;
      stored.run.automationWindowId = host.id;
      stored.run.automationWindowOwned = false;
      stored.run.lastActivityAt = new Date().toISOString();
      await saveRunAndQueue(stored.run, stored.queue);
      await publishRun(stored.run, stored.queue);
      return { windowId: host.id, initialTabId: null, owned: false };
    });
    if (!result) throw new Error('Запуск завершился до подключения окна');
    return result;
  })().finally(() => {
    if (automationWindowPromiseRunId === runId) {
      automationWindowPromise = null;
      automationWindowPromiseRunId = null;
    }
  });
  return automationWindowPromise;
}

async function markTabAsAutomation(tabId, context = null) {
  if (!chrome.scripting?.executeScript) throw new Error('Chrome Scripting API недоступен');
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (key, contextKey, value) => {
      try {
        sessionStorage.setItem(key, '1');
        if (value?.operationId && value?.entryId && Number.isInteger(Number(value?.slotId))) {
          sessionStorage.setItem(contextKey, JSON.stringify({
            operationId: String(value.operationId),
            slotId: Number(value.slotId),
            entryId: String(value.entryId),
            markedAt: new Date().toISOString()
          }));
        }
      } catch (_) {}
    },
    args: [AUTOMATION_SESSION_KEY, AUTOMATION_CONTEXT_KEY, context]
  });
}

async function closeAutomationWindowIfEmpty(runId) {
  if (!chrome.windows?.remove || !chrome.tabs?.query) return;
  const stored = await getStored();
  const run = stored.run;
  const windowId = Number(run?.automationWindowId || 0);
  if (!run || run.operationId !== runId || !windowId || run.automationWindowOwned !== true) return;
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  if (tabs.length) return;
  await chrome.windows.remove(windowId).catch(() => {});
  await withStateLock(async () => {
    const current = await getStored();
    if (!current.run || current.run.operationId !== runId) return;
    if (Number(current.run.automationWindowId || 0) !== windowId) return;
    current.run.automationWindowId = null;
    await saveRunAndQueue(current.run, current.queue);
    await publishRun(current.run, current.queue);
  });
}

async function moveRunTabsToAutomationWindow(runId) {
  if (!chrome.tabs?.get || !chrome.tabs?.move) return;
  const stored = await getStored();
  const run = stored.run;
  const windowId = Number(run?.automationWindowId || 0);
  if (!run || run.operationId !== runId || !windowId) return;
  const tabIds = [...new Set(Object.values(run.slots || {})
    .map((slot) => Number(slot.tabId || 0))
    .filter((tabId) => tabId > 0))];
  for (const tabId of tabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || Number(tab.windowId) === windowId) continue;
    if (!isAutomationChatTab(tab, tab.windowId)) continue;
    await chrome.tabs.move(tabId, { windowId, index: -1 }).catch(() => {});
    const owner = Object.values(run.slots || {}).find((slot) => Number(slot.tabId || 0) === Number(tabId));
    await markTabAsAutomation(tabId, owner?.entryId ? {
      operationId: run.operationId,
      slotId: owner.slotId,
      entryId: owner.entryId
    } : null).catch(() => {});
    await appendLog('Рабочая вкладка перенесена в окно автоматизации', { tabId, windowId });
  }
}

async function protectAutomationTab(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.update(Number(tabId), { autoDiscardable: false });
    return true;
  } catch (_) {
    return false;
  }
}

async function bootstrapAutomationTab(tabId, windowId, context = {}) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || Number(tab.windowId) !== Number(windowId)) {
    throw new Error('Рабочая вкладка исчезла до инициализации renderer');
  }
  await protectAutomationTab(tabId);
  await waitTabReady(Number(tabId), 60000);
  let response = await sendTabMessage(Number(tabId), {
    type: 'BOOTSTRAP_AUTOMATION_TAB',
    timeoutMs: 8000
  }, 10000).catch(() => null);
  // Some ChatGPT pages mount the composer only after their first activation.
  // Activate once only when the background-ready probe proves insufficient.
  if (!response?.ok || response?.value?.composerReady !== true) {
    const [previous] = await chrome.tabs.query({ windowId: Number(windowId), active: true }).catch(() => []);
    try {
      await chrome.tabs.update(Number(tabId), { active: true });
      response = await sendTabMessage(Number(tabId), {
        type: 'BOOTSTRAP_AUTOMATION_TAB',
        timeoutMs: 60000
      }, 65000);
    } finally {
      if (previous?.id && Number(previous.id) !== Number(tabId)) {
        await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
      }
    }
  }
  if (!response?.ok || response?.value?.composerReady !== true) {
    throw new Error(response?.error?.message || 'ChatGPT renderer не подготовил composer');
  }
  await appendLog('Renderer рабочей вкладки инициализирован', {
    tabId: Number(tabId),
    windowId: Number(windowId),
    slotId: context.slotId ?? null,
    entryId: context.entryId || null,
    visibilityState: response.value.visibilityState || null,
    durationMs: Number(response.value.durationMs || 0)
  });
  return response.value;
}

async function createOrReuseTabUnlocked(runId, slotId) {
  const { run } = await getStored();
  const slot = run?.slots?.[slotId];
  if (!slot) throw new Error(`Слот ${slotId} не найден`);
  const automation = await ensureAutomationWindow(runId);
  const windowId = Number(automation.windowId);
  const bootstrapTabId = Number(automation.initialTabId || 0);
  let selectedTabId = null;

  // Only explicitly owned tabs can be reused. Personal ChatGPT tabs in the
  // host window are never claimed for automation.
  await withStateLock(async () => {
    const stored = await getStored();
    const currentRun = stored.run;
    const currentSlot = currentRun?.slots?.[slotId];
    if (!currentRun || currentRun.operationId !== runId || currentRun.state !== 'RUNNING' || !currentSlot?.entryId) return;

    const knownTabId = Number(currentSlot.tabId || 0);
    if (knownTabId) {
      const existing = await chrome.tabs.get(knownTabId).catch(() => null);
      if (isAutomationChatTab(existing, windowId)) {
        selectedTabId = knownTabId;
        return;
      }
    }

    const assignedTabIds = new Set([
      ...Object.values(currentRun.slots || {})
        .map((item) => Number(item.tabId || 0))
        .filter((tabId) => tabId > 0),
      ...Object.keys(currentRun.postprocessTabs || {})
        .map((tabId) => Number(tabId || 0))
        .filter((tabId) => tabId > 0)
    ]);
    // In a user-owned host window never hijack an existing ChatGPT tab. Six
    // workers means six actual worker tabs. The bootstrap tab is reusable only
    // inside a fallback window created by the extension itself.
    if (currentRun.automationWindowOwned !== true) return;
    const bootstrapTab = bootstrapTabId && !assignedTabIds.has(bootstrapTabId)
      ? await chrome.tabs.get(bootstrapTabId).catch(() => null)
      : null;
    const freeTab = bootstrapTab && Number(bootstrapTab.windowId) === windowId
      ? bootstrapTab
      : null;
    if (!freeTab?.id) return;

    currentSlot.tabId = freeTab.id;
    selectedTabId = freeTab.id;
    await saveRunAndQueue(currentRun, stored.queue);
    await publishRun(currentRun, stored.queue);
  });
  if (selectedTabId) {
    await protectAutomationTab(selectedTabId);
    return selectedTabId;
  }

  const beforeCreate = await getStored();
  if (beforeCreate.run?.operationId !== runId || beforeCreate.run.state !== 'RUNNING'
    || beforeCreate.run.slots?.[slotId]?.entryId !== slot.entryId) {
    throw new Error('Подготовка вкладки отменена остановкой или паузой');
  }

  const tab = await chrome.tabs.create({
    windowId,
    url: AUTOMATION_URL,
    active: false
  });
  if (!tab?.id) throw new Error('Не удалось открыть рабочую вкладку в окне автоматизации');
  await protectAutomationTab(tab.id);

  let keepCreatedTab = false;
  let replacementTabId = null;
  await withStateLock(async () => {
    const stored = await getStored();
    const currentRun = stored.run;
    const currentSlot = currentRun?.slots?.[slotId];
    if (!currentRun || currentRun.operationId !== runId || currentRun.state !== 'RUNNING' || !currentSlot?.entryId) return;

    const knownTabId = Number(currentSlot.tabId || 0);
    if (knownTabId && knownTabId !== tab.id) {
      const existing = await chrome.tabs.get(knownTabId).catch(() => null);
      if (isAutomationChatTab(existing, windowId)) {
        replacementTabId = knownTabId;
        return;
      }
    }
    currentSlot.tabId = tab.id;
    keepCreatedTab = true;
    await saveRunAndQueue(currentRun, stored.queue);
    await publishRun(currentRun, stored.queue);
  });

  if (!keepCreatedTab) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (replacementTabId) {
      await protectAutomationTab(replacementTabId);
      return replacementTabId;
    }
    throw new Error('Запуск завершился до подключения рабочей вкладки');
  }
  return tab.id;
}

async function createOrReuseTab(runId, slotId) {
  return createOrReuseTabUnlocked(runId, slotId);
}

async function executeSlot(runId, slotId, entryId) {
  let tabId = null;
  let ownerLeaseId = null;
  try {
    const stored = await getStored();
    const run = stored.run;
    const queue = stored.queue;
    const job = stored.job;
    const entry = groupEntries(queue, run?.groupId).find((item) => item.sourceId === entryId);
    if (!run || run.operationId !== runId || !entry || !job) throw new Error('Данные запуска устарели');
    ownerLeaseId = run.slots?.[slotId]?.leaseId;
    if (!ownerLeaseId || run.slots[slotId].entryId !== entryId || run.clockStopped || run.stopBlocked) return;

    // PREPARE has no intentional delay. Tabs are preallocated in parallel;
    // page readiness, input transfer, upload and prompt filling proceed as
    // quickly as Chrome/ChatGPT can physically process them.
    tabId = await createOrReuseTab(runId, slotId);
    const beforePrepare = await getStored();
    const currentSlot = beforePrepare.run?.slots?.[slotId];
    if (beforePrepare.run?.operationId !== runId || beforePrepare.run.state !== 'RUNNING'
      || currentSlot?.entryId !== entryId || currentSlot.leaseId !== ownerLeaseId) return;
    if (beforePrepare.run?.operationId === runId && currentSlot?.entryId === entryId && !currentSlot.rendererBootstrappedAt) {
      const bootstrap = await bootstrapAutomationTab(tabId, beforePrepare.run.automationWindowId, { slotId, entryId });
      await withStateLock(async () => {
        const current = await getStored();
        const liveSlot = current.run?.slots?.[slotId];
        if (!current.run || current.run.operationId !== runId || liveSlot?.entryId !== entryId) return;
        liveSlot.rendererBootstrappedAt = new Date().toISOString();
        liveSlot.rendererBootstrapVisibility = bootstrap.visibilityState || null;
        await saveRunAndQueue(current.run, current.queue);
      });
    }
    await waitTabReady(tabId);
    await markTabAsAutomation(tabId, { operationId: runId, slotId, entryId }).catch((error) => appendLog('Не удалось пометить рабочую вкладку автоматизации', { tabId, error: error.message }));
    await appendLog('Слот подключён к вкладке', { slotId, entryId, tabId });
    const brandProfile = detectBrandProfile(entry.modelName);
    const brandPrompt = await loadBrandPrompt(entry.modelName);
    const inputPlan = buildInputPlan(job.inputMode);
    const recipeHash = await computeEntryRecipeHash({ ...job, inputMode: inputPlan.mode }, queue, entry, brandPrompt);
    const initialSlot = run.slots?.[slotId];
    const revisionId = ensureSlotGenerationIdentity(run, initialSlot, entry, stored.generationMemory);
    const outputFileName = ensureGenerationOutputFileName(initialSlot, entry, revisionId);
    const factsJobId = stableHash({ generationId: revisionId, extractorVersion: FACTS_EXTRACTOR_VERSION });
    const inputSourceId = String(entry.inputSourceId || entry.sourceVariantId || entry.sourceId);
    const inputAsset = await getAsset(`watch:${inputSourceId}`);
    if (!inputAsset?.blob) throw new Error(`Входное фото варианта недоступно: ${inputSourceId}`);
    const sourceHash = await sha256Blob(inputAsset.blob);
    if (!sourceHash) throw new Error('Не удалось проверить SHA-256 входного фото');
    await withStateLock(async () => {
      const current = await chrome.storage.local.get(['run', 'generationMemory']);
      const currentSlot = current.run?.slots?.[slotId];
      if (!current.run || current.run.operationId !== runId || current.run.state !== 'RUNNING'
        || currentSlot?.entryId !== entryId || currentSlot.leaseId !== initialSlot?.leaseId) {
        throw new Error('Подготовка ревизии отменена: слот больше не владеет моделью');
      }
      ensureSlotGenerationIdentity(current.run, currentSlot, entry, current.generationMemory);
      currentSlot.outputGroupId = entry.groupId || current.run.groupId;
      currentSlot.outputFileName = outputFileName;
      currentSlot.factsJobId = factsJobId;
      await chrome.storage.local.set({ run: current.run });
    });
    await beginGenerationRevision({
      generationId: revisionId,
      previousGenerationId: initialSlot?.previousGenerationId || null,
      sourceId: entry.sourceId,
      skuKey: entry.skuKey || entry.sourceId,
      sourceVariantId: inputSourceId,
      inputPath: inputAsset.relativePath || entry.relativePath || null,
      sourceHash,
      sourceFingerprint: entry.fingerprint || null,
      modelName: entry.modelName || entry.fileName,
      fileName: entry.fileName,
      outputFileName,
      groupId: entry.groupId,
      operationId: runId,
      leaseId: initialSlot?.leaseId || null,
      slotId: Number(slotId),
      tabId,
      factsJobId,
      recipeHash,
      createdAt: new Date().toISOString(),
      status: 'GENERATING'
    });
    const afterBegin = await getStored();
    const afterBeginSlot = afterBegin.run?.slots?.[slotId];
    if (afterBegin.run?.operationId !== runId || afterBegin.run.state !== 'RUNNING'
      || afterBeginSlot?.entryId !== entryId || afterBeginSlot.leaseId !== initialSlot?.leaseId) {
      await cancelUnsubmittedGenerationRevision(revisionId, entryId, 'slot_reassigned_before_send');
      throw new Error('Подготовка ревизии отменена до отправки промпта');
    }
    const pageJob = {
      prompt: buildGenerationPrompt(job.prompt, entry.modelName, brandPrompt, { inputPlan }),
      modelName: entry.modelName,
      outputFileName,
      inputMode: inputPlan.mode,
      attachmentOrder: [...inputPlan.roles],
      attachmentRefs: { ...inputPlan.refs },
      debugOverlay: job.debugOverlay === true,
      generationTimeoutMs: job.generationTimeoutMs || 900000,
      factsPrompt: buildFactsExtractionPrompt(entry),
      factsExtractorVersion: FACTS_EXTRACTOR_VERSION,
      factsJobId,
      generationId: revisionId,
      buildId: EXTENSION_BUILD_ID
    };
    await sendToTab(tabId, {
      type: 'PREPARE_PAGE_RUN',
      operationId: runId,
      slotId,
      leaseId: initialSlot?.leaseId || null,
      entryId,
      job: pageJob,
      buildId: EXTENSION_BUILD_ID
    });
    await withStateLock(async () => {
      const current = await getStored();
      const live = current.run?.slots?.[slotId];
      if (!current.run || current.run.operationId !== runId || live?.entryId !== entryId || Number(live.tabId) !== Number(tabId)) return;
      live.pageRunAcceptedAt = new Date().toISOString();
      await saveRunAndQueue(current.run, current.queue);
    });
    await appendLog('Страница подготовлена', {
      slotId,
      entryId,
      tabId,
      inputMode: inputPlan.mode,
      attachmentOrder: inputPlan.roles
    });

    const inputPayloadEntries = await Promise.all(inputPlan.roles.map(async (role) => {
      if (role === 'watchReference') {
        const sourceKey = `watch:${entry.inputSourceId || entry.sourceVariantId || entry.sourceId}`;
        const file = await requestInputFile(sourceKey);
        return [role, file, sourceKey];
      }
      const candidates = referenceCandidatesForRole(role, brandProfile).map((key) => `ref:${key}`);
      const selected = await requestInputFileFromCandidates(candidates);
      return [role, selected.file, selected.sourceKey];
    }));
    const inputFiles = Object.fromEntries(inputPayloadEntries.map(([role, file]) => [role, file]));
    try {
      await sendToTab(tabId, { type: 'CACHE_FILES', operationId: runId, entryId, leaseId: ownerLeaseId, files: inputFiles }, 60000);
    } catch (batchError) {
      // Compatibility fallback for a stale tab listener. Still transfer the
      // files concurrently rather than serially role-by-role.
      await Promise.all(inputPayloadEntries.map(([role, file]) => (
        sendToTab(tabId, { type: 'CACHE_FILE', operationId: runId, entryId, leaseId: ownerLeaseId, key: role, file }, 60000)
      )));
    }
    await appendLog('Входные изображения переданы во вкладку', {
      slotId,
      entryId,
      inputMode: inputPlan.mode,
      roles: inputPayloadEntries.map(([role]) => role)
    });

    // Phase 1: prepare every worker in parallel. No global delay is allowed
    // here: attachments and prompt text should be ready as fast as the page
    // can accept them.
    await sendToTab(tabId, {
      type: 'PREPARE_PAGE_CONTENT',
      operationId: runId,
      slotId,
      entryId,
      leaseId: ownerLeaseId
    }, PREPARE_PAGE_TIMEOUT_MS);
    await withStateLock(async () => {
      const current = await getStored();
      const slot = current.run?.slots?.[slotId];
      if (!current.run || current.run.operationId !== runId || slot?.entryId !== entryId || slot.leaseId !== ownerLeaseId || slot.tabId !== tabId) return;
      const rateLimitActive = Number(current.run.rateLimitPauseUntil || 0) > Date.now();
      slot.status = 'READY_TO_SEND';
      slot.phase = rateLimitActive ? SLOT_PHASES.RATE_LIMIT_PAUSE : SLOT_PHASES.WAITING_LAUNCH;
      slot.preparedForSubmit = true;
      if (rateLimitActive) slot.rateLimitRetryNeeded = true;
      slot.preparedAt = new Date().toISOString();
      slot.tabId = tabId;
      slot.recipeHash = recipeHash;
      slot.profileId = brandProfile;
      slot.profileVersion = stableHash(brandPrompt || 'generic');
      slot.lastActivityAt = slot.preparedAt;
      current.run.currentAction = `Подготовлено к Send: ${entry.fileName}`;
      current.run.lastActivityAt = slot.preparedAt;
      await saveRunAndQueue(current.run, current.queue, current.history, current.generationMemory);
      await publishRun(current.run, current.queue);
    });
    await appendLog('Вкладка полностью подготовлена и ждёт только Send', { slotId, entryId, tabId });

    // Phase 2: the only globally serialized operation. The configured pause
    // and rate-limit cooldown apply exclusively between real Send clicks.
    await submitPreparedSlot(runId, slotId, entryId, tabId);
    await appendLog('Send выполнен; изображение отслеживается страницей', { slotId, entryId, tabId });
  } catch (error) {
    const latest = await getStored().catch(() => ({ run: null }));
    const currentSlot = latest.run?.slots?.[slotId];
    if (!latest.run || latest.run.operationId !== runId || !['RUNNING', 'DRAINING'].includes(latest.run.state) || currentSlot?.entryId !== entryId || currentSlot.leaseId !== ownerLeaseId || currentSlot.tabId !== tabId) return;
    const phase = currentSlot?.phase || currentSlot?.status;
    await pauseRunOnError(runId, error, {
      slotId,
      entryId,
      tabId,
      leaseId: ownerLeaseId,
      generationSubmitted: slotGenerationSubmitted(currentSlot),
      errorClass: classifyAutomationError(error, { phase })
    });
  }
}

async function preallocateWorkerTabs(runId, assignments) {
  const pending = (Array.isArray(assignments) ? assignments : []).filter(Boolean);
  if (!pending.length) return;
  const automation = await ensureAutomationWindow(runId);
  const windowId = Number(automation.windowId);
  if (!windowId) throw new Error('Не удалось определить окно для рабочих вкладок');

  const snapshot = await getStored();
  const run = snapshot.run;
  if (!run || run.operationId !== runId || run.state !== 'RUNNING') return;
  const slotTabs = new Map();
  const newlyCreated = [];
  let bootstrapId = automation.owned === true ? Number(automation.initialTabId || 0) : 0;

  await Promise.all(pending.map(async (assignment, index) => {
    const current = await getStored();
    if (current.run?.operationId !== runId || current.run.state !== 'RUNNING'
      || current.run.slots?.[assignment.slot.slotId]?.entryId !== assignment.entry.sourceId) return;
    const slotId = assignment.slot.slotId;
    const knownId = Number(run.slots?.[slotId]?.tabId || 0);
    if (knownId) {
      const existing = await chrome.tabs.get(knownId).catch(() => null);
      if (isAutomationChatTab(existing, windowId)) {
        slotTabs.set(slotId, knownId);
        return;
      }
    }
    if (bootstrapId) {
      const candidate = bootstrapId;
      bootstrapId = 0;
      const bootstrap = await chrome.tabs.get(candidate).catch(() => null);
      if (isAutomationChatTab(bootstrap, windowId)) {
        slotTabs.set(slotId, candidate);
        return;
      }
    }
    const tab = await chrome.tabs.create({ windowId, url: AUTOMATION_URL, active: false });
    if (!tab?.id) throw new Error(`Не удалось создать рабочую вкладку ${index + 1}`);
    newlyCreated.push(tab.id);
    slotTabs.set(slotId, tab.id);
  }));

  let keep = false;
  await withStateLock(async () => {
    const stored = await getStored();
    if (!stored.run || stored.run.operationId !== runId || stored.run.state !== 'RUNNING') return;
    for (const assignment of pending) {
      const slotId = assignment.slot.slotId;
      const slot = stored.run.slots?.[slotId];
      const tabId = slotTabs.get(slotId);
      if (!slot || !tabId) continue;
      slot.tabId = tabId;
      slot.status = 'PREPARING';
      slot.phase = SLOT_PHASES.PREPARING;
      slot.lastActivityAt = new Date().toISOString();
    }
    stored.run.currentAction = `Созданы рабочие вкладки: ${slotTabs.size}`;
    stored.run.lastActivityAt = new Date().toISOString();
    await saveRunAndQueue(stored.run, stored.queue);
    await publishRun(stored.run, stored.queue);
    keep = true;
  });
  if (!keep) await Promise.all(newlyCreated.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  if (!keep) return;

  // Deterministic one-time renderer bootstrap. A background-ready composer
  // needs no activation; pages that mount lazily receive one brief activation.
  for (const assignment of pending) {
    const current = await getStored();
    if (current.run?.operationId !== runId || current.run.state !== 'RUNNING') break;
    const slotId = assignment.slot.slotId;
    const tabId = slotTabs.get(slotId);
    if (!tabId) continue;
    const bootstrap = await bootstrapAutomationTab(tabId, windowId, {
      slotId,
      entryId: assignment.entry.sourceId
    });
    await withStateLock(async () => {
      const stored = await getStored();
      const slot = stored.run?.slots?.[slotId];
      if (!stored.run || stored.run.operationId !== runId || slot?.entryId !== assignment.entry.sourceId) return;
      slot.rendererBootstrappedAt = new Date().toISOString();
      slot.rendererBootstrapVisibility = bootstrap.visibilityState || null;
      slot.lastActivityAt = slot.rendererBootstrappedAt;
      await saveRunAndQueue(stored.run, stored.queue);
    });
  }
}

async function startAssignments(runId, assignments) {
  const active = (Array.isArray(assignments) ? assignments : []).filter(Boolean);
  if (!active.length) return;
  // Allocate all worker tabs first and in parallel. No worker should wait for
  // another worker's page preparation merely to get its tab created.
  try {
    await preallocateWorkerTabs(runId, active);
  } catch (error) {
    const current = await getStored();
    if (current.run?.operationId !== runId || current.run.state === 'PAUSED') return;
    throw error;
  }
  const current = await getStored();
  if (current.run?.operationId !== runId || current.run.state !== 'RUNNING') return;
  for (const assignment of active) {
    void executeSlot(runId, assignment.slot.slotId, assignment.entry.sourceId);
  }
}

async function runDry() {
  const operationId = crypto.randomUUID();
  await chrome.storage.local.set({ logs: [] });
  await updateRuntime({ operationId, state: 'OPENING_CHATGPT_TAB', status: 'DRY RUN', step: '1/2', error: null });
  const window = await chrome.windows.create({
    url: AUTOMATION_URL,
    type: 'normal',
    focused: false
  });
  if (!window?.id) throw new Error('Не удалось открыть окно для DRY RUN');
  const [createdTab] = await chrome.tabs.query({ windowId: window.id }).catch(() => []);
  const tab = window.tabs?.[0] || createdTab
    || await chrome.tabs.create({ windowId: window.id, url: AUTOMATION_URL, active: false });
  try {
    await updateRuntime({ tabId: tab.id });
    await waitTabReady(tab.id);
    await updateRuntime({ state: 'DRY_RUN', step: '2/2' });
    const result = await sendTabMessage(tab.id, { type: 'DRY_RUN' });
    if (!result?.ok) throw new Error(result?.error?.message || 'Dry run failed');
    await appendLog('DRY RUN завершён', { report: result.value });
    await updateRuntime({ state: 'DONE', status: 'DRY RUN PASSED', report: result.value });
    return result.value;
  } finally {
    await chrome.windows.remove(window.id).catch(() => {});
  }
}

async function startRun(options = {}) {
  await assertManualExtensionUpdateNotApplying();
  await waitForStartupReconciliation();
  const requestedIds = Array.isArray(options?.selectedIds)
    ? [...new Set(options.selectedIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  const preferredWindowId = Number(options?.preferredWindowId || 0) || null;
  const preflight = await runPreflight({ selectedIds: requestedIds, validateLaunchSelection: true });
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => check.blocking && !check.ok).map((check) => check.label).join(', ');
    throw new Error(`Предварительная проверка не пройдена: ${failed || 'проверь входные данные'}`);
  }
  const assignments = await withStateLock(async () => {
    const updateLock = await chrome.storage.local.get(['manualExtensionUpdateLock', 'resultsImportJournal']);
    if (updateLock.resultsImportJournal) throw new Error('Завершается импорт результатов');
    if (updateLock.manualExtensionUpdateLock?.active) {
      throw new Error('Установка обновления расширения началась. Дождись её завершения.');
    }
    const stored = await getStored();
    const { job, run: oldRun } = stored;
    let { queue, history, generationMemory } = stored;
    const persistedCatalog = await getAllModelCatalog().catch(() => []);
    if (persistedCatalog.length) {
      queue = { ...(queue || {}), groups: queueGroupsFromCatalog(persistedCatalog, queue?.groups || {}) };
    }
    if (!job?.prompt) throw new Error('Промпт не сохранён');
    const rawFilter = job.filters || parseFilterSelectionId(job.queueGroup) || filterFromQueueGroup(job.queueGroup);
    const filter = normalizeWatchFilter(rawFilter);
    const groupId = groupIdForWatchFilter(filter);
    const runQueueMode = String(job.runQueueMode || '');
    const runPart = Number(job.runPart || 0);
    const filterIsExact = ['in_sale', 'not_in_sale'].includes(String(rawFilter?.saleStatus || ''))
      && ['good', 'bad'].includes(String(rawFilter?.quality || ''))
      && WATCH_BRAND_FILTERS.some((item) => item.id === String(rawFilter?.brand || '') && item.id !== 'all');
    if (!filterIsExact || !['regular', REGENERATION_QUEUE_ID].includes(runQueueMode)) {
      throw new Error('Выбери точную категорию, один бренд и список запуска');
    }
    if (!queue?.groups || !QUEUE_GROUP_IDS.some((groupKey) => Array.isArray(queue.groups[groupKey]))) {
      throw new Error('Очередь не просканирована');
    }
    if (oldRun && ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(oldRun.state)) throw new Error('Есть сохранённый запуск. Продолжи его либо останови перед новым запуском.');
    ({ queue, history, memory: generationMemory } = syncQueueWithHistory(
      queue,
      history,
      generationMemory,
      oldRun
    ));
    await reconcilePersistedCurrentRevisions(queue, history, generationMemory, {
      ...filter,
      runQueueMode
    });
    const repairItems = normalizedRepairQueue(queue).filter((item) => item.status !== 'completed');
    const configuredEntries = groupEntries(queue, groupId);
    const repairIdsForPartition = new Set(repairItems.map((item) => String(item.sourceId)));
    const partitionUniverse = runQueueMode === REGENERATION_QUEUE_ID
      ? configuredEntries.filter((entry) => repairIdsForPartition.has(String(entry.sourceId)))
      : configuredEntries;
    const partitionContext = `${runQueueMode}|${filter.saleStatus}|${filter.quality}|${filter.brand}`;
    const partPlan = queuePartPlan(partitionUniverse, RUN_PART_SIZE, partitionContext);
    const selectedPart = partPlan.parts.find((part) => part.partNumber === runPart) || null;
    if (!Number.isSafeInteger(runPart) || runPart < 1 || !selectedPart
      || String(job.runPartSignature || '') !== partPlan.signature) {
      throw new Error('Выбранная часть очереди устарела. Обнови список и выбери часть заново.');
    }
    const assignedEntries = queueEntriesForPart(partPlan, runPart);
    const explicitSelection = requestedIds.length > 0;
    const runGroupId = runQueueMode === REGENERATION_QUEUE_ID
      ? REGENERATION_QUEUE_ID
      : groupId;
    let entries = explicitSelection
      ? requestedIds.map((sourceId) => assignedEntries.find((entry) => entry.sourceId === sourceId)).filter(Boolean)
      : assignedEntries;
    if (explicitSelection && entries.length !== requestedIds.length) {
      throw new Error('Выбранные модели не входят в назначенную часть очереди');
    }
    if (runQueueMode === REGENERATION_QUEUE_ID) {
      entries = selectRepairQueueEntries(entries, repairItems);
      for (const entry of entries) {
        if (entry.status === 'done') entry.status = 'pending';
      }
    } else {
      entries = excludeRepairQueueEntries(entries, repairItems);
    }
    const inputMode = normalizeInputMode(job.inputMode, DEFAULT_INPUT_MODE);

    // A generated card is valid only for the exact prompt/reference recipe
    // that produced it. Changing the 2/3/4-input mode, the base prompt, a
    // brand profile, a template/Ozon/logo reference or the watch source makes
    // an earlier READY result stale and returns it to the queue.
    for (const entry of entries) {
      if (runQueueMode === REGENERATION_QUEUE_ID) continue;
      if (entry.status !== 'done') continue;
      const expectedRecipeHash = await computeEntryRecipeHash({ ...job, inputMode }, queue, entry);
      if (!expectedRecipeHash) continue;
      if (!entry.recipeHash) {
        // Migration for results created by 0.3.17 and older: their PNG/history
        // was valid, but the recipe hash lived only on the slot and was lost
        // at finalization. Backfill it once so future real prompt changes can
        // still invalidate the result correctly.
        entry.recipeHash = expectedRecipeHash;
        const mem = generationMemory.items?.[entry.sourceId];
        if (mem) mem.recipeHash = expectedRecipeHash;
        const hist = history.items?.[entry.sourceId];
        if (hist) hist.recipeHash = expectedRecipeHash;
        continue;
      }
      if (expectedRecipeHash === entry.recipeHash) continue;
      entry.status = 'pending';
      entry.generatedAt = null;
      entry.outputPath = null;
      entry.outputHash = null;
      entry.outputWidth = null;
      entry.outputHeight = null;
      entry.verificationMode = null;
      entry.lastError = null;
      entry.errorClass = null;
      entry.nextRetryAt = null;
      delete history.items[entry.sourceId];
      history.ignored[entry.sourceId] = true;
      setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'automatic',
        generationStartedAt: null,
        generatedAt: null,
        outputPath: null,
        outputHash: null,
        outputWidth: null,
        outputHeight: null,
        verificationMode: null,
        lastError: null,
        errorClass: null,
        nextRetryAt: null
      });
    }

    const runLimitValue = Number(job.runLimit);
    if (!Number.isSafeInteger(runLimitValue) || runLimitValue < 1 || runLimitValue > RUN_PART_SIZE) {
      throw new Error(`Количество фото за запуск должно быть от 1 до ${RUN_PART_SIZE}`);
    }
    const runLimit = runLimitValue;
    const workerCount = normalizeWorkerCount(job.workerCount, DEFAULT_WORKERS);
    const rateLimitPauseMinutes = normalizeRateLimitPauseMinutes(job.rateLimitPauseMinutes);
    const rateLimitIgnoreMinutes = normalizeRateLimitIgnoreMinutes(job.rateLimitIgnoreMinutes);
    const generationPauseMinutes = normalizeGenerationPauseMinutes(job.generationPauseMinutes);
    const generationJitterSeconds = normalizeGenerationJitterSeconds(job.generationJitterSeconds);
    const coverageMode = 'queue';
    const plannedIds = runQueueMode === REGENERATION_QUEUE_ID
      ? entries.filter((entry) => entry.status !== 'running').slice(0, runLimit).map((entry) => entry.sourceId)
      : (explicitSelection
        ? pendingEntryIdsForFilter(entries, runLimit, 'queue')
        : pendingEntryIdsForFilter(entries, runLimit, coverageMode));
    if (!plannedIds.length) {
      await chrome.storage.local.set({ queue, history, generationMemory });
      throw new Error('По выбранному фильтру нет новых товаров для генерации');
    }
    const run = {
      operationId: crypto.randomUUID(),
      groupId: runGroupId,
      filter,
      filterLabel: runQueueMode === REGENERATION_QUEUE_ID
        ? `Очередь перегенерации брака · ${watchFilterLabel(filter)}`
        : (explicitSelection ? 'Выбранные модели' : watchFilterLabel(filter)),
      coverageMode: explicitSelection ? 'queue' : coverageMode,
      runQueueMode,
      runPart,
      runPartSize: partPlan.partSize,
      runPartCount: partPlan.partCount,
      runPartSignature: partPlan.signature,
      runPartCandidateCount: selectedPart.count,
      runLimit,
      workerCount,
      inputMode,
      rateLimitPauseMinutes,
      rateLimitIgnoreMinutes,
      generationPauseMinutes,
      generationJitterSeconds,
      preferredWindowId,
      automationWindowId: null,
      automationWindowOwned: false,
      state: 'RUNNING',
      status: 'RUNNING',
      error: null,
      stopBlocked: null,
      conversationRecovery: null,
      unresolvedError: false,
      currentAction: 'Запускаю первые генерации',
      lastActivityAt: new Date().toISOString(),
      lastCheckAt: null,
      lastGenerationLaunchAt: null,
      lastAnySendAt: null,
      lastPostprocessSendAt: null,
      rateLimitPauseUntil: null,
      rateLimitPauseStartedAt: null,
      rateLimitReason: null,
      rateLimitIgnoreUntil: null,
      rateLimitIgnoreAfterPause: null,
      rateLimitIgnoredSlots: [],
      plannedIds,
      pendingIds: [...plannedIds],
      repairQueueClaims: runQueueMode === REGENERATION_QUEUE_ID
        ? Object.fromEntries(plannedIds.map((id) => [id, repairItems.find((item) => item.sourceId === id)?.queuedAt || null]))
        : {},
      slots: {},
      factsProgress: {},
      postprocessTabs: {},
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      noProgressSince: null,
      noProgressCycles: 0,
      eventJournal: [],
      eventSequence: 0,
      eventCount: 0,
      diagnosticsPersistedSequence: 0,
      recipeHash: preflight.recipeHash || stableHash({ pipelineVersion: PROMPT_PIPELINE_VERSION, inputMode, prompt: job.prompt, filter, coverageMode, workerCount, runLimit }),
      buildId: EXTENSION_BUILD_ID
    };
    recordRunEvent(run, 'run_started', {
      plannedCount: plannedIds.length,
      workerCount,
      runLimit,
      groupId: run.groupId,
      filterLabel: run.filterLabel,
      runQueueMode,
      runPart,
      runPartCount: partPlan.partCount,
      runPartCandidateCount: selectedPart.count,
      coverageMode: run.coverageMode,
      inputMode,
      generationPauseMinutes,
      generationJitterSeconds,
      rateLimitPauseMinutes,
      preflightOk: true,
      buildId: EXTENSION_BUILD_ID
    });
    const assignments = [];
    for (let slotId = 0; slotId < workerCount; slotId += 1) {
      const entryId = run.pendingIds.shift();
      if (!entryId) break;
      const entry = entries.find((item) => item.sourceId === entryId);
      entry.status = 'running';
      entry.lastError = null;
      entry.errorClass = null;
      entry.nextRetryAt = null;
      setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
        statusSource: 'automatic',
        generationStartedAt: new Date().toISOString(),
        lastError: null,
        lastRunId: run.operationId,
        retryCount: Number(entry.retryCount || 0),
        errorClass: null,
        nextRetryAt: null,
      });
      delete history.items[entry.sourceId];
      history.ignored[entry.sourceId] = true;
      const slot = {
        slotId,
        tabId: null,
        entryId,
        status: 'STARTING',
        phase: SLOT_PHASES.PREPARING,
        leaseId: makeLeaseId(),
        attempt: Number(entry.retryCount || 0) + 1,
        errorClass: null,
        nextRetryAt: null,
        lastHeartbeatAt: new Date().toISOString(),
        lastProbeAt: null,
        lastProgressAt: new Date().toISOString(),
        generationSubmittedAt: null,
        assistantObservedAt: null,
        assistantCount: 0,
        imageCandidate: false,
        imageCandidateSource: null,
        resultFingerprint: null,
        outputFileName: null,
        downloadVerification: null,
        downloadId: null,
        lastEntryName: entry.fileName,
        lastModelName: entry.modelName,
        lastResult: null,
        lastCheckState: null,
        lastCheckError: null,
        checkFailures: 0,
        lastFocusAt: null,
        focusCount: 0,
        launchWaitUntil: null,
        generationGapMs: null,
        finalCheckPending: false,
        finalCheckDeadlineAt: null,
        finalCheckAttempts: 0,
        failed: false,
        rateLimitRetryNeeded: false
      };
      run.slots[slotId] = slot;
      recordRunEvent(run, 'slot_claimed', { slotId, entryId, leaseId: slot.leaseId, attempt: slot.attempt });
      assignments.push({ entry, slot });
    }
    await chrome.storage.local.set({ logs: [] });
    await saveRunAndQueue(run, queue, history, generationMemory);
    await publishRun(run, queue);
    await appendLog(`Запуск очереди: ${watchFilterLabel(filter)}`);
    return { runId: run.operationId, assignments, active: ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state) };
  });
  if (assignments.active) {
    resetLaunchScheduler(assignments.runId);
    inputFilePromiseCache.clear();
    startAuditMonitor();
  }
  await startAssignments(assignments.runId, assignments.assignments);
  return { operationId: assignments.runId };
}

async function pauseRun(reason = 'USER', expectedRunId = null) {
  const result = await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    const history = normalizeHistory(stored.history);
    const generationMemory = normalizeGenerationMemory(stored.generationMemory);
    if (!run || (expectedRunId && run.operationId !== expectedRunId)) return { runId: null, cancelTabIds: [], cancelRevisions: [], observing: false };

    const stateBeforePause = run.state;
    const requestedPauseReason = String(reason || 'USER').toUpperCase();
    const pauseReason = ['ERROR', 'RESTART', 'IMAGE_LIMIT'].includes(requestedPauseReason)
      ? requestedPauseReason
      : 'USER';
    if (pauseReason === 'USER' && run.stalledBatchRecovery?.kind === 'PREPARATION_STALL') {
      run.stalledBatchRecovery.stage = 'MANUAL_PAUSE';
      run.stalledBatchRecovery.dueAt = null;
    }
    recordRunEvent(run, 'run_pause_requested', {
      requestedReason: requestedPauseReason,
      stateBefore: stateBeforePause,
      activeSlotsBefore: activeSlots(run)
    });

    const repairedCompleted = await reconcileRunVerifiedRevisions(run, queue, history, generationMemory);
    if (repairedCompleted) recordRunEvent(run, 'verified_revision_state_repaired', { count: repairedCompleted, reason: 'user-pause' });

    run.state = 'PAUSED';
    run.status = 'PAUSED';
    run.pauseReason = pauseReason;
    // User pause must not erase a platform cooldown. If ChatGPT has already
    // asked us to slow down, Continue must respect the remaining deadline
    // instead of immediately sending a fresh prompt.
    const activeRateLimitUntil = Number(run.rateLimitPauseUntil || 0) > Date.now()
      ? Number(run.rateLimitPauseUntil)
      : 0;
    if (!activeRateLimitUntil) {
      if (Number(run.rateLimitPauseUntil || 0) > 0) {
        armRateLimitIgnoreWindow(run, run.rateLimitPauseStartedAt || run.rateLimitPauseUntil);
      }
      run.rateLimitPauseUntil = null;
      run.rateLimitPauseStartedAt = null;
      run.rateLimitReason = null;
    }
    if (pauseReason !== 'ERROR') run.error = null;
    run.currentAction = pauseReason === 'ERROR'
      ? 'Пауза по защите от повторяющихся ошибок загрузки вложений. Очередь и прогресс сохранены.'
      : activeRateLimitUntil
      ? `Пауза пользователя. Лимит новых запросов действует до ${clockTime(activeRateLimitUntil)}; уже отправленные генерации досматриваются.`
      : 'Пауза: новые запросы не запускаются. Уже отправленные генерации досматриваются и скачиваются.';
    run.lastActivityAt = new Date().toISOString();

    const cancelTabIds = [];
    const cancelRevisions = [];
    let observing = Object.keys(run.postprocessTabs || {}).length > 0
      || Object.keys(run.recoveryTabs || {}).length > 0;
    for (const slot of Object.values(run.slots || {})) {
      if (!slot.entryId) continue;
      const entry = groupEntries(queue, run.groupId).find((item) => item.sourceId === slot.entryId);
      const submitted = slotGenerationSubmitted(slot);

      if (submitted) {
        observing = true;
        slot.status = slot.downloadId ? 'DOWNLOADING' : 'OBSERVING';
        slot.phase = slot.downloadId ? SLOT_PHASES.DOWNLOADING : SLOT_PHASES.OBSERVING;
        slot.finalCheckPending = !slot.downloadId && Boolean(slot.tabId);
        slot.finalCheckDeadlineAt = slot.downloadId
          ? null
          : (slot.tabId
            ? (Number(slot.finalCheckDeadlineAt || 0) > Date.now() ? slot.finalCheckDeadlineAt : finalCheckDeadline())
            : null);
        slot.finalCheckAttempts = Number(slot.finalCheckAttempts || 0);
        slot.failed = false;
        if (!slot.tabId) slot.lastCheckError = 'Запрос уже отправлен, вкладка недоступна; запись сохранена для сверки без повторной генерации.';
        if (entry && entry.status !== 'done') {
          entry.status = 'running';
          setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
            statusSource: 'automatic',
            generationStartedAt: slot.generationSubmittedAt || slot.lastActivityAt || new Date().toISOString(),
            lastError: null,
            lastRunId: run.operationId
          });
        }
        continue;
      }

      if (slot.tabId) cancelTabIds.push(slot.tabId);
      if (slot.generationId) cancelRevisions.push({ generationId: slot.generationId, sourceId: slot.entryId });
      if (entry && entry.status !== 'done') {
        entry.status = 'pending';
        setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic',
          generationStartedAt: null,
          lastError: entry.lastError || null,
          lastRunId: run.operationId
        });
      }
      slot.tabId = null;
      slot.entryId = null;
      slot.status = 'IDLE';
      slot.phase = SLOT_PHASES.IDLE;
      slot.downloadId = null;
      slot.launchWaitUntil = null;
      slot.finalCheckPending = false;
      slot.finalCheckDeadlineAt = null;
      slot.finalCheckAttempts = 0;
      slot.failed = false;
      slot.rateLimitRetryNeeded = false;
      slot.lastCheckState = null;
      slot.lastCheckError = null;
      slot.lastCheckAt = null;
      Object.assign(slot, freshSlotRevisionFields());
    }

    const entries = groupEntries(queue, run.groupId);
    const plannedIds = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
    const protectedIds = new Set(Object.values(run.slots || {}).filter((slot) => slot.entryId).map((slot) => slot.entryId));
    run.pendingIds = entries
      .filter((entry) => plannedIds.has(entry.sourceId) && entry.status !== 'done' && !protectedIds.has(entry.sourceId))
      .map((entry) => entry.sourceId);
    run.status = observing ? 'PAUSED_RECOVERING' : (pauseReason === 'ERROR' ? 'PAUSED_ON_ERROR' : 'PAUSED');
    recordRunEvent(run, 'run_pause_applied', {
      requestedReason: requestedPauseReason,
      pauseReason: run.pauseReason,
      stateBefore: stateBeforePause,
      stateAfter: run.state,
      observing,
      submittedSlots: Object.values(run.slots || {}).filter(slotGenerationSubmitted).length,
      requeuedUnsubmittedSlots: cancelTabIds.length,
      pendingCount: run.pendingIds.length,
      preservedRateLimitUntil: activeRateLimitUntil || null
    });

    await saveRunAndQueue(run, queue, history, generationMemory);
    await appendLog(pauseReason === 'ERROR' ? 'Прогон приостановлен защитой от повторяющихся ошибок' : 'Пауза пользователя', {
      pauseReason, observing, cancelledUnsubmittedTabs: cancelTabIds.length
    });
    await publishRun(run, queue);
    return { runId: run.operationId, cancelTabIds, cancelRevisions, observing };
  });

  await Promise.all(result.cancelRevisions.map(({ generationId, sourceId }) => (
    cancelUnsubmittedGenerationRevision(generationId, sourceId, 'user_pause_before_send')
  )));

  await Promise.all(result.cancelTabIds.map(async (tabId) => {
    // These slots have no submitted generation. Removing their owned tab is
    // sufficient cancellation and avoids waiting on an unresponsive renderer.
    await chrome.tabs.remove(tabId).catch(() => null);
  }));
  if (result.observing) startAuditMonitor();
  if (result.runId) await closeAutomationWindowIfEmpty(result.runId);
}

async function stopRun() {
  await setUserStopReloadBoundary(true).catch(() => {});
  try {
  const snapshot = await withStateLock(async () => {
    const stored = await getStored();
    if (stored.run) {
      stopRunClock(stored.run, Date.now());
      if (stored.run.stalledBatchRecovery?.kind === 'PREPARATION_STALL') {
        stored.run.stalledBatchRecovery.stage = 'MANUAL_PAUSE';
        stored.run.stalledBatchRecovery.dueAt = null;
      }
      recordRunEvent(stored.run, 'run_stop_requested', {
        stateBefore: stored.run.state,
        submittedUnfinishedCount: Object.values(stored.run.slots || {}).filter((slot) => (
          slot.entryId && slotGenerationSubmitted(slot)
        )).length
      });
      await saveRunAndQueue(stored.run, stored.queue);
      await publishRun(stored.run, stored.queue);
    }
    return { run: stored.run, queue: stored.queue };
  });
  const { run, queue } = snapshot;
  const entries = run ? groupEntries(queue, run.groupId) : [];
  const plannedIds = new Set(Array.isArray(run?.plannedIds) ? run.plannedIds : []);
  const runTotal = plannedIds.size;
  const runCompleted = entries.filter((entry) => plannedIds.has(entry.sourceId) && entry.status === 'done').length;
  const unsaved = run ? (await Promise.all(Object.values(run.slots || {}).map(async (slot) => {
    if (!slot.entryId || !slotGenerationSubmitted(slot)) return null;
    const entry = entries.find((item) => item.sourceId === slot.entryId);
    if (entry?.status === 'done') return null;
    const revision = slot.generationId
      ? await getGenerationRevision(slot.generationId).catch(() => null)
      : null;
    return revision?.outputPath && /^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))
      ? null : slot;
  }))).filter(Boolean) : [];
  if (unsaved.length) {
    const message = `Стоп временно заблокирован: ${unsaved.length} отправленных генераций ещё без сохранённого PNG. Нажми «Продолжить» для сверки результатов или кнопку «Сброс» внизу, чтобы сохранить готовые файлы и вернуть незавершённые модели в очередь.`;
    await withStateLock(async () => {
      const stored = await getStored();
      if (!stored.run || stored.run.operationId !== run?.operationId) return;
      stored.run.stopBlocked = { count: unsaved.length, at: new Date().toISOString(), message };
      stored.run.currentAction = message;
      recordRunEvent(stored.run, 'run_stop_blocked', {
        unsavedSubmittedCount: unsaved.length,
        slotIds: unsaved.map((slot) => Number(slot.slotId)),
        reason: 'submitted_generations_missing_verified_png'
      });
      await saveRunAndQueue(stored.run, stored.queue);
      await publishRun(stored.run, stored.queue);
    });
    throw new Error(message);
  }
  await withStateLock(async () => {
    const stored = await getStored();
    if (!stored.run || stored.run.operationId !== run?.operationId) return;
    recordRunEvent(stored.run, 'run_stop_accepted', {
      plannedCount: runTotal,
      completedCount: runCompleted,
      pendingCount: Math.max(0, runTotal - runCompleted),
      salvageReady: true
    });
    await saveRunAndQueue(stored.run, stored.queue);
  });
  const result = await resetRunAndRescan({
    reason: 'Пользователь остановил генерацию',
    automatic: false,
    salvageReady: true,
    preserveLogs: true
  });
  const stoppedAt = Date.now();
  const stoppedElapsedMs = run ? elapsedRunClock(run, stoppedAt) : null;
  await updateRuntime({
    operationId: null,
    state: 'STOPPED',
    status: 'STOPPED',
    startedAt: run?.startedAt || null,
    finishedAt: new Date(stoppedAt).toISOString(),
    ...(run ? {
      clockVersion: Number(run.clockVersion || 1),
      clockAccumulatedMs: Math.max(0, Number(run.clockAccumulatedMs || 0)),
      clockActiveSinceMs: null,
      clockStopped: true,
      elapsedMs: stoppedElapsedMs
    } : {}),
    runTotal,
    runCompleted,
    runRemaining: Math.max(0, runTotal - runCompleted),
    slots: [],
    factsJobs: [],
    currentAction: 'Генерация остановлена. Подтверждённые результаты сохранены; незавершённые модели доступны для нового запуска.',
    stopBlocked: null,
    conversationRecovery: null,
    error: null
  });
  return result;
  } catch (error) {
    await setUserStopReloadBoundary(false).catch(() => {});
    throw error;
  }
}

async function setUserStopReloadBoundary(pending) {
  const stored = await chrome.storage.local.get('devAutoReload');
  const marker = stored.devAutoReload || {};
  await chrome.storage.local.set({
    devAutoReload: {
      ...marker,
      userStopPending: pending === true,
      userStopRequestedAt: pending === true ? new Date().toISOString() : null
    }
  });
}

async function startOrResumeRun(options = {}) {
  await assertManualExtensionUpdateNotApplying();
  await waitForStartupReconciliation();
  const intent = String(options.intent || '').toLowerCase();
  const { run } = await getStored();

  if (intent === 'start') {
    if (run && ['PAUSED', 'STOPPED'].includes(run.state)) {
      throw new Error('Есть сохранённая сессия. Нажми «Сбросить сессию и пересканировать», если нужен новый чистый запуск, либо «Продолжить» для старого.');
    }
    return startRun(options);
  }

  if (run && ['PAUSED', 'STOPPED'].includes(run.state)) {
    // Continue always resumes the exact persisted plan. New selections are not
    // silently substituted into an old run; use Reset + fresh Start for that.
    return resumeRun(options);
  }
  return startRun(options);
}

function allQueueEntries(queue) {
  return QUEUE_GROUP_IDS.flatMap((groupId) => groupEntries(queue, groupId));
}

function findQueueEntry(queue, sourceId) {
  return allQueueEntries(queue).find((entry) => entry.sourceId === sourceId) || null;
}

function applyGenerationMemoryStatusChange(queue, history, generationMemory, sourceId, status, overrides = {}) {
  const entry = findQueueEntry(queue, sourceId);
  const existing = generationMemory.items[sourceId] || null;
  if (!entry && !existing) return false;
  const normalized = normalizeGenerationMemoryStatus(status);
  const record = entry
    ? generationMemoryRecordFromEntry(entry, {
      ...(existing || {}),
      sourcePresent: true
    })
    : existing;
  if (!record) return false;
  const manualStatusChange = (overrides.statusSource || 'manual') === 'manual';

  if (entry) {
    entry.status = queueStatusForGenerationMemoryStatus(normalized);
    if (normalized === GENERATION_MEMORY_STATUSES.READY
      || normalized === GENERATION_MEMORY_STATUSES.RUNNING) {
      entry.errorClass = null;
      entry.nextRetryAt = null;
    } else if (manualStatusChange || overrides.errorClass !== undefined || overrides.nextRetryAt !== undefined) {
      entry.errorClass = overrides.errorClass ?? null;
      entry.nextRetryAt = overrides.nextRetryAt ?? null;
    }
    if (normalized === GENERATION_MEMORY_STATUSES.READY) {
      entry.generatedAt = existing?.generatedAt || entry.generatedAt || new Date().toISOString();
      entry.outputPath = existing?.outputPath || entry.outputPath || null;
      entry.lastError = null;
    } else {
      entry.generatedAt = null;
      entry.outputPath = null;
      entry.lastError = overrides.lastError || null;
    }
  }
  setGenerationMemoryRecordStatus(generationMemory, {
    ...record,
    ...(entry ? {
      sourcePresent: true,
      groupId: entry.groupId,
      relativePath: entry.relativePath,
      fileName: entry.fileName,
      modelName: entry.modelName,
      outputFileName: entry.outputFileName,
      fingerprint: entry.fingerprint,
      retryCount: Number(entry.retryCount || record.retryCount || 0)
    } : {})
  }, normalized, {
    statusSource: overrides.statusSource || 'manual',
    generationStartedAt: overrides.generationStartedAt ?? (normalized === GENERATION_MEMORY_STATUSES.RUNNING ? new Date().toISOString() : null),
    generatedAt: overrides.generatedAt ?? (normalized === GENERATION_MEMORY_STATUSES.READY ? (existing?.generatedAt || entry?.generatedAt || new Date().toISOString()) : null),
    outputPath: overrides.outputPath ?? (normalized === GENERATION_MEMORY_STATUSES.READY ? (existing?.outputPath || entry?.outputPath || null) : null),
    lastError: overrides.lastError ?? (normalized === GENERATION_MEMORY_STATUSES.READY ? null : null),
    errorClass: overrides.errorClass ?? (manualStatusChange ? null : undefined),
    nextRetryAt: overrides.nextRetryAt ?? (manualStatusChange ? null : undefined),
    lastRunId: overrides.lastRunId ?? null,
    retryCount: overrides.retryCount ?? Number(entry?.retryCount || existing?.retryCount || 0),
    sourcePresent: entry ? true : (existing?.sourcePresent ?? false)
  });

  if (normalized === GENERATION_MEMORY_STATUSES.READY) {
    delete history.ignored[sourceId];
    if (entry) {
      history.items[sourceId] = historyRecordFromEntry(entry, {
        generatedAt: generationMemory.items[sourceId].generatedAt || undefined,
        outputPath: generationMemory.items[sourceId].outputPath || null
      });
    } else if (!history.items[sourceId]) {
      history.items[sourceId] = {
        sourceId,
        groupId: record.groupId || null,
        relativePath: record.relativePath || null,
        fileName: record.fileName || null,
        modelName: record.modelName || null,
        outputFileName: record.outputFileName || null,
        fingerprint: record.fingerprint || null,
        generatedAt: generationMemory.items[sourceId].generatedAt || new Date().toISOString(),
        outputPath: generationMemory.items[sourceId].outputPath || null
      };
    }
  } else {
    delete history.items[sourceId];
    // Ignore an old file with the same output name until a fresh download
    // records this source as ready. This makes manual re-generation reliable.
    history.ignored[sourceId] = true;
  }
  return true;
}

async function importGenerationMemorySnapshot(snapshot = {}) {
  return withStateLock(async () => {
    const stored = await getStored();
    const run = stored.run;
    if (run && ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) {
      throw new Error('Сначала останови активный прогон, затем импортируй память');
    }
    const queue = stored.queue || { groups: {} };
    const history = normalizeHistory(stored.history);
    const incoming = normalizeGenerationMemory(snapshot?.generationMemory || snapshot);
    const current = normalizeGenerationMemory(stored.generationMemory);
    let count = 0;
    for (const [sourceId, record] of Object.entries(incoming.items || {})) {
      if (!record?.sourceId && !sourceId) continue;
      const id = String(record.sourceId || sourceId);
      const status = normalizeGenerationMemoryStatus(record.status);
      current.items[id] = generationMemoryRecordFromEntry({ ...record, sourceId: id }, {
        ...current.items[id],
        ...record,
        sourceId: id,
        status,
        statusSource: 'manual',
        updatedAt: new Date().toISOString()
      });
      count += 1;
    }
    const synced = syncQueueWithHistory(queue, history, current, run);
    await saveRunAndQueue(run || null, synced.queue, synced.history, synced.memory);
    if (run) await publishRun(run, synced.queue);
    await appendLog(`Память импортирована: ${count} записей`);
    return { count };
  });
}

async function resultsTransferRequest(route, { method = 'GET', body = null, id = '' } = {}) {
  const identity = await getDevControlClientIdentity();
  const query = new URLSearchParams({ ...identity, id });
  const response = await fetchWithTimeout(`http://127.0.0.1:17321/results-transfer/${route}?${query}`, {
    method, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  }, 30000);
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'Ошибка локального сервиса передачи результатов');
  return payload.value;
}

async function prepareResultsExport(operationId = '') {
  const revisions = (await getAllGenerationRevisions()).filter((record) => transferableRevision(record)
    && (!operationId || record.operationId === operationId));
  if (!revisions.length) throw new Error('Нет сохранённых результатов для выбранного прогона');
  return resultsTransferRequest('export', { method: 'POST', body: { records: revisions } });
}

async function completeResultsImport() {
  return withStateLock(async () => {
    const { resultsImportJournal: journal } = await chrome.storage.local.get('resultsImportJournal');
    if (!journal) return { skipped: true };
    const installed = await resultsTransferRequest('verify', { id: journal.id });
    const stored = await getStored();
    if (runHasActiveAutomationWork(stored.run)) throw new Error('Импорт ожидает завершения активного прогона');
    const [revisions, savedCatalog] = await Promise.all([getAllGenerationRevisions(), getAllModelCatalog({ includeRemoved: true })]);
    const catalog = savedCatalog.length ? savedCatalog : modelCatalogRecordsFromGroups(stored.queue?.groups || {});
    const plan = planResultsMerge(installed.items, { ...stored, revisions, catalog });
    if (!savedCatalog.length) plan.models = [...new Map([...catalog, ...plan.models].map((model) => [model.skuKey, model])).values()];
    const summary = journal.summary || plan.summary;
    await chrome.storage.local.set({ resultsImportJournal: { ...journal, phase: 'database', summary } });
    await mergeResultsDatabase(plan);
    await saveRunAndQueue(stored.run || null, plan.queue, plan.history, plan.generationMemory);
    await chrome.storage.local.set({ lastResultsImport: { id: journal.id, completedAt: new Date().toISOString(), summary } });
    await chrome.storage.local.remove('resultsImportJournal');
    await resultsTransferRequest('finish', { id: journal.id, method: 'POST' }).catch(() => {});
    return summary;
  });
}

async function importInstalledResults(id) {
  const job = await resultsTransferRequest('status', { id });
  if (job.kind !== 'import' || job.phase !== 'installed') throw new Error('Сначала дождись установки PNG в папку результатов');
  await withStateLock(async () => {
    const stored = await getStored();
    const locks = await chrome.storage.local.get(['resultsImportJournal', 'manualExtensionUpdateLock']);
    if (runHasActiveAutomationWork(stored.run)) throw new Error('Перед импортом заверши или сбрось активный прогон');
    if (locks.manualExtensionUpdateLock?.active) throw new Error('Сначала дождись установки обновления расширения');
    if (locks.resultsImportJournal && locks.resultsImportJournal.id !== id) throw new Error('Сначала заверши предыдущий импорт');
    await chrome.storage.local.set({ resultsImportJournal: { ...(locks.resultsImportJournal || {}), id,
      items: job.items, startedAt: locks.resultsImportJournal?.startedAt || new Date().toISOString() } });
  });
  return completeResultsImport();
}

async function claimResultsImport(id) {
  const job = await resultsTransferRequest('status', { id });
  if (job.kind !== 'import' || !job.items || !['ready', 'installing', 'installed', 'error'].includes(job.phase)) throw new Error('Сначала проверь архив результатов');
  return withStateLock(async () => {
    const stored = await getStored();
    const locks = await chrome.storage.local.get(['resultsImportJournal', 'manualExtensionUpdateLock']);
    if (runHasActiveAutomationWork(stored.run)) throw new Error('Перед импортом заверши или сбрось активный прогон');
    if (locks.manualExtensionUpdateLock?.active) throw new Error('Дождись установки обновления расширения');
    if (locks.resultsImportJournal && locks.resultsImportJournal.id !== id) throw new Error('Завершается предыдущий импорт');
    if (!locks.resultsImportJournal) await chrome.storage.local.set({ resultsImportJournal: { id, startedAt: new Date().toISOString() } });
    return { id };
  });
}

async function resultsTransferInfo() {
  const [revisions, stored, pending, identity] = await Promise.all([getAllGenerationRevisions(), getStored(),
    chrome.storage.local.get(['resultsImportJournal', 'lastResultsImport']), getDevControlClientIdentity()]);
  const eligible = revisions.filter(transferableRevision);
  const runs = new Map();
  for (const record of eligible) {
    const id = String(record.operationId || '');
    if (!id) continue;
    const old = runs.get(id) || { id, count: 0, date: record.completedAt || record.generatedAt || record.downloadedAt || '' };
    old.count++; runs.set(id, old);
  }
  return { identity, count: eligible.length, runs: [...runs.values()].sort((a, b) => b.date.localeCompare(a.date)),
    active: runHasActiveAutomationWork(stored.run), pendingId: pending.resultsImportJournal?.id || null,
    lastImport: pending.lastResultsImport || null };
}

async function fastRuntimeState() {
  // Status polling must never run syncQueueWithHistory, read the multi-thousand
  // item queue, or enter stateChain. publishRun already stores compact slot and
  // facts summaries in `runtime`; that snapshot is exactly what the live panel
  // needs between full refreshes.
  const stored = await chrome.storage.local.get(['runtime', 'logs']);
  const runtime = { ...(stored.runtime || {}), buildId: EXTENSION_BUILD_ID };
  return {
    runtime,
    run: runtime.operationId ? { operationId: runtime.operationId, state: runtime.state || null, pauseReason: runtime.pauseReason || null } : null,
    logs: Array.isArray(stored.logs) ? stored.logs : []
  };
}

async function ensureGenerationMemoryState() {
  return withStateLock(async () => {
    const stored = await getStored();
    let queue = stored.queue || { groups: Object.fromEntries(QUEUE_GROUP_IDS.map((id) => [id, []])) };
    const catalog = await getAllModelCatalog().catch(() => []);
    if (catalog.length) {
      queue = { ...queue, groups: queueGroupsFromCatalog(catalog, queue.groups || {}) };
    }
    if (!queue?.groups) {
      // Keep the memory panel usable even before a queue has been created.
      // This also makes records survive an extension update that temporarily
      // restores storage before the input folder is selected again.
      return {
        ...stored,
        history: normalizeHistory(stored.history),
        generationMemory: normalizeGenerationMemory(stored.generationMemory)
      };
    }
    const history = normalizeHistory(stored.history);
    const memory = normalizeGenerationMemory(stored.generationMemory);
    if (catalog.length) {
      await reconcilePersistedCurrentRevisions(queue, history, memory, {
        saleStatus: 'all', quality: 'all', brand: 'all', runQueueMode: 'regular'
      });
    }
    const beforeQueue = JSON.stringify(allQueueEntries(stored.queue || { groups: {} }).map((entry) => [entry.sourceId, entry.status, entry.generatedAt, entry.outputPath, entry.lastError]));
    const synced = syncQueueWithHistory(queue, history, memory, stored.run);
    const afterQueue = JSON.stringify(allQueueEntries(synced.queue).map((entry) => [entry.sourceId, entry.status, entry.generatedAt, entry.outputPath, entry.lastError]));
    const queueChanged = beforeQueue !== afterQueue || JSON.stringify(stored.queue?.groups || {}) !== JSON.stringify(synced.queue.groups || {});
    if (queueChanged || synced.historyChanged || synced.memoryChanged || !stored.generationMemory) {
      await chrome.storage.local.set({
        queue: synced.queue,
        history: synced.history,
        generationMemory: synced.memory
      });
    }
    return {
      ...stored,
      queue: synced.queue,
      history: synced.history,
      generationMemory: synced.memory
    };
  });
}


async function quickProbeReadyResultsBeforeReset(run) {
  if (!run) return { checked: 0, downloadsStarted: 0 };
  const slots = Object.values(run.slots || {}).filter((slot) => slot.entryId && slot.tabId);
  if (!slots.length) return { checked: 0, downloadsStarted: 0 };
  let downloadsStarted = 0;
  await Promise.all(slots.map(async (slot) => {
    try {
      const response = await sendTabMessage(slot.tabId, {
        type: 'CHECK_GENERATION',
        operationId: run.operationId,
        slotId: slot.slotId,
        entryId: slot.entryId,
        leaseId: slot.leaseId || null,
        generationId: slot.generationId || null,
        outputFileName: slot.outputFileName || slot.lastEntryName || null,
        modelName: slot.lastModelName || null,
        submittedAtMs: Date.parse(slot.generationSubmittedAt || '') || 0,
        baselineAssistantCount: Number(slot.baselineAssistantCount || 0),
        recover: Boolean(slot.generationSubmittedAt && slot.generationId && slot.leaseId)
      }, 4000);
      if (response?.ok && ['READY', 'DOWNLOADING'].includes(String(response.value?.state || '').toUpperCase())) {
        downloadsStarted += 1;
      }
    } catch (_) {
      // Reset is intentionally best-effort: an unresponsive/stale tab must
      // never block clearing the session.
    }
  }));
  if (downloadsStarted) {
    await sleep(800);
    await reconcileActiveDownloads().catch(() => {});
  }
  return { checked: slots.length, downloadsStarted };
}

function resetRunAndRescan(options = {}) {
  if (resetRunPromise) return resetRunPromise;
  resetRunPromise = performResetRunAndRescan(options).finally(() => {
    resetRunPromise = null;
  });
  return resetRunPromise;
}

async function resumeInterruptedSessionReset(intent = {}) {
  if (!intent || typeof intent !== 'object') return { skipped: true };
  return resetRunAndRescan({
    reason: `Завершаю прерванный сброс: ${String(intent.reason || 'Сброс сессии')}`,
    automatic: intent.automatic === true,
    salvageReady: intent.salvageReady !== false,
    preserveLogs: intent.preserveLogs === true,
    cleanupTabIds: Array.isArray(intent.cleanupTabIds) ? intent.cleanupTabIds : [],
    cleanupWindowId: Number(intent.cleanupWindowId || 0),
    cleanupWindowOwned: intent.cleanupWindowOwned === true
  });
}

async function performResetRunAndRescan(options = {}) {
  const {
    reason = 'Сессия генерации сброшена пользователем',
    automatic = false,
    salvageReady = true,
    preserveLogs = false,
    cleanupTabIds = [],
    cleanupWindowId = 0,
    cleanupWindowOwned = false
  } = options;

  // Store the reset request before page probing or state-lock waits. If Chrome
  // reloads the extension mid-reset, startup must finish clearing this run
  // rather than treating the previous snapshot as work to resume.
  await chrome.storage.local.set({
    sessionResetIntent: {
      requestedAt: new Date().toISOString(),
      reason,
      automatic,
      salvageReady,
      preserveLogs,
      cleanupTabIds: [...new Set(cleanupTabIds.map((value) => Number(value || 0)).filter((value) => value > 0))],
      cleanupWindowId: Number(cleanupWindowId || 0),
      cleanupWindowOwned
    }
  });

  stopAuditMonitor();
  await updateRuntime({
    state: 'RECONCILING',
    status: automatic ? 'MIGRATING' : 'RESETTING',
    currentAction: automatic
      ? 'Обновляю состояние расширения и сверяю сохранённые ревизии…'
      : 'Сбрасываю временную сессию и сверяю сохранённые ревизии…',
    stopBlocked: null,
    conversationRecovery: null,
    error: null,
    buildId: EXTENSION_BUILD_ID
  });

  const initial = await getStored();
  const initialRun = initial.run;
  if (initialRun?.operationId) {
    recordRunEvent(initialRun, 'session_reset_requested', {
      reason: String(reason),
      automatic: automatic === true,
      salvageReady: salvageReady !== false,
      stateBefore: initialRun.state
    });
    await saveRunAndQueue(initialRun, initial.queue);
  }
  await Promise.all(Object.values(initialRun?.slots || {})
    .filter((slot) => slot.entryId && slot.generationId && !slotGenerationSubmitted(slot))
    .map((slot) => cancelUnsubmittedGenerationRevision(
      slot.generationId, slot.entryId, 'run_stopped_before_send'
    ).catch((error) => appendLog('Не удалось отменить неподанную ревизию', {
      generationId: slot.generationId, sourceId: slot.entryId, error: error.message
    }))));
  const initialRunId = initialRun?.operationId || null;
  const persistedResetIntent = initial.sessionResetIntent || {};
  const automationWindowId = Number(initialRun?.automationWindowId || persistedResetIntent.cleanupWindowId || 0);
  const automationWindowOwned = initialRun?.automationWindowOwned === true
    || persistedResetIntent.cleanupWindowOwned === true;
  const slotTabIds = Object.values(initialRun?.slots || {})
    .map((slot) => Number(slot.tabId || 0))
    .filter((tabId) => tabId > 0);
  const postprocessTabIds = Object.keys(initialRun?.postprocessTabs || {})
    .map((tabId) => Number(tabId || 0))
    .filter((tabId) => tabId > 0);
  const recoveryTabIds = Object.keys(initialRun?.recoveryTabs || {})
    .map((tabId) => Number(tabId || 0))
    .filter((tabId) => tabId > 0);
  const conversationTabIds = (initialRun?.conversationRecovery?.slots || [])
    .flatMap((slot) => [slot.oldTabId, slot.reopenedTabId])
    .concat((initialRun?.conversationRecovery?.closeTabs || []).map((item) => item.tabId))
    .map((tabId) => Number(tabId || 0))
    .filter((tabId) => tabId > 0);
  const stalledBatchTabIds = (initialRun?.stalledBatchRecovery?.closeTabs || [])
    .map((item) => Number(item?.tabId || 0))
    .filter((tabId) => tabId > 0);
  const windowTabs = automationWindowOwned && automationWindowId
    ? await chrome.tabs.query({ windowId: automationWindowId }).catch(() => [])
    : [];
  const ownedTabIds = [...new Set([
    ...(Array.isArray(persistedResetIntent.cleanupTabIds) ? persistedResetIntent.cleanupTabIds : []),
    ...slotTabIds,
    ...postprocessTabIds,
    ...recoveryTabIds,
    ...conversationTabIds,
    ...stalledBatchTabIds,
    ...windowTabs
      .filter((tab) => /^https:\/\/chatgpt\.com\//i.test(tab.url || tab.pendingUrl || ''))
      .map((tab) => Number(tab.id || 0))
      .filter((tabId) => tabId > 0)
  ])];

  // Keep exact cleanup targets durable too. If the worker is terminated after
  // clearing `run` but before closing tabs, its restart can still finish cleanup.
  await chrome.storage.local.set({
    sessionResetIntent: {
      ...persistedResetIntent,
      cleanupTabIds: ownedTabIds,
      cleanupWindowId: automationWindowId,
      cleanupWindowOwned: automationWindowOwned
    }
  });


  let probe = { checked: 0, downloadsStarted: 0 };
  if (initialRun && salvageReady) {
    probe = await quickProbeReadyResultsBeforeReset(initialRun).catch(() => probe);
  }
  await reconcileActiveDownloads().catch(() => {});

  let restoredFromRevisions = 0;
  let resetRecords = 0;
  await withStateLock(async () => {
    const stored = await getStored();
    const queue = stored.queue || {
      version: 1,
      groups: Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => [groupId, []])),
      refs: {}
    };
    const history = normalizeHistory(stored.history);
    const generationMemory = normalizeGenerationMemory(stored.generationMemory);
    const run = stored.run;
    const targetRunId = run?.operationId || initialRunId;
    restoredFromRevisions += await reconcileRunVerifiedRevisions(run, queue, history, generationMemory);
    restoredFromRevisions += await reconcilePersistedCurrentRevisions(queue, history, generationMemory, {
      ...(run?.filters || stored.job?.filters || {}),
      runQueueMode: run?.groupId === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : stored.job?.runQueueMode
    });
    const runEntryIds = new Set([
      ...(Array.isArray(run?.plannedIds) ? run.plannedIds : []),
      ...Object.values(run?.slots || {}).map((slot) => slot.entryId).filter(Boolean)
    ]);

    for (const entry of allQueueEntries(queue)) {
      const memoryRecord = generationMemory.items[entry.sourceId] || null;
      const belongsToResetRun = runEntryIds.has(entry.sourceId)
        || (targetRunId && memoryRecord?.lastRunId === targetRunId)
        || entry.status === 'running';
      if (!belongsToResetRun || entry.status === 'done') continue;
      entry.status = 'pending';
      entry.retryCount = 0;
      entry.lastError = null;
      entry.errorClass = null;
      entry.nextRetryAt = null;
      entry.generationStartedAt = null;
      entry.generatedAt = null;
      entry.outputPath = null;
      entry.outputHash = null;
      entry.outputWidth = null;
      entry.outputHeight = null;
      entry.verificationMode = null;
      setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'automatic',
        generationStartedAt: null,
        generatedAt: null,
        outputPath: null,
        outputHash: null,
        outputWidth: null,
        outputHeight: null,
        verificationMode: null,
        lastError: null,
        lastRunId: null,
        retryCount: 0,
        errorClass: null,
        nextRetryAt: null
      });
      delete history.items[entry.sourceId];
      delete history.ignored[entry.sourceId];
      resetRecords += 1;
    }

    // Older builds could leave memory rows marked RUNNING even after the run
    // object was lost. A session reset must never keep those phantom jobs.
    for (const record of Object.values(generationMemory.items || {})) {
      if (normalizeGenerationMemoryStatus(record.status) !== GENERATION_MEMORY_STATUSES.RUNNING) continue;
      const queueEntry = record.sourceId ? findQueueEntry(queue, record.sourceId) : null;
      if (queueEntry?.status === 'done') {
        const completedStatus = queueEntry.factsStatus === 'ok'
          ? GENERATION_MEMORY_STATUSES.READY
          : (queueEntry.factsStatus === 'pending'
            ? GENERATION_MEMORY_STATUSES.FACTS_PENDING
            : GENERATION_MEMORY_STATUSES.IMAGE_SAVED);
        setGenerationMemoryRecordStatus(generationMemory, record, completedStatus, {
          statusSource: 'automatic',
          generationStartedAt: null,
          generatedAt: queueEntry.generatedAt || record.generatedAt || new Date().toISOString(),
          outputPath: queueEntry.outputPath || record.outputPath || null,
          outputHash: queueEntry.outputHash || record.outputHash || null,
          outputWidth: queueEntry.outputWidth || record.outputWidth || null,
          outputHeight: queueEntry.outputHeight || record.outputHeight || null,
          verificationMode: queueEntry.verificationMode || record.verificationMode || null,
          lastError: null,
          lastRunId: null,
          errorClass: null,
          nextRetryAt: null
        });
        continue;
      }
      setGenerationMemoryRecordStatus(generationMemory, record, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'automatic',
        generationStartedAt: null,
        generatedAt: null,
        outputPath: null,
        outputHash: null,
        outputWidth: null,
        outputHeight: null,
        verificationMode: null,
        lastError: null,
        lastRunId: null,
        retryCount: 0,
        errorClass: null,
        nextRetryAt: null
      });
      if (record.sourceId) {
        delete history.items[record.sourceId];
        delete history.ignored[record.sourceId];
      }
    }

    if (run?.operationId) {
      const planned = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
      const completedCount = allQueueEntries(queue).filter((entry) => planned.has(entry.sourceId) && entry.status === 'done').length;
      const previousState = run.state;
      run.state = 'RESET';
      run.status = automatic ? 'RESET_AUTOMATICALLY' : 'RESET_BY_USER';
      run.pauseReason = 'RESET';
      run.finishedAt = new Date().toISOString();
      run.currentAction = String(reason);
      recordRunEvent(run, 'session_reset_completed', {
        reason: String(reason),
        automatic: automatic === true,
        stateBefore: previousState,
        completedCount,
        plannedCount: planned.size,
        returnedToQueueCount: resetRecords,
        restoredFromRevisions,
        downloadsStartedBeforeReset: probe.downloadsStarted
      });
      await flushRunDiagnosticsSafely(run, queue);
    }

    await chrome.storage.local.set({
      queue,
      history,
      generationMemory,
      run: null,
      ...(preserveLogs ? {} : { logs: [] })
    });
    if (!preserveLogs) await chrome.storage.local.remove('lastDiagnostic');
  });

  await Promise.all(ownedTabIds.map(async (tabId) => {
    await sendTabMessage(tabId, { type: 'STOP' }, 1500).catch(() => null);
    await chrome.tabs.remove(tabId).catch(() => null);
  }));
  if (chrome.alarms?.clear) await chrome.alarms.clear(CONVERSATION_LOAD_RECOVERY_ALARM_NAME).catch(() => {});
  if (chrome.alarms?.clear) await chrome.alarms.clear(STALLED_BATCH_RECOVERY_ALARM_NAME).catch(() => {});
  if (automationWindowOwned && automationWindowId) await chrome.windows.remove(automationWindowId).catch(() => {});

  await updateRuntime({
    operationId: null,
    state: 'IDLE',
    status: 'IDLE',
    queueGroup: null,
    activeSlots: 0,
    completed: 0,
    pending: 0,
    rateLimitPauseUntil: null,
    currentAction: `Сессия сброшена. Состояние восстановлено по сохранённым ревизиям: ${restoredFromRevisions}.`,
    stopBlocked: null,
    conversationRecovery: null,
    error: null,
    buildId: EXTENSION_BUILD_ID
  });
  await chrome.storage.local.remove('sessionResetIntent');
  await appendLog(automatic ? 'Автосброс состояния после обновления расширения' : 'Сессия сброшена и ревизии сверены с памятью приложения', {
    reason,
    oldRunId: initialRunId,
    resetRecords,
    restoredFromRevisions,
    closedTabs: ownedTabIds.length,
    probedTabs: probe.checked,
    downloadsStartedBeforeReset: probe.downloadsStarted,
    buildId: EXTENSION_BUILD_ID
  });

  return {
    ok: true,
    oldRunId: initialRunId,
    resetRecords,
    restoredFromRevisions,
    closedTabs: ownedTabIds.length,
    probedTabs: probe.checked,
    downloadsStartedBeforeReset: probe.downloadsStarted
  };
}

async function clearGenerationHistory() {
  await withStateLock(async () => {
    const { run, queue, history: storedHistory, generationMemory: storedMemory } = await getStored();
    const hasActiveRun = run && ['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(run.state);
    const hasActiveDownload = Object.values(run?.slots || {}).some((slot) => slot.downloadId);
    if (hasActiveRun || hasActiveDownload) {
      throw new Error('Сначала останови текущий запуск и дождись завершения активных скачиваний');
    }
    const nextQueue = queue || {
      version: 1,
      groups: Object.fromEntries(QUEUE_GROUP_IDS.map((groupId) => [groupId, []])),
      refs: {}
    };
    for (const groupId of QUEUE_GROUP_IDS) {
      for (const entry of groupEntries(nextQueue, groupId)) {
        entry.status = 'pending';
        entry.retryCount = 0;
        entry.lastError = null;
        entry.generatedAt = null;
        entry.outputPath = null;
        entry.outputHash = null;
        entry.outputWidth = null;
        entry.outputHeight = null;
        entry.verificationMode = null;
        entry.recipeHash = null;
        entry.profileId = null;
        entry.profileVersion = null;
        entry.attempt = 0;
        entry.errorClass = null;
        entry.nextRetryAt = null;
      }
    }
    const nextHistory = normalizeHistory(storedHistory);
    const nextMemory = normalizeGenerationMemory(storedMemory);
    for (const groupId of QUEUE_GROUP_IDS) {
      for (const entry of groupEntries(nextQueue, groupId)) {
        nextHistory.ignored[entry.sourceId] = true;
      }
    }
    for (const sourceId of Object.keys(nextHistory.items)) {
      nextHistory.ignored[sourceId] = true;
    }
    nextHistory.items = {};
    for (const record of Object.values(nextMemory.items)) {
      setGenerationMemoryRecordStatus(nextMemory, record, GENERATION_MEMORY_STATUSES.NOT_READY, {
        statusSource: 'manual',
        generationStartedAt: null,
        generatedAt: null,
        outputPath: null,
        outputHash: null,
        outputWidth: null,
        outputHeight: null,
        verificationMode: null,
        lastError: null,
        errorClass: null,
        nextRetryAt: null,
        lastRunId: null,
        retryCount: 0
      });
      if (record?.sourceId) nextHistory.ignored[record.sourceId] = true;
    }
    await chrome.storage.local.set({
      queue: nextQueue,
      history: nextHistory,
      generationMemory: nextMemory,
      run: null,
      logs: []
    });
    await chrome.storage.local.remove('lastDiagnostic');
    await updateRuntime({
      operationId: null,
      state: 'IDLE',
      status: 'IDLE',
      queueGroup: null,
      activeSlots: 0,
      completed: 0,
      pending: 0,
      error: null
    });
    await appendLog('История сгенерированных карточек очищена');
  });
}

function errorContextMatchesSlot(run, context = {}) {
  if (context.slotId == null && !context.entryId && !context.tabId) return true;
  const slot = context.slotId == null
    ? Object.values(run?.slots || {}).find((item) => item.entryId === context.entryId)
    : run?.slots?.[context.slotId];
  return Boolean(slot?.entryId)
    && (!context.entryId || slot.entryId === context.entryId)
    && (!context.tabId || Number(slot.tabId) === Number(context.tabId))
    && (!context.leaseId || slot.leaseId === context.leaseId);
}

async function pauseRunOnError(runId, error, context = {}) {
  const owner = (await getStored()).run;
  if (!owner || owner.operationId !== runId || !errorContextMatchesSlot(owner, context)) return;
  const rateLimitFailure = context.rateLimit === true
    || context.errorClass === AUTOMATION_ERROR_CLASSES.RATE_LIMIT
    || classifyAutomationError(error, context) === AUTOMATION_ERROR_CLASSES.RATE_LIMIT;

  if (isUserPauseCancellation(error?.message)) {
    const { run } = await getStored();
    if (run?.operationId === runId && run.state === 'PAUSED'
      && ['USER', 'IMAGE_LIMIT'].includes(String(run.pauseReason || '').toUpperCase())) {
      await appendLog('Отложенная операция завершилась штатно после пользовательской паузы', {
        slotId: context.slotId ?? null,
        entryId: context.entryId ?? null
      });
      return;
    }
  }

  // A rate-limit modal is a shared send gate, not a failed product. Keep the
  // current source assigned to its slot and let downloads/audits continue.
  // The slot is retried after the global cooldown if the prompt had not been
  // submitted yet. This prevents a modal in one tab from consuming the item
  // and replacing it with a different queue entry.
  if (rateLimitFailure) {
    const imageResumeAt = imageLimitResumeAt(error?.message || context.message);
    if (imageResumeAt) {
      void pauseForImageLimit(runId, {
        slotId: context.slotId, tabId: context.tabId,
        text: error?.message || context.message || ''
      }, imageResumeAt).catch((limitError) => appendLog('Ошибка обработки лимита изображений', { error: limitError.message }));
      return;
    }
    const ignoreLimit = await ignoreRateLimitDuringWindow(runId, {
      slotId: context.slotId,
      tabId: context.tabId,
      text: error?.message || context.message || 'Слишком много запросов'
    });
    if (ignoreLimit) {
      let retry = null;
      await withStateLock(async () => {
        const stored = await getStored();
        const { run, queue } = stored;
        const slot = run?.operationId === runId ? run.slots?.[context.slotId] : null;
        if (!run || run.state !== 'RUNNING' || !slot?.entryId
          || (context.entryId && slot.entryId !== context.entryId)) return;
        const submitted = slotGenerationSubmitted(slot) || context.generationSubmitted === true;
        slot.lastRateLimitIgnoredAt = new Date().toISOString();
        if (submitted) {
          slot.status = 'OBSERVING';
          slot.phase = SLOT_PHASES.OBSERVING;
          slot.finalCheckPending = true;
          slot.finalCheckDeadlineAt ||= finalCheckDeadline();
        } else {
          slot.preparedForSubmit = slot.preparedForSubmit || context.preparedForSubmit === true;
          if (slot.preparedForSubmit && slot.generationGapMs == null) {
            const retryGap = resolveGenerationPause(null, run.generationPauseMinutes, run.generationJitterSeconds);
            slot.generationGapMs = retryGap.delayMs;
            slot.generationPauseFactor = retryGap.factor;
            slot.generationPauseDirection = retryGap.direction;
            recordRunEvent(run, 'generation_pause_sampled', {
              slotId: slot.slotId,
              entryId: slot.entryId,
              delayMs: retryGap.delayMs,
              factor: retryGap.factor,
              direction: retryGap.direction,
              retryAfterIgnoredRateLimit: true
            });
          }
          slot.status = slot.preparedForSubmit ? 'READY_TO_SEND' : 'STARTING';
          slot.phase = slot.preparedForSubmit ? SLOT_PHASES.WAITING_LAUNCH : SLOT_PHASES.PREPARING;
          slot.rateLimitRetryNeeded = true;
          retry = { slotId: slot.slotId, entryId: slot.entryId, tabId: slot.tabId };
        }
        slot.failed = false;
        slot.errorClass = null;
        slot.lastCheckError = null;
        run.currentAction = 'Сообщение о лимите закрыто в окне игнорирования';
        run.lastActivityAt = new Date().toISOString();
        recordRunEvent(run, 'rate_limit_ignored_retry', {
          slotId: slot.slotId,
          entryId: slot.entryId,
          generationSubmitted: submitted
        });
        await saveRunAndQueue(run, queue);
        await publishRun(run, queue);
      });
      if (retry?.tabId) {
        void submitPreparedSlot(runId, retry.slotId, retry.entryId, retry.tabId)
          .catch((retryError) => pauseRunOnError(runId, retryError, {
            slotId: retry.slotId,
            entryId: retry.entryId,
            tabId: retry.tabId,
            errorClass: classifyAutomationError(retryError)
          }));
      }
      return;
    }
    const retrySlot = await withStateLock(async () => {
      const stored = await getStored();
      const { run, queue } = stored;
      if (!run || run.operationId !== runId || ['STOPPED', 'DONE'].includes(run.state)) return null;
      const directSlot = run.slots?.[context.slotId];
      const slot = (directSlot && (!context.entryId || directSlot.entryId === context.entryId) && directSlot.entryId
        ? directSlot
        : null)
        || Object.values(run.slots || {}).find((item) => context.entryId && item.entryId === context.entryId)
        || Object.values(run.slots || {}).find((item) => context.tabId && item.tabId === context.tabId && item.entryId);
      if (!slot) return null;
      const submitted = Boolean(
        context.generationSubmitted === true
        || slot.generationSubmittedAt
        || slot.finalCheckPending
        || slot.downloadId
        || ['GENERATING', 'WAITING_GENERATION', 'REQUESTING_DOWNLOAD', 'DOWNLOADING', 'OBSERVING'].includes(slot.status)
      );
      const at = new Date().toISOString();
      slot.errorClass = null;
      slot.nextRetryAt = null;
      slot.lastCheckError = null;
      slot.failed = false;
      if (!submitted && context.preparedForSubmit === true) slot.preparedForSubmit = true;
      if (submitted) {
        // The assistant may still finish even though the modal was visible.
        // Preserve an observation lease and let the regular audit/download
        // path handle the result.
        slot.status = 'OBSERVING';
        slot.phase = SLOT_PHASES.OBSERVING;
        slot.finalCheckPending = true;
        slot.finalCheckDeadlineAt = Number(slot.finalCheckDeadlineAt || 0) > Date.now()
          ? slot.finalCheckDeadlineAt
          : finalCheckDeadline();
      } else {
        slot.status = slot.preparedForSubmit ? 'READY_TO_SEND' : 'WAITING_LAUNCH';
        slot.phase = SLOT_PHASES.RATE_LIMIT_PAUSE;
        slot.rateLimitRetryNeeded = true;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
      }
      run.currentAction = submitted
        ? `Лимит: продолжаю проверять ${entryDisplayName(groupEntries(queue, run.groupId).find((entry) => entry.sourceId === slot.entryId), slot)}`
        : `Лимит: подготовлено, отправка ожидает паузу`;
      run.lastActivityAt = at;
      recordRunEvent(run, 'rate_limit_deferred', {
        slotId: slot.slotId,
        entryId: slot.entryId,
        generationSubmitted: submitted
      });
      await saveRunAndQueue(run, queue);
      await publishRun(run, queue);
      return submitted ? null : { slotId: slot.slotId, entryId: slot.entryId };
    });
    await pauseNewLaunchesForRateLimit(runId, {
      slotId: context.slotId,
      tabId: context.tabId,
      text: error?.message || context.message || 'Слишком много запросов'
    });
    await appendLog('Лимит обработан как общая пауза отправки; текущий слот сохранён', {
      slotId: context.slotId ?? null,
      entryId: context.entryId ?? null,
      retryAfterPause: Boolean(retrySlot)
    });
    return;
  }

  const result = await withStateLock(async () => {
    const stored = await getStored();
    const { run, queue } = stored;
    const history = normalizeHistory(stored.history);
    const generationMemory = normalizeGenerationMemory(stored.generationMemory);
    if (!run || run.operationId !== runId || ['STOPPED', 'DONE'].includes(run.state)
      || !errorContextMatchesSlot(run, context)) return { tabIds: [] };
    const failure = {
      message: error?.message || String(error),
      at: new Date().toISOString(),
      ...context,
      errorClass: context.errorClass || classifyAutomationError(error, context)
    };
    const terminalResponseClasses = new Set([
      AUTOMATION_ERROR_CLASSES.TEXT_ONLY,
      AUTOMATION_ERROR_CLASSES.CLARIFICATION_REQUIRED,
      AUTOMATION_ERROR_CLASSES.MODEL_REFUSAL,
      AUTOMATION_ERROR_CLASSES.TOOL_UNAVAILABLE
    ]);
    const terminalResponse = context.terminalResponse === true || terminalResponseClasses.has(failure.errorClass);
    run.errors = [...(run.errors || []), failure].slice(-20);
    const attachmentFailureCircuitBreaker = shouldTripAttachmentFailureCircuitBreaker(run, failure);
    const pauseForError = context.globalNoProgress === true || attachmentFailureCircuitBreaker;
    run.error = pauseForError ? failure : (run.error || failure);
    const preservePause = run.state === 'PAUSED'
      && ['USER', 'RESTART', 'IMAGE_LIMIT', 'ERROR'].includes(String(run.pauseReason || '').toUpperCase());
    run.state = (pauseForError || preservePause) ? 'PAUSED' : 'RUNNING';
    run.status = pauseForError
      ? 'PAUSED_ON_ERROR'
      : (preservePause ? 'PAUSED_WITH_ERRORS' : 'RUNNING_WITH_ERRORS');
    if (pauseForError) run.pauseReason = 'ERROR';
    const directSlot = run.slots?.[context.slotId];
    const failedSlot = (directSlot && (!context.entryId || directSlot.entryId === context.entryId) && directSlot.entryId
      ? directSlot
      : null)
      || Object.values(run.slots || {}).find((slot) => context.entryId && slot.entryId === context.entryId)
      || Object.values(run.slots || {}).find((slot) => context.tabId && slot.tabId === context.tabId && slot.entryId);
    const contextEntry = groupEntries(queue, run.groupId).find((item) => item.sourceId === context.entryId);
    if (!failedSlot && contextEntry?.status === 'done') return { tabIds: [] };
    if (!failedSlot) run.unresolvedError = true;
    const tabIds = [];
    const generationWasStarted = Boolean(
      !terminalResponse && !context.tabClosed && !context.rateLimitBeforeAssistant && failedSlot && (
        (context.generationSubmitted === true && !failedSlot.preparedForSubmit) ||
        slotGenerationSubmitted(failedSlot) ||
        currentSlotSendClicked(failedSlot) ||
        failedSlot.downloadId ||
        context.downloadId != null
      )
    );
    const duplicateFailure = failedSlot
      && failedSlot.finalCheckPending
      && failedSlot.lastCheckError === failure.message;
    if (failedSlot) {
      const failedEntry = groupEntries(queue, run.groupId).find((item) => item.sourceId === failedSlot.entryId);
      if (!duplicateFailure) {
        if (failedSlot.tabId != null) tabIds.push(failedSlot.tabId);
        if (failedSlot.entryId) {
          if (failedEntry && failedEntry.status !== 'done') {
            failedEntry.status = 'error';
            failedEntry.autoRetryPending = !generationWasStarted;
            failedEntry.retryCount = Number(failedEntry.retryCount || 0) + 1;
            failedEntry.lastError = failure.message;
            failedEntry.errorClass = failure.errorClass;
            failedEntry.nextRetryAt = new Date(Date.now() + retryDelayMs(
              failure.errorClass,
              failedEntry.retryCount,
              randomInt(0, 1000) / 1000
            )).toISOString();
            const retryAt = failedEntry.nextRetryAt;
            setGenerationMemoryStatus(
              generationMemory,
              failedEntry,
              generationWasStarted && failedSlot.tabId != null ? GENERATION_MEMORY_STATUSES.RUNNING : GENERATION_MEMORY_STATUSES.NOT_READY,
              {
                statusSource: 'automatic',
                generationStartedAt: generationWasStarted && failedSlot.tabId != null
                  ? (failedSlot.lastActivityAt || failure.at)
                  : null,
                lastError: failure.message,
                lastRunId: runId,
                retryCount: Number(failedEntry.retryCount || 0),
                errorClass: failure.errorClass,
                nextRetryAt: retryAt
              }
            );
          }
        }
        failedSlot.lastEntryName = failedEntry?.fileName || failedSlot.lastEntryName;
        failedSlot.lastModelName = failedEntry?.modelName || failedSlot.lastModelName;
        failedSlot.lastResult = 'ERROR';
        failedSlot.lastCheckState = 'ERROR';
        failedSlot.lastCheckError = failure.message;
        failedSlot.lastCheckAt = failure.at;
        failedSlot.errorClass = failure.errorClass;
        failedSlot.nextRetryAt = failedEntry?.nextRetryAt
          || new Date(Date.now() + retryDelayMs(failure.errorClass, failedEntry?.retryCount || 1, randomInt(0, 1000) / 1000)).toISOString();
        failedSlot.status = generationWasStarted && failedSlot.tabId != null ? 'OBSERVING' : 'PAUSED';
        failedSlot.phase = generationWasStarted && failedSlot.tabId != null ? SLOT_PHASES.OBSERVING : SLOT_PHASES.RETRY_BACKOFF;
        failedSlot.downloadId = null;
        failedSlot.finalCheckPending = generationWasStarted && failedSlot.tabId != null;
        failedSlot.finalCheckDeadlineAt = failedSlot.finalCheckPending
          ? (Number(failedSlot.finalCheckDeadlineAt || 0) > Date.now() ? failedSlot.finalCheckDeadlineAt : finalCheckDeadline())
          : null;
        failedSlot.finalCheckAttempts = 0;
        failedSlot.failed = generationWasStarted && failedSlot.tabId != null;
        recordRunEvent(run, 'slot_error', {
          slotId: failedSlot.slotId,
          entryId: failedSlot.entryId,
          errorClass: failure.errorClass,
          generationSubmitted: generationWasStarted,
          retryAt: failedSlot.nextRetryAt
        });
        if (!generationWasStarted || failedSlot.tabId == null) run.unresolvedError = true;
      }
    }
    const failedName = failedSlot
      ? entryDisplayName(groupEntries(queue, run.groupId).find((item) => item.sourceId === failedSlot.entryId), failedSlot)
      : 'одной из вкладок';
    run.currentAction = `Ошибка в ${failedName}. Остальные вкладки продолжают очередь.`;
    run.lastActivityAt = failure.at;
    // A setup/upload failure has no generation to protect. Leave the slot
    // available for the next queue item; claimNext() will replace it after
    // this state is persisted. A running generation still gets its guarded
    // observation pass below.
    if (context.globalNoProgress) {
      run.unresolvedError = true;
      run.currentAction = 'Пауза: ни одна рабочая вкладка не показала прогресс за 5 минут.';
    } else if (attachmentFailureCircuitBreaker) {
      run.unresolvedError = true;
      run.currentAction = 'Пауза: 3 разные модели подряд не загрузили пакет вложений. Очередь сохранена.';
      recordRunEvent(run, 'attachment_failure_circuit_opened', {
        windowMs: 10 * 60 * 1000,
        threshold: 3,
        slotId: failedSlot?.slotId ?? context.slotId ?? null,
        entryId: failedSlot?.entryId ?? context.entryId ?? null
      });
    } else if ((generationWasStarted && failedSlot?.tabId != null) || !(run.pendingIds || []).length) finalizeDrainingRun(run, queue);
    await saveRunAndQueue(run, queue, history, generationMemory);
    await appendLog('ОШИБКА: проблемный слот исключён, остальные продолжают очередь', { error: failure.message, ...context });
    await publishRun(run, queue);
    return {
      tabIds: [...new Set(tabIds)],
      failure,
      pauseRunForAttachmentStorm: attachmentFailureCircuitBreaker,
      closeUnsubmittedTabId: !duplicateFailure && !generationWasStarted && failedSlot?.tabId != null
        ? Number(failedSlot.tabId)
        : null,
      cancelRevision: !generationWasStarted && failedSlot?.generationId && failedSlot?.entryId
        ? { generationId: failedSlot.generationId, sourceId: failedSlot.entryId }
        : null,
      finalCheck: !duplicateFailure && generationWasStarted && failedSlot?.tabId != null
        ? { tabId: failedSlot.tabId, slotId: failedSlot.slotId, entryId: failedSlot.entryId }
        : null,
      replaceSlot: (!generationWasStarted || failedSlot?.tabId == null) && failedSlot?.slotId != null
        ? { slotId: failedSlot.slotId, entryId: failedSlot.entryId }
        : null
    };
  });
  if (result.cancelRevision) {
    await cancelUnsubmittedGenerationRevision(
      result.cancelRevision.generationId, result.cancelRevision.sourceId, 'setup_failed_before_send'
    ).catch((cancelError) => appendLog('Не удалось отменить неподанную ревизию после ошибки', {
      generationId: result.cancelRevision.generationId,
      sourceId: result.cancelRevision.sourceId,
      error: cancelError.message
    }));
  }
  if (context.rateLimit) {
    await pauseNewLaunchesForRateLimit(runId, {
      slotId: context.slotId,
      tabId: context.tabId,
      text: 'Слишком много запросов'
    });
  }
  let replacement = result.replaceSlot || null;
  if (result.finalCheck) {
    let downloadStarted = false;
    let checkResponse = null;
    try {
      // Downloads API errors can leave the page-side cache with the old
      // download id. Clear it before the retrying check below.
      await sendTabMessage(result.finalCheck.tabId, {
        type: 'RESET_DOWNLOAD',
        operationId: runId,
        slotId: result.finalCheck.slotId,
        entryId: result.finalCheck.entryId
      });
    } catch (_) {}
    try {
      checkResponse = await sendTabMessage(result.finalCheck.tabId, {
        type: 'CHECK_GENERATION',
        operationId: runId,
        slotId: result.finalCheck.slotId,
        entryId: result.finalCheck.entryId
      });
      downloadStarted = Boolean(
        checkResponse?.ok && checkResponse.value &&
        ['DOWNLOADING', 'READY'].includes(checkResponse.value.state)
      );
    } catch (_) {}
    await withStateLock(async () => {
      const stored = await getStored();
      stored.history = normalizeHistory(stored.history);
      stored.generationMemory = normalizeGenerationMemory(stored.generationMemory);
      if (!stored.run || stored.run.operationId !== runId) return;
      const slot = stored.run.slots?.[result.finalCheck.slotId];
      if (!slot || slot.entryId !== result.finalCheck.entryId) return;
      if (downloadStarted || slot.downloadId) {
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.failed = false;
        slot.lastResult = 'DOWNLOADING';
      } else if (checkResponse?.ok && checkResponse.value?.state === 'ERROR') {
        // The response is settled and contains no downloadable image. Keep
        // the source marked as error for a later Continue, while releasing
        // this worker for the next source immediately.
        slot.finalCheckPending = false;
        slot.status = 'PAUSED';
        slot.finalCheckDeadlineAt = null;
        slot.finalCheckAttempts = Number(slot.finalCheckAttempts || 0) + 1;
        slot.failed = false;
        slot.lastCheckState = 'ERROR';
        slot.lastCheckError = checkResponse.value.error || slot.lastCheckError;
        stored.run.unresolvedError = true;
        replacement = { slotId: slot.slotId, entryId: slot.entryId };
      } else {
        slot.finalCheckPending = true;
        slot.status = 'OBSERVING';
        slot.finalCheckDeadlineAt = Number(slot.finalCheckDeadlineAt || 0) > Date.now()
          ? slot.finalCheckDeadlineAt
          : finalCheckDeadline();
        slot.finalCheckAttempts = Number(slot.finalCheckAttempts || 0) + 1;
        slot.lastCheckState = checkResponse?.ok ? (checkResponse.value?.state || 'UNKNOWN') : 'NO_RESPONSE';
        slot.lastCheckError = checkResponse?.ok
          ? (checkResponse.value?.error || slot.lastCheckError)
          : (checkResponse?.error?.message || slot.lastCheckError || 'Нет ответа вкладки');
      }
      if (!replacement || !(stored.run.pendingIds || []).length) finalizeDrainingRun(stored.run, stored.queue);
      const entry = groupEntries(stored.queue, stored.run.groupId).find((item) => item.sourceId === result.finalCheck.entryId);
      if (entry && !downloadStarted && checkResponse?.ok && checkResponse.value?.state === 'ERROR') {
        setGenerationMemoryStatus(
          stored.generationMemory,
          entry,
          GENERATION_MEMORY_STATUSES.NOT_READY,
          {
            statusSource: 'automatic',
            generationStartedAt: null,
            lastError: checkResponse.value.error || slot.lastCheckError || 'Ошибка генерации',
            lastRunId: runId,
            retryCount: Number(entry.retryCount || 0)
          }
        );
      }
      await saveRunAndQueue(stored.run, stored.queue, stored.history, stored.generationMemory);
      await publishRun(stored.run, stored.queue);
    });
  }
  await Promise.all(result.tabIds.map(async (tabId) => {
    try {
      const response = await sendTabMessage(tabId, { type: 'CAPTURE_DIAGNOSTICS', reason: result.failure?.message || String(error) });
      if (response?.ok && response.value) await storeDiagnostics({ ...response.value, ...context });
    } catch (_) {}
  }));
  if (result.pauseRunForAttachmentStorm) {
    await schedulePreparationStallRecovery(runId, [context.entryId].filter(Boolean));
    return;
  }
  if (result.closeUnsubmittedTabId) {
    const latest = await getStored().catch(() => ({ run: null }));
    const automationWindowId = Number(latest.run?.operationId === runId ? latest.run.automationWindowId : 0);
    const tab = await chrome.tabs.get(result.closeUnsubmittedTabId).catch(() => null);
    if (automationWindowId && isAutomationChatTab(tab, automationWindowId)) {
      await chrome.tabs.remove(result.closeUnsubmittedTabId).catch(() => {});
    }
  }
  if (replacement) {
    const next = await claimNext(runId, replacement.slotId);
    if (next) void executeSlot(runId, next.slot.slotId, next.entry.sourceId);
  }
}

async function recoverVisibleResults(run, { forceReload = false } = {}) {
  const stored = await getStored();
  if (!run || !stored.run || stored.run.operationId !== run.operationId) return [];
  const entries = groupEntries(stored.queue, run.groupId);
  const results = [];
  for (const slot of Object.values(run.slots || {})) {
    if (!slot.entryId || !slot.tabId || slot.downloadId) continue;
    if (slot.preparedForSubmit && !slotGenerationSubmitted(slot)) {
      results.push({ slotId: slot.slotId, entryId: slot.entryId,
        state: 'READY_TO_SEND', recovered: false, observe: false, retryable: true, unsent: true });
      continue;
    }
    const entry = entries.find((item) => item.sourceId === slot.entryId);
    if (!entry) continue;
    const recoveryGenerationId = ensureSlotGenerationIdentity(run, slot, entry, stored.generationMemory);
    const recoveryFactsJobId = slot.factsJobId || stableHash({ generationId: recoveryGenerationId, extractorVersion: FACTS_EXTRACTOR_VERSION });
    slot.factsJobId = recoveryFactsJobId;
    const job = {
      prompt: '',
      modelName: entry.modelName,
      outputFileName: entry.outputFileName,
      debugOverlay: false,
      generationTimeoutMs: FINAL_CHECK_TIMEOUT_MS,
      factsPrompt: buildFactsExtractionPrompt(entry),
      factsExtractorVersion: FACTS_EXTRACTOR_VERSION,
      factsJobId: recoveryFactsJobId,
      generationId: recoveryGenerationId
    };
    try {
      await reloadTabForRecovery(slot.tabId, slot.slotId, { force: forceReload });
      await sendTabMessage(slot.tabId, {
        type: 'PREPARE_PAGE_RUN',
        operationId: run.operationId,
        slotId: slot.slotId,
        leaseId: slot.leaseId || null,
        entryId: slot.entryId,
        job,
        recovery: true
      });
      const response = await sendTabMessage(slot.tabId, {
        type: 'CHECK_GENERATION',
        operationId: run.operationId,
        slotId: slot.slotId,
        entryId: slot.entryId
      });
      const value = response?.ok ? (response.value || {}) : {};
      const hasAssistant = Number(value.assistantCount || 0) > 0;
      const hasUserTurn = Number(value.userCount || 0) > 0;
      const state = value.state || 'NO_RESPONSE';
      const recovered = ['READY', 'DOWNLOADING'].includes(state);
      const activeGeneration = (
        ['GENERATING', 'WAITING_IMAGE'].includes(state) && hasAssistant
      ) || (
        // After a worker/extension restart a SENDING slot is ambiguous. A
        // visible user turn is authoritative evidence that ChatGPT accepted
        // the prompt even if the assistant has not mounted its turn yet.
        state === 'WAITING_ASSISTANT' && (hasUserTurn || slotGenerationSubmitted(slot))
      ) || (state === 'RATE_LIMIT_PAUSE');
      // A settled page error can safely be retried. Active generation states
      // stay under observation so Continue never starts a duplicate request.
      // If the message exchange fails after reload, the catch branch below
      // keeps the slot guarded for safety.
      // A submitted prompt in an existing chat is an immutable attempt. A
      // changed ChatGPT DOM must not turn an unreadable result into a second
      // image-generation request for the same SKU.
      const observe = !response?.ok || (!recovered && (activeGeneration || slotGenerationSubmitted(slot)));
      results.push({
        slotId: slot.slotId,
        entryId: slot.entryId,
        state,
        recovered,
        observe,
        retryable: !observe && !recovered
      });
      await appendLog('Проверка результата перед продолжением', {
        slotId: slot.slotId,
        entryName: entry.fileName,
        state,
        action: observe ? 'оставляю под наблюдением' : (recovered ? 'результат восстановлен' : 'возвращаю в очередь')
      });
    } catch (error) {
      const tabStillExists = await chrome.tabs.get(slot.tabId)
        .then((tab) => /^https:\/\/chatgpt\.com\//i.test(tab.url || ''))
        .catch(() => false);
      // A closed tab cannot contain a result, so its source can be retried in
      // a newly created tab. A tab that still exists but failed to reconnect
      // remains guarded to avoid duplicating an unknown generation.
      results.push({
        slotId: slot.slotId,
        entryId: slot.entryId,
        state: tabStillExists ? 'NO_RESPONSE' : 'TAB_CLOSED',
        recovered: false,
        observe: tabStillExists,
        retryable: !tabStillExists
      });
      await appendLog('Не удалось проверить результат перед продолжением', {
        slotId: slot.slotId,
        entryName: entry.fileName,
        error: error.message,
        action: tabStillExists ? 'оставляю под наблюдением' : 'вкладка закрыта, возвращаю в очередь'
      });
    }
  }
  return results;
}

async function resumeRun(options = {}) {
  await assertManualExtensionUpdateNotApplying();
  const internalRecoveryResume = options?.conversationRecoveryInternal === true
    || options?.stalledBatchRecoveryInternal === true
    || options?.preparationStallRecoveryInternal === true;
  if (!internalRecoveryResume) {
    await waitForStartupReconciliation();
  }
  const preferredWindowId = Number(options?.preferredWindowId || 0);
  if (preferredWindowId) {
    const host = await chrome.windows.get(preferredWindowId).catch(() => null);
    if (!host || host.type !== 'normal') throw new Error('Окно панели для продолжения запуска недоступно');
    await withStateLock(async () => {
      const stored = await getStored();
      if (!stored.run || stored.run.state !== 'PAUSED') return;
      stored.run.preferredWindowId = preferredWindowId;
      await saveRunAndQueue(stored.run, stored.queue);
    });
  }
  const current = await withStateLock(async () => {
    const stored = await getStored();
    if (stored.run && ['PAUSED', 'STOPPED'].includes(stored.run.state)) {
      recordRunEvent(stored.run, 'run_resume_requested', {
        stateBefore: stored.run.state,
        source: options?.conversationRecoveryInternal === true ? 'conversation_recovery'
          : options?.preparationStallRecoveryInternal === true ? 'preparation_stall_recovery'
            : options?.stalledBatchRecoveryInternal === true ? 'stalled_batch_recovery' : 'user_or_ui'
      });
      await saveRunAndQueue(stored.run, stored.queue);
    }
    return stored;
  });
  if (!current.run || !['PAUSED', 'STOPPED'].includes(current.run.state)) throw new Error('Нет запуска, который можно продолжить');
  if (internalRecoveryResume && (current.run.clockStopped || current.run.stopBlocked
    || ['USER', 'RESTART'].includes(current.run.pauseReason))) {
    throw new Error('Автопродолжение отменено пользователем');
  }
  const stalledBatchStage = String(current.run.stalledBatchRecovery?.stage || '').toUpperCase();
  const internalStalledBatchResume = options?.stalledBatchRecoveryInternal === true
    || options?.preparationStallRecoveryInternal === true;
  if (['CLOSING', 'WAITING'].includes(stalledBatchStage) && !internalStalledBatchResume) {
    recordRunEvent(current.run, 'run_resume_blocked', { reason: 'stalled_batch_recovery_in_progress', recoveryStage: stalledBatchStage });
    await saveRunAndQueue(current.run, current.queue);
    throw new Error('Автовосстановление набора уже выполняется. Дождись окончания пятиминутной паузы.');
  }
  if (stalledBatchStage === 'RESTARTING' && !internalStalledBatchResume) {
    recordRunEvent(current.run, 'run_resume_blocked', { reason: 'stalled_batch_restart_in_progress', recoveryStage: stalledBatchStage });
    await saveRunAndQueue(current.run, current.queue);
    throw new Error('Идёт автоматический перезапуск очереди. Дождись его завершения.');
  }
  if (['INSPECTING', 'WAITING', 'REOPENING'].includes(String(current.run.conversationRecovery?.stage || '').toUpperCase())) {
    recordRunEvent(current.run, 'run_resume_blocked', {
      reason: 'conversation_recovery_in_progress',
      recoveryStage: current.run.conversationRecovery?.stage || null
    });
    await saveRunAndQueue(current.run, current.queue);
    throw new Error('Идёт безопасное восстановление разговоров ChatGPT. Дождись его завершения.');
  }
  if (current.run.imageLimitDetected === true && Number(current.run.rateLimitPauseUntil || 0) > Date.now()) {
    recordRunEvent(current.run, 'run_resume_blocked', {
      reason: 'image_limit_cooldown',
      resumeAt: current.run.rateLimitPauseUntil
    });
    await saveRunAndQueue(current.run, current.queue);
    throw new Error(`Лимит создания изображений действует до ${clockTime(current.run.rateLimitPauseUntil)}. Очередь продолжится автоматически.`);
  }
  const resumePreflight = await runPreflight({
    selectedIds: Array.isArray(current.run.plannedIds) ? current.run.plannedIds : [],
    queueMode: current.run.groupId === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular',
    partNumber: current.run.runPart || null,
    validateLaunchSelection: false
  });
  if (!resumePreflight.ok) {
    const failed = (resumePreflight.checks || [])
      .filter((check) => check.blocking && !check.ok)
      .map((check) => check.label)
      .filter(Boolean)
      .join(', ');
    recordRunEvent(current.run, 'run_resume_blocked', {
      reason: 'preflight_failed',
      failedChecks: (resumePreflight.checks || []).filter((check) => check.blocking && !check.ok).map((check) => check.label).filter(Boolean)
    });
    await saveRunAndQueue(current.run, current.queue);
    throw new Error(`Продолжение невозможно: ${failed || 'проверь входные данные'}`);
  }
  await ensureAutomationWindow(current.run.operationId);
  await moveRunTabsToAutomationWindow(current.run.operationId);
  const isolated = await getStored();
  const recovered = await recoverVisibleResults(isolated.run);
  await Promise.all(recovered.filter((item) => item.unsent).map(async (item) => {
    const tabId = Number(isolated.run?.slots?.[item.slotId]?.tabId || 0);
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }));
  const observedEntryIds = new Set(recovered.filter((item) => item.observe).map((item) => item.entryId));
  const assignments = await withStateLock(async () => {
    const updateLock = await chrome.storage.local.get(['manualExtensionUpdateLock', 'resultsImportJournal']);
    if (updateLock.resultsImportJournal) throw new Error('Завершается импорт результатов');
    if (updateLock.manualExtensionUpdateLock?.active) {
      throw new Error('Установка обновления расширения началась. Дождись её завершения.');
    }
    const stored = await getStored();
    const { run } = stored;
    let { queue, history, generationMemory } = stored;
    const persistedCatalog = await getAllModelCatalog().catch(() => []);
    if (persistedCatalog.length) {
      queue = { ...(queue || {}), groups: queueGroupsFromCatalog(persistedCatalog, queue?.groups || {}) };
    }
    if (!run || !['PAUSED', 'STOPPED'].includes(run.state)) throw new Error('Нет запуска, который можно продолжить');
    syncRunClock(run, Date.now());
    const clockStopLatched = run.clockStopped === true || Boolean(run.stopBlocked);
    if (internalRecoveryResume && (clockStopLatched || ['USER', 'RESTART'].includes(run.pauseReason))) {
      throw new Error('Автопродолжение отменено пользователем');
    }
    if (!internalRecoveryResume) {
      run.preparationRecoveryAttempts = 0;
      run.attachmentFailureBaselineAt = new Date().toISOString();
    }
    ({ queue, history, memory: generationMemory } = syncQueueWithHistory(
      queue,
      history,
      generationMemory,
      run
    ));
    run.filter = normalizeWatchFilter(
      run.filter || parseFilterSelectionId(run.groupId) || filterFromQueueGroup(run.groupId)
    );
    run.finishedAt = null;
    run.filterLabel = run.filterLabel || watchFilterLabel(run.filter);
    run.coverageMode = normalizeCoverageMode(run.coverageMode);
    await reconcilePersistedCurrentRevisions(queue, history, generationMemory, {
      ...(run.filter || parseFilterSelectionId(run.groupId) || filterFromQueueGroup(run.groupId)),
      runQueueMode: run.groupId === REGENERATION_QUEUE_ID ? REGENERATION_QUEUE_ID : 'regular',
      excludeSourceIds: ['RESTARTING', 'FAILED'].includes(stalledBatchStage)
        ? (run.stalledBatchRecovery?.requeuedIds || [])
        : []
    });
    const entries = groupEntries(queue, run.groupId);
    const plannedIds = Array.isArray(run.plannedIds) && run.plannedIds.length
      ? [...run.plannedIds]
      : pendingEntryIdsForFilter(entries, normalizeRunLimit(run.runLimit, 0), run.coverageMode);
    run.plannedIds = plannedIds;
    const plannedIdSet = new Set(plannedIds);
    for (const slot of Object.values(run.slots || {})) {
      const slotEntry = entries.find((entry) => entry.sourceId === slot.entryId);
      if (slot.entryId && observedEntryIds.has(slot.entryId) && !slot.downloadId && slotEntry?.status !== 'done') {
        slot.status = 'OBSERVING';
        slot.finalCheckPending = true;
        slot.finalCheckDeadlineAt = finalCheckDeadline();
        slot.finalCheckAttempts = 0;
        slot.failed = true;
        setGenerationMemoryStatus(generationMemory, slotEntry, GENERATION_MEMORY_STATUSES.RUNNING, {
          statusSource: 'automatic',
          generationStartedAt: slot.lastActivityAt || new Date().toISOString(),
          lastError: slot.lastCheckError || null,
          lastRunId: run.operationId
        });
        continue;
      }
      if (!slot.downloadId && slot.entryId && slotEntry?.status !== 'done') {
        // The recovery check saw a settled page error or a stale disconnected
        // slot. Release it now so Continue can actually claim the next item.
        // The source remains pending and is still part of this run's plan.
        slot.entryId = null;
        slot.status = 'IDLE';
        slot.phase = SLOT_PHASES.IDLE;
        slot.launchWaitUntil = null;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.finalCheckAttempts = 0;
        slot.failed = false;
        setGenerationMemoryStatus(generationMemory, slotEntry, GENERATION_MEMORY_STATUSES.NOT_READY, {
          statusSource: 'automatic',
          generationStartedAt: null,
          lastError: slot.lastCheckError || null,
          lastRunId: run.operationId
        });
      }
      if (slot.downloadId && slot.revisionPersistBlocked) {
        slot.revisionPersistBlocked = false;
        slot.revisionPersistFailures = 0;
        slot.revisionPersistRetryAt = null;
        slot.status = 'DOWNLOADING';
        slot.phase = SLOT_PHASES.DOWNLOADING;
        slot.failed = false;
        if (slotEntry && slotEntry.status !== 'done') {
          slotEntry.status = 'running';
          slotEntry.lastError = null;
          slotEntry.errorClass = null;
          slotEntry.nextRetryAt = null;
        }
      }
      if (!slot.downloadId) continue;
      if (slotEntry?.status === 'done') {
        slot.downloadId = null;
        slot.entryId = null;
        slot.status = 'IDLE';
        slot.phase = SLOT_PHASES.IDLE;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.finalCheckAttempts = 0;
        slot.failed = false;
      }
    }
    const activeDownloadEntryIds = new Set(
      Object.values(run.slots || {}).filter((slot) => slot.downloadId).map((slot) => slot.entryId)
    );
    const observedIds = new Set(
      Object.values(run.slots || {}).filter((slot) => slot.finalCheckPending && slot.entryId).map((slot) => slot.entryId)
    );
    for (const entry of entries.filter((item) => plannedIdSet.has(item.sourceId))) {
      if (observedIds.has(entry.sourceId)) continue;
      if (entry.status !== 'done' && !activeDownloadEntryIds.has(entry.sourceId)) {
        entry.status = 'pending';
        entry.autoRetryPending = false;
        entry.errorClass = null;
        entry.nextRetryAt = null;
        entry.lastError = null;
        if (!observedIds.has(entry.sourceId)) {
          setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
            statusSource: 'automatic',
            generationStartedAt: null,
            lastError: entry.lastError || null,
            lastRunId: run.operationId
          });
        }
      }
    }
    run.pendingIds = plannedIds.filter((entryId) => {
      const entry = entries.find((item) => item.sourceId === entryId);
      return entry && entry.status !== 'done' && !activeDownloadEntryIds.has(entryId) && !observedIds.has(entryId);
    });
    const preservedRateLimitUntil = Number(run.rateLimitPauseUntil || 0);
    const recoveredRateLimit = recovered.some((item) => item.state === 'RATE_LIMIT_PAUSE');
    run.state = 'RUNNING';
    run.status = 'RUNNING';
    run.pauseReason = null;
    run.error = null;
    run.unresolvedError = false;
    if (!internalRecoveryResume || !clockStopLatched) run.stopBlocked = null;
    if (String(run.conversationRecovery?.stage || '').toUpperCase() === 'FAILED') {
      run.conversationRecovery.stage = 'MANUAL_RESUME';
      run.conversationRecovery.manualResumeAt = new Date().toISOString();
    }
    if (['RESTARTING', 'FAILED'].includes(String(run.stalledBatchRecovery?.stage || '').toUpperCase())) {
      run.stalledBatchRecovery.stage = 'RESUMED';
      run.stalledBatchRecovery.resumedAt = new Date().toISOString();
      run.stalledBatchRecovery.dueAt = null;
    }
    run.currentAction = 'Продолжаю незавершённые генерации';
    run.lastActivityAt = new Date().toISOString();
    recordRunEvent(run, 'run_resumed', {
      source: options?.conversationRecoveryInternal === true ? 'conversation_recovery'
        : options?.preparationStallRecoveryInternal === true ? 'preparation_stall_recovery'
          : options?.stalledBatchRecoveryInternal === true ? 'stalled_batch_recovery' : 'user_or_ui',
      pendingCount: run.pendingIds.length,
      activeObservedSlots: Object.values(run.slots || {}).filter((slot) => slot.entryId && slotGenerationSubmitted(slot)).length,
      rateLimitPausePreserved: recoveredRateLimit || preservedRateLimitUntil > Date.now()
    });
    run.generationPauseMinutes = normalizeGenerationPauseMinutes(run.generationPauseMinutes);
    run.generationJitterSeconds = normalizeGenerationJitterSeconds(run.generationJitterSeconds);
    if (recoveredRateLimit || preservedRateLimitUntil > Date.now()) {
      run.rateLimitPauseMinutes = normalizeRateLimitPauseMinutes(run.rateLimitPauseMinutes);
      run.rateLimitPauseUntil = recoveredRateLimit
        ? coalescedPauseDeadline(preservedRateLimitUntil, Date.now(), rateLimitPauseMs(run))
        : preservedRateLimitUntil;
      run.rateLimitPauseStartedAt ||= new Date().toISOString();
      run.rateLimitReason ||= 'Слишком много запросов';
      run.status = 'RATE_LIMIT_PAUSE';
      run.currentAction = `Пауза новых запусков до ${clockTime(run.rateLimitPauseUntil)}`;
    } else {
      run.rateLimitPauseUntil = null;
      run.rateLimitPauseStartedAt = null;
      run.rateLimitReason = null;
    }
    if (!internalRecoveryResume || !clockStopLatched) {
      resumeRunClock(run, Date.now());
    } else {
      run.clockVersion = 1;
      run.clockStopped = true;
      run.clockActiveSinceMs = null;
    }
    const assignments = [];
    const workerCount = normalizeWorkerCount(run.workerCount, DEFAULT_WORKERS);
    run.workerCount = workerCount;
    for (let slotId = 0; slotId < workerCount; slotId += 1) {
      const oldSlot = run.slots[slotId] || { slotId, tabId: null };
      if (oldSlot.downloadId) {
        oldSlot.status = 'DOWNLOADING';
        run.slots[slotId] = oldSlot;
        continue;
      }
      if (oldSlot.finalCheckPending && oldSlot.entryId) {
        oldSlot.status = 'OBSERVING';
        run.slots[slotId] = oldSlot;
        continue;
      }
      const entryId = run.pendingIds.shift();
      if (!entryId) {
        oldSlot.entryId = null;
        oldSlot.tabId = null;
        oldSlot.status = 'IDLE';
        oldSlot.phase = SLOT_PHASES.IDLE;
        oldSlot.launchWaitUntil = null;
        oldSlot.finalCheckPending = false;
        oldSlot.finalCheckDeadlineAt = null;
        oldSlot.finalCheckAttempts = 0;
        oldSlot.failed = false;
        run.slots[slotId] = oldSlot;
        continue;
      }
      const entry = entries.find((item) => item.sourceId === entryId);
      entry.status = 'running';
      entry.errorClass = null;
      entry.nextRetryAt = null;
      setGenerationMemoryStatus(generationMemory, entry, GENERATION_MEMORY_STATUSES.RUNNING, {
        statusSource: 'automatic',
        generationStartedAt: new Date().toISOString(),
          lastError: null,
          lastRunId: run.operationId,
          retryCount: Number(entry.retryCount || 0),
          errorClass: null,
          nextRetryAt: null,
      });
      delete history.items[entry.sourceId];
      history.ignored[entry.sourceId] = true;
      const slot = {
        ...oldSlot,
        ...freshSlotRevisionFields(),
        tabId: null,
        entryId,
        status: 'STARTING',
        phase: SLOT_PHASES.PREPARING,
        leaseId: makeLeaseId(),
        attempt: Number(entry.retryCount || 0) + 1,
        errorClass: null,
        nextRetryAt: null,
        lastHeartbeatAt: new Date().toISOString(),
        lastProbeAt: null,
        lastProgressAt: new Date().toISOString(),
        generationSubmittedAt: null,
        assistantObservedAt: null,
        assistantCount: 0,
        imageCandidate: false,
        imageCandidateSource: null,
        resultFingerprint: null,
        downloadVerification: null,
        downloadId: null,
        lastEntryName: entry.fileName,
        lastModelName: entry.modelName,
        lastResult: null,
        lastCheckState: null,
        lastCheckError: null,
        checkFailures: 0,
        lastFocusAt: null,
        focusCount: 0,
        launchWaitUntil: null,
        generationGapMs: null,
        finalCheckPending: false,
        finalCheckDeadlineAt: null,
        finalCheckAttempts: 0,
        failed: false,
        rateLimitRetryNeeded: false
      };
      run.slots[slotId] = slot;
      recordRunEvent(run, 'slot_claimed', { slotId, entryId, leaseId: slot.leaseId, attempt: slot.attempt });
      assignments.push({ entry, slot });
    }
    if (!run.pendingIds.length && !activeDownloadEntryIds.size && !observedIds.size && !assignments.length) {
      run.state = 'DONE';
      run.status = 'DONE';
    }
    await saveRunAndQueue(run, queue, history, generationMemory);
    await appendLog('Продолжение очереди после паузы');
    await publishRun(run, queue);
    return { runId: run.operationId, assignments, active: ['RUNNING', 'STARTING', 'DRAINING'].includes(run.state) };
  });
  if (assignments.active) {
    resetLaunchScheduler(assignments.runId);
    startAuditMonitor();
  }
  await startAssignments(assignments.runId, assignments.assignments);
  return { operationId: assignments.runId };
}


function factText(value, max = 500) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^(?:null|none|нет|—|-)$/i.test(text)) return null;
  return text.slice(0, max);
}

function normalizedComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}

function parseExtractionJson(rawText) {
  const parser = globalThis.WatchFactsUtils?.parseExtractionJson;
  if (typeof parser !== 'function') {
    const error = new Error('FACTS_PARSER_UNAVAILABLE: facts-json-utils.js не загружен');
    error.code = 'FACTS_PARSER_UNAVAILABLE';
    error.responseText = String(rawText || '').slice(0, 12000);
    throw error;
  }
  return parser(rawText);
}

function parseDecimal(value) {
  const match = String(value || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizeWaterResistance(raw) {
  const text = factText(raw);
  if (!text) return { text: null, value: null, unit: null };
  const value = parseDecimal(text);
  const lower = text.toLowerCase();
  let unit = null;
  if (/(?:\bbar\b|бар)/i.test(lower)) unit = 'bar';
  else if (/(?:\batm\b|атм)/i.test(lower)) unit = 'atm';
  else if (/(?:\bm\b|метр|(^|\s)м($|\s))/i.test(lower)) unit = 'm';
  return { text, value, unit };
}

function normalizeCaseSize(raw) {
  const text = factText(raw);
  if (!text) return { text: null, valueMm: null };
  return { text, valueMm: parseDecimal(text) };
}

function buildFactsWarnings(facts, titleSpec) {
  const warnings = [];
  const actualBrand = normalizedComparableText(facts.titleBrand);
  const expectedBrand = normalizedComparableText(titleSpec?.brand);
  const actualSeries = normalizedComparableText(facts.titleSeries);
  const expectedSeries = normalizedComparableText(titleSpec?.explicitSeriesPrint);
  const actualModel = normalizedComparableText(facts.titleModel);
  const expectedModel = normalizedComparableText(titleSpec?.referenceCode);

  if (!facts.utp1) warnings.push('MISSING_UTP_1');
  if (!facts.utp2) warnings.push('MISSING_UTP_2');
  if (!facts.waterResistance) warnings.push('MISSING_WATER_RESISTANCE');
  if (!facts.caseSize) warnings.push('MISSING_CASE_SIZE');

  if (titleSpec?.mode === 'fixed' && Array.isArray(titleSpec.fixedLines)) {
    if (normalizedComparableText(titleSpec.fixedLines[0]) !== actualBrand) warnings.push('TITLE_BRAND_MISMATCH');
    if (normalizedComparableText(titleSpec.fixedLines[1]) !== actualSeries) warnings.push('TITLE_SERIES_MISMATCH');
    if (normalizedComparableText(titleSpec.fixedLines[2]) !== actualModel) warnings.push('TITLE_MODEL_MISMATCH');
  } else {
    if (expectedBrand && actualBrand && expectedBrand !== actualBrand) warnings.push('TITLE_BRAND_MISMATCH');
    if (expectedBrand && !actualBrand) warnings.push('MISSING_TITLE_BRAND');
    if (titleSpec?.seriesRequired && !actualSeries) warnings.push('MISSING_SERIES');
    if (expectedSeries && actualSeries && expectedSeries !== actualSeries) warnings.push('TITLE_SERIES_MISMATCH');
    if (expectedSeries && !actualSeries) warnings.push('MISSING_SERIES');
    if (expectedModel && actualModel && expectedModel !== actualModel) warnings.push('TITLE_MODEL_MISMATCH');
    if (expectedModel && !actualModel) warnings.push('MISSING_TITLE_MODEL');
  }

  if (Array.isArray(facts.uncertain) && facts.uncertain.length) warnings.push('UNCERTAIN_TEXT');
  return [...new Set(warnings)];
}

function buildFactsExtractionPrompt(entry) {
  return [
    'Рассмотри ТОЛЬКО последнее сгенерированное изображение в этом чате.',
    'Это буквальная OCR-постпроверка готовой карточки, а не проверка характеристик модели.',
    'Источник значений — ТОЛЬКО пиксели последнего изображения. Запрещено использовать название чата, предыдущие сообщения, исходный промпт, интернет, память или знания о часах.',
    'Каждое ненулевое значение должно быть дословной транскрипцией текста, реально видимого в соответствующем блоке изображения.',
    'НЕ дополняй текст знаниями о модели и НЕ уточняй формулировки. Примеры запрета: если видно «Мировое время», нельзя писать «Мировое время 48 городов»; если видно «48,2 мм», нельзя заменять число и нельзя добавлять слово «диаметр», если его нет на картинке.',
    'Не исправляй опечатки, дефисы, единицы измерения и формулировки. Многострочный текст одного блока соедини одним пробелом, сохраняя все видимые слова и числа.',
    'Если поле нельзя уверенно прочитать или соответствующего текста нет — верни null и добавь имя поля в uncertain.',
    '',
    'Считывай поля только из этих зон:',
    '- titleBrand: первая строка блока названия в верхней левой части карточки.',
    '- titleSeries: строка серии в том же блоке названия; если отдельной строки серии нет — null.',
    '- titleModel: код модели только из блока названия. Не бери маркировку с циферблата, ремешка или корпуса.',
    '- utp1: первый информационный тезис под блоком названия, сверху вниз.',
    '- utp2: второй информационный тезис под блоком названия, сверху вниз.',
    '- waterResistance: нижний блок с иконкой капли; перепиши весь видимый текст этого блока.',
    '- caseSize: соседний нижний блок размера корпуса; перепиши весь видимый текст этого блока.',
    '',
    'Перед ответом молча проверь каждое слово и каждую цифру: они должны буквально присутствовать на изображении. Всё, чего на изображении нет, удали из значения.',
    'Верни ТОЛЬКО валидный JSON без markdown, пояснений и дополнительного текста:',
    '{',
    '  "titleBrand": "дословный текст или null",',
    '  "titleSeries": "дословный текст или null",',
    '  "titleModel": "дословный код модели или null",',
    '  "utp1": "дословный текст первого УТП или null",',
    '  "utp2": "дословный текст второго УТП или null",',
    '  "waterResistance": "дословный текст блока водозащиты или null",',
    '  "caseSize": "дословный текст блока размера корпуса или null",',
    '  "uncertain": ["имена полей, которые прочитаны неуверенно"]',
    '}'
  ].join('\n');
}

function normalizeExtractedFacts(entry, rawText, context = {}) {
  const { parsed, raw } = parseExtractionJson(rawText);
  const titleSpec = resolveTitleSpec(entry?.modelName || entry?.fileName || '');
  const water = normalizeWaterResistance(parsed.waterResistance);
  const size = normalizeCaseSize(parsed.caseSize);
  const facts = {
    sourceId: entry.sourceId,
    generationId: context.generationId || entry.generationId || null,
    outputHash: context.outputHash || entry.outputHash || null,
    outputPath: context.outputPath || entry.outputPath || null,
    chatUrl: normalizeChatConversationUrl(context.chatUrl || entry.chatUrl),
    modelName: entry.modelName || entry.fileName || '',
    profileId: detectBrandProfile(entry.modelName || entry.fileName || ''),
    titleBrand: factText(parsed.titleBrand),
    titleSeries: factText(parsed.titleSeries),
    titleModel: factText(parsed.titleModel),
    utp1: factText(parsed.utp1),
    utp2: factText(parsed.utp2),
    waterResistance: water.text,
    waterResistanceValue: water.value,
    waterResistanceUnit: water.unit,
    caseSize: size.text,
    caseSizeValueMm: size.valueMm,
    uncertain: Array.isArray(parsed.uncertain)
      ? parsed.uncertain.map((item) => factText(item, 120)).filter(Boolean).slice(0, 20)
      : [],
    expectedTitleBrand: titleSpec?.brand || null,
    expectedTitleSeries: titleSpec?.explicitSeriesPrint || null,
    expectedTitleModel: titleSpec?.referenceCode || null,
    seriesRequired: titleSpec?.seriesRequired === true,
    extractedAt: new Date().toISOString(),
    extractorVersion: FACTS_EXTRACTOR_VERSION,
    rawResponse: raw.slice(0, 16000),
    responseFingerprint: stableHash(raw),
    status: 'ok'
  };
  facts.warnings = buildFactsWarnings(facts, titleSpec);
  return facts;
}

async function updateFactsMetadata(sourceId, generationIdValue, patch = {}) {
  await withStateLock(async () => {
    const stored = await getStored();
    const queue = stored.queue || { groups: {} };
    const generationMemory = normalizeGenerationMemory(stored.generationMemory);
    const currentGenerationId = generationMemory.items[sourceId]?.generationId || null;
    const activeGenerationId = Object.values(stored.run?.slots || {})
      .find((slot) => slot?.entryId === sourceId
        && slot.generationId
        && !['IDLE', 'DONE', 'STOPPED', 'PAUSED'].includes(String(slot.status || '').toUpperCase()))
      ?.generationId || null;
    // A late OCR result remains attached to its historical revision and must
    // never rewrite the latest SKU projection used by the queue/side panel.
    if (generationIdValue && currentGenerationId && generationIdValue !== currentGenerationId) return;
    if (generationIdValue && activeGenerationId && generationIdValue !== activeGenerationId) return;
    if (generationIdValue) {
      const revision = await getGenerationRevision(generationIdValue).catch(() => null);
      const model = await getModelCatalog(sourceId).catch(() => null);
      if (!model || String(model.currentGenerationId || '') !== String(generationIdValue)
        || revision?.reviewStatus === 'rejected'
        || (revision && String(revision.sourceId || '') !== String(sourceId))
        ) return;
      if (patch.factsStatus !== 'ok' && revisionFactsAreComplete(revision)) return;
      if (patch.factsStatus === 'ok' && !revisionFactsAreComplete(revision)) return;
    }
    const entry = findQueueEntry(queue, sourceId);
    const projections = factsMetadataProjections(patch);
    if (entry) Object.assign(entry, projections.queue);
    if (generationMemory.items[sourceId]) Object.assign(generationMemory.items[sourceId], projections.memory);
    await saveRunAndQueue(stored.run || null, queue, stored.history, generationMemory);
    await publishRun(stored.run || null, queue).catch(() => {});
  });
}

async function cleanupPostprocessTab(runId, tabId) {
  await withStateLock(async () => {
    const stored = await getStored();
    if (stored.run?.operationId === runId && stored.run.postprocessTabs) {
      delete stored.run.postprocessTabs[String(tabId)];
      // Postprocess owns the tab after the PNG is finalized. Do not expose the
      // run as DONE until the last such owner has released its tab.
      if (['RUNNING', 'DRAINING'].includes(stored.run.state)) finalizeDrainingRun(stored.run, stored.queue);
      await saveRunAndQueue(stored.run, stored.queue, stored.history, stored.generationMemory);
      await publishRun(stored.run, stored.queue).catch(() => {});
    }
  }).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  await closeAutomationWindowIfEmpty(runId).catch(() => {});
}

async function reservePostprocessCapacity(runId, slotId, downloadId) {
  const key = String(Number(downloadId));
  if (postprocessCapacityReservations.has(key)) return { allowed: false, reserved: false };
  const { run } = await chrome.storage.local.get('run');
  if (!run || run.operationId !== runId) return { allowed: false, reserved: false };
  if (!run.slots?.[slotId]?.tabId) return { allowed: true, reserved: false };
  const ownerCount = Object.keys(run.postprocessTabs || {}).length;
  const reservedCount = [...postprocessCapacityReservations.values()]
    .filter((item) => item.operationId === runId).length;
  if (ownerCount + reservedCount >= MAX_POSTPROCESS_TABS) return { allowed: false, reserved: false };
  postprocessCapacityReservations.set(key, { operationId: runId, slotId: Number(slotId) });
  return { allowed: true, reserved: true };
}

function releasePostprocessCapacity(downloadId) {
  postprocessCapacityReservations.delete(String(Number(downloadId)));
}

function startFactsPulseMonitor(delay = FACTS_FAST_PULSE_INTERVAL_MS) {
  if (factsPulseTimer || factsPulseInFlight) return;
  factsPulseTimer = setTimeout(() => {
    factsPulseTimer = null;
    factsPulseInFlight = (async () => {
      const { run } = await chrome.storage.local.get('run');
      const hasOwners = Boolean(run
        && ['RUNNING', 'DRAINING', 'PAUSED'].includes(run.state)
        && Object.keys(run.postprocessTabs || {}).length);
      if (!hasOwners) return false;
      await pulsePostprocessTabs(run);
      return true;
    })().catch((error) => {
      void appendLog('Ошибка быстрой проверки OCR-ответа', { error: error?.message || String(error) });
      return false;
    }).finally(() => {
      factsPulseInFlight = null;
    });
    void factsPulseInFlight.then((keepRunning) => {
      if (keepRunning) startFactsPulseMonitor();
    });
  }, Math.max(0, Number(delay || 0)));
}

async function pulsePostprocessTabs(runSnapshot) {
  const owners = Object.values(runSnapshot?.postprocessTabs || {})
    .filter((item) => Number(item?.tabId || 0) > 0 && item?.entryId && item?.factsJobId);
  if (!owners.length) return { checked: 0, completed: 0 };

  const expired = owners.filter((owner) => Number(owner.recoveryDeadlineAt || 0) > 0
    && Date.now() >= Number(owner.recoveryDeadlineAt));
  await Promise.all(expired.map(async (owner) => {
    await updateFactsStage({ operationId: runSnapshot.operationId, entryId: owner.entryId,
      generationId: owner.generationId, factsJobId: owner.factsJobId, slotId: owner.slotId }, { tab: { id: Number(owner.tabId) } }, {
      stage: 'ERROR', error: 'Постпроверка не завершилась за 15 минут; PNG сохранён, спецификацию можно повторить из галереи'
    });
    await cleanupPostprocessTab(runSnapshot.operationId, owner.tabId);
  }));
  const liveOwners = owners.filter((owner) => !expired.includes(owner));
  if (!liveOwners.length) return { checked: 0, completed: 0, expired: expired.length };

  const results = await Promise.all(liveOwners.map(async (owner) => {
    let tabState = await chrome.tabs.get(Number(owner.tabId)).catch(() => null);
    try {
      await protectAutomationTab(Number(owner.tabId));
      if (tabState?.frozen === true || tabState?.discarded === true) {
        await chrome.tabs.reload(Number(owner.tabId));
        await waitTabReady(Number(owner.tabId), 60000);
        tabState = await chrome.tabs.get(Number(owner.tabId)).catch(() => tabState);
      }
      const response = await sendTabMessage(Number(owner.tabId), {
        type: 'PULSE_FACTS_EXTRACTION',
        operationId: runSnapshot.operationId,
        slotId: owner.slotId,
        entryId: owner.entryId,
        generationId: owner.generationId || null,
        factsJobId: owner.factsJobId,
        modelName: owner.modelName || null,
        outputFileName: owner.outputFileName || null,
        userTurnId: owner.userTurnId || null,
        baselineAssistantCount: Number(owner.baselineAssistantCount || 0),
        baselineUserCount: Number(owner.baselineUserCount || 0),
        recover: true
      }, 2500);
      return { owner, tabState, response, error: null };
    } catch (error) {
      return { owner, tabState, response: null, error };
    }
  }));

  let completed = 0;
  const telemetry = [];
  for (const result of results) {
    const owner = result.owner;
    const value = result.response?.ok ? (result.response.value || {}) : null;
    telemetry.push({
      tabId: Number(owner.tabId),
      entryId: owner.entryId,
      factsJobId: owner.factsJobId,
      generationId: owner.generationId || null,
      pulseAt: new Date().toISOString(),
      pulseState: value?.state || (result.error ? 'no-response' : 'unknown'),
      visibilityState: value?.visibilityState || null,
      discarded: result.tabState?.discarded === true,
      frozen: result.tabState?.frozen === true,
      autoDiscardable: result.tabState?.autoDiscardable !== false,
      lastDomInspectionAt: value?.lastDomInspectionAt || null,
      userTurnFound: value?.userTurnFound === true,
      assistantTurnFound: value?.assistantTurnFound === true,
      jsonComplete: value?.complete === true,
      assistantCount: Number(value?.assistantCount || 0),
      responseChars: Number(value?.characters || 0),
      pulseError: result.error?.message || result.response?.error?.message || null
    });
    if (!value?.complete || !String(value?.text || '').trim()) continue;
    completed += 1;
    await handleFactsExtractionResult({
      operationId: runSnapshot.operationId,
      entryId: owner.entryId,
      generationId: owner.generationId || null,
      factsJobId: owner.factsJobId,
      outputPath: owner.outputPath || null,
      outputHash: owner.outputHash || null,
      chatUrl: owner.chatUrl || null,
      text: String(value.text || ''),
      durationMs: Number(value.durationMs || 0) || null,
      completion: 'service-worker-pulse-complete',
      fastPath: false
    }, { tab: { id: Number(owner.tabId) } }).catch((error) => {
      void appendLog('Facts pulse: не удалось сохранить найденный ответ', {
        entryId: owner.entryId, tabId: owner.tabId, error: error?.message || String(error)
      });
    });
  }

  // Keep lightweight pulse diagnostics on the postprocess owner. This uses only
  // the small run object, not queue/history/generationMemory.
  if (telemetry.length) {
    try {
      await withStateLock(async () => {
        const { run } = await chrome.storage.local.get('run');
        if (run?.operationId !== runSnapshot.operationId) return;
        let changed = false;
        for (const info of telemetry) {
          const owner = run.postprocessTabs?.[String(info.tabId)];
          if (!owner || owner.entryId !== info.entryId || owner.factsJobId !== info.factsJobId) continue;
          Object.assign(owner, {
            lastPulseAt: info.pulseAt,
            pulseState: info.pulseState,
            visibilityState: info.visibilityState,
            discarded: info.discarded,
            frozen: info.frozen,
            autoDiscardable: info.autoDiscardable,
            lastDomInspectionAt: info.lastDomInspectionAt,
            userTurnFound: info.userTurnFound,
            assistantTurnFound: info.assistantTurnFound,
            jsonComplete: info.jsonComplete,
            assistantCount: info.assistantCount,
            responseChars: info.responseChars,
            pulseError: info.pulseError
          });
          changed = true;
        }
        if (changed) await chrome.storage.local.set({ run });
      });
    } catch (_) {}
  }
  return { checked: liveOwners.length, completed, expired: expired.length };
}

async function persistRecoveredRevisionFacts(revision, rawText, telemetry = {}) {
  const generationIdValue = String(revision?.generationId || '');
  if (!generationIdValue) throw new Error('Recovery revision has no generationId');
  const current = await getGenerationRevision(generationIdValue);
  if (!current) throw new Error(`Generation revision ${generationIdValue} was not found`);
  if (String(current.sourceId || '') !== String(revision.sourceId || '')) {
    throw new Error('Recovery sourceId does not match the persisted revision');
  }
  if (current.reviewStatus === 'rejected') {
    return { generationId: generationIdValue, sourceId: current.sourceId, skipped: true, reason: 'revision_rejected' };
  }
  if (current.factsStatus === 'ok' && current.facts?.status === 'ok') {
    return { generationId: generationIdValue, sourceId: current.sourceId, duplicate: true };
  }

  // Every field used here comes from the same immutable revision. Recovery is
  // allowed to fill only its facts slot; it cannot rebind a response to the
  // current SKU projection or to another physical PNG.
  const facts = normalizeExtractedFacts(current, rawText, {
    generationId: current.generationId,
    outputPath: current.outputPath || null,
    outputHash: current.outputHash || null,
    chatUrl: current.chatUrl || null
  });
  facts.factsJobId = current.factsJobId
    || stableHash({ generationId: current.generationId, outputHash: current.outputHash || null, recovery: true });
  facts.pageDurationMs = Number(telemetry.durationMs || 0) || null;
  facts.completion = 'gallery-recovery-existing-response';
  facts.recoveredAt = new Date().toISOString();

  const saved = {
    ...current,
    factsJobId: facts.factsJobId,
    factsStatus: 'ok',
    facts,
    factsSavedAt: facts.extractedAt,
    chatUrl: facts.chatUrl || current.chatUrl || null,
    responseFingerprint: facts.responseFingerprint || null,
    factsRecovery: {
      recoveredAt: facts.recoveredAt,
      assistantTurnId: telemetry.assistantTurnId || null,
      assistantCount: Number(telemetry.assistantCount || 0),
      responseChars: Number(telemetry.characters || String(rawText || '').length),
      visibilityState: telemetry.visibilityState || null
    }
  };
  const persisted = await persistGenerationFactsRevision({ ...saved, status: 'READY' });
  if (!persisted?.matched || persisted?.latest !== true) {
    return { generationId: generationIdValue, sourceId: current.sourceId, skipped: true, reason: 'generation_superseded' };
  }
  await updateFactsMetadata(current.sourceId, generationIdValue, {
    factsStatus: 'ok',
    factsUpdatedAt: facts.extractedAt,
    factsError: null,
    factsWarnings: facts.warnings,
    chatUrl: facts.chatUrl || null
  });
  await updateFactsStage({
    operationId: current.operationId,
    entryId: current.sourceId,
    generationId: generationIdValue,
    factsJobId: facts.factsJobId
  }, null, { stage: 'SAVED', generationId: generationIdValue, chatUrl: facts.chatUrl });
  await withStateLock(async () => {
    const stored = await getStored();
    if (stored.run?.operationId !== current.operationId || stored.run.status !== 'DONE_WITH_FACTS_ERRORS') return;
    const remaining = Object.values(stored.run.factsProgress || {})
      .some((progress) => String(progress?.stage || '').toUpperCase() === 'ERROR');
    if (remaining) return;
    stored.run.status = 'DONE';
    stored.run.currentAction = 'Все спецификации восстановлены и сохранены.';
    await saveRunAndQueue(stored.run, stored.queue);
    await publishRun(stored.run, stored.queue);
  });
  void appendLog('Спецификация восстановлена из готового ответа ChatGPT', {
    sourceId: current.sourceId,
    generationId: generationIdValue,
    factsJobId: facts.factsJobId,
    responseFingerprint: facts.responseFingerprint,
    warnings: facts.warnings
  });
  return { generationId: generationIdValue, sourceId: current.sourceId, recovered: true, warnings: facts.warnings };
}

async function recoverRevisionFactsUnlocked(generationIdValue) {
  const revision = await getGenerationRevision(String(generationIdValue || ''));
  if (!revision) throw new Error(`Generation revision ${generationIdValue} was not found`);
  if (revision.reviewStatus === 'rejected') {
    return { generationId: revision.generationId, sourceId: revision.sourceId, skipped: true, reason: 'revision_rejected' };
  }
  if (revision.factsStatus === 'ok' && revision.facts?.status === 'ok') {
    return { generationId: revision.generationId, sourceId: revision.sourceId, duplicate: true };
  }
  const recoveryUrl = automationConversationUrl(revision.chatUrl || revision.facts?.chatUrl);
  if (!recoveryUrl) throw new Error('У revision отсутствует корректный URL ChatGPT-чата');

  const factsJobId = String(revision.factsJobId
    || stableHash({ generationId: revision.generationId, outputHash: revision.outputHash || null, recovery: true }));
  const operationId = `revision-recovery:${revision.generationId}`;
  let tabId = null;
  try {
    const host = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (!host?.id) throw new Error('Нет открытого окна Chrome для восстановления OCR');
    const tab = await chrome.tabs.create({ windowId: host.id, url: recoveryUrl, active: false });
    tabId = Number(tab?.id || 0) || null;
    if (!tabId) throw new Error('Chrome не создал вкладку восстановления');
    await withStateLock(async () => {
      const stored = await getStored();
      if (stored.run?.operationId !== revision.operationId) return;
      stored.run.recoveryTabs ||= {};
      stored.run.recoveryTabs[String(tabId)] = { generationId: revision.generationId, sourceId: revision.sourceId };
      await saveRunAndQueue(stored.run, stored.queue);
    });
    await bootstrapAutomationTab(tabId, host.id, { slotId: -1, entryId: revision.sourceId });

    const loaded = await chrome.tabs.get(tabId).catch(() => null);
    if (normalizeChatConversationUrl(loaded?.url) !== normalizeChatConversationUrl(revision.chatUrl)) {
      throw new Error('ChatGPT не открыл сохранённый conversation URL');
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < REVISION_FACTS_RECOVERY_TIMEOUT_MS) {
      let tabState = await chrome.tabs.get(tabId).catch(() => null);
      if (!tabState) throw new Error('Вкладка восстановления была закрыта');
      if (tabState.frozen === true || tabState.discarded === true) {
        await chrome.tabs.reload(tabId);
        await waitTabReady(tabId, REVISION_FACTS_RECOVERY_TIMEOUT_MS);
        tabState = await chrome.tabs.get(tabId).catch(() => tabState);
      }
      const response = await sendTabMessage(tabId, {
        type: 'PULSE_FACTS_EXTRACTION',
        operationId,
        slotId: -1,
        entryId: revision.sourceId,
        generationId: revision.generationId,
        factsJobId,
        modelName: revision.modelName || revision.fileName || null,
        outputFileName: revision.outputFileName || null,
        baselineAssistantCount: 0,
        baselineUserCount: 0,
        userTurnId: null,
        recover: true
      }, 5000).catch(() => null);
      const value = response?.ok ? response.value : null;
      if (value?.complete === true && String(value.text || '').trim()) {
        return persistRecoveredRevisionFacts(revision, String(value.text), {
          ...value,
          durationMs: Date.now() - startedAt,
          discarded: tabState?.discarded === true,
          frozen: tabState?.frozen === true,
          autoDiscardable: tabState?.autoDiscardable !== false
        });
      }
      await sleep(750);
    }
    throw new Error('Готовый полный JSON не найден в сохранённом ChatGPT-чате');
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    if (tabId) await withStateLock(async () => {
      const stored = await getStored();
      if (stored.run?.recoveryTabs?.[String(tabId)]) {
        delete stored.run.recoveryTabs[String(tabId)];
        await saveRunAndQueue(stored.run, stored.queue);
      }
    }).catch(() => {});
  }
}

function recoverRevisionFacts(generationIdValue) {
  const key = String(generationIdValue || '');
  if (!key) return Promise.reject(new Error('generationId is required'));
  if (revisionFactsRecoveryTasks.has(key)) return revisionFactsRecoveryTasks.get(key);
  const task = recoverRevisionFactsUnlocked(key).finally(() => {
    if (revisionFactsRecoveryTasks.get(key) === task) revisionFactsRecoveryTasks.delete(key);
  });
  revisionFactsRecoveryTasks.set(key, task);
  return task;
}

async function recoverGalleryFacts(generationIds = []) {
  const ids = [...new Set((generationIds || []).map((value) => String(value || '')).filter(Boolean))].slice(0, 100);
  const results = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      const generationIdValue = ids[index];
      try {
        results[index] = await recoverRevisionFacts(generationIdValue);
      } catch (error) {
        results[index] = { generationId: generationIdValue, error: error?.message || String(error) };
        void appendLog('Не удалось восстановить спецификацию из сохранённого чата', results[index]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVISION_FACTS_RECOVERY_CONCURRENCY, ids.length) }, worker));
  return {
    requested: ids.length,
    recovered: results.filter((item) => item?.recovered === true).length,
    duplicate: results.filter((item) => item?.duplicate === true).length,
    failed: results.filter((item) => item?.error).length,
    results
  };
}

async function scheduleRevisionFactsRecoveryAfterUpgrade() {
  if (!chrome.alarms?.create) return { scheduled: false };
  const stored = await getStored();
  if (stored.sessionResetIntent) return { scheduled: false, reason: 'session_reset_pending' };
  const { run } = stored;
  if (!run || !['RUNNING', 'STARTING', 'DRAINING'].includes(run.state)) {
    return { scheduled: false, reason: 'no_active_run' };
  }
  const key = 'revisionFactsRecoveryMigration';
  const storedMigration = await chrome.storage.local.get(key);
  const marker = storedMigration[key] || {};
  if (marker.buildId === EXTENSION_BUILD_ID && marker.completedAt) {
    return { scheduled: false, duplicate: true };
  }
  const existing = await chrome.alarms.get(REVISION_FACTS_RECOVERY_ALARM_NAME).catch(() => null);
  if (marker.buildId === EXTENSION_BUILD_ID && existing) return { scheduled: false, duplicate: true };
  await chrome.storage.local.set({
    [key]: {
      buildId: EXTENSION_BUILD_ID,
      scheduledAt: new Date().toISOString(),
      completedAt: null,
      result: null
    }
  });
  await chrome.alarms.create(REVISION_FACTS_RECOVERY_ALARM_NAME, { when: Date.now() + 5000 });
  return { scheduled: true };
}

async function recoverTimedOutRevisionFacts() {
  const stored = await getStored();
  // Historical OCR errors are retried explicitly from the gallery. A stopped
  // or completed run must never open ChatGPT tabs on browser/extension launch.
  const currentRunId = ['RUNNING', 'STARTING', 'DRAINING'].includes(stored.run?.state)
    ? stored.run.operationId
    : null;
  if (!currentRunId) return { skipped: true, reason: 'no_active_run' };
  const revisions = await getAllGenerationRevisions();
  const ownedGenerationIds = new Set(Object.values(stored.run?.postprocessTabs || {})
    .map((owner) => String(owner.generationId || '')));
  const generationIds = revisions
    .filter((revision) => revision?.generationId
      && revision.operationId === currentRunId
      && !ownedGenerationIds.has(String(revision.generationId))
      && normalizeChatConversationUrl(revision.chatUrl || revision.facts?.chatUrl)
      && revision.factsStatus !== 'ok'
      && revision.facts?.status !== 'ok'
      && /Timeout waiting for settled assistant text|FACTS_JSON_(?:INCOMPLETE|PARSE)/i.test(String(revision.facts?.error || '')))
    .map((revision) => String(revision.generationId));
  const result = generationIds.length
    ? await recoverGalleryFacts(generationIds)
    : { requested: 0, recovered: 0, duplicate: 0, failed: 0, results: [] };
  await chrome.storage.local.set({
    revisionFactsRecoveryMigration: {
      buildId: EXTENSION_BUILD_ID,
      scheduledAt: null,
      completedAt: new Date().toISOString(),
      result: {
        requested: result.requested,
        recovered: result.recovered,
        duplicate: result.duplicate,
        failed: result.failed
      }
    }
  });
  await withStateLock(async () => {
    const current = await getStored();
    if (current.run?.operationId !== currentRunId) return;
    if (finalizeDrainingRun(current.run, current.queue)) {
      await saveRunAndQueue(current.run, current.queue);
      await publishRun(current.run, current.queue);
    }
  });
  void appendLog('Автовосстановление готовых OCR-ответов завершено', result);
  return result;
}

function startFactsExtractionDetached(context) {
  const { tabId, runId, entry, outputPath, outputHash } = context || {};
  if (!tabId || !entry?.sourceId) return;
  const prompt = buildFactsExtractionPrompt(entry);
  const factsJobId = String(context?.factsJobId || stableHash({ operationId: runId, sourceId: entry.sourceId, outputHash: outputHash || null, tabId }));

  // This task is deliberately detached from download finalization. The first
  // awaited operation is the tab message itself; no storage/state lock is
  // allowed to sit between a verified PNG and the postprocess Send click.
  void sendTabMessage(tabId, {
    type: 'START_FACTS_EXTRACTION',
    operationId: runId,
    entryId: entry.sourceId,
    generationId: context?.generationId || entry.generationId || null,
    prompt,
    factsJobId,
    outputPath: outputPath || null,
    outputHash: outputHash || null,
    extractorVersion: FACTS_EXTRACTOR_VERSION,
    chatUrl: normalizeChatConversationUrl(context?.chatUrl)
  }, FACTS_START_ACK_TIMEOUT_MS).then((response) => {
    if (!response?.ok) throw new Error(response?.error?.message || 'Postprocess start was not accepted');
    // The content script may already have started the low-latency postcheck
    // immediately after chrome.downloads accepted the PNG. In that case this
    // verified-file fallback is only an acknowledgement and must not overwrite
    // an already completed facts record with status=extracting.
    if (response?.value?.duplicate === true) {
      const duplicateState = response?.value?.state || null;
      void appendLog('Постобработка уже запущена fast-path; повторный старт пропущен', {
        sourceId: entry.sourceId,
        tabId,
        factsJobId: response?.value?.factsJobId || factsJobId,
        state: duplicateState
      });
      // If the fast-path already finished before verified-file finalization,
      // this fallback is the point where the tab is safe to release.
      if (duplicateState === 'done') {
        // The fast path may have completed between the verified-file lookup and
        // this acknowledgement. Sync its metadata before releasing the tab.
        void getGenerationFacts(entry.sourceId).then((facts) => {
          if (facts?.status === 'ok') {
            return updateFactsMetadata(entry.sourceId, context?.generationId || entry.generationId || null, {
              factsStatus: 'ok',
              factsUpdatedAt: facts.extractedAt || new Date().toISOString(),
              factsError: null,
              factsWarnings: Array.isArray(facts.warnings) ? facts.warnings : []
            });
          }
          return null;
        }).finally(() => cleanupPostprocessTab(runId, tabId));
      }
      return;
    }
    // Do not write a transient `extracting` record into the facts store. A
    // detached final response can arrive very quickly; an un-awaited transient
    // IDB put used to race it and could overwrite the final record afterwards.
    void updateFactsMetadata(entry.sourceId, context?.generationId || entry.generationId || null, {
      factsStatus: 'extracting',
      factsUpdatedAt: new Date().toISOString(),
      factsError: null,
      factsWarnings: []
    });
    void appendLog('Постобработка запущена во вкладке без ожидания service worker', {
      sourceId: entry.sourceId,
      tabId,
      factsJobId
    });
  }).catch((error) => {
    void updateFactsMetadata(entry.sourceId, context?.generationId || entry.generationId || null, {
      factsStatus: 'pending',
      factsUpdatedAt: new Date().toISOString(),
      factsError: `Не удалось запустить постобработку: ${error?.message || String(error)}`,
      factsWarnings: []
    });
    void appendLog('Постобработка не стартовала; генерации продолжаются', {
      sourceId: entry.sourceId,
      tabId,
      error: error?.message || String(error)
    });
    void cleanupPostprocessTab(runId, tabId);
  });
}

function isIndexedDbPersistenceError(error) {
  const code = String(error?.code || '').toUpperCase();
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || error || '');
  return /^IDB_(?:OPEN|TRANSACTION)_TIMEOUT$/.test(code)
    || name === 'quotaexceedederror'
    || /indexeddb.*(?:failed|aborted|timed out|quota)|transaction.*timed out/i.test(message);
}

async function handleFactsExtractionResult(message, sender) {
  const sourceId = String(message?.entryId || '');
  const tabId = Number(sender?.tab?.id || message?.tabId || 0);
  const runId = String(message?.operationId || '');
  if (!sourceId) throw new Error('Facts result has no sourceId');

  const stored = await getStored();
  const entry = findQueueEntry(stored.queue, sourceId)
    || stored.generationMemory?.items?.[sourceId]
    || null;
  const activeSlotOwnsTab = tabId
    ? Object.values(stored.run?.slots || {}).some((slot) => Number(slot?.tabId || 0) === tabId && slot?.entryId === sourceId)
    : false;
  const activeOwningSlot = tabId
    ? Object.values(stored.run?.slots || {}).find((slot) => Number(slot?.tabId || 0) === tabId && slot?.entryId === sourceId) || null
    : null;
  const postprocessOwner = tabId ? (stored.run?.postprocessTabs?.[String(tabId)] || null) : null;
  const postprocessOwnsTab = Boolean(postprocessOwner);
  const canCleanupFactsTab = Boolean(tabId) && (
    message?.fastPath !== true
    || postprocessOwnsTab
    || !activeSlotOwnsTab
  );
  if (runId && stored.run?.operationId && stored.run.operationId !== runId) {
    await appendLog('Игнорирую устаревший ответ постобработки от предыдущего запуска', {
      sourceId,
      resultRunId: runId,
      activeRunId: stored.run.operationId,
      tabId
    });
    return { stale: true, reason: 'run_mismatch' };
  }
  const expectedFactsJobId = String(activeOwningSlot?.factsJobId || postprocessOwner?.factsJobId || '');
  if (expectedFactsJobId && String(message?.factsJobId || '') !== expectedFactsJobId) {
    await appendLog('Игнорирую устаревший ответ постобработки: factsJobId не совпадает', {
      sourceId,
      tabId,
      expectedFactsJobId,
      receivedFactsJobId: message.factsJobId
    });
    return { stale: true, reason: 'facts_job_mismatch' };
  }
  const expectedGenerationId = String(activeOwningSlot?.generationId || postprocessOwner?.generationId || '');
  const receivedGenerationId = String(message?.generationId || '');
  if (expectedGenerationId && receivedGenerationId && receivedGenerationId !== expectedGenerationId) {
    await appendLog('Игнорирую устаревший ответ постобработки: generationId не совпадает', {
      sourceId, tabId, expectedGenerationId, receivedGenerationId
    });
    return { stale: true, reason: 'generation_mismatch' };
  }
  if (tabId && !activeSlotOwnsTab && !postprocessOwnsTab) {
    await appendLog('Игнорирую ответ постобработки от вкладки, которая больше не владеет моделью', {
      sourceId,
      runId,
      tabId
    });
    return { stale: true, reason: 'tab_not_owned' };
  }
  if (!entry) {
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    throw new Error('Facts result refers to an unknown model');
  }

  const resultGenerationId = expectedGenerationId
    || receivedGenerationId
    || String(entry.generationId || '')
    || generationId(sourceId, `${runId || 'legacy'}-${message?.factsJobId || 'facts'}`);
  const revision = await getGenerationRevision(resultGenerationId).catch(() => null);
  if (revision?.reviewStatus === 'rejected') {
    await appendLog('Игнорирую ответ OCR для ревизии, уже помеченной браком', {
      sourceId, generationId: resultGenerationId, factsJobId: message?.factsJobId || null, tabId
    });
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    return { stale: true, reason: 'revision_rejected' };
  }
  const revisionEntry = revision ? { ...entry, ...revision, sourceId } : entry;
  if (revision?.factsStatus === 'ok'
    && revision?.factsJobId
    && revision.factsJobId === String(message?.factsJobId || '')) {
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    return { ok: true, duplicate: true, warnings: revision?.facts?.warnings || [] };
  }
  const expectedHash = String(message?.outputHash || revision?.outputHash || '');
  const currentHash = String(revision?.outputHash || entry.outputHash || '');
  if (expectedHash && currentHash && expectedHash !== currentHash) {
    // A regenerated image must never receive facts from the previous PNG.
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    await appendLog('Игнорирую устаревший ответ постобработки', { sourceId, expectedHash, currentHash });
    return { stale: true };
  }

  if (message?.error) {
    const rateLimited = message.error.code === 'RATE_LIMIT' || /RATE_LIMIT/i.test(String(message.error.message || ''));
    // If verified-file finalization deduplicated against a still-running fast
    // attempt and that attempt later fails, retry once from the verified owner.
    // Fallback messages are not fastPath, so this branch cannot recurse.
    if (message?.fastPath === true && postprocessOwnsTab && !rateLimited && message?.error?.promptAccepted !== true) {
      await appendLog('Fast-path постпроверка не отправилась; повторяю после подтверждённого скачивания', {
        sourceId,
        tabId,
        error: message.error.message || 'unknown'
      });
      startFactsExtractionDetached({
        tabId,
        runId,
        entry: { ...entry },
        outputPath: entry.outputPath || null,
        outputHash: entry.outputHash || null,
        factsJobId: expectedFactsJobId || message?.factsJobId || null,
        chatUrl: message?.chatUrl || entry.chatUrl || null
      });
      return { ok: false, retrying: true };
    }
    const errorStage = String(message?.error?.factsStage || '').toUpperCase() || null;
    const errorMessage = message.error.message || 'Postprocess extraction failed';
    const errorRecord = {
      sourceId,
      generationId: resultGenerationId,
      outputHash: message?.outputHash || entry.outputHash || null,
      outputPath: message?.outputPath || entry.outputPath || null,
      modelName: entry.modelName || entry.fileName || '',
      profileId: detectBrandProfile(entry.modelName || entry.fileName || ''),
      status: rateLimited ? 'pending' : 'error',
      warnings: [],
      rawResponse: String(message.error.responseText || '').slice(0, 16000),
      error: errorStage ? `[${errorStage}] ${errorMessage}` : errorMessage,
      errorStage,
      errorCode: message?.error?.code || null,
      promptSubmitted: message?.error?.promptSubmitted === true,
      promptAccepted: message?.error?.promptAccepted === true,
      responseDiagnostics: message.error.responseDiagnostics && typeof message.error.responseDiagnostics === 'object'
        ? { ...message.error.responseDiagnostics }
        : null,
      extractedAt: new Date().toISOString(),
      extractorVersion: FACTS_EXTRACTOR_VERSION,
      factsJobId: message?.factsJobId || null,
      chatUrl: normalizeChatConversationUrl(message?.chatUrl || entry.chatUrl)
    };
    const persistedRevision = await upsertGenerationRevision({
      ...revision,
      generationId: resultGenerationId,
      sourceId,
      factsJobId: message?.factsJobId || revision?.factsJobId || null,
      factsStatus: errorRecord.status,
      facts: errorRecord,
      factsSavedAt: errorRecord.extractedAt,
      chatUrl: errorRecord.chatUrl || revision?.chatUrl || null
    }, { rejectIfReviewed: true });
    if (persistedRevision?.reviewStatus === 'rejected') {
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { stale: true, reason: 'revision_rejected' };
    }
    await updateFactsStage(message, sender, { stage: rateLimited ? 'RATE_LIMIT' : 'ERROR', error: errorRecord.error, chatUrl: errorRecord.chatUrl });
    await updateFactsMetadata(sourceId, resultGenerationId, {
      factsStatus: errorRecord.status,
      factsUpdatedAt: errorRecord.extractedAt,
      factsError: errorRecord.error,
      factsWarnings: [],
      chatUrl: errorRecord.chatUrl || null
    });
    void appendLog('Постобработка завершилась ошибкой', {
      sourceId, generationId: resultGenerationId, factsJobId: errorRecord.factsJobId,
      rateLimited, error: errorRecord.error, errorStage: errorRecord.errorStage,
      errorCode: errorRecord.errorCode, promptSubmitted: errorRecord.promptSubmitted,
      promptAccepted: errorRecord.promptAccepted, responseDiagnostics: errorRecord.responseDiagnostics
    });
    const waitForLateJson = !rateLimited && errorRecord.promptAccepted
      && /Timeout waiting for settled assistant text|FACTS_JSON_(?:INCOMPLETE|PARSE)/i.test(errorMessage)
      && postprocessOwnsTab;
    if (waitForLateJson) {
      await withStateLock(async () => {
        const stored = await getStored();
        const owner = stored.run?.operationId === runId ? stored.run.postprocessTabs?.[String(tabId)] : null;
        if (!owner || owner.entryId !== sourceId || owner.factsJobId !== errorRecord.factsJobId) return;
        owner.recoveryDeadlineAt = Date.now() + FINAL_CHECK_TIMEOUT_MS;
        await saveRunAndQueue(stored.run, stored.queue);
      });
      await updateFactsStage(message, sender, {
        stage: 'RECEIVING_RESPONSE',
        chatUrl: errorRecord.chatUrl,
        error: null
      });
      startFactsPulseMonitor(0);
    } else if (canCleanupFactsTab) {
      void cleanupPostprocessTab(runId, tabId);
    }
    return { ok: false, rateLimited };
  }

  let revisionFactsCommitted = false;
  try {
    await updateFactsStage(message, sender, { stage: 'PERSISTING', chatUrl: message?.chatUrl });
    const facts = normalizeExtractedFacts(revisionEntry, message?.text || '', {
      generationId: resultGenerationId,
      outputPath: message?.outputPath || entry.outputPath || null,
      outputHash: message?.outputHash || entry.outputHash || null,
      chatUrl: message?.chatUrl || entry.chatUrl || null
    });
    facts.factsJobId = message?.factsJobId || null;
    facts.pageDurationMs = Number(message?.durationMs || 0) || null;
    facts.completion = message?.completion || null;
    const persistedRevision = await persistGenerationFactsRevision({
      ...revision,
      generationId: resultGenerationId,
      sourceId,
      factsJobId: facts.factsJobId,
      factsStatus: 'ok',
      facts,
      factsSavedAt: facts.extractedAt,
      chatUrl: facts.chatUrl || revision?.chatUrl || null,
      responseFingerprint: facts.responseFingerprint || null,
      status: 'READY'
    });
    if (!persistedRevision?.matched || persistedRevision?.latest !== true) {
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { stale: true, reason: persistedRevision?.matched ? 'generation_superseded' : 'revision_rejected_or_mismatch' };
    }
    revisionFactsCommitted = true;
    await updateFactsMetadata(sourceId, resultGenerationId, {
      factsStatus: 'ok',
      factsUpdatedAt: facts.extractedAt,
      factsError: null,
      factsWarnings: facts.warnings,
      chatUrl: facts.chatUrl || null
    });
    await updateFactsStage(message, sender, { stage: 'SAVED', chatUrl: facts.chatUrl });
    await completeRepairQueueClaim(runId, sourceId, resultGenerationId).catch((error) => {
      void appendLog('Не удалось завершить элемент очереди перегенерации', {
        sourceId, generationId: resultGenerationId, error: error?.message || String(error)
      });
    });
    void appendLog('Постобработка: текст карточки сохранён', {
      sourceId,
      warnings: facts.warnings,
      durationMs: facts.pageDurationMs,
      completion: facts.completion
    });
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    return { ok: true, warnings: facts.warnings };
  } catch (error) {
    if (revisionFactsCommitted) {
      await updateFactsStage(message, sender, { stage: 'SAVED', chatUrl: message?.chatUrl, error: null }).catch(() => {});
      void appendLog('Характеристики записаны в ревизию; не удалось обновить вторичную проекцию', {
        sourceId, generationId: resultGenerationId, error: error?.message || String(error)
      });
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { ok: true, projectionWarning: true };
    }
    if (isIndexedDbPersistenceError(error)) {
      const persistenceMessage = `IndexedDB не сохранила спецификацию: ${error?.message || String(error)}. PNG остаётся сохранённым; повтори извлечение из галереи.`;
      await updateFactsStage(message, sender, { stage: 'ERROR', error: persistenceMessage, chatUrl: message?.chatUrl }).catch(() => {});
      void appendLog('Не удалось сохранить спецификацию в IndexedDB; освобождаю вкладку постпроверки', {
        sourceId, generationId: resultGenerationId, factsJobId: message?.factsJobId || null,
        error: error?.message || String(error)
      });
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { ok: false, persistenceError: true };
    }
    const parseWarning = error?.code === 'FACTS_JSON_INCOMPLETE'
      ? 'FACTS_INCOMPLETE_RESPONSE'
      : 'FACTS_PARSE_ERROR';
    const errorRecord = {
      sourceId,
      generationId: resultGenerationId,
      outputHash: message?.outputHash || entry.outputHash || null,
      outputPath: message?.outputPath || entry.outputPath || null,
      modelName: entry.modelName || entry.fileName || '',
      profileId: detectBrandProfile(entry.modelName || entry.fileName || ''),
      status: 'error',
      warnings: [parseWarning],
      rawResponse: String(message?.text || error?.responseText || '').slice(0, 16000),
      error: error?.message || String(error),
      extractedAt: new Date().toISOString(),
      extractorVersion: FACTS_EXTRACTOR_VERSION,
      completion: message?.completion || null,
      missingKeys: Array.isArray(error?.missingKeys) ? error.missingKeys : [],
      factsJobId: message?.factsJobId || null,
      chatUrl: normalizeChatConversationUrl(message?.chatUrl || entry.chatUrl)
    };
    let persistedRevision;
    try {
      persistedRevision = await upsertGenerationRevision({
        ...revision,
        generationId: resultGenerationId,
        sourceId,
        factsJobId: message?.factsJobId || revision?.factsJobId || null,
        factsStatus: 'error',
        facts: errorRecord,
        factsSavedAt: errorRecord.extractedAt,
        chatUrl: errorRecord.chatUrl || revision?.chatUrl || null
      }, { rejectIfReviewed: true });
    } catch (persistError) {
      const persistenceMessage = `Не удалось записать ошибку разбора спецификации: ${persistError?.message || String(persistError)}. PNG сохранён; повтори чтение из галереи.`;
      await updateFactsStage(message, sender, { stage: 'ERROR', error: persistenceMessage, chatUrl: errorRecord.chatUrl }).catch(() => {});
      void appendLog('Не удалось сохранить статус ошибки спецификации в IndexedDB', {
        sourceId, generationId: resultGenerationId, factsJobId: message?.factsJobId || null,
        error: persistError?.message || String(persistError)
      });
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { ok: false, persistenceError: true };
    }
    if (persistedRevision?.reviewStatus === 'rejected') {
      if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
      return { stale: true, reason: 'revision_rejected' };
    }
    await updateFactsStage(message, sender, { stage: 'ERROR', error: errorRecord.error, chatUrl: errorRecord.chatUrl });
    void updateFactsMetadata(sourceId, resultGenerationId, {
      factsStatus: 'error',
      factsUpdatedAt: errorRecord.extractedAt,
      factsError: errorRecord.error,
      factsWarnings: errorRecord.warnings,
      chatUrl: errorRecord.chatUrl || null
    });
    void appendLog('Ответ постобработки получен, но не разобран', {
      sourceId,
      error: errorRecord.error,
      responseText: errorRecord.rawResponse.slice(0, 2000),
      completion: errorRecord.completion,
      missingKeys: errorRecord.missingKeys
    });
    if (canCleanupFactsTab) void cleanupPostprocessTab(runId, tabId);
    return { ok: false, parseError: true };
  }
}

async function finalizeCompletedArtifact(runId, slotId, entryId, outputPath, verification, options = {}) {
  let nextAssignment = null;
  let completedTabId = null;
  let completedGenerationId = null;
  let completedFactsJobId = null;
  let imagePersistedCurrent = false;
  let postprocessContext = null;
  let shouldCloseAutomationWindow = false;
  const expectedDownloadId = options.expectedDownloadId;
  const sourceMode = options.sourceMode || 'downloads';
  const existingFacts = await getGenerationFacts(entryId).catch(() => null);
  let factsAlreadyComplete = false;
  await withStateLock(async () => {
    const stored = await getStored();
    const { run } = stored;
    let { queue, history, generationMemory } = stored;
    if (!run || run.operationId !== runId) return;
    ({ queue, history, memory: generationMemory } = syncQueueWithHistory(queue, history, generationMemory, run));
    const slot = run.slots?.[slotId];
    if (!slot || slot.entryId !== entryId) return;
    if (expectedDownloadId != null && Number(slot.downloadId) !== Number(expectedDownloadId)) return;
    const entry = groupEntries(queue, run.groupId).find((item) => item.sourceId === entryId);
    if (!entry) return;
    const revisionId = ensureSlotGenerationIdentity(run, slot, entry, generationMemory);
    completedGenerationId = revisionId;
    const previousRevision = await getGenerationRevision(revisionId).catch(() => null);
    const revisionFacts = previousRevision?.facts || null;
    const expectedFactsJobId = String(slot.factsJobId || stableHash({ generationId: revisionId, extractorVersion: FACTS_EXTRACTOR_VERSION }));
    slot.factsJobId = expectedFactsJobId;
    completedFactsJobId = expectedFactsJobId;
    const factsCandidate = [revisionFacts, existingFacts].find((facts) => facts
      && facts.status === 'ok'
      && String(facts.generationId || '') === String(revisionId)
      && String(facts.factsJobId || '') === expectedFactsJobId
      && (!facts.outputHash || String(facts.outputHash).toLowerCase() === String(verification.sha256 || '').toLowerCase())
      && (!facts.outputPath || normalizedDownloadPath(facts.outputPath) === normalizedDownloadPath(outputPath)));
    factsAlreadyComplete = Boolean(factsCandidate);
    completedTabId = slot.tabId || null;
    entry.status = 'done';
    entry.generatedAt = new Date().toISOString();
    entry.outputPath = outputPath || null;
    entry.outputFileName = String(outputPath || '').replaceAll('\\', '/').split('/').at(-1) || entry.outputFileName;
    entry.outputHash = verification.sha256 || null;
    entry.outputWidth = Number(verification.width || 0) || null;
    entry.outputHeight = Number(verification.height || 0) || null;
    entry.verificationMode = verification.verificationMode || sourceMode;
    // The recipe belongs to the completed artifact, not merely to the worker
    // slot. Persist it before recordCompletedEntry() so a reload/update does
    // not put this model back at the head of the pending queue.
    entry.recipeHash = slot.recipeHash || entry.recipeHash || null;
    entry.profileId = slot.profileId || entry.profileId || null;
    entry.profileVersion = slot.profileVersion || entry.profileVersion || null;
    entry.generationId = revisionId;
    entry.previousGenerationId = slot.previousGenerationId || null;
    entry.chatUrl = normalizeChatConversationUrl(slot.chatUrl || revisionFacts?.chatUrl || existingFacts?.chatUrl || entry.chatUrl);
    entry.lastError = null;
    entry.errorClass = null;
    entry.nextRetryAt = null;
    entry.factsStatus = factsAlreadyComplete ? 'ok' : (completedTabId ? 'pending' : 'unavailable');
    entry.factsUpdatedAt = new Date().toISOString();
    entry.factsError = factsAlreadyComplete ? null : (completedTabId ? null : 'Рабочая вкладка недоступна для постобработки');
    entry.factsWarnings = factsAlreadyComplete && Array.isArray((revisionFacts || existingFacts)?.warnings) ? (revisionFacts || existingFacts).warnings : [];
    const imagePersistence = await persistGenerationImageRevision({
      ...previousRevision,
      generationId: revisionId,
      previousGenerationId: slot.previousGenerationId || previousRevision?.previousGenerationId || null,
      sourceId: entry.sourceId,
      skuKey: entry.skuKey || entry.sourceId,
      sourceVariantId: entry.inputSourceId || entry.sourceVariantId || previousRevision?.sourceVariantId || null,
      groupId: entry.groupId || run.groupId,
      modelName: entry.modelName || entry.fileName || null,
      fileName: entry.fileName || null,
      outputFileName: entry.outputFileName || null,
      operationId: runId,
      leaseId: slot.leaseId || null,
      slotId: Number(slotId),
      tabId: completedTabId,
      chatUrl: entry.chatUrl || null,
      imageUrlFingerprint: slot.resultFingerprint || null,
      outputPath: outputPath || null,
      outputHash: verification.sha256 || null,
      outputWidth: Number(verification.width || 0) || null,
      outputHeight: Number(verification.height || 0) || null,
      verificationMode: verification.verificationMode || sourceMode,
      downloadedAt: entry.generatedAt,
      completedAt: entry.generatedAt,
      recipeHash: entry.recipeHash || null,
      profileId: entry.profileId || null,
      profileVersion: entry.profileVersion || null,
      factsJobId: expectedFactsJobId,
      factsStatus: factsAlreadyComplete ? 'ok' : (completedTabId ? 'pending' : 'unavailable'),
      facts: factsAlreadyComplete ? factsCandidate : null,
      status: factsAlreadyComplete ? 'READY' : 'FACTS_PENDING'
    });
    imagePersistedCurrent = imagePersistence?.current === true && imagePersistence?.matched === true;
    recordCompletedEntry(history, entry, outputPath, generationMemory, runId, factsAlreadyComplete);
    if (factsAlreadyComplete && run.groupId === REGENERATION_QUEUE_ID) {
      const claimedAt = run.repairQueueClaims?.[entry.sourceId];
      const repairItems = normalizedRepairQueue(queue);
      const repairItem = repairItems.find((item) => item.sourceId === entry.sourceId);
      if (claimedAt && repairItem?.queuedAt === claimedAt) {
        queue.repairQueue = repairItems.filter((item) => item.sourceId !== entry.sourceId);
        delete run.repairQueueClaims[entry.sourceId];
        recordRunEvent(run, 'repair_queue_item_completed', { sourceId: entry.sourceId, generationId: revisionId });
      }
    }
    if (generationMemory.items[entry.sourceId]) {
      Object.assign(generationMemory.items[entry.sourceId], {
        generationId: revisionId,
        previousGenerationId: slot.previousGenerationId || null,
        factsStatus: entry.factsStatus,
        factsUpdatedAt: entry.factsUpdatedAt,
        factsError: entry.factsError,
        factsWarnings: [],
        chatUrl: entry.chatUrl || null
      });
    }
    if (completedTabId && !factsAlreadyComplete) {
      run.postprocessTabs ||= {};
      const persistedFactsProgress = run.factsProgress?.[expectedFactsJobId] || null;
      run.postprocessTabs[String(completedTabId)] = {
        tabId: completedTabId,
        entryId: entry.sourceId,
        modelName: entry.modelName || entry.fileName || null,
        outputFileName: entry.outputFileName || null,
        factsJobId: expectedFactsJobId,
        generationId: revisionId,
        chatUrl: entry.chatUrl || null,
        outputPath: outputPath || null,
        outputHash: verification.sha256 || null,
        userTurnId: persistedFactsProgress?.userTurnId || null,
        baselineAssistantCount: Number(persistedFactsProgress?.baselineAssistantCount || 0),
        baselineUserCount: Number(persistedFactsProgress?.baselineUserCount || 0),
        slotId,
        startedAt: new Date().toISOString(),
        recoveryDeadlineAt: Date.now() + FINAL_CHECK_TIMEOUT_MS,
        lastPulseAt: null
      };
      void protectAutomationTab(completedTabId);
      postprocessContext = {
        tabId: completedTabId,
        runId,
        entry: { ...entry },
        outputPath: outputPath || null,
        outputHash: verification.sha256 || null,
        factsJobId: expectedFactsJobId,
        generationId: revisionId,
        chatUrl: entry.chatUrl || null,
        slotId
      };
    }
    slot.lastEntryName = entry.fileName;
    slot.lastModelName = entry.modelName;
    slot.lastResult = 'DOWNLOADED';
    slot.lastCheckState = 'DOWNLOADED';
    slot.lastCheckError = null;
    slot.lastCheckAt = new Date().toISOString();
    slot.errorClass = null;
    slot.nextRetryAt = null;
    slot.status = 'DONE';
    slot.phase = SLOT_PHASES.DONE;
    slot.downloadVerification = verification;
    slot.resultFingerprint = stableHash({ entryId: entry.sourceId, outputHash: verification.sha256 || null, outputPath });
    slot.downloadId = null;
    slot.launchWaitUntil = null;
    slot.finalCheckPending = false;
    slot.finalCheckDeadlineAt = null;
    slot.finalCheckAttempts = 0;
    slot.failed = false;
    slot.revisionPersistFailures = 0;
    slot.revisionPersistRetryAt = null;
    slot.revisionPersistBlocked = false;
    clearResolvedRunError(run, queue);
    run.currentAction = `${sourceMode === 'custom' ? 'Сохранено' : 'Скачано'}: ${entry.fileName}`;
    run.lastActivityAt = new Date().toISOString();
    slot.tabId = null;
    recordRunEvent(run, 'output_verified', {
      slotId,
      entryId: entry.sourceId,
      generationId: revisionId,
      outputPath,
      sourceMode,
      verificationMode: verification.verificationMode,
      width: verification.width || null,
      height: verification.height || null,
      sha256: verification.sha256 || null
    });
    await appendLog(sourceMode === 'custom' ? 'Фото сохранено в выбранную папку и проверено' : 'Фото скачано и проверено', {
      slotId, entryName: entry.fileName, outputPath, verification, sourceMode
    });
    if (run.state === 'RUNNING' && run.pendingIds.length) {
      const nextEntryId = run.pendingIds.shift();
      const nextEntry = groupEntries(queue, run.groupId).find((item) => item.sourceId === nextEntryId);
      if (nextEntry) {
        nextEntry.status = 'running';
        setGenerationMemoryStatus(generationMemory, nextEntry, GENERATION_MEMORY_STATUSES.RUNNING, {
          statusSource: 'automatic',
          generationStartedAt: new Date().toISOString(),
          lastError: null,
          lastRunId: runId,
          retryCount: Number(nextEntry.retryCount || 0),
          errorClass: null,
          nextRetryAt: null,
        });
        delete history.items[nextEntry.sourceId];
        history.ignored[nextEntry.sourceId] = true;
        Object.assign(slot, freshSlotRevisionFields());
        slot.entryId = nextEntryId;
        slot.status = 'STARTING';
        slot.phase = SLOT_PHASES.PREPARING;
        slot.leaseId = makeLeaseId();
        slot.attempt = Number(nextEntry.retryCount || 0) + 1;
        slot.errorClass = null;
        slot.nextRetryAt = null;
        slot.lastHeartbeatAt = new Date().toISOString();
        slot.lastProbeAt = null;
        slot.lastProgressAt = new Date().toISOString();
        slot.generationSubmittedAt = null;
        slot.assistantObservedAt = null;
        slot.assistantCount = 0;
        slot.imageCandidate = false;
        slot.imageCandidateSource = null;
        slot.resultFingerprint = null;
        slot.outputFileName = null;
        slot.downloadVerification = null;
        slot.lastEntryName = nextEntry.fileName;
        slot.lastModelName = nextEntry.modelName;
        slot.lastResult = null;
        slot.lastCheckState = null;
        slot.lastCheckError = null;
        slot.checkFailures = 0;
        slot.lastFocusAt = null;
        slot.focusCount = 0;
        slot.launchWaitUntil = null;
        slot.generationGapMs = null;
        slot.rateLimitRetryNeeded = false;
        slot.factsJobId = null;
        slot.generationId = null;
        slot.previousGenerationId = null;
        slot.chatUrl = null;
        run.currentAction = `Запускаю следующую генерацию: ${nextEntry.fileName}`;
        nextAssignment = { entry: nextEntry, slot: { ...slot } };
      } else {
        slot.entryId = null;
        if (['RUNNING', 'DRAINING'].includes(run.state)) shouldCloseAutomationWindow = finalizeDrainingRun(run, queue) && run.state === 'DONE';
      }
    } else {
      slot.entryId = null;
      if (['RUNNING', 'DRAINING'].includes(run.state)) shouldCloseAutomationWindow = finalizeDrainingRun(run, queue) && run.state === 'DONE';
    }
    if (shouldEnterFactsDraining(run, nextAssignment)) {
      run.state = 'DRAINING';
      run.status = 'DRAINING';
      run.currentAction = 'Изображения скачаны. Дожидаюсь постпроверки характеристик.';
    }
    // Start the page-owned text extraction before persisting the large queue /
    // generationMemory snapshot. This is intentionally fire-and-forget: the
    // extraction Send click must not wait behind multi-megabyte storage I/O.
    if (postprocessContext) startFactsExtractionDetached(postprocessContext);
    await saveRunAndQueue(run, queue, history, generationMemory);
    await publishRun(run, queue);
  });
  if (factsAlreadyComplete && imagePersistedCurrent && completedFactsJobId) {
    await updateFactsStage({ operationId: runId, entryId, factsJobId: completedFactsJobId, slotId }, null, {
      stage: 'SAVED', slotId, tabId: completedTabId, chatUrl: existingFacts?.chatUrl || null
    });
  }
  // Generation capacity is released immediately after the PNG is verified.
  // Start the replacement worker before waiting for any text-only postprocess.
  if (nextAssignment) void executeSlot(runId, nextAssignment.slot.slotId, nextAssignment.entry.sourceId);

  if (!postprocessContext && completedTabId) {
    await chrome.tabs.remove(completedTabId).catch(() => {});
  }
  if (shouldCloseAutomationWindow) await closeAutomationWindowIfEmpty(runId);
}

async function finishDownload(runId, slotId, downloadId, outputPath, knownVerification = null) {
  const downloadKey = Number(downloadId);
  if (activeDownloadFinalizations.has(downloadKey)) return { skipped: true, reason: 'finalization_in_progress' };
  activeDownloadFinalizations.add(downloadKey);
  try {
  let [downloadItem] = await chrome.downloads.search({ id: Number(downloadId) }).catch(() => []);
  if (downloadItem?.state === 'complete' && !downloadItem.fileSize && !downloadItem.bytesReceived) {
    await sleep(250);
    [downloadItem] = await chrome.downloads.search({ id: Number(downloadId) }).catch(() => [downloadItem]);
  }
  let expectedEntry = null;
  try {
    const stored = await getStored();
    expectedEntry = groupEntries(stored.queue, stored.run?.groupId)
      .find((entry) => entry.sourceId === stored.run?.slots?.[slotId]?.entryId) || null;
  } catch (_) {}
  const downloadedFileName = String(downloadItem?.filename || outputPath || '').replaceAll('\\', '/').split('/').at(-1) || '';
  const runSnapshot = await chrome.storage.local.get('run').then(({ run }) => run).catch(() => null);
  const owningSlot = runSnapshot?.operationId === runId ? runSnapshot.slots?.[slotId] : null;
  const sourceUrl = String(downloadItem?.finalUrl || downloadItem?.url || '');
  const fallbackVerify = knownVerification?.valid === true
    ? async () => knownVerification
    : owningSlot?.tabId && sourceUrl
    ? async () => {
      const response = await sendTabMessage(Number(owningSlot.tabId), {
        type: 'VERIFY_GENERATED_PNG_SOURCE',
        operationId: runId,
        entryId: owningSlot.entryId,
        url: sourceUrl
      }, 20000);
      if (!response?.ok) throw new Error(response?.error?.message || 'Страница не смогла проверить исходный PNG');
      return response.value;
    }
    : null;
  const verification = await verifyDownloadedArtifact(downloadItem, { outputFileName: downloadedFileName }, fallbackVerify);
  if (!verification.valid) {
    await pauseRunOnError(runId, new Error(`Результат скачивания не прошёл проверку: ${verification.reason || 'невалидный PNG'}`), {
      slotId,
      downloadId,
      outputPath: outputPath || downloadItem?.filename || null,
      generationSubmitted: true,
      errorClass: AUTOMATION_ERROR_CLASSES.INVALID_OUTPUT
    });
    return;
  }
  if (!expectedEntry) return;
  const resolvedOutputPath = outputPath || downloadItem?.filename || null;
  const capacity = await reservePostprocessCapacity(runId, slotId, downloadId);
  if (!capacity.allowed) {
    return { ok: false, deferred: true, reason: 'postprocess_capacity_full' };
  }
  try {
    await finalizeCompletedArtifact(runId, slotId, expectedEntry.sourceId, resolvedOutputPath, verification, {
      expectedDownloadId: downloadId,
      sourceMode: 'downloads'
    });
  } catch (error) {
    let retryAt = null;
    let terminalFailure = false;
    let terminalTabId = null;
    await withStateLock(async () => {
      const stored = await getStored();
      const run = stored.run?.operationId === runId ? stored.run : null;
      const slot = run?.slots?.[slotId];
      if (!run || slot?.entryId !== expectedEntry.sourceId || Number(slot.downloadId) !== Number(downloadId)) return;
      const failures = Math.max(0, Number(slot.revisionPersistFailures || 0)) + 1;
      slot.revisionPersistFailures = failures;
      slot.lastCheckError = error?.message || String(error);
      run.lastActivityAt = new Date().toISOString();
      if (failures >= MAX_ARTIFACT_REVISION_PERSIST_FAILURES) {
        terminalFailure = true;
        slot.revisionPersistBlocked = true;
        slot.revisionPersistRetryAt = null;
        slot.status = 'PAUSED';
        slot.phase = SLOT_PHASES.NEEDS_ATTENTION;
        slot.finalCheckPending = false;
        slot.finalCheckDeadlineAt = null;
        slot.failed = true;
        slot.lastCheckState = 'REVISION_PERSIST_FAILED';
        terminalTabId = Number(slot.tabId || 0) || null;
        slot.tabId = null;
        const entries = groupEntries(stored.queue, run.groupId);
        const entry = entries.find((item) => item.sourceId === expectedEntry.sourceId);
        if (entry && entry.status !== 'done') {
          entry.status = 'error';
          entry.lastError = slot.lastCheckError;
          entry.errorClass = AUTOMATION_ERROR_CLASSES.DOWNLOAD;
          entry.nextRetryAt = null;
          entry.autoRetryPending = false;
          stored.generationMemory = normalizeGenerationMemory(stored.generationMemory);
          setGenerationMemoryStatus(stored.generationMemory, entry, GENERATION_MEMORY_STATUSES.NOT_READY, {
            statusSource: 'automatic', generationStartedAt: slot.generationSubmittedAt || null,
            lastError: slot.lastCheckError, lastRunId: runId
          });
        }
        run.state = 'PAUSED';
        run.status = 'PAUSED_ON_ERROR';
        run.pauseReason = 'ERROR';
        run.unresolvedError = true;
        run.error = slot.lastCheckError;
        run.finishedAt = null;
        run.currentAction = 'PNG уже скачан. Запись ревизии не прошла 3 попытки, прогон поставлен на паузу; «Продолжить» повторит сохранение без новой генерации.';
        recordRunEvent(run, 'artifact_revision_persist_blocked', {
          slotId, entryId: expectedEntry.sourceId,
          generationId: slot.generationId || null, downloadId,
          attempts: failures, outputPath: resolvedOutputPath,
          error: slot.lastCheckError
        });
      } else {
        const backoffMs = Math.min(5 * 60_000, 30_000 * (2 ** Math.min(failures - 1, 4)));
        retryAt = Date.now() + backoffMs;
        slot.revisionPersistBlocked = false;
        slot.revisionPersistRetryAt = retryAt;
        slot.status = 'DOWNLOADING';
        slot.phase = SLOT_PHASES.DOWNLOADING;
        run.currentAction = `PNG скачан; повторная запись ревизии через ${Math.ceil(backoffMs / 1000)} с`;
        recordRunEvent(run, 'artifact_revision_persist_retry_scheduled', {
          slotId,
          entryId: expectedEntry.sourceId,
          generationId: slot.generationId || null,
          attempt: failures,
          retryAt: new Date(retryAt).toISOString(),
          error: slot.lastCheckError
        });
      }
      await saveRunAndQueue(run, stored.queue, undefined, stored.generationMemory);
      await publishRun(run, stored.queue);
    });
    if (!retryAt && !terminalFailure) throw error;
    if (terminalTabId) await chrome.tabs.remove(terminalTabId).catch(() => {});
    await appendLog(terminalFailure
      ? 'PNG скачан, но запись ревизии исчерпала лимит попыток; прогон остановлен на паузу'
      : 'PNG проверен; запись ревизии не завершилась, будет повторена с паузой', {
      operationId: runId,
      slotId,
      entryId: expectedEntry.sourceId,
      downloadId,
      retryAt: retryAt ? new Date(retryAt).toISOString() : null,
      error: error?.message || String(error)
    });
    return { ok: false, persistPending: true, terminal: terminalFailure, retryAt };
  } finally {
    if (capacity.reserved) releasePostprocessCapacity(downloadId);
  }
  } finally {
    activeDownloadFinalizations.delete(downloadKey);
  }
}

async function persistDownloadStartedFast({ operationId, slotId, entryId, downloadId, resultFingerprint, outputFileName, chatUrl }) {
  return withStateLock(async () => {
    const { run } = await chrome.storage.local.get('run');
    if (!run || run.operationId !== operationId) return false;
    const slot = run.slots?.[slotId];
    if (!slot || slot.entryId !== entryId) return false;
    slot.downloadId = downloadId;
    slot.status = 'DOWNLOADING';
    slot.phase = SLOT_PHASES.DOWNLOADING;
    slot.resultFingerprint = resultFingerprint;
    if (normalizeChatConversationUrl(chatUrl)) slot.chatUrl = normalizeChatConversationUrl(chatUrl);
    slot.lastHeartbeatAt = new Date().toISOString();
    slot.lastCheckState = 'DOWNLOADING';
    slot.lastCheckError = null;
    slot.lastActivityAt = new Date().toISOString();
    slot.failed = false;
    run.currentAction = `Скачиваю результат: ${outputFileName || slot.lastEntryName || entryId}`;
    run.lastActivityAt = slot.lastActivityAt;
    recordRunEvent(run, 'download_started', { slotId, entryId, downloadId, resultFingerprint });
    await chrome.storage.local.set({ run });
    await publishRun(run, null);
    return true;
  });
}

async function startGeneratedDownload({ operationId, slotId, entryId, url, dataUrl, recovery = false, outputFileName = null, sourceMode = 'direct-url', chatUrl = null }) {
  // Critical path: only read the run object first. The former getStored() read
  // pulled queue/history/generationMemory/logs for every image before Chrome
  // was even allowed to start the download.
  const { run } = await chrome.storage.local.get('run');
  if (!run || run.operationId !== operationId) throw new Error('Запуск уже остановлен или заменён');
  const slot = run.slots?.[slotId];
  if (!slot || slot.entryId !== entryId) throw new Error('Несоответствие слота и карточки');

  const pausedObservationAllowed = run.state === 'PAUSED' && (
    slotGenerationSubmitted(slot)
    || slot.finalCheckPending
    || ['OBSERVING', 'GENERATING', 'WAITING_GENERATION', 'WAITING_IMAGE', 'REQUESTING_DOWNLOAD', 'DOWNLOADING'].includes(String(slot.status || '').toUpperCase())
  );
  const stateAllowed = ['RUNNING', 'DRAINING'].includes(run.state)
    || pausedObservationAllowed
    || (recovery === true && ['PAUSED', 'STOPPED'].includes(run.state));
  if (!stateAllowed) throw new Error('Запуск уже остановлен или поставлен на паузу до отправки генерации');
  if (slot.downloadId != null) return { mode: 'downloads', completed: false, downloadId: slot.downloadId, sourceMode: 'existing' };

  const pageDataUrl = typeof dataUrl === 'string' && /^data:image\/png;base64,/i.test(dataUrl)
    ? dataUrl
    : null;
  const downloadUrl = pageDataUrl || String(url || '');
  if (!downloadUrl) throw new Error('У изображения отсутствует URL для скачивания');

  const destination = await getOutputDestination();

  // Custom File System Access output still needs a Blob in the service worker.
  // For protected ChatGPT URLs ask the page to perform the fallback fetch,
  // rather than silently spending seconds on a worker-side authenticated fetch.
  if (destination.mode === 'custom' && !pageDataUrl) {
    throw new Error('CUSTOM_OUTPUT_REQUIRES_PAGE_FETCH');
  }

  let pagePayloadVerification = null;
  if (destination.mode === 'custom') {
    const stored = await getStored();
    const currentRun = stored.run;
      const entry = groupEntries(stored.queue, currentRun?.groupId).find((item) => item.sourceId === entryId);
      if (!currentRun || currentRun.operationId !== operationId || !entry) throw new Error('Данные карточки устарели');
      entry.outputFileName = String(slot.outputFileName || outputFileName || entry.outputFileName || '');
    const resultFingerprint = stableHash({
      entryId,
      url: String(url || ''),
      dataPrefix: pageDataUrl ? pageDataUrl.slice(0, 256) : null,
      recipeHash: entry.recipeHash || currentRun.recipeHash || null
    });
    try {
      await withStateLock(async () => {
        const current = await getStored();
        const currentSlot = current.run?.slots?.[slotId];
        if (!current.run || current.run.operationId !== operationId || currentSlot?.entryId !== entryId) return;
        currentSlot.status = 'DOWNLOADING';
        currentSlot.phase = SLOT_PHASES.DOWNLOADING;
        currentSlot.resultFingerprint = resultFingerprint;
        if (normalizeChatConversationUrl(chatUrl)) currentSlot.chatUrl = normalizeChatConversationUrl(chatUrl);
        currentSlot.lastHeartbeatAt = new Date().toISOString();
        currentSlot.lastCheckState = 'SAVING_CUSTOM_OUTPUT';
        currentSlot.lastCheckError = null;
        currentSlot.lastActivityAt = new Date().toISOString();
        current.run.currentAction = `Сохраняю в выбранную папку: ${entry.fileName}`;
        current.run.lastActivityAt = currentSlot.lastActivityAt;
        await saveRunAndQueue(current.run, current.queue, current.history, current.generationMemory);
        await publishRun(current.run, current.queue);
      });
      const blob = await blobFromGeneratedPayload(pageDataUrl, url);
      pagePayloadVerification = await verifyPngBlob(blob);
      if (!pagePayloadVerification.valid) throw new Error(`PNG не прошёл проверку перед записью: ${pagePayloadVerification.reason || 'invalid'}`);
      const saved = await writeGeneratedToCustomDirectory(entry, blob);
      if (!saved) throw new Error('Папка результатов не выбрана');
      await finalizeCompletedArtifact(operationId, slotId, entryId, saved.outputPath, saved.verification, { sourceMode: 'custom' });
      await appendLog('Результат сохранён напрямую в выбранную папку', {
        slotId, entryName: entry.fileName, outputPath: saved.outputPath, folderName: saved.folderName
      });
      return { mode: 'custom', completed: true, outputPath: saved.outputPath, verification: saved.verification, sourceMode: 'page-fetch' };
    } catch (error) {
      await appendLog('Прямая запись в выбранную папку недоступна, использую Downloads как резерв', {
        slotId, entryId, error: error?.message || String(error)
      });
      await chrome.storage.local.set({
        outputDestination: { ...destination, permission: error?.code === 'OUTPUT_DIRECTORY_PERMISSION' ? 'prompt' : destination.permission, lastError: error?.message || String(error) }
      }).catch(() => {});
      // pageDataUrl is already available here, so the normal Downloads fast
      // path below can save the same PNG without another page fetch.
    }
  }

  let resolvedOutputFileName = String(slot.outputFileName || outputFileName || '').trim();
  const slotOutputGroupId = QUEUE_GROUP_IDS.includes(String(slot.outputGroupId || '')) ? slot.outputGroupId : null;
  let outputEntry = null;
  if (!resolvedOutputFileName || !slotOutputGroupId) {
    const { queue: outputQueue } = await chrome.storage.local.get('queue');
    outputEntry = findQueueEntry(outputQueue, entryId);
  }
  if (!resolvedOutputFileName) {
    // Compatibility fallback for an older/recovered content script. This read
    // is intentionally avoided in the normal 0.3.10 path.
    resolvedOutputFileName = outputEntry?.outputFileName || outputEntry?.fileName || `${entryId}.png`;
  }
  const outputGroupId = slotOutputGroupId
    || (QUEUE_GROUP_IDS.includes(String(outputEntry?.groupId || '')) ? outputEntry.groupId : null);
  if (!outputGroupId) throw new Error('Не удалось определить настоящую категорию модели для сохранения PNG');
  const filename = `WatchAutomation/${sanitizeFilename(outputGroupId)}/${sanitizeFilename(resolvedOutputFileName)}`;
  if (pageDataUrl && !pagePayloadVerification) {
    pagePayloadVerification = await verifyPngBlob(await blobFromGeneratedPayload(pageDataUrl, url));
    if (!pagePayloadVerification.valid) throw new Error(`PNG не прошёл проверку перед скачиванием: ${pagePayloadVerification.reason || 'invalid'}`);
  }
  const resultFingerprint = stableHash({
    entryId,
    url: String(url || ''),
    dataPrefix: pageDataUrl ? pageDataUrl.slice(0, 256) : null,
    sourceMode
  });

  // Start the browser download before any large queue/history write.
  const downloadId = await chrome.downloads.download({
    url: downloadUrl,
    filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });

  const persistPromise = persistDownloadStartedFast({
    operationId,
    slotId,
    entryId,
    downloadId,
    resultFingerprint,
    outputFileName: resolvedOutputFileName,
    chatUrl: normalizeChatConversationUrl(chatUrl)
  });
  activeDownloadClaims.set(Number(downloadId), {
    operationId,
    slotId: Number(slotId),
    entryId,
    outputFileName: resolvedOutputFileName,
    pagePayloadVerification,
    persistPromise,
    startedAt: Date.now()
  });
  void persistPromise.catch((error) => appendLog('Не удалось быстро сохранить состояние скачивания', {
    slotId,
    entryId,
    downloadId,
    error: error?.message || String(error)
  }));
  void appendLog('Скачивание запущено fast-path', {
    slotId,
    entryName: resolvedOutputFileName,
    downloadId,
    sourceMode: pageDataUrl ? 'page-fetch' : 'direct-url'
  });

  // Return immediately. The content script can launch OCR/postcheck while the
  // small run-state write finishes in parallel.
  return {
    mode: 'downloads',
    completed: false,
    downloadId,
    sourceMode: pageDataUrl ? 'page-fetch' : 'direct-url'
  };
}

async function openDownloadsFolder() {
  const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 100 }).catch(() => []);
  const latest = items.find((item) => (
    item?.id != null
    && String(item.filename || '').replaceAll('\\', '/').toLowerCase().includes('/watchautomation/')
  ));
  if (latest?.id != null && chrome.downloads.show) {
    await chrome.downloads.show(Number(latest.id));
    return { fallback: false, downloadId: Number(latest.id), path: latest.filename || null };
  }
  // Chrome does not expose an arbitrary filesystem path to an extension.
  // The downloads page is the safe fallback when no WatchAutomation file has
  // been created yet; once a result exists downloads.show opens its folder in
  // the native file manager.
  if (chrome.tabs?.create) await chrome.tabs.create({ url: 'chrome://downloads/' });
  return { fallback: true };
}

async function captureDiagnosticsFromTab(tabId, context = {}) {
  try {
    const response = await sendTabMessage(tabId, { type: 'CAPTURE_DIAGNOSTICS', reason: context.reason || 'service-worker' });
    if (response?.ok && response.value) await storeDiagnostics({ ...context, ...response.value });
  } catch (_) {}
}

async function storeDiagnostics(diagnostic) {
  const value = { ...diagnostic, capturedAt: diagnostic.capturedAt || new Date().toISOString() };
  await chrome.storage.local.set({ lastDiagnostic: value });
  queueDiagnosticBridge(value);
  await appendLog('DOM-диагностика сохранена', { reason: value.reason, slotId: value.slotId, entryName: value.entryName });
  try { await chrome.runtime.sendMessage({ type: 'RUNTIME_UPDATED' }); } catch (_) {}
}

async function handleStateEvent(message, sender) {
  const patch = message.patch || {};
  const initialRun = (await chrome.storage.local.get('run')).run;
  const initialSlot = initialRun?.operationId === message.operationId
    ? initialRun.slots?.[message.slotId]
    : null;
  if (!initialSlot || initialSlot.entryId !== message.entryId
    || !message.leaseId || String(initialSlot.leaseId || '') !== String(message.leaseId)
    || (sender?.tab?.id != null && Number(initialSlot.tabId || 0) !== Number(sender.tab.id))) return;
  if (patch.state === 'CONVERSATION_LOAD_ERROR'
    || String(patch.errorClass || '').toUpperCase() === AUTOMATION_ERROR_CLASSES.CONVERSATION_LOAD_ERROR) {
    await beginConversationLoadRecovery(message.operationId, {
      slotId: message.slotId,
      entryId: message.entryId,
      leaseId: message.leaseId,
      error: patch.error || 'Не удалось загрузить этот разговор ChatGPT'
    });
    return;
  }
  if (patch.state === 'ERROR') {
    await pauseRunOnError(message.operationId, new Error(patch.error || 'Ошибка страницы'), {
      slotId: message.slotId,
      entryId: message.entryId,
      tabId: sender?.tab?.id || null,
      leaseId: message.leaseId,
      physicalSendAtMs: Number(patch.physicalSendAtMs || message.physicalSendAtMs || 0),
      rateLimit: patch.rateLimit === true,
      rateLimitBeforeAssistant: patch.rateLimitBeforeAssistant === true,
      generationSubmitted: patch.generationSubmitted === true,
      preparedForSubmit: patch.preparedForSubmit === true,
      errorClass: patch.errorClass || classifyAutomationError(patch.error || 'Ошибка страницы', {
        rateLimit: patch.rateLimit === true,
        tabClosed: patch.tabClosed === true
      }),
      terminalResponse: ['TEXT_ONLY', 'CLARIFICATION_REQUIRED', 'MODEL_REFUSAL', 'TOOL_UNAVAILABLE'].includes(String(patch.errorClass || '').toUpperCase())
    });
    return;
  }

  // Page telemetry is high-frequency and never needs the multi-megabyte queue,
  // history or generationMemory snapshots. Keeping those writes in the global
  // state lock caused unrelated slots to pile up behind storage I/O and then
  // "release" together. Persist only the small run object here; queue/memory
  // transitions are handled by claim/download/finalize operations.
  await withStateLock(async () => {
    const { run } = await chrome.storage.local.get('run');
    if (!run || run.operationId !== message.operationId) return;
      const slot = run.slots?.[message.slotId];
    if (!slot || slot.entryId !== message.entryId || String(slot.leaseId || '') !== String(message.leaseId || '')
      || (sender?.tab?.id != null && Number(slot.tabId || 0) !== Number(sender.tab.id))) return;

    const pageState = String(patch.state || '').toUpperCase();
    slot.status = patch.state || slot.status;
    const now = new Date().toISOString();
    slot.lastHeartbeatAt = now;
    const sameLeaseAlreadySubmitted = String(slot.pageSubmissionLeaseId || '') === String(message.leaseId)
      && slot.pageGenerationSubmitted === true;
    slot.pageSubmissionLeaseId = String(message.leaseId);
    slot.pageGenerationSubmitted = patch.generationSubmitted === true || sameLeaseAlreadySubmitted;
    slot.pageProbeAt = now;
    if (Number.isFinite(Number(patch.assistantCount))) slot.pageProbeAssistantCount = Number(patch.assistantCount);
    if (Number(message.physicalSendAtMs || patch.physicalSendAtMs || 0) > 0) {
      const physicalSendAtMs = Number(message.physicalSendAtMs || patch.physicalSendAtMs);
      slot.physicalSendAtMs = physicalSendAtMs;
      slot.physicalSendLeaseId = String(message.leaseId);
      slot.lastSendClickedAt = new Date(physicalSendAtMs).toISOString();
      slot.submissionObservationDeadlineAt ||= physicalSendAtMs + FINAL_CHECK_TIMEOUT_MS;
    }
    if (patch.phase) slot.phase = patch.phase;
    const reportedChatUrl = normalizeChatConversationUrl(message.chatUrl || sender?.tab?.url);
    if (reportedChatUrl) slot.chatUrl = reportedChatUrl;
    if (!patch.phase) {
      const phaseByPageState = {
        CREATING_NEW_CHAT: SLOT_PHASES.PREPARING,
        UPLOADING_ATTACHMENTS: SLOT_PHASES.UPLOADING,
        ATTACHMENTS_READY: SLOT_PHASES.UPLOADING,
        FILLING_PROMPT: SLOT_PHASES.UPLOADING,
        READY_TO_SEND: SLOT_PHASES.WAITING_LAUNCH,
        SENDING: SLOT_PHASES.SENDING,
        PROMPT_SENT: SLOT_PHASES.PROMPT_SENT,
        WAITING_GENERATION: SLOT_PHASES.GENERATING,
        GENERATING: SLOT_PHASES.GENERATING,
        WAITING_IMAGE: SLOT_PHASES.GENERATING,
        REQUESTING_DOWNLOAD: SLOT_PHASES.DOWNLOADING,
        DOWNLOADING: SLOT_PHASES.DOWNLOADING
      };
      if (phaseByPageState[pageState]) slot.phase = phaseByPageState[pageState];
    }
    if (patch.preparedForSubmit === true || pageState === 'READY_TO_SEND') {
      slot.preparedForSubmit = true;
      if (Number(run.rateLimitPauseUntil || 0) > Date.now()) {
        slot.rateLimitRetryNeeded = true;
        slot.phase = SLOT_PHASES.RATE_LIMIT_PAUSE;
      }
    }
    if (pageState === 'PROMPT_SENT') slot.preparedForSubmit = false;
    const submittedNow = patch.generationSubmitted === true || pageState === 'PROMPT_SENT';
    if (submittedNow) {
      const submittedAtMs = Number(patch.submittedAtMs || patch.physicalSendAtMs || message.physicalSendAtMs || Date.now());
      if (!slot.generationSubmittedAt) slot.generationSubmittedAt = new Date(submittedAtMs).toISOString();
      slot.submissionObservationDeadlineAt ||= submittedAtMs + FINAL_CHECK_TIMEOUT_MS;
      if (Number.isFinite(Number(patch.baselineAssistantCount))) {
        slot.baselineAssistantCount = Number(patch.baselineAssistantCount);
      }
      run.lastGenerationLaunchAt = Math.max(Number(run.lastGenerationLaunchAt || 0), submittedAtMs);
      run.lastAnySendAt = Math.max(Number(run.lastAnySendAt || 0), submittedAtMs);
      lastLaunchAt = Math.max(lastLaunchAt, submittedAtMs);
      lastAnySendAt = Math.max(lastAnySendAt, submittedAtMs);
      slot.rateLimitRetryNeeded = false;
      slot.preparedForSubmit = false;
      recordRunEvent(run, 'generation_submitted', { slotId: message.slotId, entryId: message.entryId, tabId: slot.tabId || null, submittedAtMs });
    }
    if (patch.progress || ['READY_TO_SEND', 'SENDING', 'PROMPT_SENT', 'WAITING_GENERATION', 'GENERATING', 'WAITING_IMAGE', 'READY', 'DOWNLOADING'].includes(pageState)) {
      slot.lastProgressAt = now;
      slot.lastActivityAt = now;
      run.lastProgressAt = now;
      run.noProgressSince = null;
      run.noProgressCycles = 0;
    }
    if (patch.error) slot.lastCheckError = patch.error;
    if (patch.state) {
      run.currentAction = `${patch.state}: ${entryDisplayName(null, slot)}`;
      recordRunEvent(run, 'page_state', {
        slotId: message.slotId,
        entryId: message.entryId,
        state: patch.state,
        generationSubmitted: patch.generationSubmitted === true
      });
    }
    run.lastActivityAt = slot.lastActivityAt || run.lastActivityAt;
    await flushRunDiagnosticsSafely(run, null);
    await chrome.storage.local.set({ run });
    await publishRun(run, null);
  });
}

async function reconcileDownloadChange(delta) {
  if (!delta.state && !delta.error) return;

  const claim = activeDownloadClaims.get(Number(delta.id));
  if (claim) {
    if (delta.error) {
      activeDownloadClaims.delete(Number(delta.id));
      await claim.persistPromise?.catch(() => {});
      await pauseRunOnError(claim.operationId, new Error(`Ошибка скачивания: ${delta.error.current}`), {
        slotId: Number(claim.slotId),
        entryId: claim.entryId,
        downloadId: delta.id
      });
      return;
    }
    if (delta.state?.current === 'complete') {
      // Ensure slot.downloadId reached storage before finalization checks it.
      // The postcheck is already running in the page and does not wait here.
      await claim.persistPromise?.catch(() => {});
      const [item] = await chrome.downloads.search({ id: delta.id });
      activeDownloadClaims.delete(Number(delta.id));
      await finishDownload(claim.operationId, Number(claim.slotId), delta.id, item?.filename || null, claim.pagePayloadVerification || null);
      return;
    }
  }

  // Recovery path for downloads that outlived a service-worker suspension.
  const { run } = await chrome.storage.local.get('run');
  if (!run) return;
  for (const [slotId, slot] of Object.entries(run.slots || {})) {
    if (slot.downloadId !== delta.id) continue;
    if (delta.error) {
      await pauseRunOnError(run.operationId, new Error(`Ошибка скачивания: ${delta.error.current}`), { slotId: Number(slotId), entryId: slot.entryId, downloadId: delta.id });
      return;
    }
    if (delta.state?.current === 'complete') {
      const [item] = await chrome.downloads.search({ id: delta.id });
      await finishDownload(run.operationId, Number(slotId), delta.id, item?.filename || null);
    }
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  reconcileDownloadChange(delta).catch((error) => appendLog('Ошибка обработки Downloads API', { error: error.message }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getStored().then(({ run }) => {
    if (!run || !['RUNNING', 'STARTING', 'DRAINING', 'PAUSED'].includes(run.state)) return null;
    const postprocess = run.postprocessTabs?.[String(tabId)] || null;
    if (postprocess) {
      // Manual/browser tab closure must not strand the run in DRAINING forever.
      // cleanupPostprocessTab also finalizes the run when this was the last
      // outstanding facts owner.
      return cleanupPostprocessTab(run.operationId, tabId);
    }
    const slot = Object.values(run.slots || {}).find((item) => item.tabId === tabId && item.entryId);
    if (!slot) return null;
    return pauseRunOnError(run.operationId, new Error('Рабочая вкладка ChatGPT была закрыта'), { slotId: slot.slotId, entryId: slot.entryId, tabId, tabClosed: true });
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['GET_RESULTS_TRANSFER_INFO', 'EXPORT_RESULTS_PACKAGE', 'PREVIEW_RESULTS_IMPORT', 'CLAIM_RESULTS_IMPORT',
    'COMMIT_RESULTS_IMPORT', 'RESUME_RESULTS_IMPORT'].includes(message?.type)) {
    if (sender?.tab?.url && !sender.tab.url.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ ok: false, error: 'Передача результатов доступна из галереи расширения' }); return false;
    }
    (async () => {
      if (message.type === 'GET_RESULTS_TRANSFER_INFO') return resultsTransferInfo();
      if (message.type === 'EXPORT_RESULTS_PACKAGE') return prepareResultsExport(String(message.operationId || ''));
      if (message.type === 'PREVIEW_RESULTS_IMPORT') {
        const job = await resultsTransferRequest('status', { id: message.id });
        if (job.kind !== 'import' || !['ready', 'installed'].includes(job.phase)) throw new Error('Проверка архива ещё выполняется');
        return resultsImportPreview(job.items, await getAllGenerationRevisions());
      }
      if (message.type === 'COMMIT_RESULTS_IMPORT') return importInstalledResults(message.id);
      if (message.type === 'CLAIM_RESULTS_IMPORT') return claimResultsImport(message.id);
      return completeResultsImport();
    })().then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'DEV_RELOAD_POLL') {
    Promise.all([
      pollDevReload('side-panel'),
      pollDevControl('side-panel')
    ]).then(([reload, control]) => sendResponse({ ok: reload?.ok !== false, reload, control }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'START_EXTENSION_UPDATE') {
    startManualExtensionUpdate()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'GET_EXTENSION_UPDATE_STATUS') {
    getManualExtensionUpdateStatus()
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'DOM_OBSERVATION_BATCH') {
    addDomObservations(Array.isArray(message.observations) ? message.observations : [message.observation])
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RUN_REQUEST') {
    startOrResumeRun({ selectedIds: message.selectedIds, intent: message.intent, preferredWindowId: message.preferredWindowId }).then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RUN_PREFLIGHT') {
    runPreflight({ selectedIds: message.selectedIds }).then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'START_RUN') {
    startRun().then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'DRY_RUN_REQUEST') {
    runDry().then((value) => sendResponse({ ok: true, value })).catch(async (error) => {
      await appendLog('DRY RUN ERROR', { error: error.message });
      await updateRuntime({ state: 'ERROR', status: 'ERROR', error: error.message });
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message?.type === 'RESUME_RUN') {
    resumeRun().then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'PAUSE_RUN') {
    pauseRun().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'STOP_RUN') {
    stopRun().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RESET_RUN_RESCAN') {
    // Reset performs its own quick result/download salvage and serializes the
    // destructive state change under the state lock. Waiting for startup
    // reconciliation here can make an emergency reset appear to do nothing
    // when a background ChatGPT tab never answers that reconciliation pass.
    resetRunAndRescan({
        reason: message.reason || 'Ручной сброс сессии и повторное сканирование результатов',
        automatic: false,
        salvageReady: message.salvageReady !== false
      })
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'CLEAR_HISTORY') {
    clearGenerationHistory().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'IMPORT_GENERATION_MEMORY') {
    importGenerationMemorySnapshot(message.snapshot)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'REVIEW_GENERATION') {
    reviewGeneration(message.sourceId, message.decision, message.artifact || {})
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RECOVER_GALLERY_FACTS') {
    recoverGalleryFacts(message.generationIds)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'DOWNLOAD_GENERATED') {
    startGeneratedDownload(message).then((result) => sendResponse({ ok: true, ...(result || {}) })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'OPEN_DOWNLOADS_FOLDER') {
    openDownloadsFolder().then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'SET_DOM_DIAGNOSTICS_MODE') {
    setDomDiagnosticsMode(message.mode)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'CLEAR_DOM_DIAGNOSTICS') {
    clearDomDiagnostics()
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'FACTS_STAGE_EVENT') {
    // Live UI first: persistence may wait behind unrelated state writes, but a
    // user should see the real postprocess stage immediately.
    try {
      chrome.runtime.sendMessage({
        type: 'FACTS_STAGE_LIVE',
        job: {
          factsJobId: message.factsJobId || null,
          entryId: message.entryId || null,
          entryName: message.entryName || null,
          modelName: message.modelName || null,
          slotId: Number.isFinite(Number(message.slotId)) ? Number(message.slotId) : null,
          tabId: Number(sender?.tab?.id || 0) || null,
          stage: String(message.stage || 'QUEUED').toUpperCase(),
          stageAtMs: Number(message.stageAtMs || Date.now()),
          startedAtMs: Number(message.startedAtMs || message.stageAtMs || Date.now()),
          waitUntil: Number(message.waitUntil || 0) || null,
          chatUrl: normalizeChatConversationUrl(message.chatUrl),
          error: message.error || null
        }
      }).catch(() => {});
    } catch (_) {}
    updateFactsStage(message, sender)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'REQUEST_FACTS_SEND_PERMIT') {
    requestFactsSendPermit(message, sender)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'FACTS_EXTRACTION_RESULT') {
    // A page-owned postprocess wakes the MV3 worker with its final result. The
    // long ChatGPT wait never lives inside one tabs.sendMessage callback.
    handleFactsExtractionResult(message, sender)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'RATE_LIMIT_EVENT') {
    const scope = String(message.scope || message.rateLimit?.scope || 'generation');
    if (scope === 'postprocess') {
      appendLog('Postprocess rate limit: генерации не ставятся на паузу', {
        tabId: sender?.tab?.id || null,
        text: message.rateLimit?.text || null
      }).then(() => sendResponse({ ok: true, ignoredForGeneration: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    getStored().then(async ({ run }) => {
      const slot = Object.values(run?.slots || {}).find((item) => item.tabId === sender?.tab?.id);
      const details = run && slot ? {
          slotId: slot.slotId,
          tabId: sender?.tab?.id,
          ...(message.rateLimit || {})
        } : null;
      if (!run || !slot || !details) return null;
      if (imageLimitResumeAt(details.text)) {
        // Reply before probing tabs: CHECK_GENERATION can itself report this
        // banner, so awaiting the sweep here would deadlock its page message.
        void pauseNewLaunchesForRateLimit(run.operationId, details)
          .catch((error) => appendLog('Ошибка обработки лимита изображений', { error: error.message }));
        return { accepted: true, imageLimit: true };
      }
      if (await ignoreRateLimitDuringWindow(run.operationId, details)) return { ignored: true };
      return pauseNewLaunchesForRateLimit(run.operationId, details);
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'STATE_EVENT') {
    handleStateEvent(message, sender).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'LOG_EVENT') {
    appendLog(message.message, { ...(message.extra || {}), slotId: message.slotId, entryId: message.entryId }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'DIAGNOSTICS_EVENT') {
    storeDiagnostics({ ...(message.diagnostic || {}), slotId: message.slotId, entryId: message.entryId, entryName: message.entryName }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'GET_RUNTIME_FAST') {
    fastRuntimeState()
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'GET_RUNTIME') {
    ensureGenerationMemoryState()
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
