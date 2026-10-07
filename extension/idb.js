export const DB_NAME = 'watch-card-automation';
import {
  OUTPUT_RECOVERY_STATES,
  canRecoverOutputRecord,
  createOutputRecoveryRecord,
  markOutputRecoveryRecord,
  normalizeOutputRecoveryRecord,
  transitionOutputRecoveryRecord
} from './output-recovery-utils.js';

export const DB_VERSION = 9;
export const STORE = 'assets';
export const HANDLE_STORE = 'handles';
export const FACTS_STORE = 'generationFacts';
export const REVISION_STORE = 'generationRevisions';
export const MODEL_STORE = 'modelCatalog';
export const RUN_DIAGNOSTICS_STORE = 'runDiagnostics';
export const RUN_DIAGNOSTIC_EVENTS_STORE = 'runDiagnosticEvents';
export const OUTPUT_RECOVERY_STORE = 'outputRecovery';
export const ACCOUNTING_BACKUP_STORE = 'accountingBackups';
export const IDENTITY_QUARANTINE_STORE = 'identityQuarantine';
export const OUTPUT_DIRECTORY_HANDLE_KEY = 'output-directory';
export const GALLERY_DIRECTORY_HANDLE_KEY = 'gallery-directory';
// A folder can contain several thousand high-resolution source images. Keep
// each IndexedDB transaction small so one large folder cannot time out or
// exhaust the renderer's temporary transaction memory.
const ASSET_BATCH_SIZE = 32;
const IDB_OPEN_TIMEOUT_MS = 15000;
const IDB_TRANSACTION_TIMEOUT_MS = 15000;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`IndexedDB open timed out after ${IDB_OPEN_TIMEOUT_MS}ms`);
      error.code = 'IDB_OPEN_TIMEOUT';
      reject(error);
    }, IDB_OPEN_TIMEOUT_MS);
    const settle = (callback, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
      return true;
    };
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(FACTS_STORE)) db.createObjectStore(FACTS_STORE, { keyPath: 'sourceId' });
      if (!db.objectStoreNames.contains(REVISION_STORE)) {
        const revisions = db.createObjectStore(REVISION_STORE, { keyPath: 'generationId' });
        revisions.createIndex('sourceId', 'sourceId', { unique: false });
        revisions.createIndex('completedAt', 'completedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(MODEL_STORE)) db.createObjectStore(MODEL_STORE, { keyPath: 'skuKey' });
      if (!db.objectStoreNames.contains(RUN_DIAGNOSTICS_STORE)) {
        const diagnostics = db.createObjectStore(RUN_DIAGNOSTICS_STORE, { keyPath: 'operationId' });
        diagnostics.createIndex('startedAt', 'startedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(RUN_DIAGNOSTIC_EVENTS_STORE)) {
        const events = db.createObjectStore(RUN_DIAGNOSTIC_EVENTS_STORE, { keyPath: ['operationId', 'sequence'] });
        events.createIndex('operationId', 'operationId', { unique: false });
      }
      if (!db.objectStoreNames.contains(OUTPUT_RECOVERY_STORE)) {
        db.createObjectStore(OUTPUT_RECOVERY_STORE, { keyPath: 'generationId' });
      }
      if (!db.objectStoreNames.contains(ACCOUNTING_BACKUP_STORE)) {
        const backups = db.createObjectStore(ACCOUNTING_BACKUP_STORE, { keyPath: 'backupId' });
        backups.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDENTITY_QUARANTINE_STORE)) {
        const quarantines = db.createObjectStore(IDENTITY_QUARANTINE_STORE, { keyPath: 'quarantineId' });
        quarantines.createIndex('sourceId', 'sourceId', { unique: false });
      }
      // Schema upgrades only add stores. Capture a full, immutable snapshot
      // inside this same version-change transaction before any later
      // canonical migration is permitted to mutate accounting state.
      if (Number(event.oldVersion || 0) > 0 && Number(event.oldVersion || 0) < DB_VERSION) {
        const backupStore = req.transaction.objectStore(ACCOUNTING_BACKUP_STORE);
        const backupId = `pre-accounting-v${DB_VERSION}-from-v${event.oldVersion}`;
        const existing = backupStore.get(backupId);
        existing.onsuccess = () => {
          if (existing.result?.complete === true) return;
          const sources = [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE, IDENTITY_QUARANTINE_STORE]
            .filter((name) => db.objectStoreNames.contains(name));
          const rows = Object.fromEntries(sources.map((name) => [name, []]));
          let remaining = sources.length;
          if (!remaining) {
            backupStore.put({ backupId, schemaVersion: 1, complete: true,
              createdAt: new Date().toISOString(), fromDbVersion: event.oldVersion,
              counts: { catalog: 0, revisions: 0, facts: 0, outputRecovery: 0, quarantines: 0 },
              stores: { catalog: [], revisions: [], facts: [], outputRecovery: [], quarantines: [] } });
            return;
          }
          for (const name of sources) {
            const request = req.transaction.objectStore(name).getAll();
            request.onsuccess = () => {
              rows[name] = request.result || [];
              remaining -= 1;
              if (remaining !== 0) return;
              backupStore.put({
                backupId,
                schemaVersion: 1,
                complete: true,
                createdAt: new Date().toISOString(),
                fromDbVersion: event.oldVersion,
                counts: { catalog: rows[MODEL_STORE]?.length || 0,
                  revisions: rows[REVISION_STORE]?.length || 0,
                  facts: rows[FACTS_STORE]?.length || 0,
                  outputRecovery: rows[OUTPUT_RECOVERY_STORE]?.length || 0,
                  quarantines: rows[IDENTITY_QUARANTINE_STORE]?.length || 0 },
                stores: { catalog: rows[MODEL_STORE] || [],
                  revisions: rows[REVISION_STORE] || [], facts: rows[FACTS_STORE] || [],
                  outputRecovery: rows[OUTPUT_RECOVERY_STORE] || [],
                  quarantines: rows[IDENTITY_QUARANTINE_STORE] || [] }
              });
            };
            request.onerror = () => { try { req.transaction.abort(); } catch (_) {} };
          }
        };
        existing.onerror = () => { try { req.transaction.abort(); } catch (_) {} };
      }
    };
    req.onsuccess = () => {
      if (!settle(resolve, req.result)) req.result.close();
    };
    req.onerror = () => settle(reject, req.error || new Error('IndexedDB open failed'));
  });
}

export function transactionResult(db, stores, run, errorLabel, timeoutMs = IDB_TRANSACTION_TIMEOUT_MS, mode = 'readwrite') {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      const error = new Error(`${errorLabel} timed out after ${timeoutMs}ms`);
      error.code = 'IDB_TRANSACTION_TIMEOUT';
      settle(reject, error);
      try { tx.abort(); } catch (_) {}
    }, timeoutMs);
    const settle = (callback, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
      return true;
    };
    let value;
    try { value = run(tx); } catch (error) {
      try { tx.abort(); } catch (_) {}
      settle(reject, error);
      return;
    }
    tx.oncomplete = () => settle(resolve, value);
    tx.onerror = () => settle(reject, tx.error || new Error(`${errorLabel} failed`));
    tx.onabort = () => settle(reject, tx.error || new Error(`${errorLabel} aborted`));
  });
}

export async function saveRunDiagnostics(header, events = []) {
  if (!header?.operationId) throw new Error('Run diagnostics require an operationId');
  const db = await openDb();
  try {
    const records = (Array.isArray(events) ? events : []).filter((event) => (
      event?.operationId === header.operationId && Number(event.sequence) > 0
    ));
    const savedHeader = { ...header, updatedAt: new Date().toISOString() };
    return await transactionResult(db, [RUN_DIAGNOSTICS_STORE, RUN_DIAGNOSTIC_EVENTS_STORE], (tx) => {
      tx.objectStore(RUN_DIAGNOSTICS_STORE).put(savedHeader);
      const store = tx.objectStore(RUN_DIAGNOSTIC_EVENTS_STORE);
      for (const event of records) store.put(event);
      return { eventCount: records.length, header: savedHeader };
    }, 'Run diagnostics write');
  } finally { db.close(); }
}

export async function listRunDiagnostics({ limit = 200 } = {}) {
  const db = await openDb();
  try {
    let rows = [];
    await transactionResult(db, RUN_DIAGNOSTICS_STORE, (tx) => {
      const request = tx.objectStore(RUN_DIAGNOSTICS_STORE).getAll();
      request.onsuccess = () => { rows = request.result || []; };
      return null;
    }, 'Run diagnostics read', undefined, 'readonly');
    rows.sort((left, right) => (
      String(right.startedAt || right.updatedAt || '').localeCompare(String(left.startedAt || left.updatedAt || ''))
    ));
    return rows.slice(0, Math.max(1, Number(limit) || 200));
  } finally { db.close(); }
}

export async function getRunDiagnostic(operationId) {
  if (!operationId) return null;
  const db = await openDb();
  try {
    let header = null;
    let events = [];
    await transactionResult(db, [RUN_DIAGNOSTICS_STORE, RUN_DIAGNOSTIC_EVENTS_STORE], (tx) => {
      const headerRequest = tx.objectStore(RUN_DIAGNOSTICS_STORE).get(String(operationId));
      const eventsRequest = tx.objectStore(RUN_DIAGNOSTIC_EVENTS_STORE).index('operationId').getAll(String(operationId));
      headerRequest.onsuccess = () => { header = headerRequest.result || null; };
      eventsRequest.onsuccess = () => { events = eventsRequest.result || []; };
      return null;
    }, 'Run diagnostics read', undefined, 'readonly');
    return {
      run: header,
      events: events.sort((left, right) => Number(left.sequence) - Number(right.sequence))
    };
  } finally { db.close(); }
}

function catalogWithVariantState(model, sourceVariantId, patch) {
  const id = String(sourceVariantId || '');
  if (!id || !Array.isArray(model?.variants)) return model;
  let changed = false;
  const variants = model.variants.map((variant) => {
    if (String(variant?.sourceVariantId || variant?.variantId || '') !== id) return variant;
    changed = true;
    return { ...variant, ...patch };
  });
  return changed ? { ...model, variants } : model;
}

function identityVariantKeyForMigration(variant = {}) {
  return String(variant?.sourceVariantId || variant?.variantId || variant?.assetKey || variant?.sourceId
    || [variant?.groupId, variant?.relativePath || variant?.fileName].filter(Boolean).join('|'));
}

function revisionHasCompleteResult(revision) {
  const facts = revision?.facts;
  return Boolean(revision?.status === 'READY' && revision?.factsStatus === 'ok'
    && facts?.status === 'ok' && revision.outputPath
    && /^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))
    && String(facts.generationId || '') === String(revision.generationId || '')
    && String(facts.factsJobId || '') === String(revision.factsJobId || '')
    && String(facts.outputHash || '').toLowerCase() === String(revision.outputHash || '').toLowerCase());
}

function catalogAfterFreshRetryResult(model, revision) {
  const retry = model?.sessionRetry;
  if (!model?.retryRequired || !retry || revision?.supersededBySessionRestartId
    || String(revision?.generationId || '') === String(retry.previousGenerationId || '')) return model;
  return { ...model, retryRequired: false, sessionRetry: null,
    lastSessionRetry: { ...retry, resolvedByGenerationId: revision.generationId,
      resolvedAt: new Date().toISOString() } };
}

// Detach only the exact incomplete current revision. Its immutable PNG/facts
// tuple remains available in history, but cannot become current again through
// a late callback or the cancellation of a replacement draft.
export async function markGenerationForSessionRetry(sourceId, expectedGenerationId, {
  restartId = '', inputSourceId = ''
} = {}) {
  const skuKey = String(sourceId || '');
  const generationKey = String(expectedGenerationId || '');
  if (!skuKey || !generationKey || !String(restartId || '')) {
    return { marked: false, reason: 'missing_identity', sourceId: skuKey, generationId: generationKey };
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const modelRequest = models.get(skuKey);
      const revisionRequest = revisions.get(generationKey);
      const result = { marked: false, sourceId: skuKey, generationId: generationKey };
      let modelReady = false;
      let revisionReady = false;
      const commit = () => {
        if (!modelReady || !revisionReady) return;
        const model = modelRequest.result;
        const revision = revisionRequest.result;
        if (model?.retryRequired && model.sessionRetry?.restartId === String(restartId)
          && model.sessionRetry?.previousGenerationId === generationKey
          && revision?.supersededBySessionRestartId === String(restartId)) {
          Object.assign(result, { alreadyMarked: true, reason: 'already_marked' });
          return;
        }
        if (!model || String(model.currentGenerationId || '') !== generationKey) {
          result.reason = 'current_generation_changed';
          return;
        }
        if (!revision || String(revision.sourceId || '') !== skuKey
          || (inputSourceId && revision.sourceVariantId
            && String(inputSourceId) !== String(revision.sourceVariantId))) {
          result.reason = 'revision_identity_mismatch';
          return;
        }
        if (revisionHasCompleteResult(revision)) {
          result.reason = 'result_complete';
          return;
        }
        const requestedAt = new Date().toISOString();
        const variantId = String(inputSourceId || revision.sourceVariantId || '');
        const retry = { restartId: String(restartId), previousGenerationId: generationKey,
          inputSourceId: variantId, requestedAt };
        const withVariant = catalogWithVariantState(model, variantId, {
          status: 'pending', generationId: null, outputPath: null, outputHash: null,
          factsStatus: null, lastError: null
        });
        models.put({ ...withVariant, currentGenerationId: null, currentOutputPath: null,
          currentOutputHash: null, generationStatus: 'NOT_READY', retryRequired: true,
          sessionRetry: retry,
          queueState: { ...(model.queueState || {}), status: 'pending', generationId: null,
            outputPath: null, outputHash: null, factsStatus: null, lastError: null },
          updatedAt: requestedAt });
        revisions.put({ ...revision, supersededBySessionRestartId: String(restartId),
          sessionRetryRequestedAt: requestedAt, updatedAt: requestedAt });
        result.marked = true;
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      return result;
    }, 'Generation session retry write');
  } finally { db.close(); }
}

// Catalog rows describe the current input-folder snapshot. Existing history
// and revision pointers survive a rescan, while missing inputs are retained
// with sourcePresent=false for diagnostics and historical gallery records.
export async function replaceModelCatalog(records = []) {
  const db = await openDb();
  try {
    return await transactionResult(db, MODEL_STORE, (tx) => {
      const store = tx.objectStore(MODEL_STORE);
      const request = store.getAll();
      const incoming = new Map((records || []).filter((item) => item?.skuKey).map((item) => [String(item.skuKey), item]));
      let result = { total: incoming.size, missing: 0 };
      request.onsuccess = () => {
        const previous = new Map((request.result || []).map((item) => [String(item.skuKey), item]));
        for (const [skuKey, item] of incoming) {
          const old = previous.get(skuKey) || {};
          store.put({ ...old, ...item, skuKey, sourcePresent: true, updatedAt: new Date().toISOString() });
          previous.delete(skuKey);
        }
        for (const [skuKey, old] of previous) {
          if (old.sourcePresent === false) continue;
          store.put({ ...old, sourcePresent: false, sourceRemovedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          result.missing += 1;
        }
      };
      return result;
    }, 'Catalog write');
  } finally { db.close(); }
}

export async function getAllModelCatalog({ includeRemoved = false } = {}) {
  const db = await openDb();
  try {
    let rows = [];
    await transactionResult(db, MODEL_STORE, (tx) => {
      const request = tx.objectStore(MODEL_STORE).getAll();
      request.onsuccess = () => { rows = request.result || []; };
      return null;
    }, 'Model catalog read', undefined, 'readonly');
    return includeRemoved ? rows : rows.filter((item) => item.sourcePresent !== false);
  } finally { db.close(); }
}

export async function getModelCatalog(skuKey) {
  if (!skuKey) return null;
  const db = await openDb();
  try {
    let model = null;
    await transactionResult(db, MODEL_STORE, (tx) => {
      const request = tx.objectStore(MODEL_STORE).get(String(skuKey));
      request.onsuccess = () => { model = request.result || null; };
      return null;
    }, 'Model catalog read', undefined, 'readonly');
    return model;
  } finally { db.close(); }
}

// Re-key only old revisions that already contain an exact path/hash tuple.
// Ambiguous records remain untouched as legacy rows and cannot become gallery
// cards through a filename match.
export async function adoptLegacyGenerationRevisions(sourceAliases = {}) {
  const aliases = new Map(Object.entries(sourceAliases || {}).map(([oldId, skuKey]) => [String(oldId), String(skuKey)]));
  if (!aliases.size) return { adopted: 0, ready: 0 };
  const revisions = await getAllGenerationRevisions();
  const eligible = revisions.filter((revision) => {
    const skuKey = aliases.get(String(revision?.sourceId || ''));
    return skuKey && revision?.generationId && revision?.outputPath
      && /^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''));
  }).map((revision) => {
    const skuKey = aliases.get(String(revision.sourceId));
    const facts = revision.facts;
    const factsValid = Boolean(revision.factsJobId) && revision.factsStatus === 'ok' && facts?.status === 'ok'
      && String(facts.generationId || '') === String(revision.generationId)
      && String(facts.factsJobId || '') === String(revision.factsJobId)
      && String(facts.outputHash || '') === String(revision.outputHash || '');
    return { revision, skuKey, factsValid };
  });
  if (!eligible.length) return { adopted: 0, ready: 0 };
  const latestImage = new Map();
  const latestReady = new Map();
  const timestamp = (revision) => Date.parse(revision.completedAt || revision.downloadedAt || revision.createdAt || '') || 0;
  for (const item of eligible) {
    const choose = (map) => {
      const old = map.get(item.skuKey);
      if (!old || timestamp(item.revision) > timestamp(old.revision)) map.set(item.skuKey, item);
    };
    if (item.revision.reviewStatus !== 'rejected') choose(latestImage);
    if (item.factsValid && item.revision.reviewStatus !== 'rejected') choose(latestReady);
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisionStore = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const updatesBySku = new Map();
      let adopted = 0;
      let ready = 0;
      for (const item of eligible) {
        const migrated = { ...item.revision, legacySourceId: item.revision.sourceId,
          sourceId: item.skuKey, skuKey: item.skuKey,
          status: item.factsValid ? 'READY' : 'FACTS_PENDING',
          migratedAt: new Date().toISOString() };
        revisionStore.put(migrated);
        adopted += 1;
        if (item.factsValid) ready += 1;
        const current = updatesBySku.get(item.skuKey) || {};
        updatesBySku.set(item.skuKey, {
          current: latestImage.get(item.skuKey),
          ready: latestReady.get(item.skuKey),
          revisions: [...(current.revisions || []), migrated]
        });
      }
      for (const [skuKey, update] of updatesBySku) {
        const request = models.get(skuKey);
        request.onsuccess = () => {
          const model = request.result || { skuKey, sourceId: skuKey, sourcePresent: false, variants: [] };
          const currentGenerationId = model.currentGenerationId || update.current?.revision?.generationId || null;
          const readyGenerationId = model.latestReadyGenerationId || update.ready?.revision?.generationId || null;
          models.put({ ...model, currentGenerationId, latestReadyGenerationId: readyGenerationId,
            generationStatus: readyGenerationId ? 'READY' : (currentGenerationId ? 'FACTS_PENDING' : model.generationStatus),
            updatedAt: new Date().toISOString() });
          if (readyGenerationId) {
            const exact = update.revisions.find((item) => String(item.generationId) === String(readyGenerationId));
            if (exact?.facts) factsStore.put({ ...exact.facts, sourceId: skuKey, generationId: readyGenerationId });
          }
        };
        request.onerror = () => tx.abort();
      }
      return { adopted, ready };
    }, 'Legacy revision migration');
  } finally { db.close(); }
}

// Set the current attempt before Send. This pointer prevents late OCR or a
// slower older worker from replacing the active projection of a newer run.
export async function beginGenerationRevision(record) {
  if (!record?.generationId || !record?.sourceId) throw new Error('Generation identity is required');
  const db = await openDb();
  try {
    const result = await transactionResult(db, [MODEL_STORE, REVISION_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const key = String(record.sourceId);
      const generationKey = String(record.generationId);
      const result = {};
      const modelRequest = models.get(key);
      const revisionRequest = revisions.get(generationKey);
      const recoveryRequest = recovery.get(generationKey);
      let modelReady = false;
      let revisionReady = false;
      let recoveryReady = false;
      const commit = () => {
        if (!modelReady || !revisionReady || !recoveryReady) return;
        const model = modelRequest.result || { skuKey: key, sourceId: key, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if (previous.sourceId && String(previous.sourceId) !== key) {
          Object.assign(result, { ...previous, identityConflict: true });
          return;
        }
        if (previous.supersededBySessionRestartId) {
          Object.assign(result, { ...previous, superseded: true });
          return;
        }
        if (previous.outputPath && previous.outputHash && previous.status === 'READY') {
          Object.assign(result, { ...previous, alreadyComplete: true });
          return;
        }
        const existingRecovery = normalizeOutputRecoveryRecord(recoveryRequest.result);
        if (existingRecovery && (existingRecovery.sourceId !== key
          || (existingRecovery.operationId && record.operationId && existingRecovery.operationId !== String(record.operationId))
          || (existingRecovery.attemptId && record.leaseId && existingRecovery.attemptId !== String(record.leaseId)))) {
          Object.assign(result, { ...previous, recoveryConflict: true });
          return;
        }
        if (existingRecovery && existingRecovery.state !== OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED) {
          Object.assign(result, { ...previous, verifiedOutputPending: true, recoveryRecord: existingRecovery });
          return;
        }
        const recoveryRecord = existingRecovery || createOutputRecoveryRecord({
          generationId: generationKey, sourceId: key, operationId: record.operationId,
          attemptId: record.leaseId, startedAt: record.createdAt || new Date().toISOString()
        });
        if (!recoveryRecord) throw new Error('Failed to create output recovery journal record');
        Object.assign(result, {
          ...previous, ...record, generationId: generationKey, sourceId: key,
          createdAt: previous.createdAt || record.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(), status: 'GENERATING'
        });
        revisions.put(result);
        recovery.put(recoveryRecord);
        const withVariant = catalogWithVariantState(model, record.sourceVariantId, {
          status: 'running', generationId: generationKey, sourceHash: record.sourceHash || null,
          sourceFingerprint: record.sourceFingerprint || null, inputPath: record.inputPath || null,
          lastError: null
        });
        models.put({ ...withVariant, skuKey: key, currentGenerationId: generationKey,
          generationStatus: 'GENERATING', currentAttemptAt: result.createdAt,
          queueState: { ...(model.queueState || {}), status: 'running', generationId: generationKey, lastError: null },
          updatedAt: new Date().toISOString() });
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      recoveryRequest.onsuccess = () => { recoveryReady = true; commit(); };
      return result;
    }, 'Generation start write');
    if (result.identityConflict) throw new Error('Generation ID is already bound to another SKU');
    if (result.superseded) throw new Error('Generation ID was superseded by a session restart');
    if (result.alreadyComplete) throw new Error('Generation ID already has a verified complete image');
    if (result.recoveryConflict) throw new Error('Generation ID conflicts with its durable output recovery journal');
    if (result.verifiedOutputPending) throw new Error('Generation ID has a verified output awaiting safe recovery; it cannot be regenerated');
    return result;
  } finally { db.close(); }
}

// A preparation cancelled before the physical Send must not leave the catalog
// pointing at a phantom GENERATING revision. The audit row is retained.
export async function cancelUnsubmittedGenerationRevision(generationId, sourceId, reason = 'cancelled_before_send') {
  if (!generationId || !sourceId) return { cancelled: false };
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const revisionRequest = revisions.get(String(generationId));
      const modelRequest = models.get(String(sourceId));
      const recoveryRequest = recovery.get(String(generationId));
      const result = { cancelled: false };
      let revisionReady = false;
      let modelReady = false;
      let recoveryReady = false;
      const commit = () => {
        if (!revisionReady || !modelReady || !recoveryReady) return;
        const revision = revisionRequest.result;
        const model = modelRequest.result;
        if (!revision || String(revision.sourceId) !== String(sourceId)
          || revision.outputPath || revision.outputHash
          || !['GENERATING', 'PENDING'].includes(String(revision.status || ''))) return;
        const cancelledAt = new Date().toISOString();
        revisions.put({ ...revision, status: 'CANCELLED', cancellationReason: reason,
          cancelledAt, updatedAt: cancelledAt });
        const recoveryRecord = normalizeOutputRecoveryRecord(recoveryRequest.result);
        if (recoveryRecord && recoveryRecord.state === OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED) {
          const terminal = markOutputRecoveryRecord(recoveryRecord, {
            state: OUTPUT_RECOVERY_STATES.REJECTED, reason: String(reason || 'cancelled_before_send'), at: cancelledAt
          });
          if (terminal.ok && terminal.changed) recovery.put(terminal.record);
        }
        result.cancelled = true;
        if (!model || String(model.currentGenerationId || '') !== String(generationId)) return;
        const finish = (previousGenerationId) => {
          const resetOutputs = model.retryRequired || !previousGenerationId;
          const withVariant = catalogWithVariantState(model, revision.sourceVariantId, {
            status: 'pending', generationId: previousGenerationId, lastError: null,
            ...(resetOutputs ? { outputPath: null, outputHash: null, factsStatus: null } : {})
          });
          models.put({ ...withVariant, currentGenerationId: previousGenerationId,
            generationStatus: resetOutputs ? 'NOT_READY' : (model.latestReadyGenerationId ? 'READY' : 'NOT_READY'),
            ...(resetOutputs ? { currentOutputPath: null, currentOutputHash: null } : {}),
            queueState: { ...(model.queueState || {}), status: 'pending',
              generationId: previousGenerationId, lastError: null }, updatedAt: cancelledAt });
        };
        if (model.retryRequired) { finish(null); return; }
        const previousGenerationId = revision.previousGenerationId || model.latestReadyGenerationId || null;
        if (!previousGenerationId) { finish(null); return; }
        const previousRequest = revisions.get(String(previousGenerationId));
        previousRequest.onsuccess = () => {
          const previous = previousRequest.result;
          finish(previous?.supersededBySessionRestartId
            || (previous?.sourceId && String(previous.sourceId) !== String(sourceId)) ? null : previousGenerationId);
        };
      };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      recoveryRequest.onsuccess = () => { recoveryReady = true; commit(); };
      return result;
    }, 'Cancel unsubmitted generation');
  } finally { db.close(); }
}

export async function persistGenerationImageRevision(record) {
  if (!record?.generationId || !record?.sourceId || !record?.outputPath || !record?.outputHash) {
    throw new Error('Verified image revision identity is incomplete');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(record.outputHash))) throw new Error('Verified PNG SHA-256 is invalid');
  const rawProof = record.fileVerification || {};
  const fileVerification = {
    ...rawProof,
    generationId: rawProof.generationId || record.generationId,
    sourceId: rawProof.sourceId || record.sourceId,
    outputPath: rawProof.outputPath || rawProof.path || record.outputPath,
    outputHash: rawProof.outputHash || rawProof.sha256 || record.outputHash,
    verified: rawProof.verified === true,
    exists: rawProof.exists === true,
    isFile: rawProof.isFile === true,
    sizeBytes: Number(rawProof.sizeBytes ?? rawProof.bytes ?? 0),
    verifiedAt: rawProof.verifiedAt || rawProof.checkedAt || new Date().toISOString()
  };
  if (!fileVerification.verified || !fileVerification.exists || !fileVerification.isFile
    || !Number.isSafeInteger(fileVerification.sizeBytes) || fileVerification.sizeBytes <= 0
    || String(fileVerification.outputHash).toLowerCase() !== String(record.outputHash).toLowerCase()
    || String(fileVerification.outputPath).replaceAll('\\', '/') !== String(record.outputPath).replaceAll('\\', '/')
    || String(fileVerification.generationId) !== String(record.generationId)
    || String(fileVerification.sourceId) !== String(record.sourceId)) {
    throw new Error('PNG registration requires positive physical existence and SHA-256 verification for the exact generation tuple');
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const skuKey = String(record.sourceId);
      const generationKey = String(record.generationId);
      const modelRequest = models.get(skuKey);
      const revisionRequest = revisions.get(generationKey);
      const recoveryRequest = recovery.get(generationKey);
      const result = { current: false, matched: false, registered: false, reason: null };
      let modelReady = false;
      let revisionReady = false;
      let recoveryReady = false;
      const commit = () => {
        if (!modelReady || !revisionReady || !recoveryReady) return;
        const model = modelRequest.result || { skuKey, sourceId: skuKey, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if ((previous.sourceId && String(previous.sourceId) !== skuKey)
          || previous.reviewStatus === 'rejected'
          || previous.identityQuarantined
          || previous.supersededBySessionRestartId
          || (previous.factsJobId && String(previous.factsJobId) !== String(record.factsJobId || ''))) return;
        if (previous.outputPath && previous.outputHash
          && (String(previous.outputPath) !== String(record.outputPath)
            || String(previous.outputHash).toLowerCase() !== String(record.outputHash).toLowerCase())) return;
        const existingRecovery = normalizeOutputRecoveryRecord(recoveryRequest.result);
        const attempt = existingRecovery || createOutputRecoveryRecord({
          generationId: generationKey, sourceId: skuKey, operationId: record.operationId,
          attemptId: record.leaseId, startedAt: record.createdAt || fileVerification.verifiedAt,
          outputPath: record.outputPath, outputHash: record.outputHash
        });
        if (!attempt || attempt.sourceId !== skuKey) { result.reason = 'recovery_identity_mismatch'; return; }
        const verified = transitionOutputRecoveryRecord(attempt, {
          type: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
          generationId: generationKey, sourceId: skuKey, outputPath: record.outputPath,
          outputHash: record.outputHash, fileVerification, at: fileVerification.verifiedAt
        });
        if (!verified.ok) { result.reason = verified.reason; return; }
        const registered = transitionOutputRecoveryRecord(verified.record, {
          type: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED,
          generationId: generationKey, sourceId: skuKey, outputPath: record.outputPath,
          outputHash: record.outputHash, at: new Date().toISOString()
        });
        if (!registered.ok) { result.reason = registered.reason; return; }
        result.matched = true;
        const factsCandidate = record.facts || previous.facts || null;
        const factsReady = (record.factsStatus === 'ok' || previous.factsStatus === 'ok') && factsCandidate?.status === 'ok'
          && String(factsCandidate.generationId || '') === generationKey
          && String(factsCandidate.factsJobId || '') === String(record.factsJobId || '')
          && (!factsCandidate.outputHash || String(factsCandidate.outputHash) === String(record.outputHash));
        const boundFacts = factsReady ? {
          ...factsCandidate,
          sourceId: skuKey,
          generationId: generationKey,
          factsJobId: String(record.factsJobId),
          outputPath: record.outputPath,
          outputHash: record.outputHash,
          chatUrl: record.chatUrl || factsCandidate.chatUrl || null
        } : null;
        const merged = { ...previous, ...record, generationId: generationKey, sourceId: skuKey,
          fileVerification,
          facts: boundFacts || factsCandidate,
          factsStatus: factsReady ? 'ok' : (record.factsStatus || previous.factsStatus || 'pending'),
          status: factsReady ? 'READY' : 'FACTS_PENDING', updatedAt: new Date().toISOString() };
        revisions.put(merged);
        recovery.put(registered.record);
        result.registered = true;
        result.current = String(model.currentGenerationId || '') === generationKey
          && previous.reviewStatus !== 'rejected' && !previous.identityQuarantined
          && !previous.supersededBySessionRestartId;
        if (result.current) {
          if (factsReady) factsStore.put({ ...boundFacts,
            updatedAt: boundFacts.extractedAt || new Date().toISOString() });
          const withVariant = catalogWithVariantState(model, record.sourceVariantId, {
            status: 'done', generationId: generationKey, outputPath: record.outputPath,
            outputHash: record.outputHash, sourceHash: record.sourceHash || null,
            recipeHash: record.recipeHash || null,
            factsStatus: factsReady ? 'ok' : 'pending', lastError: null
          });
          models.put({ ...catalogAfterFreshRetryResult(withVariant, merged), generationStatus: merged.status, currentOutputPath: record.outputPath,
            currentOutputHash: record.outputHash,
            latestReadyGenerationId: factsReady ? generationKey : model.latestReadyGenerationId || null,
            ...(factsReady ? { replacementRequired: false } : {}),
            queueState: { ...(model.queueState || {}), status: 'done', generationId: generationKey,
              recipeHash: record.recipeHash || model.queueState?.recipeHash || null, lastError: null },
            updatedAt: new Date().toISOString() });
        }
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      recoveryRequest.onsuccess = () => { recoveryReady = true; commit(); };
      return result;
    }, 'Generation image write');
  } finally { db.close(); }
}

export async function persistGenerationFactsRevision(record) {
  if (!record?.generationId || !record?.sourceId || !record?.facts
    || record.facts.status !== 'ok'
    || String(record.facts.generationId || '') !== String(record.generationId)
    || !record.factsJobId
    || String(record.facts.factsJobId || '') !== String(record.factsJobId)) {
    throw new Error('Complete generation facts identity is required');
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const skuKey = String(record.sourceId);
      const generationKey = String(record.generationId);
      let modelReady = false;
      let revisionReady = false;
      let recoveryReady = false;
      const result = { latest: false, matched: false };
      const modelRequest = models.get(skuKey);
      const revisionRequest = revisions.get(generationKey);
      const recoveryRequest = recovery.get(generationKey);
      const commit = () => {
        if (!modelReady || !revisionReady || !recoveryReady) return;
        const model = modelRequest.result || { skuKey, sourceId: skuKey, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if (previous.reviewStatus === 'rejected'
          || previous.identityQuarantined
          || (previous.sourceId && String(previous.sourceId) !== skuKey)
          || String(previous.factsJobId || '') !== String(record.factsJobId || '')) return;
        const journal = normalizeOutputRecoveryRecord(recoveryRequest.result);
        const proof = journal?.fileVerification;
        const registeredImage = journal?.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED
          && recoveryIdentityMatches(journal, {
            generationId: generationKey,
            sourceId: skuKey,
            outputPath: previous.outputPath,
            outputHash: previous.outputHash
          })
          && proof?.verified === true && proof?.exists === true && proof?.isFile === true
          && Number(proof.sizeBytes || 0) > 0;
        const authorizedAcceptedRevision = String(record.authorizedAcceptedGenerationId || '') === generationKey
          && String(model.latestReadyGenerationId || '') === generationKey;
        const ownsCurrentRevision = String(model.currentGenerationId || '') === generationKey;
        const mayAccept = registeredImage && (ownsCurrentRevision || authorizedAcceptedRevision);
        if (previous.factsStatus === 'ok' && previous.facts?.status === 'ok') {
          result.matched = true;
          result.latest = Boolean(mayAccept && revisionHasCompleteResult(previous));
          result.duplicate = true;
          if (result.latest && revisionHasCompleteResult(previous)) {
            const resolved = { ...catalogAfterFreshRetryResult(model, previous), replacementRequired: false };
            if (resolved !== model) models.put(resolved);
          }
          return;
        }
        if (record.facts.outputHash && previous.outputHash
          && String(record.facts.outputHash) !== String(previous.outputHash)) return;
        result.matched = true;
        // A superseded attempt may still receive its late OCR result. Keep that
        // fact on the immutable historical revision, while `mayAccept` remains
        // the only gate that can update the SKU's accepted/current projection.
        const imageVerified = Boolean(registeredImage && previous.outputPath
          && /^[a-f0-9]{64}$/i.test(String(previous.outputHash || '')));
        const boundFacts = {
          ...record.facts,
          sourceId: skuKey,
          generationId: generationKey,
          factsJobId: String(record.factsJobId),
          outputPath: previous.outputPath || record.facts.outputPath || null,
          outputHash: previous.outputHash || record.facts.outputHash || null,
          chatUrl: record.chatUrl || previous.chatUrl || record.facts.chatUrl || null
        };
        const merged = { ...previous, ...record, generationId: generationKey, sourceId: skuKey,
          facts: boundFacts,
          factsStatus: 'ok', status: imageVerified ? 'READY' : 'FACTS_WAITING_IMAGE', updatedAt: new Date().toISOString() };
        revisions.put(merged);
        result.latest = Boolean(mayAccept && imageVerified);
        if (result.latest) {
          factsStore.put({ ...boundFacts, updatedAt: boundFacts.extractedAt || new Date().toISOString() });
          const withVariant = catalogWithVariantState(model, record.sourceVariantId, {
            status: 'done', generationId: generationKey, factsStatus: 'ok', lastError: null
          });
          models.put({ ...catalogAfterFreshRetryResult(withVariant, merged), latestReadyGenerationId: generationKey,
            replacementRequired: false,
            generationStatus: 'READY',
            queueState: { ...(model.queueState || {}), status: 'done', generationId: generationKey,
              recipeHash: record.recipeHash || model.queueState?.recipeHash || null, lastError: null },
            updatedAt: new Date().toISOString() });
        }
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      recoveryRequest.onsuccess = () => { recoveryReady = true; commit(); };
      return result;
    }, 'Generation facts write');
  } finally { db.close(); }
}

export async function rejectGenerationRevision(generationId, updates = {}) {
  if (!generationId) return null;
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], (tx) => {
      const revisions = tx.objectStore(REVISION_STORE);
      const models = tx.objectStore(MODEL_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const revisionRequest = revisions.get(String(generationId));
      const result = {};
      revisionRequest.onsuccess = () => {
        const revision = revisionRequest.result;
        if (!revision) return;
        Object.assign(result, {
          ...revision,
          ...updates,
          generationId: String(generationId),
          reviewStatus: 'rejected',
          archivedFacts: revision.facts || revision.archivedFacts || null,
          facts: null,
          factsStatus: 'rejected'
        });
        revisions.put(result);
        const modelRequest = models.get(String(revision.sourceId));
        const factsRequest = factsStore.get(String(revision.sourceId));
        factsRequest.onsuccess = () => {
          if (factsRequest.result?.generationId === String(generationId)) factsStore.delete(String(revision.sourceId));
        };
        modelRequest.onsuccess = () => {
          const model = modelRequest.result;
          if (!model) return;
          const current = model.currentGenerationId === String(generationId);
          const latestReady = model.latestReadyGenerationId === String(generationId);
          if (current || latestReady) {
            const withVariant = current || !model.currentGenerationId
              ? catalogWithVariantState(model, revision.sourceVariantId, { status: 'pending', generationId: null, outputPath: null, outputHash: null, factsStatus: 'rejected' })
              : model;
            models.put({ ...withVariant,
            currentGenerationId: current ? null : model.currentGenerationId,
            latestReadyGenerationId: latestReady ? null : model.latestReadyGenerationId,
            replacementRequired: latestReady ? true : model.replacementRequired === true,
            generationStatus: current ? 'NOT_READY' : model.generationStatus,
            queueState: current ? { ...(model.queueState || {}), status: 'pending', generationId: null } : model.queueState,
            updatedAt: new Date().toISOString() });
          }
        };
      };
      return result;
    }, 'Generation rejection write');
  } finally { db.close(); }
}

export async function putAsset(key, file) {
  return putAssets([{ key, file }]);
}

export async function putAssets(entries = []) {
  for (let index = 0; index < entries.length; index += ASSET_BATCH_SIZE) {
    await writeAssetBatch(entries.slice(index, index + ASSET_BATCH_SIZE));
  }
}

function assetRecord(entry) {
  const file = entry.file;
  return {
    key: entry.key,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: Number(file.size || 0),
    lastModified: Number(file.lastModified || 0),
    relativePath: entry.relativePath || file.webkitRelativePath || file.name,
    blob: file,
    updatedAt: Date.now()
  };
}

async function writeAssetBatch(entries = []) {
  if (!entries.length) return;
  const db = await openDb();
  try {
    await transactionResult(db, STORE, (tx) => {
      const store = tx.objectStore(STORE);
      for (const entry of entries) store.put(assetRecord(entry));
      return null;
    }, 'Asset batch write');
  } finally {
    db.close();
  }
}

async function deleteAssetKeys(keys = []) {
  for (let index = 0; index < keys.length; index += ASSET_BATCH_SIZE * 4) {
    const batch = keys.slice(index, index + ASSET_BATCH_SIZE * 4);
    const db = await openDb();
    try {
      await transactionResult(db, STORE, (tx) => {
        const store = tx.objectStore(STORE);
        for (const key of batch) store.delete(key);
        return null;
      }, 'Asset delete batch');
    } finally {
      db.close();
    }
  }
}

export async function getAsset(key) {
  const db = await openDb();
  try {
    let result = null;
    await transactionResult(db, STORE, (tx) => {
    const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => { result = req.result || null; };
      return null;
    }, 'Asset read', undefined, 'readonly');
    return result;
  } finally { db.close(); }
}

export async function getAssetKeys(prefix = '') {
  const db = await openDb();
  try {
    let keys = [];
    await transactionResult(db, STORE, (tx) => {
      const request = tx.objectStore(STORE).getAllKeys();
      request.onsuccess = () => { keys = request.result || []; };
      return null;
    }, 'Asset keys read', undefined, 'readonly');
    return keys.filter((key) => String(key).startsWith(prefix));
  } finally { db.close(); }
}


export async function getAssetMetadata(prefix = '') {
  const db = await openDb();
  try {
    const items = new Map();
    await transactionResult(db, STORE, (tx) => {
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value;
        const key = String(record?.key || cursor.key || '');
        if (key.startsWith(prefix)) {
          items.set(key, {
            key,
            name: record?.name || '',
            type: record?.type || '',
            size: Number(record?.size || 0),
            lastModified: Number(record?.lastModified || 0),
            relativePath: record?.relativePath || ''
          });
        }
        cursor.continue();
      };
      return null;
    }, 'Asset metadata read', undefined, 'readonly');
    return items;
  } finally {
    db.close();
  }
}

export async function replaceAssets(prefix, entries = [], { force = false } = {}) {
  const existing = await getAssetMetadata(prefix);
  const desired = new Map(entries.map((entry) => [String(entry.key), entry]));
  const changed = [];

  for (const entry of entries) {
    const key = String(entry.key);
    const file = entry.file;
    const previous = existing.get(key);
    const relativePath = entry.relativePath || file?.webkitRelativePath || file?.name || '';
    const unchanged = !force && previous
      && previous.name === String(file?.name || '')
      && previous.type === String(file?.type || 'application/octet-stream')
      && previous.size === Number(file?.size || 0)
      && previous.lastModified === Number(file?.lastModified || 0)
      && previous.relativePath === relativePath;
    if (!unchanged) changed.push(entry);
  }

  // Write additions/replacements first. If quota or disk I/O fails, the old
  // dataset remains mostly usable instead of being deleted before the error.
  await putAssets(changed);

  const removedKeys = [...existing.keys()].filter((key) => !desired.has(key));
  await deleteAssetKeys(removedKeys);
  return { total: entries.length, changed: changed.length, removed: removedKeys.length };
}

// Imports files exposed by the local companion service in bounded batches.
// The caller supplies lightweight file metadata and a loader so large photo
// libraries never need to be held in browser memory all at once.
export async function replaceAssetsFromLoader(prefix, entries = [], loadFile, {
  force = false,
  batchSize = 12,
  concurrency = 3,
  shouldLoad = null,
  onFileLoaded = null,
  onProgress = null
} = {}) {
  if (typeof loadFile !== 'function') throw new Error('A local asset loader is required');
  const safeBatchSize = Math.max(1, Math.min(64, Number(batchSize) || 12));
  const safeConcurrency = Math.max(1, Math.min(8, Number(concurrency) || 3));
  const existing = await getAssetMetadata(prefix);
  const desired = new Map(entries.map((entry) => [String(entry.key), entry]));
  const changed = [];

  for (const entry of entries) {
    const key = String(entry.key);
    const file = entry.file || {};
    const previous = existing.get(key);
    const relativePath = entry.relativePath || file.relativePath || file.name || '';
    const sameMetadata = previous
      && previous.name === String(file.name || '')
      && previous.type === String(file.type || 'application/octet-stream')
      && previous.size === Number(file.size || 0)
      && previous.lastModified === Number(file.lastModified || 0)
      && previous.relativePath === relativePath;
    if (force || !sameMetadata || (typeof shouldLoad === 'function' && shouldLoad(entry, previous))) {
      changed.push(entry);
    }
  }

  let completed = 0;
  for (let offset = 0; offset < changed.length; offset += safeBatchSize) {
    const batch = changed.slice(offset, offset + safeBatchSize);
    const loaded = new Array(batch.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(safeConcurrency, batch.length) }, async () => {
      while (cursor < batch.length) {
        const index = cursor++;
        const entry = batch[index];
        const file = await loadFile(entry);
        if (!file || typeof file.arrayBuffer !== 'function') {
          throw new Error(`Не удалось загрузить локальный файл ${entry.file?.name || entry.key}`);
        }
        if (typeof onFileLoaded === 'function') await onFileLoaded(entry, file);
        loaded[index] = { ...entry, file };
        completed += 1;
        if (typeof onProgress === 'function') onProgress(completed, changed.length, entry);
      }
    }));
    await putAssets(loaded);
  }

  const removedKeys = [...existing.keys()].filter((key) => !desired.has(key));
  await deleteAssetKeys(removedKeys);
  return { total: entries.length, changed: changed.length, removed: removedKeys.length };
}


export async function putOutputDirectoryHandle(handle) {
  if (!handle) throw new Error('Output directory handle is required');
  const db = await openDb();
  try {
    await transactionResult(db, HANDLE_STORE, (tx) => {
      tx.objectStore(HANDLE_STORE).put({ key: OUTPUT_DIRECTORY_HANDLE_KEY, handle, updatedAt: Date.now() });
      return null;
    }, 'Output directory handle write');
  } finally { db.close(); }
}

export async function getOutputDirectoryHandle() {
  const db = await openDb();
  try {
    let handle = null;
    await transactionResult(db, HANDLE_STORE, (tx) => {
      const req = tx.objectStore(HANDLE_STORE).get(OUTPUT_DIRECTORY_HANDLE_KEY);
      req.onsuccess = () => { handle = req.result?.handle || null; };
      return null;
    }, 'Output directory handle read', undefined, 'readonly');
    return handle;
  } finally { db.close(); }
}


export async function putGalleryDirectoryHandle(handle) {
  if (!handle) throw new Error('Gallery directory handle is required');
  const db = await openDb();
  try {
    await transactionResult(db, HANDLE_STORE, (tx) => {
      tx.objectStore(HANDLE_STORE).put({ key: GALLERY_DIRECTORY_HANDLE_KEY, handle, updatedAt: Date.now() });
      return null;
    }, 'Gallery directory handle write');
  } finally { db.close(); }
}

export async function getGalleryDirectoryHandle() {
  const db = await openDb();
  try {
    let handle = null;
    await transactionResult(db, HANDLE_STORE, (tx) => {
      const req = tx.objectStore(HANDLE_STORE).get(GALLERY_DIRECTORY_HANDLE_KEY);
      req.onsuccess = () => { handle = req.result?.handle || null; };
      return null;
    }, 'Gallery directory handle read', undefined, 'readonly');
    return handle;
  } finally { db.close(); }
}


export async function putGenerationFacts(record) {
  if (!record?.sourceId) throw new Error('Generation facts sourceId is required');
  const db = await openDb();
  try {
    await transactionResult(db, FACTS_STORE, (tx) => {
      tx.objectStore(FACTS_STORE).put({
        ...record,
        sourceId: String(record.sourceId),
        updatedAt: record.updatedAt || new Date().toISOString()
      });
      return null;
    }, 'Generation facts write');
  } finally { db.close(); }
}

export async function getGenerationFacts(sourceId) {
  if (!sourceId) return null;
  const db = await openDb();
  try {
    let facts = null;
    await transactionResult(db, FACTS_STORE, (tx) => {
      const req = tx.objectStore(FACTS_STORE).get(String(sourceId));
      req.onsuccess = () => { facts = req.result || null; };
      return null;
    }, 'Generation facts read', undefined, 'readonly');
    return facts;
  } finally { db.close(); }
}

export async function getAllGenerationFacts() {
  const db = await openDb();
  try {
    let facts = [];
    await transactionResult(db, FACTS_STORE, (tx) => {
      const req = tx.objectStore(FACTS_STORE).getAll();
      req.onsuccess = () => { facts = req.result || []; };
      return null;
    }, 'Generation facts read', undefined, 'readonly');
    return facts;
  } finally { db.close(); }
}

function recoveryIdentityMatches(record, expected) {
  return Boolean(record && expected
    && String(record.generationId || '') === String(expected.generationId || '')
    && String(record.sourceId || '') === String(expected.sourceId || '')
    && String(record.outputPath || '').replaceAll('\\', '/') === String(expected.outputPath || '').replaceAll('\\', '/')
    && String(record.outputHash || '').toLowerCase() === String(expected.outputHash || '').toLowerCase());
}

export async function getOutputRecoveryRecord(generationId) {
  if (!generationId) return null;
  const db = await openDb();
  try {
    let record = null;
    await transactionResult(db, OUTPUT_RECOVERY_STORE, (tx) => {
      const request = tx.objectStore(OUTPUT_RECOVERY_STORE).get(String(generationId));
      request.onsuccess = () => { record = normalizeOutputRecoveryRecord(request.result); };
      return null;
    }, 'Output recovery journal read', undefined, 'readonly');
    return record;
  } finally { db.close(); }
}

export async function getAllOutputRecoveryRecords() {
  const db = await openDb();
  try {
    let records = [];
    await transactionResult(db, OUTPUT_RECOVERY_STORE, (tx) => {
      const request = tx.objectStore(OUTPUT_RECOVERY_STORE).getAll();
      request.onsuccess = () => { records = (request.result || []).map(normalizeOutputRecoveryRecord).filter(Boolean); };
      return null;
    }, 'Output recovery journal read', undefined, 'readonly');
    return records;
  } finally { db.close(); }
}

// Record positive physical evidence before attempting to register an image
// revision. A later worker restart can use this exact tuple to recover the
// interrupted IDB write without guessing from filenames or timestamps.
export async function recordVerifiedOutputArtifact(record = {}) {
  const generationId = String(record.generationId || '');
  const sourceId = String(record.sourceId || '');
  if (!generationId || !sourceId) throw new Error('Output verification requires generationId and sourceId');
  const db = await openDb();
  try {
    return await transactionResult(db, OUTPUT_RECOVERY_STORE, (tx) => {
      const store = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const request = store.get(generationId);
      const result = { recorded: false, reason: null, record: null };
      request.onsuccess = () => {
        const old = normalizeOutputRecoveryRecord(request.result)
          || createOutputRecoveryRecord({ ...record, startedAt: record.startedAt || record.verifiedAt || new Date().toISOString() });
        if (!old || old.sourceId !== sourceId) { result.reason = 'journal_identity_mismatch'; return; }
        const proof = {
          type: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
          generationId,
          sourceId,
          outputPath: record.outputPath,
          outputHash: record.outputHash,
          fileVerification: record.fileVerification || record.verification,
          at: record.verifiedAt || new Date().toISOString()
        };
        const changed = transitionOutputRecoveryRecord(old, proof);
        if (!changed.ok) { result.reason = changed.reason; result.record = changed.record; return; }
        if (changed.changed) store.put(changed.record);
        result.recorded = true;
        result.record = changed.record;
      };
      request.onerror = () => tx.abort();
      return result;
    }, 'Verified output journal write');
  } finally { db.close(); }
}

// Persist a downloaded artifact's immutable candidate tuple even when the
// physical file verifier is temporarily unavailable. This tuple is explicitly
// unverified: it blocks automatic duplicate generation, but cannot make a
// result READY. A later positive on-disk check can promote it through the
// ordinary strict image-registration transaction.
export async function recordUnverifiedOutputCandidate(record = {}) {
  const generationId = String(record.generationId || '');
  const sourceId = String(record.sourceId || '');
  const outputPath = String(record.outputPath || '').trim().replaceAll('\\', '/');
  const outputHash = String(record.outputHash || '').trim().toLowerCase();
  if (!generationId || !sourceId || !outputPath || !/^[a-f0-9]{64}$/.test(outputHash)) {
    throw new Error('Unverified output candidate requires the exact generation, source, path, and SHA-256 tuple');
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const modelRequest = models.get(sourceId);
      const revisionRequest = revisions.get(generationId);
      const recoveryRequest = recovery.get(generationId);
      const result = { recorded: false, reason: null };
      let ready = 0;
      const commit = () => {
        if (++ready !== 3) return;
        const model = modelRequest.result;
        const previous = revisionRequest.result || {};
        const journal = normalizeOutputRecoveryRecord(recoveryRequest.result);
        if (!model || String(model.currentGenerationId || '') !== generationId
          || (previous.sourceId && String(previous.sourceId) !== sourceId)
          || previous.reviewStatus === 'rejected' || previous.identityQuarantined
          || previous.supersededBySessionRestartId) {
          result.reason = 'current_attempt_or_identity_changed';
          return;
        }
        if (!journal || journal.state !== OUTPUT_RECOVERY_STATES.ATTEMPT_STARTED
          || journal.sourceId !== sourceId
          || (journal.operationId && record.operationId && journal.operationId !== String(record.operationId))
          || (journal.attemptId && record.leaseId && journal.attemptId !== String(record.leaseId))) {
          result.reason = 'attempt_journal_mismatch';
          return;
        }
        if ((journal.outputPath && journal.outputPath !== outputPath)
          || (journal.outputHash && journal.outputHash !== outputHash)
          || (previous.outputPath && String(previous.outputPath).replaceAll('\\', '/') !== outputPath)
          || (previous.outputHash && String(previous.outputHash).toLowerCase() !== outputHash)) {
          result.reason = 'candidate_tuple_conflict';
          return;
        }
        if (previous.factsJobId && record.factsJobId
          && String(previous.factsJobId) !== String(record.factsJobId)) {
          result.reason = 'facts_job_mismatch';
          return;
        }
        const at = new Date().toISOString();
        const candidateJournal = normalizeOutputRecoveryRecord({ ...journal,
          outputPath, outputHash, updatedAt: at });
        if (!candidateJournal) { result.reason = 'candidate_journal_invalid'; return; }
        const candidateRevision = {
          ...previous,
          ...record,
          generationId,
          sourceId,
          skuKey: sourceId,
          outputPath,
          outputHash,
          factsJobId: previous.factsJobId || record.factsJobId || null,
          factsStatus: previous.factsStatus || 'pending',
          status: 'OUTPUT_VERIFICATION_PENDING',
          fileVerification: null,
          outputVerificationPending: true,
          outputCandidateRecordedAt: at,
          updatedAt: at
        };
        revisions.put(candidateRevision);
        recovery.put(candidateJournal);
        models.put({ ...model, generationStatus: 'OUTPUT_VERIFICATION_PENDING',
          currentOutputPath: outputPath, currentOutputHash: outputHash,
          updatedAt: at });
        result.recorded = true;
        result.generationId = generationId;
        result.sourceId = sourceId;
      };
      modelRequest.onsuccess = commit;
      revisionRequest.onsuccess = commit;
      recoveryRequest.onsuccess = commit;
      modelRequest.onerror = () => tx.abort();
      revisionRequest.onerror = () => tx.abort();
      recoveryRequest.onerror = () => tx.abort();
      return result;
    }, 'Unverified output candidate write');
  } finally { db.close(); }
}

export async function recordRegisteredOutputRevision(record = {}) {
  const generationId = String(record.generationId || '');
  const sourceId = String(record.sourceId || '');
  if (!generationId || !sourceId) throw new Error('Revision registration requires generationId and sourceId');
  const db = await openDb();
  try {
    return await transactionResult(db, OUTPUT_RECOVERY_STORE, (tx) => {
      const store = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const request = store.get(generationId);
      const result = { registered: false, reason: null, record: null };
      request.onsuccess = () => {
        const journal = normalizeOutputRecoveryRecord(request.result);
        const tuple = { generationId, sourceId, outputPath: record.outputPath, outputHash: record.outputHash };
        if (!journal || journal.sourceId !== sourceId || !recoveryIdentityMatches(journal, tuple)) {
          result.reason = 'verified_journal_tuple_missing';
          return;
        }
        const changed = transitionOutputRecoveryRecord(journal, {
          type: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED,
          ...tuple,
          at: record.registeredAt || new Date().toISOString()
        });
        if (!changed.ok) { result.reason = changed.reason; result.record = changed.record; return; }
        if (changed.changed) store.put(changed.record);
        result.registered = true;
        result.record = changed.record;
      };
      request.onerror = () => tx.abort();
      return result;
    }, 'Registered output journal write');
  } finally { db.close(); }
}

export async function recordExistingVerifiedRevision(revision, fileVerification) {
  if (!revision?.generationId || !revision?.sourceId || !revision?.outputPath || !revision?.outputHash) {
    throw new Error('Existing revision verification tuple is incomplete');
  }
  const current = await getOutputRecoveryRecord(revision.generationId);
  if (current?.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED
    && recoveryIdentityMatches(current, revision)) return { registered: true, alreadyRegistered: true };
  const proof = {
    generationId: revision.generationId,
    sourceId: revision.sourceId,
    outputPath: revision.outputPath,
    outputHash: revision.outputHash,
    fileVerification
  };
  const verified = await recordVerifiedOutputArtifact({ ...proof, verifiedAt: fileVerification?.verifiedAt });
  if (!verified.recorded) return { registered: false, reason: verified.reason };
  return recordRegisteredOutputRevision(proof);
}

// Batch legacy/imported artifact journal recovery in one transaction. The
// current revision tuples are re-read in the same readwrite transaction so a
// stale snapshot or racing replacement cannot register proof against a
// different generation/source/path/hash.
export async function recordExistingVerifiedRevisions(items = []) {
  const candidates = (Array.isArray(items) ? items : []).filter((item) => (
    item?.revision?.generationId && item?.revision?.sourceId && item?.revision?.outputPath
    && item?.revision?.outputHash && item?.fileVerification
  ));
  if (!candidates.length) return { registered: 0, skipped: 0, results: [] };
  const db = await openDb();
  try {
    return await transactionResult(db, [REVISION_STORE, OUTPUT_RECOVERY_STORE], (tx) => {
      const revisions = tx.objectStore(REVISION_STORE);
      const recovery = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const revisionRequest = revisions.getAll();
      const recoveryRequest = recovery.getAll();
      const result = { registered: 0, skipped: 0, results: [] };
      let ready = 0;
      const commit = () => {
        if (++ready !== 2) return;
        const revisionById = new Map((revisionRequest.result || []).map((row) => [String(row.generationId || ''), row]));
        const recoveryById = new Map((recoveryRequest.result || []).map((row) => [String(row.generationId || ''), row]));
        for (const item of candidates) {
          const expected = item.revision;
          const generationId = String(expected.generationId);
          const sourceId = String(expected.sourceId);
          const current = revisionById.get(generationId);
          const proof = item.fileVerification || {};
          const exactCurrent = Boolean(current && String(current.sourceId || '') === sourceId
            && String(current.outputPath || '').replaceAll('\\', '/') === String(expected.outputPath).replaceAll('\\', '/')
            && String(current.outputHash || '').toLowerCase() === String(expected.outputHash).toLowerCase()
            && current.reviewStatus !== 'rejected' && !current.identityQuarantined
            && !current.supersededBySessionRestartId);
          const exactProof = Boolean(proof.verified === true && proof.exists === true && proof.isFile === true
            && Number(proof.sizeBytes || 0) > 0
            && String(proof.generationId || '') === generationId
            && String(proof.sourceId || '') === sourceId
            && String(proof.outputPath || '').replaceAll('\\', '/') === String(expected.outputPath).replaceAll('\\', '/')
            && String(proof.outputHash || '').toLowerCase() === String(expected.outputHash).toLowerCase());
          if (!exactCurrent || !exactProof) {
            result.skipped += 1;
            result.results.push({ generationId, sourceId, registered: false, reason: exactCurrent ? 'invalid_file_proof' : 'revision_tuple_changed' });
            continue;
          }
          const existing = normalizeOutputRecoveryRecord(recoveryById.get(generationId));
          if (existing?.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED) {
            const same = recoveryIdentityMatches(existing, expected)
              && existing.fileVerification?.verified === true
              && existing.fileVerification?.exists === true
              && existing.fileVerification?.isFile === true
              && Number(existing.fileVerification?.sizeBytes || 0) > 0;
            if (same) {
              result.skipped += 1;
              result.results.push({ generationId, sourceId, registered: true, alreadyRegistered: true });
              continue;
            }
          }
          const started = existing || createOutputRecoveryRecord({
            generationId, sourceId, operationId: expected.operationId || null,
            attemptId: expected.leaseId || null,
            startedAt: expected.createdAt || proof.verifiedAt || new Date().toISOString(),
            outputPath: expected.outputPath, outputHash: expected.outputHash
          });
          if (!started || started.sourceId !== sourceId) {
            result.skipped += 1;
            result.results.push({ generationId, sourceId, registered: false, reason: 'journal_identity_mismatch' });
            continue;
          }
          const verified = started.state === OUTPUT_RECOVERY_STATES.FILE_VERIFIED
            && recoveryIdentityMatches(started, expected)
            && started.fileVerification?.verified === true
            && started.fileVerification?.exists === true
            && started.fileVerification?.isFile === true
            && Number(started.fileVerification?.sizeBytes || 0) > 0
            ? { ok: true, changed: false, record: started }
            : transitionOutputRecoveryRecord(started, {
              type: OUTPUT_RECOVERY_STATES.FILE_VERIFIED,
              generationId, sourceId, outputPath: expected.outputPath, outputHash: expected.outputHash,
              fileVerification: proof, at: proof.verifiedAt || proof.checkedAt || new Date().toISOString()
            });
          if (!verified.ok) {
            result.skipped += 1;
            result.results.push({ generationId, sourceId, registered: false, reason: verified.reason || 'file_verification_transition_failed' });
            continue;
          }
          const registered = transitionOutputRecoveryRecord(verified.record, {
            type: OUTPUT_RECOVERY_STATES.REVISION_REGISTERED,
            generationId, sourceId, outputPath: expected.outputPath, outputHash: expected.outputHash,
            at: new Date().toISOString()
          });
          if (!registered.ok) {
            result.skipped += 1;
            result.results.push({ generationId, sourceId, registered: false, reason: registered.reason || 'revision_registration_failed' });
            continue;
          }
          recovery.put(registered.record);
          recoveryById.set(generationId, registered.record);
          result.registered += 1;
          result.results.push({ generationId, sourceId, registered: true });
        }
      };
      revisionRequest.onsuccess = commit;
      recoveryRequest.onsuccess = commit;
      revisionRequest.onerror = () => tx.abort();
      recoveryRequest.onerror = () => tx.abort();
      return result;
    }, 'Verified output journal batch write', 60000);
  } finally { db.close(); }
}

export async function getAllIdentityQuarantines() {
  const db = await openDb();
  try {
    let rows = [];
    await transactionResult(db, IDENTITY_QUARANTINE_STORE, (tx) => {
      const request = tx.objectStore(IDENTITY_QUARANTINE_STORE).getAll();
      request.onsuccess = () => { rows = request.result || []; };
      return null;
    }, 'Identity quarantine read', undefined, 'readonly');
    return rows;
  } finally { db.close(); }
}

// Catalog, accepted pointers, revisions, facts and recovery proof must be read
// from one readonly transaction. Independent getters can straddle an image or
// facts write and manufacture a tuple that never existed.
export async function getAccountingRecords({ includeRemoved = true } = {}) {
  const db = await openDb();
  try {
    const records = { catalog: [], revisions: [], facts: [], outputRecovery: [], quarantines: [] };
    await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE, IDENTITY_QUARANTINE_STORE], (tx) => {
      const requests = [
        ['catalog', tx.objectStore(MODEL_STORE).getAll()],
        ['revisions', tx.objectStore(REVISION_STORE).getAll()],
        ['facts', tx.objectStore(FACTS_STORE).getAll()],
        ['outputRecovery', tx.objectStore(OUTPUT_RECOVERY_STORE).getAll()],
        ['quarantines', tx.objectStore(IDENTITY_QUARANTINE_STORE).getAll()]
      ];
      for (const [key, request] of requests) {
        request.onsuccess = () => { records[key] = request.result || []; };
        request.onerror = () => tx.abort();
      }
      return null;
    }, 'Canonical accounting snapshot read', 60000, 'readonly');
    if (!includeRemoved) records.catalog = records.catalog.filter((row) => row.sourcePresent !== false);
    records.outputRecovery = records.outputRecovery.map(normalizeOutputRecoveryRecord).filter(Boolean);
    return records;
  } finally { db.close(); }
}

export async function createAccountingBackup(backupId = '') {
  const id = String(backupId || `accounting-${Date.now()}-${crypto.randomUUID()}`);
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE, IDENTITY_QUARANTINE_STORE, ACCOUNTING_BACKUP_STORE], (tx) => {
      const backupStore = tx.objectStore(ACCOUNTING_BACKUP_STORE);
      const existingRequest = backupStore.get(id);
      const catalogRequest = tx.objectStore(MODEL_STORE).getAll();
      const revisionsRequest = tx.objectStore(REVISION_STORE).getAll();
      const factsRequest = tx.objectStore(FACTS_STORE).getAll();
      const recoveryRequest = tx.objectStore(OUTPUT_RECOVERY_STORE).getAll();
      const quarantineRequest = tx.objectStore(IDENTITY_QUARANTINE_STORE).getAll();
      const result = { backupId: id, created: false, alreadyExists: false };
      let ready = 0;
      const persist = () => {
        if (++ready !== 6) return;
        if (existingRequest.result?.complete === true) {
          Object.assign(result, { alreadyExists: true, completedAt: existingRequest.result.completedAt || null,
            counts: existingRequest.result.counts || null });
          return;
        }
        const catalog = catalogRequest.result || [];
        const revisions = revisionsRequest.result || [];
        const facts = factsRequest.result || [];
        const outputRecovery = recoveryRequest.result || [];
        const quarantines = quarantineRequest.result || [];
        const backup = {
          backupId: id,
          schemaVersion: 1,
          complete: true,
          createdAt: new Date().toISOString(),
          counts: { catalog: catalog.length, revisions: revisions.length, facts: facts.length,
            outputRecovery: outputRecovery.length, quarantines: quarantines.length },
          stores: { catalog, revisions, facts, outputRecovery, quarantines }
        };
        backupStore.put(backup);
        Object.assign(result, { created: true, completedAt: backup.createdAt, counts: backup.counts });
      };
      for (const request of [existingRequest, catalogRequest, revisionsRequest, factsRequest, recoveryRequest, quarantineRequest]) {
        request.onsuccess = persist;
        request.onerror = () => tx.abort();
      }
      return result;
    }, 'Accounting backup write', 60000);
  } finally { db.close(); }
}

export async function getAccountingBackup(backupId) {
  if (!backupId) return null;
  const db = await openDb();
  try {
    let backup = null;
    await transactionResult(db, ACCOUNTING_BACKUP_STORE, (tx) => {
      const request = tx.objectStore(ACCOUNTING_BACKUP_STORE).get(String(backupId));
      request.onsuccess = () => { backup = request.result || null; };
      return null;
    }, 'Accounting backup read', undefined, 'readonly');
    return backup;
  } finally { db.close(); }
}

// Apply only evidence-backed per-revision moves. The complete accounting
// stores are copied into an immutable backup in the same transaction as the
// first change, so a crash commits both the backup and migration or neither.
export async function applyExplicitIdentityMigration(plan = {}, { backupId = '' } = {}) {
  const revisionMoves = Array.isArray(plan.revisionMoves) ? plan.revisionMoves : [];
  const catalogAssignments = Array.isArray(plan.catalogAssignments) ? plan.catalogAssignments : [];
  if (!revisionMoves.length && !catalogAssignments.length
    && !(Array.isArray(plan.quarantined) && plan.quarantined.length)) {
    return { movedRevisions: 0, movedCatalogRows: 0, skipped: true };
  }
  const id = String(backupId || `identity-${Date.now()}-${crypto.randomUUID()}`);
  const migrationFingerprint = String(plan.fingerprint || JSON.stringify({
    revisionMoves, catalogAssignments, quarantined: Array.isArray(plan.quarantined) ? plan.quarantined : []
  }));
  const moveByGeneration = new Map();
  for (const move of revisionMoves) {
    const generationId = String(move?.generationId || '');
    const fromSourceId = String(move?.fromSourceId || '');
    const toSourceId = String(move?.toSourceId || move?.skuKey || '');
    if (!generationId || !fromSourceId || !toSourceId || moveByGeneration.has(generationId)) {
      throw new Error('Identity migration requires one explicit destination per generationId');
    }
    moveByGeneration.set(generationId, { ...move, generationId, fromSourceId, toSourceId });
  }
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE, OUTPUT_RECOVERY_STORE, ACCOUNTING_BACKUP_STORE, IDENTITY_QUARANTINE_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisionsStore = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const recoveryStore = tx.objectStore(OUTPUT_RECOVERY_STORE);
      const backups = tx.objectStore(ACCOUNTING_BACKUP_STORE);
      const quarantines = tx.objectStore(IDENTITY_QUARANTINE_STORE);
      const catalogRequest = models.getAll();
      const revisionsRequest = revisionsStore.getAll();
      const factsRequest = factsStore.getAll();
      const recoveryRequest = recoveryStore.getAll();
      const backupRequest = backups.get(id);
      const quarantineRequest = quarantines.getAll();
      const result = { backupId: id, movedRevisions: 0, movedCatalogRows: 0, movedFactsRows: 0, quarantined: 0 };
      let ready = 0;
      const commit = () => {
        if (++ready !== 6) return;
        try {
        const catalog = catalogRequest.result || [];
        const revisions = revisionsRequest.result || [];
        const facts = factsRequest.result || [];
        const outputRecovery = recoveryRequest.result || [];
        const catalogById = new Map(catalog.map((row) => [String(row.skuKey || row.sourceId || ''), row]));
        const revisionById = new Map(revisions.map((row) => [String(row.generationId || ''), row]));
        const existingBackup = backupRequest.result;
        const allAlreadyApplied = [...moveByGeneration.values()].every((move) => (
          String(revisionById.get(move.generationId)?.sourceId || '') === move.toSourceId
            && String(revisionById.get(move.generationId)?.originSourceId || '') === String(move.originSourceId || move.fromSourceId)
        ));
        const assignmentsApplied = catalogAssignments.every((assignment) => {
          const target = catalogById.get(String(assignment.toSourceId));
          if (!target || String(target.originSourceId || '') !== String(assignment.originSourceId || assignment.fromSourceId)) return false;
          const expected = (assignment.variantKeys || []).map(String);
        const actual = new Set((target.variants || []).map(identityVariantKeyForMigration));
          return expected.every((key) => actual.has(key));
        });
        if (existingBackup?.complete === true && existingBackup.migrationFingerprint === migrationFingerprint
          && allAlreadyApplied && assignmentsApplied) {
          Object.assign(result, { alreadyApplied: true, movedRevisions: revisionMoves.length,
            movedCatalogRows: catalogAssignments.length, completedAt: existingBackup.createdAt });
          return;
        }
        if (existingBackup) {
          tx.abort();
          return;
        }
        for (const move of moveByGeneration.values()) {
          const revision = revisionById.get(move.generationId);
          if (!revision || String(revision.sourceId || '') !== move.fromSourceId
            || (move.outputHash && String(revision.outputHash || '').toLowerCase() !== String(move.outputHash).toLowerCase())) {
            tx.abort();
            return;
          }
        }
        for (const assignment of catalogAssignments) {
          if (!String(assignment?.fromSourceId || '') || !String(assignment?.toSourceId || '')) { tx.abort(); return; }
          if (!catalogById.has(String(assignment.fromSourceId))
            && (assignment.sourcePresent !== false || (assignment.variantKeys || []).length > 0)) { tx.abort(); return; }
        }
        if (!existingBackup) {
          backups.put({
            backupId: id, schemaVersion: 1, complete: true, createdAt: new Date().toISOString(),
            migrationFingerprint,
            counts: { catalog: catalog.length, revisions: revisions.length, facts: facts.length,
              outputRecovery: outputRecovery.length, quarantines: (quarantineRequest.result || []).length },
            stores: { catalog, revisions, facts, outputRecovery, quarantines: quarantineRequest.result || [] }
          });
        }
        for (const move of moveByGeneration.values()) {
          const revision = revisionById.get(move.generationId);
          const migratedFacts = revision.facts && String(revision.facts.generationId || '') === move.generationId
            ? { ...revision.facts, sourceId: move.toSourceId }
            : revision.facts;
          const migrated = { ...revision, sourceId: move.toSourceId, skuKey: move.toSourceId,
            facts: migratedFacts,
            originSourceId: revision.originSourceId || move.originSourceId || move.fromSourceId,
            identityMigrationEvidence: Array.isArray(move.evidence) ? move.evidence : revision.identityMigrationEvidence || [],
            identityMigrationBackupId: id, identityMigratedAt: new Date().toISOString() };
          revisionsStore.put(migrated);
          revisionById.set(move.generationId, migrated);
          result.movedRevisions += 1;
        }
        const assignmentsBySource = new Map();
        for (const assignment of catalogAssignments) {
          const key = String(assignment.fromSourceId);
          const rows = assignmentsBySource.get(key) || [];
          rows.push(assignment);
          assignmentsBySource.set(key, rows);
        }
        const affectedTargets = new Map();
        for (const [fromSourceId, assignments] of assignmentsBySource) {
          const original = catalogById.get(fromSourceId)
            || { skuKey: fromSourceId, sourceId: fromSourceId, sourcePresent: false, variants: [] };
          const variants = Array.isArray(original.variants) ? original.variants : [];
          const assignedVariants = new Set();
          for (const assignment of assignments) {
            const targetId = String(assignment.toSourceId);
            const selectedVariantIds = new Set((assignment.variantKeys || []).map(String));
            const selectedVariants = variants.filter((variant) => {
              const key = identityVariantKeyForMigration(variant);
              if (!selectedVariantIds.size) return targetId === fromSourceId;
              if (!selectedVariantIds.has(key)) return false;
              assignedVariants.add(key);
              return true;
            });
            const existingTarget = catalogById.get(targetId);
            const previousTarget = affectedTargets.get(targetId) || existingTarget || {};
            const mergedVariants = [...(previousTarget.variants || [])];
            for (const variant of selectedVariants) {
              const variantId = identityVariantKeyForMigration(variant);
              const existingIndex = mergedVariants.findIndex((row) => identityVariantKeyForMigration(row) === variantId);
              const existingVariant = existingIndex >= 0 ? mergedVariants[existingIndex] : null;
              const partitionOrderKey = existingVariant?.partitionOrderKey || variant.partitionOrderKey || assignment.partitionOrderKey
                || assignment.membership?.partitionOrderKey || original.partitionOrderKey || fromSourceId;
              const migratedVariant = { ...variant, ...existingVariant,
                originSourceId: existingVariant?.originSourceId || variant.originSourceId || assignment.originSourceId || fromSourceId,
                partitionOrderKey,
                identityMigrationMembership: existingVariant?.identityMigrationMembership || variant.identityMigrationMembership || assignment.membership || null };
              if (existingIndex >= 0) mergedVariants[existingIndex] = migratedVariant;
              else mergedVariants.push(migratedVariant);
            }
            const matchingRevisions = [...revisionById.values()].filter((revision) => String(revision.sourceId || '') === targetId);
            const currentId = String(previousTarget.currentGenerationId || '');
            const readyId = String(previousTarget.latestReadyGenerationId || '');
            const validPointer = (pointer) => pointer && String(revisionById.get(pointer)?.sourceId || '') === targetId;
            const movedCurrent = [...moveByGeneration.values()].find((move) => move.fromSourceId === fromSourceId
              && move.toSourceId === targetId && original.currentGenerationId === move.generationId);
            const movedReady = [...moveByGeneration.values()].find((move) => move.fromSourceId === fromSourceId
              && move.toSourceId === targetId && original.latestReadyGenerationId === move.generationId);
            const currentGenerationId = validPointer(currentId) ? currentId : movedCurrent?.generationId || null;
            const latestReadyGenerationId = validPointer(readyId) ? readyId : movedReady?.generationId || null;
            const model = {
              ...original, ...previousTarget, ...assignment,
              skuKey: targetId, sourceId: targetId,
              originSourceId: previousTarget.originSourceId || assignment.originSourceId || fromSourceId,
              modelName: assignment.modelName || previousTarget.modelName || original.modelName || '',
              brandId: assignment.brandId || previousTarget.brandId || original.brandId || '',
              variants: mergedVariants,
              partitionOrderKey: assignment.partitionOrderKey || assignment.membership?.partitionOrderKey
                || previousTarget.partitionOrderKey || original.partitionOrderKey || fromSourceId,
              sourcePresent: assignment.sourcePresent ?? previousTarget.sourcePresent ?? original.sourcePresent ?? false,
              currentGenerationId,
              latestReadyGenerationId,
              identityMigrationBackupId: id,
              identityMigrationMembership: assignment.membership || previousTarget.identityMigrationMembership || null,
              updatedAt: new Date().toISOString()
            };
            delete model.fromSourceId;
            delete model.toSourceId;
            delete model.variantKeys;
            affectedTargets.set(targetId, model);
            result.movedCatalogRows += 1;
          }
          const leftover = variants.filter((variant) => !assignedVariants.has(identityVariantKeyForMigration(variant)));
          const sourceReassignedAway = assignments.some((item) => String(item.toSourceId) !== fromSourceId);
          if (catalogById.has(fromSourceId) && (leftover.length || sourceReassignedAway || !variants.length)) {
            models.put({ ...original, variants: leftover,
              sourcePresent: leftover.length ? original.sourcePresent !== false : false,
              identitySupersededBy: assignments.map((item) => String(item.toSourceId)),
              updatedAt: new Date().toISOString() });
          }
        }
        for (const [skuKey, model] of affectedTargets) models.put(model);
        const factsBySource = new Map(facts.map((record) => [String(record.sourceId || ''), record]));
        const factsMovesByTarget = new Map();
        for (const move of moveByGeneration.values()) {
          const sourceFacts = factsBySource.get(move.fromSourceId);
          if (!sourceFacts || String(sourceFacts.generationId || '') !== move.generationId
            || (move.outputHash && String(sourceFacts.outputHash || '').toLowerCase() !== String(move.outputHash).toLowerCase())) continue;
          const candidates = factsMovesByTarget.get(move.toSourceId) || [];
          candidates.push({ record: sourceFacts, move });
          factsMovesByTarget.set(move.toSourceId, candidates);
        }
        const factsSourcesToDelete = new Set();
        for (const [targetId, incoming] of factsMovesByTarget) {
          const targetExisting = factsBySource.get(targetId) || null;
          const targetModel = affectedTargets.get(targetId) || catalogById.get(targetId) || {};
          const preferredGenerationId = String(targetModel.latestReadyGenerationId || targetModel.currentGenerationId || '');
          const candidates = [
            ...(targetExisting ? [{ record: targetExisting, move: null, existing: true }] : []),
            ...incoming.map((item) => ({ ...item, existing: false }))
          ];
          const preferred = preferredGenerationId
            ? candidates.find((item) => String(item.record.generationId || '') === preferredGenerationId)
            : null;
          // A current target fact row is already the active per-SKU projection.
          // Otherwise select a pointer-matching incoming row, or the sole
          // candidate. Ambiguous collisions are archived instead of being
          // resolved by iteration order.
          const winner = preferred || (targetExisting
            ? candidates.find((item) => item.existing)
            : candidates.length === 1 ? candidates[0] : null);
          for (const candidate of candidates) {
            const { record, move, existing } = candidate;
            const isWinner = candidate === winner;
            if (isWinner) {
              factsStore.put({ ...record, sourceId: targetId,
                originSourceId: record.originSourceId || move?.originSourceId || move?.fromSourceId || targetId,
                identityMigrationBackupId: id, updatedAt: new Date().toISOString() });
              if (move && move.fromSourceId !== targetId) result.movedFactsRows += 1;
              continue;
            }
            const quarantineId = `facts\u0000${String(record.generationId || '')}\u0000${String(record.sourceId || '')}\u0000${targetId}`;
            quarantines.put({ quarantineId, recordType: 'facts', reason: 'facts-target-collision',
              sourceId: String(record.sourceId || ''), fromSourceId: String(record.sourceId || ''),
              toSourceId: targetId, generationId: String(record.generationId || '') || null,
              outputHash: record.outputHash || null, recordSnapshot: record,
              evidence: move?.evidence || [], version: 1, recordedAt: new Date().toISOString() });
            result.quarantined += 1;
          }
          for (const candidate of incoming) {
            if (candidate.move.fromSourceId !== targetId) factsSourcesToDelete.add(candidate.move.fromSourceId);
          }
        }
        // Do not delete a source row that is itself the selected target winner
        // for another target. Deletions happen after all groups are resolved.
        const keptSources = new Set([...factsMovesByTarget.keys()].filter((targetId) => factsBySource.has(targetId)));
        for (const sourceId of factsSourcesToDelete) {
          if (!keptSources.has(sourceId)) factsStore.delete(sourceId);
        }
        for (const move of moveByGeneration.values()) {
          const journal = normalizeOutputRecoveryRecord(outputRecovery.find((row) => String(row.generationId || '') === move.generationId));
          if (!journal || journal.sourceId !== move.fromSourceId) continue;
          const fileVerification = journal.fileVerification
            ? { ...journal.fileVerification, sourceId: move.toSourceId }
            : null;
          const migratedJournal = {
            ...journal,
            sourceId: move.toSourceId,
            originSourceId: journal.originSourceId || move.originSourceId || move.fromSourceId,
            identityMigrationBackupId: id,
            ...(journal.state === OUTPUT_RECOVERY_STATES.REVISION_REGISTERED
              ? { revision: { generationId: move.generationId, sourceId: move.toSourceId,
                outputPath: journal.outputPath, outputHash: journal.outputHash } }
              : {}),
            ...(fileVerification ? { fileVerification } : {}),
            updatedAt: new Date().toISOString()
          };
          recoveryStore.put(migratedJournal);
        }
        const quarantineRows = Array.isArray(plan.quarantined) ? plan.quarantined : [];
        for (const item of quarantineRows) {
          const generationId = String(item?.generationId || '');
          const sourceId = String(item?.fromSourceId || item?.sourceId || '');
          if (!sourceId) continue;
          const revision = generationId ? revisionById.get(generationId) : null;
          if (revision && String(revision.sourceId || '') === sourceId
            && (!item.outputHash || String(revision.outputHash || '').toLowerCase() === String(item.outputHash).toLowerCase())) {
            const quarantinedRevision = { ...revision, identityQuarantined: {
              version: 1, reason: String(item.reason || 'ambiguous_identity'),
              evidence: Array.isArray(item.evidence) ? item.evidence : [],
              quarantineId: `${generationId}\u0000${sourceId}`,
              recordedAt: new Date().toISOString()
            } };
            revisionsStore.put(quarantinedRevision);
            revisionById.set(generationId, quarantinedRevision);
          }
          const sourceModel = catalogById.get(sourceId);
          if (sourceModel && ['catalog', 'catalog-variant'].includes(String(item.recordType || ''))) {
            const variantKey = String(item.variantKey || '');
            const variants = (sourceModel.variants || []).map((variant) => identityVariantKeyForMigration(variant) === variantKey && variantKey
              ? { ...variant, identityQuarantined: { version: 1, reason: String(item.reason || 'ambiguous_identity'), evidence: item.evidence || [] } }
              : variant);
            models.put({ ...sourceModel, variants,
              identityQuarantined: variantKey ? sourceModel.identityQuarantined || null : {
                version: 1, reason: String(item.reason || 'ambiguous_identity'), evidence: item.evidence || []
              }, updatedAt: new Date().toISOString() });
          }
          const quarantineId = `${String(item.recordType || 'record')}\u0000${generationId}\u0000${sourceId}\u0000${String(item.variantKey || '')}`;
          quarantines.put({ ...item, quarantineId, generationId: generationId || null,
            sourceId, version: 1, recordedAt: item.recordedAt || new Date().toISOString() });
          result.quarantined += 1;
        }
        result.catalogAssignments = [...affectedTargets.keys()];
        } catch (error) {
          result.error = error?.message || String(error);
          try { tx.abort(); } catch (_) {}
        }
      };
      for (const request of [catalogRequest, revisionsRequest, factsRequest, recoveryRequest, backupRequest, quarantineRequest]) {
        request.onsuccess = commit;
        request.onerror = () => tx.abort();
      }
      return result;
    }, 'Explicit identity migration', 60000);
  } finally { db.close(); }
}

export async function deleteGenerationFacts(sourceId) {
  if (!sourceId) return;
  const db = await openDb();
  try {
    await transactionResult(db, FACTS_STORE, (tx) => {
      tx.objectStore(FACTS_STORE).delete(String(sourceId));
      return null;
    }, 'Generation facts delete');
  } finally { db.close(); }
}

// One row is one immutable physical generation. Image identity fields are
// written when the PNG is verified; OCR fields are merged into the same row.
// The read-modify-write happens in one IndexedDB transaction so gallery never
// observes a half-updated image/facts/chat tuple.
export async function upsertGenerationRevision(record, { rejectIfReviewed = false } = {}) {
  if (!record?.generationId) throw new Error('Generation revision generationId is required');
  if (!record?.sourceId) throw new Error('Generation revision sourceId is required');
  const db = await openDb();
  try {
    let merged = null;
    await transactionResult(db, REVISION_STORE, (tx) => {
      const store = tx.objectStore(REVISION_STORE);
      const key = String(record.generationId);
      const get = store.get(key);
      get.onsuccess = () => {
        const previous = get.result || {};
        if (rejectIfReviewed && previous.reviewStatus === 'rejected') {
          merged = previous;
          return;
        }
        if ((previous.sourceId && String(previous.sourceId) !== String(record.sourceId || ''))
          || (previous.factsJobId && record.factsJobId
            && String(previous.factsJobId) !== String(record.factsJobId))) {
          merged = previous;
          return;
        }
        if (previous.factsStatus === 'ok' && previous.facts?.status === 'ok'
          && record.factsStatus !== 'ok') {
          merged = previous;
          return;
        }
        merged = {
          ...previous,
          ...record,
          generationId: key,
          sourceId: String(record.sourceId || previous.sourceId || ''),
          createdAt: previous.createdAt || record.createdAt || new Date().toISOString(),
          updatedAt: record.updatedAt || new Date().toISOString()
        };
        store.put(merged);
      };
      return null;
    }, 'Generation revision write');
    return merged;
  } finally { db.close(); }
}

export async function getGenerationRevision(generationId) {
  if (!generationId) return null;
  const db = await openDb();
  try {
    let revision = null;
    await transactionResult(db, REVISION_STORE, (tx) => {
      const req = tx.objectStore(REVISION_STORE).get(String(generationId));
      req.onsuccess = () => { revision = req.result || null; };
      return null;
    }, 'Generation revision read', undefined, 'readonly');
    return revision;
  } finally { db.close(); }
}

export async function getAllGenerationRevisions() {
  const db = await openDb();
  try {
    let revisions = [];
    await transactionResult(db, REVISION_STORE, (tx) => {
      const req = tx.objectStore(REVISION_STORE).getAll();
      req.onsuccess = () => { revisions = req.result || []; };
      return null;
    }, 'Generation revisions read', undefined, 'readonly');
    return revisions;
  } finally { db.close(); }
}

// A result package becomes visible as a single catalog/revision/facts commit.
export async function mergeResultsDatabase(plan) {
  const db = await openDb();
  try {
    return await transactionResult(db, [REVISION_STORE, MODEL_STORE, FACTS_STORE], (tx) => {
      const revisions = tx.objectStore(REVISION_STORE);
      const models = tx.objectStore(MODEL_STORE);
      const facts = tx.objectStore(FACTS_STORE);
      for (const revision of plan.revisions) revisions.put(revision);
      const byId = new Map(plan.revisions.map((revision) => [revision.generationId, revision]));
      for (const model of plan.models) {
        models.put(model);
        const revision = byId.get(model.latestReadyGenerationId);
        if (revision?.factsStatus === 'ok') facts.put({ ...revision.facts, sourceId: model.skuKey, updatedAt: new Date().toISOString() });
      }
      return { revisions: plan.revisions.length, models: plan.models.length };
    }, 'Results import write', 60000);
  } finally { db.close(); }
}

export async function getGenerationRevisionsForSource(sourceId) {
  if (!sourceId) return [];
  const db = await openDb();
  try {
    let revisions = [];
    await transactionResult(db, REVISION_STORE, (tx) => {
      const req = tx.objectStore(REVISION_STORE).index('sourceId').getAll(String(sourceId));
      req.onsuccess = () => { revisions = req.result || []; };
      return null;
    }, 'Generation revisions read', undefined, 'readonly');
    return revisions;
  } finally { db.close(); }
}
