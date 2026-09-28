export const DB_NAME = 'watch-card-automation';
export const DB_VERSION = 6;
export const STORE = 'assets';
export const HANDLE_STORE = 'handles';
export const FACTS_STORE = 'generationFacts';
export const REVISION_STORE = 'generationRevisions';
export const MODEL_STORE = 'modelCatalog';
export const OUTPUT_DIRECTORY_HANDLE_KEY = 'output-directory';
export const GALLERY_DIRECTORY_HANDLE_KEY = 'gallery-directory';
// A folder can contain several thousand high-resolution source images. Keep
// each IndexedDB transaction small so one large folder cannot time out or
// exhaust the renderer's temporary transaction memory.
const ASSET_BATCH_SIZE = 32;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionResult(db, stores, run, errorLabel) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    let value;
    try { value = run(tx); } catch (error) { tx.abort(); reject(error); return; }
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error(`${errorLabel} failed`));
    tx.onabort = () => reject(tx.error || new Error(`${errorLabel} aborted`));
  });
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
      request.onerror = () => { throw request.error || new Error('Catalog read failed'); };
      return result;
    }, 'Catalog write');
  } finally { db.close(); }
}

export async function getAllModelCatalog({ includeRemoved = false } = {}) {
  const db = await openDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(MODEL_STORE, 'readonly');
      const request = tx.objectStore(MODEL_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return includeRemoved ? rows : rows.filter((item) => item.sourcePresent !== false);
  } finally { db.close(); }
}

export async function getModelCatalog(skuKey) {
  if (!skuKey) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MODEL_STORE, 'readonly');
      const request = tx.objectStore(MODEL_STORE).get(String(skuKey));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
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
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([MODEL_STORE, REVISION_STORE, FACTS_STORE], 'readwrite');
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
      tx.oncomplete = () => resolve({ adopted, ready });
      tx.onerror = () => reject(tx.error || new Error('Legacy revision migration failed'));
      tx.onabort = () => reject(tx.error || new Error('Legacy revision migration aborted'));
    });
  } finally { db.close(); }
}

// Set the current attempt before Send. This pointer prevents late OCR or a
// slower older worker from replacing the active projection of a newer run.
export async function beginGenerationRevision(record) {
  if (!record?.generationId || !record?.sourceId) throw new Error('Generation identity is required');
  const db = await openDb();
  try {
    const result = await transactionResult(db, [MODEL_STORE, REVISION_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const key = String(record.sourceId);
      const generationKey = String(record.generationId);
      const result = {};
      const modelRequest = models.get(key);
      const revisionRequest = revisions.get(generationKey);
      let modelReady = false;
      let revisionReady = false;
      const commit = () => {
        if (!modelReady || !revisionReady) return;
        const model = modelRequest.result || { skuKey: key, sourceId: key, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if (previous.sourceId && String(previous.sourceId) !== key) {
          Object.assign(result, { ...previous, identityConflict: true });
          return;
        }
        if (previous.outputPath && previous.outputHash && previous.status === 'READY') {
          Object.assign(result, { ...previous, alreadyComplete: true });
          return;
        }
        Object.assign(result, {
          ...previous, ...record, generationId: generationKey, sourceId: key,
          createdAt: previous.createdAt || record.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(), status: 'GENERATING'
        });
        revisions.put(result);
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
      modelRequest.onerror = revisionRequest.onerror = () => { throw modelRequest.error || revisionRequest.error; };
      return result;
    }, 'Generation start write');
    if (result.identityConflict) throw new Error('Generation ID is already bound to another SKU');
    if (result.alreadyComplete) throw new Error('Generation ID already has a verified complete image');
    return result;
  } finally { db.close(); }
}

// A preparation cancelled before the physical Send must not leave the catalog
// pointing at a phantom GENERATING revision. The audit row is retained.
export async function cancelUnsubmittedGenerationRevision(generationId, sourceId, reason = 'cancelled_before_send') {
  if (!generationId || !sourceId) return { cancelled: false };
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const revisionRequest = revisions.get(String(generationId));
      const modelRequest = models.get(String(sourceId));
      const result = { cancelled: false };
      let revisionReady = false;
      let modelReady = false;
      const commit = () => {
        if (!revisionReady || !modelReady) return;
        const revision = revisionRequest.result;
        const model = modelRequest.result;
        if (!revision || String(revision.sourceId) !== String(sourceId)
          || revision.outputPath || revision.outputHash
          || !['GENERATING', 'PENDING'].includes(String(revision.status || ''))) return;
        const cancelledAt = new Date().toISOString();
        revisions.put({ ...revision, status: 'CANCELLED', cancellationReason: reason,
          cancelledAt, updatedAt: cancelledAt });
        result.cancelled = true;
        if (!model || String(model.currentGenerationId || '') !== String(generationId)) return;
        const previousGenerationId = revision.previousGenerationId || model.latestReadyGenerationId || null;
        const withVariant = catalogWithVariantState(model, revision.sourceVariantId, {
          status: 'pending', generationId: previousGenerationId, lastError: null
        });
        models.put({ ...withVariant, currentGenerationId: previousGenerationId,
          generationStatus: model.latestReadyGenerationId ? 'READY' : 'NOT_READY',
          queueState: { ...(model.queueState || {}), status: 'pending',
            generationId: previousGenerationId, lastError: null }, updatedAt: cancelledAt });
      };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      return result;
    }, 'Cancel unsubmitted generation');
  } finally { db.close(); }
}

export async function persistGenerationImageRevision(record) {
  if (!record?.generationId || !record?.sourceId || !record?.outputPath || !record?.outputHash) {
    throw new Error('Verified image revision identity is incomplete');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(record.outputHash))) throw new Error('Verified PNG SHA-256 is invalid');
  const db = await openDb();
  try {
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const skuKey = String(record.sourceId);
      const generationKey = String(record.generationId);
      const modelRequest = models.get(skuKey);
      const revisionRequest = revisions.get(generationKey);
      const result = { current: false, matched: false };
      let modelReady = false;
      let revisionReady = false;
      const commit = () => {
        if (!modelReady || !revisionReady) return;
        const model = modelRequest.result || { skuKey, sourceId: skuKey, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if ((previous.sourceId && String(previous.sourceId) !== skuKey)
          || (previous.factsJobId && String(previous.factsJobId) !== String(record.factsJobId || ''))) return;
        if (previous.outputPath && previous.outputHash
          && (String(previous.outputPath) !== String(record.outputPath)
            || String(previous.outputHash).toLowerCase() !== String(record.outputHash).toLowerCase())) return;
        result.matched = true;
        const factsCandidate = record.facts || previous.facts || null;
        const factsReady = record.factsStatus === 'ok' && factsCandidate?.status === 'ok'
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
          facts: boundFacts || factsCandidate,
          status: factsReady ? 'READY' : 'FACTS_PENDING', updatedAt: new Date().toISOString() };
        revisions.put(merged);
        result.current = String(model.currentGenerationId || '') === generationKey;
        if (result.current) {
          if (factsReady) factsStore.put({ ...boundFacts,
            updatedAt: boundFacts.extractedAt || new Date().toISOString() });
          const withVariant = catalogWithVariantState(model, record.sourceVariantId, {
            status: 'done', generationId: generationKey, outputPath: record.outputPath,
            outputHash: record.outputHash, sourceHash: record.sourceHash || null,
            recipeHash: record.recipeHash || null,
            factsStatus: factsReady ? 'ok' : 'pending', lastError: null
          });
          models.put({ ...withVariant, generationStatus: merged.status, currentOutputPath: record.outputPath,
            currentOutputHash: record.outputHash,
            latestReadyGenerationId: factsReady ? generationKey : model.latestReadyGenerationId || null,
            queueState: { ...(model.queueState || {}), status: 'done', generationId: generationKey,
              recipeHash: record.recipeHash || model.queueState?.recipeHash || null, lastError: null },
            updatedAt: new Date().toISOString() });
        }
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      modelRequest.onerror = revisionRequest.onerror = () => { throw modelRequest.error || revisionRequest.error; };
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
    return await transactionResult(db, [MODEL_STORE, REVISION_STORE, FACTS_STORE], (tx) => {
      const models = tx.objectStore(MODEL_STORE);
      const revisions = tx.objectStore(REVISION_STORE);
      const factsStore = tx.objectStore(FACTS_STORE);
      const skuKey = String(record.sourceId);
      const generationKey = String(record.generationId);
      let modelReady = false;
      let revisionReady = false;
      const result = { latest: false, matched: false };
      const modelRequest = models.get(skuKey);
      const revisionRequest = revisions.get(generationKey);
      const commit = () => {
        if (!modelReady || !revisionReady) return;
        const model = modelRequest.result || { skuKey, sourceId: skuKey, sourcePresent: true, variants: [] };
        const previous = revisionRequest.result || {};
        if (previous.reviewStatus === 'rejected'
          || (previous.sourceId && String(previous.sourceId) !== skuKey)
          || String(previous.factsJobId || '') !== String(record.factsJobId || '')) return;
        if (previous.factsStatus === 'ok' && previous.facts?.status === 'ok') {
          result.matched = true;
          result.latest = String(model.currentGenerationId || '') === generationKey
            && Boolean(previous.outputPath && /^[a-f0-9]{64}$/i.test(String(previous.outputHash || '')));
          result.duplicate = true;
          return;
        }
        result.matched = true;
        const imageVerified = Boolean(previous.outputPath && /^[a-f0-9]{64}$/i.test(String(previous.outputHash || '')));
        if (record.facts.outputHash && previous.outputHash
          && String(record.facts.outputHash) !== String(previous.outputHash)) return;
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
        result.latest = String(model.currentGenerationId || '') === generationKey && imageVerified;
        if (result.latest) {
          factsStore.put({ ...boundFacts, updatedAt: boundFacts.extractedAt || new Date().toISOString() });
          const withVariant = catalogWithVariantState(model, record.sourceVariantId, {
            status: 'done', generationId: generationKey, factsStatus: 'ok', lastError: null
          });
          models.put({ ...withVariant, latestReadyGenerationId: generationKey,
            generationStatus: 'READY',
            queueState: { ...(model.queueState || {}), status: 'done', generationId: generationKey,
              recipeHash: record.recipeHash || model.queueState?.recipeHash || null, lastError: null },
            updatedAt: new Date().toISOString() });
        }
      };
      modelRequest.onsuccess = () => { modelReady = true; commit(); };
      revisionRequest.onsuccess = () => { revisionReady = true; commit(); };
      modelRequest.onerror = revisionRequest.onerror = () => { throw modelRequest.error || revisionRequest.error; };
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
            generationStatus: current ? 'NOT_READY' : model.generationStatus,
            queueState: current ? { ...(model.queueState || {}), status: 'pending', generationId: null } : model.queueState,
            updatedAt: new Date().toISOString() });
          }
        };
      };
      revisionRequest.onerror = () => { throw revisionRequest.error; };
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const entry of entries) store.put(assetRecord(entry));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function deleteAssetKeys(keys = []) {
  for (let index = 0; index < keys.length; index += ASSET_BATCH_SIZE * 4) {
    const batch = keys.slice(index, index + ASSET_BATCH_SIZE * 4);
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const key of batch) store.delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
      });
    } finally {
      db.close();
    }
  }
}

export async function getAsset(key) {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function getAssetKeys(prefix = '') {
  const db = await openDb();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return keys.filter((key) => String(key).startsWith(prefix));
}


export async function getAssetMetadata(prefix = '') {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      const items = new Map();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
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
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function replaceAssets(prefix, entries = []) {
  const existing = await getAssetMetadata(prefix);
  const desired = new Map(entries.map((entry) => [String(entry.key), entry]));
  const changed = [];

  for (const entry of entries) {
    const key = String(entry.key);
    const file = entry.file;
    const previous = existing.get(key);
    const relativePath = entry.relativePath || file?.webkitRelativePath || file?.name || '';
    const unchanged = previous
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


export async function putOutputDirectoryHandle(handle) {
  if (!handle) throw new Error('Output directory handle is required');
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put({ key: OUTPUT_DIRECTORY_HANDLE_KEY, handle, updatedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB handle write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB handle write aborted'));
    });
  } finally { db.close(); }
}

export async function getOutputDirectoryHandle() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(OUTPUT_DIRECTORY_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result?.handle || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}


export async function putGalleryDirectoryHandle(handle) {
  if (!handle) throw new Error('Gallery directory handle is required');
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put({ key: GALLERY_DIRECTORY_HANDLE_KEY, handle, updatedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB gallery handle write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB gallery handle write aborted'));
    });
  } finally { db.close(); }
}

export async function getGalleryDirectoryHandle() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(GALLERY_DIRECTORY_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result?.handle || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}


export async function putGenerationFacts(record) {
  if (!record?.sourceId) throw new Error('Generation facts sourceId is required');
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACTS_STORE, 'readwrite');
      tx.objectStore(FACTS_STORE).put({
        ...record,
        sourceId: String(record.sourceId),
        updatedAt: record.updatedAt || new Date().toISOString()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB generation facts write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB generation facts write aborted'));
    });
  } finally { db.close(); }
}

export async function getGenerationFacts(sourceId) {
  if (!sourceId) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FACTS_STORE, 'readonly');
      const req = tx.objectStore(FACTS_STORE).get(String(sourceId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function getAllGenerationFacts() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FACTS_STORE, 'readonly');
      const req = tx.objectStore(FACTS_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function deleteGenerationFacts(sourceId) {
  if (!sourceId) return;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACTS_STORE, 'readwrite');
      tx.objectStore(FACTS_STORE).delete(String(sourceId));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB generation facts delete failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB generation facts delete aborted'));
    });
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
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(REVISION_STORE, 'readwrite');
      const store = tx.objectStore(REVISION_STORE);
      const key = String(record.generationId);
      let merged = null;
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
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB generation revision write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB generation revision write aborted'));
    });
  } finally { db.close(); }
}

export async function getGenerationRevision(generationId) {
  if (!generationId) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(REVISION_STORE, 'readonly');
      const req = tx.objectStore(REVISION_STORE).get(String(generationId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function getAllGenerationRevisions() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(REVISION_STORE, 'readonly');
      const req = tx.objectStore(REVISION_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function getGenerationRevisionsForSource(sourceId) {
  if (!sourceId) return [];
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(REVISION_STORE, 'readonly');
      const req = tx.objectStore(REVISION_STORE).index('sourceId').getAll(String(sourceId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
