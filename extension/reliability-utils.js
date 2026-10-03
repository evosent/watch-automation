// Pure helpers used by the service worker and the test suite.  Keeping the
// retry and progress policy free from Chrome APIs makes the orchestration
// rules deterministic and easy to exercise with a fake browser.

export const SLOT_PHASES = Object.freeze({
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  UPLOADING: 'UPLOADING',
  WAITING_LAUNCH: 'WAITING_LAUNCH',
  SENDING: 'SENDING',
  PROMPT_SENT: 'PROMPT_SENT',
  GENERATING: 'GENERATING',
  OBSERVING: 'OBSERVING',
  IMAGE_FOUND: 'IMAGE_FOUND',
  DOWNLOADING: 'DOWNLOADING',
  VERIFYING_FILE: 'VERIFYING_FILE',
  DONE: 'DONE',
  RETRY_BACKOFF: 'RETRY_BACKOFF',
  RATE_LIMIT_PAUSE: 'RATE_LIMIT_PAUSE',
  TAB_LOST: 'TAB_LOST',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
  STOPPED: 'STOPPED'
});

export const AUTOMATION_ERROR_CLASSES = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  CONVERSATION_LOAD_ERROR: 'CONVERSATION_LOAD_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SECURITY_CHALLENGE: 'SECURITY_CHALLENGE',
  NETWORK: 'NETWORK',
  TAB_LOST: 'TAB_LOST',
  DOM_CHANGED: 'DOM_CHANGED',
  TEXT_ONLY: 'TEXT_ONLY',
  CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
  MODEL_REFUSAL: 'MODEL_REFUSAL',
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE',
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',
  DOWNLOAD: 'DOWNLOAD',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
});

export const CONVERSATION_LOAD_RECOVERY_DELAY_MS = 2 * 60 * 1000;
export const GENERATION_TRANSPORT_REFRESH_AFTER_MS = 4 * 60 * 1000;
export const STALLED_BATCH_RECOVERY_AFTER_MS = 15 * 60 * 1000;
export const STALLED_BATCH_RECOVERY_DELAY_MS = 5 * 60 * 1000;

export function shouldRefreshUnresponsiveGeneration(slot, now = Date.now(), thresholdMs = GENERATION_TRANSPORT_REFRESH_AFTER_MS) {
  if (!slot?.tabId || !slot?.generationId || !slot?.leaseId || !slot?.generationSubmittedAt || slot?.downloadId) return false;
  if (String(slot.autoRefreshGenerationId || '') === String(slot.generationId)) return false;
  const since = Date.parse(slot.noResponseSince || '');
  return Number.isFinite(since) && since > 0 && Number(now) - since >= Number(thresholdMs);
}

function isActiveSubmittedGeneration(slot) {
  if (!slot?.entryId || !slot?.tabId || !slot?.generationSubmittedAt || slot?.downloadId) return false;
  return !['DONE', 'STOPPED', 'IDLE'].includes(String(slot.status || '').toUpperCase());
}

function isOffStandardGenerationSlot(slot) {
  const status = String(slot?.status || '').toUpperCase();
  const phase = String(slot?.phase || '').toUpperCase();
  const checkState = String(slot?.lastCheckState || '').toUpperCase();
  return Boolean(slot?.failed || slot?.finalCheckPending)
    || ['OBSERVING', 'ERROR', 'PAUSED', 'RETRY_BACKOFF', 'TAB_LOST', 'NEEDS_ATTENTION'].includes(status)
    || ['OBSERVING', 'ERROR', 'RETRY_BACKOFF', 'TAB_LOST', 'NEEDS_ATTENTION'].includes(phase)
    || ['ERROR', 'NO_RESPONSE', 'CONVERSATION_LOAD_ERROR', 'TAB_CLOSED'].includes(checkState);
}

export function findStalledBatchRecoveryCandidate(
  run,
  now = Date.now(),
  thresholdMs = STALLED_BATCH_RECOVERY_AFTER_MS
) {
  const activeRun = ['RUNNING', 'STARTING', 'DRAINING'].includes(String(run?.state || '').toUpperCase())
    || (String(run?.state || '').toUpperCase() === 'PAUSED'
      && String(run?.pauseReason || '').toUpperCase() === 'ERROR');
  if (!activeRun || run?.imageLimitDetected === true
    || String(run?.status || '').toUpperCase() === 'RATE_LIMIT_PAUSE'
    || Number(run?.rateLimitPauseUntil || 0) > Number(now)) return null;

  const active = Object.values(run?.slots || {})
    .filter(isActiveSubmittedGeneration)
    .sort((a, b) => (Date.parse(a.generationSubmittedAt || '') || 0)
      - (Date.parse(b.generationSubmittedAt || '') || 0));
  if (active.length < 2) return null;

  const oldest = active[0];
  const noResponseSince = Date.parse(oldest.noResponseSince || '');
  if (!Number.isFinite(noResponseSince) || noResponseSince <= 0
    || Number(now) - noResponseSince < Number(thresholdMs)) return null;

  const abnormalSiblings = active.slice(1).filter(isOffStandardGenerationSlot);
  if (!abnormalSiblings.length) return null;
  return {
    slotId: Number(oldest.slotId),
    entryId: String(oldest.entryId),
    noResponseSince: new Date(noResponseSince).toISOString(),
    abnormalSlotIds: abnormalSiblings.map((slot) => Number(slot.slotId))
  };
}

// Defaults preserve roughly the previous 8–12 second Send spacing until the
// user chooses their own base pause and spread in the side panel.
export const DEFAULT_GENERATION_PAUSE_MINUTES = 0.17;
export const DEFAULT_GENERATION_JITTER_SECONDS = 2;
export const DEFAULT_RATE_LIMIT_IGNORE_MINUTES = 10;
export const MAX_RATE_LIMIT_IGNORE_MINUTES = 60;

export function normalizeRateLimitIgnoreMinutes(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_RATE_LIMIT_IGNORE_MINUTES;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RATE_LIMIT_IGNORE_MINUTES;
  return Math.min(MAX_RATE_LIMIT_IGNORE_MINUTES, Math.max(0, Math.round(numeric)));
}

export function isRateLimitIgnored(ignoreUntil, now = Date.now()) {
  return Number(ignoreUntil || 0) > Number(now || 0);
}

export function isUserPauseCancellation(message) {
  return /^(?:Запуск генерации отменён: очередь больше не активна|Отправка генерации отменена(?::| у)|Пауза генерации отменена: слот больше не владеет моделью)/i
    .test(String(message || '').trim());
}

export function normalizeGenerationPauseMinutes(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_GENERATION_PAUSE_MINUTES;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(120, Math.max(0, Math.round(numeric * 100) / 100)) : DEFAULT_GENERATION_PAUSE_MINUTES;
}

export function normalizeGenerationJitterSeconds(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_GENERATION_JITTER_SECONDS;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(3600, Math.max(0, Math.round(numeric))) : DEFAULT_GENERATION_JITTER_SECONDS;
}

export function sampleGenerationPause(minutes, jitterSeconds, random = Math.random) {
  const baseMs = Math.round(normalizeGenerationPauseMinutes(minutes) * 60000);
  const spreadMs = normalizeGenerationJitterSeconds(jitterSeconds) * 1000;
  const unit = () => Math.min(1, Math.max(0, Number(random()) || 0));
  const factor = 0.5 + unit();
  const direction = unit() < 0.5 ? -1 : 1;
  return {
    delayMs: Math.max(0, Math.round(baseMs + direction * spreadMs * factor)),
    factor,
    direction
  };
}

export function resolveGenerationPause(savedGapMs, minutes, jitterSeconds, random = Math.random) {
  const saved = Number(savedGapMs);
  if (savedGapMs != null && Number.isFinite(saved) && saved >= 0) {
    return { delayMs: saved, factor: null, direction: null, reused: true };
  }
  return { ...sampleGenerationPause(minutes, jitterSeconds, random), reused: false };
}

const RETRY_BASE_MS = Object.freeze({
  [AUTOMATION_ERROR_CLASSES.RATE_LIMIT]: 180000,
  [AUTOMATION_ERROR_CLASSES.NETWORK]: 15000,
  [AUTOMATION_ERROR_CLASSES.TAB_LOST]: 5000,
  [AUTOMATION_ERROR_CLASSES.DOM_CHANGED]: 10000,
  [AUTOMATION_ERROR_CLASSES.DOWNLOAD]: 8000,
  [AUTOMATION_ERROR_CLASSES.INVALID_OUTPUT]: 12000,
  [AUTOMATION_ERROR_CLASSES.TEXT_ONLY]: 20000,
  [AUTOMATION_ERROR_CLASSES.CLARIFICATION_REQUIRED]: 60000,
  [AUTOMATION_ERROR_CLASSES.MODEL_REFUSAL]: 60000,
  [AUTOMATION_ERROR_CLASSES.TOOL_UNAVAILABLE]: 30000,
  [AUTOMATION_ERROR_CLASSES.UPLOAD_REJECTED]: 15000,
  [AUTOMATION_ERROR_CLASSES.TIMEOUT]: 20000,
  [AUTOMATION_ERROR_CLASSES.UNKNOWN]: 30000
});

// A single incident can be reported by several observers at once. Keep the
// original deadline while it is active; duplicate signals must not turn a
// three-minute cooldown into a sliding or stacked delay.
export function coalescedPauseDeadline(previousUntil, now = Date.now(), pauseMs = 180000) {
  const previous = Number(previousUntil || 0);
  const current = Number(now || Date.now());
  return previous > current ? previous : current + Math.max(0, Number(pauseMs) || 0);
}

export function imageLimitResumeAt(message, now = Date.now()) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!/(?:лимит\s+(?:создания|генерации)\s+изображений|лимит\s+запросов\s+на\s+генерацию\s+изображений|image\s+generation\s+limit)/i.test(text)) return null;
  const match = text.match(/(?:попробуйте\s+снова\s+в|try\s+again\s+at)\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) return null;
  if (match[3]) hour = (hour % 12) + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  const deadline = new Date(now);
  deadline.setHours(hour, minute + 1, 0, 0);
  // A stale banner seen just after its reset time warrants a short recheck,
  // not a wait until the same clock time tomorrow.
  if (deadline.getTime() <= now && now - deadline.getTime() < 5 * 60000) return now + 60000;
  if (deadline.getTime() <= now) deadline.setDate(deadline.getDate() + 1);
  return deadline.getTime();
}

function textOf(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return `${error.code || ''} ${error.name || ''} ${error.message || ''} ${error.responseText || ''}`
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyAutomationError(error, context = {}) {
  const value = textOf(error).toLowerCase();
  const explicitCode = String(error?.code || context.errorClass || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(AUTOMATION_ERROR_CLASSES, explicitCode)) {
    return AUTOMATION_ERROR_CLASSES[explicitCode];
  }
  if (context.rateLimit || /rate\s*limit|too\s+many|слишком\s+много|слишком\s+часто|временно\s+ограничен|лимит\s+(?:создания|генерации)\s+изображений/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.RATE_LIMIT;
  }
  if (context.authRequired || /sign\s*in|log\s*in|войти|авторизац|сессия|unauthoriz|401/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.AUTH_REQUIRED;
  }
  if (context.securityChallenge || /captcha|проверка\s+безопасности|security\s+check|challenge/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.SECURITY_CHALLENGE;
  }
  if (/не\s+удалось\s+загрузить\s+этот\s+разговор\s+chatgpt/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.CONVERSATION_LOAD_ERROR;
  }
  if (/network|offline|fetch|connection|соединен|сеть|нет\s+ответа/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.NETWORK;
  }
  if (context.tabClosed || /tab\s+closed|вкладка.*закры|receiving\s+end\s+does\s+not\s+exist/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.TAB_LOST;
  }
  if (/selector|composer|file\s+input|send\s+button|dom|element.*not\s+found|не\s+найден.*(кноп|элемент|поле)|страниц/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.DOM_CHANGED;
  }
  if (/text_only|без\s+изображ|without\s+generated\s+image/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.TEXT_ONLY;
  }
  if (/clarification_required|уточнит|уточни|could you clarify|please clarify/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.CLARIFICATION_REQUIRED;
  }
  if (/model_refusal|не могу (?:помочь|выполнить|создать|сгенерировать)|can't (?:help|comply|assist)|cannot (?:help|comply|assist)/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.MODEL_REFUSAL;
  }
  if (/tool_unavailable|failed to generate.*image|image generation.*unavailable|генерац.*(?:недоступ|не удалось|сбой)/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.TOOL_UNAVAILABLE;
  }
  if (/upload_rejected|invalid input plan|attachment.*(?:reject|fail)|вложен.*(?:ошиб|не удал)/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.UPLOAD_REJECTED;
  }
  if (/download|скачив/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.DOWNLOAD;
  }
  if (/invalid.*(png|image|output)|поврежд|невалид.*(png|изображ)|не\s+является\s+изображ/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.INVALID_OUTPUT;
  }
  if (context.assistantPending || /assistant_pending|timeout|таймаут|ожидани.*заверш|время\s+истек/.test(value)) {
    return AUTOMATION_ERROR_CLASSES.TIMEOUT;
  }
  return AUTOMATION_ERROR_CLASSES.UNKNOWN;
}

export function retryDelayMs(errorClass, attempt = 1, randomValue = 0.5) {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = RETRY_BASE_MS[errorClass] || RETRY_BASE_MS[AUTOMATION_ERROR_CLASSES.UNKNOWN];
  const exponential = Math.min(base * (2 ** Math.min(normalizedAttempt - 1, 5)), 30 * 60 * 1000);
  const jitter = Math.min(1, Math.max(0, Number(randomValue) || 0)) * Math.min(10000, Math.max(1000, exponential * 0.25));
  return Math.round(exponential * 0.875 + jitter);
}

// Return only retries that belong to this persisted run and are safe to submit
// again. A retry is safe when the entry was explicitly marked retryable before
// Send, or when an older build left its worker in RETRY_BACKOFF. Any trace that
// Send was accepted takes precedence and keeps the generation on observation.
export function scheduledRunRetries(run, entries = [], now = Date.now()) {
  if (!run || ['DONE', 'STOPPED'].includes(String(run.state || '').toUpperCase())) return [];
  if (['USER', 'RESTART', 'ERROR'].includes(String(run.pauseReason || '').toUpperCase())) return [];

  const plannedIds = new Set(Array.isArray(run.plannedIds) ? run.plannedIds.map(String) : []);
  if (!plannedIds.size) return [];
  const slots = Object.values(run.slots || {});
  const retries = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryId = String(entry?.sourceId || '');
    if (!entryId || !plannedIds.has(entryId) || entry.status !== 'error') continue;
    const slot = slots.find((item) => String(item?.entryId || '') === entryId) || null;
    const retryBackoff = String(slot?.phase || '').toUpperCase() === 'RETRY_BACKOFF';
    if (entry.autoRetryPending !== true && !retryBackoff) continue;

    const submitted = Boolean(slot && (
      slot.generationSubmittedAt
      || slot.finalCheckPending
      || slot.downloadId
      || ['PROMPT_SENT', 'WAITING_ASSISTANT', 'WAITING_GENERATION', 'GENERATING', 'WAITING_IMAGE', 'REQUESTING_DOWNLOAD', 'DOWNLOADING', 'OBSERVING'].includes(String(slot.status || '').toUpperCase())
      || ['PROMPT_SENT', 'GENERATING', 'OBSERVING', 'IMAGE_FOUND', 'DOWNLOADING', 'VERIFYING_FILE'].includes(String(slot.phase || '').toUpperCase())
    ));
    if (submitted) continue;

    const retryAt = Date.parse(entry.nextRetryAt || slot?.nextRetryAt || '');
    if (!Number.isFinite(retryAt) || retryAt <= 0) continue;
    retries.push({ entryId, retryAt, slotId: slot ? Number(slot.slotId) : null });
  }

  return retries.sort((left, right) => left.retryAt - right.retryAt || left.entryId.localeCompare(right.entryId))
    .map((item) => ({ ...item, due: item.retryAt <= Number(now) }));
}

export function stableHash(value) {
  let hash = 2166136261;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function generationId(sourceId, revisionKey = '') {
  const key = String(revisionKey || 'legacy').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `gen-${stableHash(String(sourceId || 'unknown'))}-${key || 'legacy'}`;
}

export function isMeaningfulProgress(previous = {}, next = {}) {
  if (!next || typeof next !== 'object') return false;
  if (next.state === 'READY' || next.state === 'DOWNLOADING' || next.state === 'DOWNLOADED') return true;
  if (next.imageCandidate === true && (
    previous.imageCandidate !== true
    || (next.imageSource && next.imageSource !== previous.imageSource)
  )) return true;
  if (next.assistantCount > Number(previous.assistantCount || 0)) return true;
  const previousState = String(previous.state || previous.lastCheckState || '');
  const nextState = String(next.state || next.lastCheckState || '');
  return Boolean(nextState && nextState !== previousState && !['UNKNOWN', 'NO_RESPONSE'].includes(nextState));
}

export function isSlotTerminal(phase) {
  return [
    SLOT_PHASES.IDLE,
    SLOT_PHASES.DONE,
    SLOT_PHASES.NEEDS_ATTENTION,
    SLOT_PHASES.STOPPED
  ].includes(String(phase || '').toUpperCase());
}
