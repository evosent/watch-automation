import { modelCodeFromName, normalizeBrandId, normalizeSkuCode } from './sku-utils.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const IMAGE_ATTEMPT_STATUSES = new Set(['GENERATING', 'PENDING', 'RUNNING', 'SUBMITTING']);
const FACTS_ATTEMPT_STATUSES = new Set(['FACTS_RUNNING', 'FACTS_EXTRACTING', 'POSTPROCESSING']);

function text(value) { return String(value ?? '').trim(); }
function lower(value) { return text(value).toLowerCase(); }
function timestamp(value) { return Date.parse(value || '') || 0; }

function lookup(container, key) {
  if (!container || !key) return undefined;
  if (container instanceof Map) return container.get(String(key));
  if (Array.isArray(container)) return container.find((item) => (
    String(item?.generationId || '') === String(key)
    || String(item?.sourceId || '') === String(key)
  ));
  return container[String(key)];
}

function factForRevision(revision, facts) {
  if (revision?.facts && typeof revision.facts === 'object') return revision.facts;
  const byGeneration = lookup(facts, revision?.generationId);
  if (byGeneration && String(byGeneration.generationId || '') === String(revision?.generationId || '')) return byGeneration;
  const bySource = lookup(facts, revision?.sourceId);
  if (bySource && String(bySource.generationId || '') === String(revision?.generationId || '')) return bySource;
  return null;
}

function factsMatchRevision(revision, facts) {
  if (!revision || !facts || revision.factsStatus !== 'ok' || facts.status !== 'ok') return false;
  const generationId = text(revision.generationId);
  const factsJobId = text(revision.factsJobId);
  const outputHash = lower(revision.outputHash);
  return Boolean(generationId && factsJobId && HASH_PATTERN.test(outputHash)
    && String(facts.generationId || '') === generationId
    && String(facts.factsJobId || '') === factsJobId
    && lower(facts.outputHash) === outputHash);
}

function normalizedConversationUrl(value) {
  try {
    const url = new URL(text(value));
    if (url.origin !== 'https://chatgpt.com') return null;
    const match = url.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? `${url.origin}/c/${match[1]}` : null;
  } catch (_) {
    return null;
  }
}

function validConversationUrl(value) { return Boolean(normalizedConversationUrl(value)); }

function factsChatBindingConsistent(revision, facts) {
  const revisionChatUrl = text(revision?.chatUrl);
  const factsChatUrl = text(facts?.chatUrl);
  const revisionUrl = normalizedConversationUrl(revision?.chatUrl);
  const factsUrl = normalizedConversationUrl(facts?.chatUrl);
  if ((revisionChatUrl && !revisionUrl) || (factsChatUrl && !factsUrl)) return false;
  if (revisionUrl && factsUrl && revisionUrl !== factsUrl) return false;
  return true;
}

function factsChatBindingAvailable(revision, facts) {
  return Boolean(normalizedConversationUrl(revision?.chatUrl) || normalizedConversationUrl(facts?.chatUrl));
}

function factsProveAttemptWithoutRegisteredImage(revision, facts) {
  const generationId = text(revision?.generationId);
  const factsJobId = text(revision?.factsJobId);
  return Boolean(revision && generationId && factsJobId
    && String(revision.status || '').toUpperCase() === 'FACTS_WAITING_IMAGE'
    && revision.factsStatus === 'ok'
    && !hasImage(revision)
    && facts?.status === 'ok'
    && String(facts.generationId || '') === generationId
    && String(facts.factsJobId || '') === factsJobId
    && factsChatBindingConsistent(revision, facts)
    && factsChatBindingAvailable(revision, facts));
}

function hasImage(revision) {
  return Boolean(text(revision?.generationId) && text(revision?.outputPath)
    && HASH_PATTERN.test(text(revision?.outputHash)));
}

function artifactCheckFor(revision, checks) {
  const check = lookup(checks, revision?.generationId);
  if (!check || typeof check !== 'object') {
    return { status: 'UNKNOWN', verified: false, exists: null, hashMatches: null, checkedAt: null, reason: 'check_missing' };
  }
  // Access/permission failures mean the result could not be inspected. They
  // must never be interpreted as evidence that the artifact was lost.
  // The verifier marks a confirmed ENOENT/file_missing response with
  // exists:false + verified:true. Handle that before its descriptive error;
  // access failures carry exists:null and remain unknown.
  if (check.exists === false && check.verified === true) {
    return { ...check, status: 'MISSING', verified: false, reason: 'file_missing' };
  }
  if (check.error || check.errorCode === 'EACCES' || check.errorCode === 'EPERM') {
    return { ...check, status: 'UNKNOWN', verified: false, reason: 'check_failed' };
  }
  const expectedHash = lower(revision?.outputHash);
  const observedHashes = [check.sha256, check.actualHash, check.outputHash]
    .map(lower).filter(Boolean);
  const observedHashMismatch = observedHashes.some((hash) => hash !== expectedHash);
  const expectedPath = normalizeArtifactPath(revision?.outputPath);
  const observedPaths = [check.path, check.outputPath, check.checkedPath].map(normalizeArtifactPath).filter(Boolean);
  const observedPathMismatch = observedPaths.some((path) => path !== expectedPath);
  if (check.exists === false) return { ...check, status: 'UNKNOWN', verified: false, reason: 'unconfirmed_missing' };
  if (check.valid === false || check.pngValid === false || observedHashMismatch || observedPathMismatch
    || check.hashMatches === false) {
    const reason = check.valid === false || check.pngValid === false ? 'invalid_image'
      : observedPathMismatch ? 'path_mismatch' : 'hash_mismatch';
    return { ...check, status: 'MISMATCH', verified: false, hashMatches: false, reason };
  }
  if (check.verified === false) {
    return { ...check, status: 'UNKNOWN', verified: false, reason: 'verification_incomplete' };
  }
  // A positive boolean is not enough: accept only a live check that reports
  // the exact bytes and exact path for this immutable revision. This prevents
  // stale metadata or a UI-level `hashMatches` flag from proving readiness.
  const hashEvidenceMatches = observedHashes.length > 0 && observedHashes.every((hash) => hash === expectedHash);
  const pathEvidenceMatches = observedPaths.length > 0 && observedPaths.every((path) => path === expectedPath);
  if (check.exists === true && hashEvidenceMatches && pathEvidenceMatches && expectedPath) {
    return { ...check, status: 'VERIFIED', verified: true, hashMatches: true, reason: null };
  }
  return { ...check, status: 'UNKNOWN', verified: false, reason: check.verified === false ? 'verification_incomplete' : 'hash_or_path_unverified' };
}

function normalizeArtifactPath(value) {
  return text(value).replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isExplicitArtifactFailure(check) {
  return check?.status === 'MISSING' || check?.status === 'MISMATCH';
}

function brandFrom(model, skuKey) {
  return normalizeBrandId(model?.brandId || text(skuKey).split(':', 1)[0] || 'generic');
}

// Reuse the shared identity parser. This evidence detects key collisions; it
// never changes or migrates a stored SKU.
export function modelCodeEvidence(value) {
  return modelCodeFromName(value) || '';
}

function normalizedName(value) {
  return String(value || '').normalize('NFKC').replace(/\.(?:png|jpe?g|webp|bmp|tiff?)$/i, '')
    .toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function identityValues(model = {}) {
  const values = [];
  for (const key of ['canonicalModelCode', 'fullModelCode', 'modelCode', 'titleModel', 'modelName']) {
    if (text(model[key])) values.push({ value: text(model[key]), explicit: ['canonicalModelCode', 'fullModelCode', 'modelCode'].includes(key) });
  }
  for (const variant of Array.isArray(model.variants) ? model.variants : []) {
    for (const key of ['canonicalModelCode', 'fullModelCode', 'modelCode', 'modelName', 'fileName']) {
      if (text(variant?.[key])) values.push({ value: text(variant[key]), explicit: ['canonicalModelCode', 'fullModelCode', 'modelCode'].includes(key) });
    }
  }
  return values;
}

function identitySignature(value, explicit, brand) {
  const code = modelCodeEvidence(value);
  if (code) return `${brand}:${code}`;
  if (explicit) {
    const compact = normalizeSkuCode(value);
    if (compact.length >= 4) return `${brand}:${compact}`;
  }
  const name = normalizedName(value);
  return name ? `${brand}:name:${name}` : '';
}

function scopeEntry(entry, scope) {
  if (scope?.sourceIds && !new Set([...scope.sourceIds].map(String)).has(entry.skuKey)) return false;
  if (scope?.brandId && scope.brandId !== 'all' && lower(entry.model?.brandId || entry.brandId) !== lower(scope.brandId)) return false;
  if (scope?.groupId && scope.groupId !== 'all' && !entry.groupIds.includes(String(scope.groupId))) return false;
  const expectedSale = scope?.saleStatus && scope.saleStatus !== 'all'
    ? (scope.saleStatus === 'in_sale' ? 'in_sale' : 'not_in_sale')
    : null;
  const expectedQuality = scope?.quality && scope.quality !== 'all'
    ? (scope.quality === 'good' ? '_good' : '_bad')
    : null;
  if ((expectedSale || expectedQuality) && !entry.groupIds.some((group) => (
    (!expectedSale || group.startsWith(expectedSale))
    && (!expectedQuality || group.endsWith(expectedQuality))
  ))) return false;
  return true;
}

function isAttemptActive(revision) {
  const status = text(revision?.status).toUpperCase();
  return IMAGE_ATTEMPT_STATUSES.has(status) || FACTS_ATTEMPT_STATUSES.has(status);
}

function revisionFor(model, byGenerationId, pointerName) {
  const id = text(model?.[pointerName]);
  return id ? byGenerationId.get(id) || null : null;
}

function chooseTimestampNewest(records) {
  return [...records].sort((left, right) => (
    timestamp(right.updatedAt || right.completedAt || right.downloadedAt || right.createdAt)
      - timestamp(left.updatedAt || left.completedAt || left.downloadedAt || left.createdAt)
    || text(right.generationId).localeCompare(text(left.generationId))
  ))[0] || null;
}

/**
 * Build a read-only, canonical readiness snapshot from the persistent catalog
 * and immutable revisions. `artifactChecks` must contain an explicit check for
 * the exact generation and output hash; file paths and stored hashes alone do
 * not prove that the PNG still exists.
 */
export function projectCanonicalAccounting({
  catalog = [], revisions = [], facts = [], artifactChecks = {}, outputRecovery = [], scope = {}, liveGenerationIds
} = {}) {
  const liveIds = liveGenerationIds === undefined
    ? null
    : new Set([...liveGenerationIds].map(String));
  const modelsBySku = new Map();
  for (const model of catalog || []) {
    const skuKey = text(model?.skuKey || model?.sourceId);
    if (!skuKey) continue;
    const rows = modelsBySku.get(skuKey) || [];
    rows.push(model);
    modelsBySku.set(skuKey, rows);
  }

  const revisionsBySku = new Map();
  const byGenerationId = new Map();
  for (const revision of revisions || []) {
    const generationId = text(revision?.generationId);
    if (generationId) byGenerationId.set(generationId, revision);
    const skuKey = text(revision?.sourceId || revision?.skuKey);
    if (!skuKey) continue;
    const rows = revisionsBySku.get(skuKey) || [];
    rows.push(revision);
    revisionsBySku.set(skuKey, rows);
  }

  const recoveryByGenerationId = new Map((outputRecovery || [])
    .filter((row) => row?.generationId)
    .map((row) => [String(row.generationId), row]));

  const entries = [];
  const bySku = new Map();
  for (const [skuKey, modelRows] of modelsBySku) {
    const model = modelRows[0];
    const brandId = brandFrom(model, skuKey);
    const evidence = [];
    for (const row of modelRows) evidence.push(...identityValues(row));
    for (const revision of revisionsBySku.get(skuKey) || []) {
      if (text(revision.modelName)) evidence.push({ value: text(revision.modelName), explicit: false });
      if (text(revision.facts?.titleModel)) evidence.push({ value: text(revision.facts.titleModel), explicit: false });
    }
    const identityCandidates = [...new Set(evidence.map((item) => identitySignature(item.value, item.explicit, brandId)).filter(Boolean))];
    const identityStatus = identityCandidates.length > 1 ? 'AMBIGUOUS' : 'OK';

    const latestReadyId = text(model.latestReadyGenerationId);
    const acceptedPointer = latestReadyId ? byGenerationId.get(latestReadyId) || null : null;
    const currentAttempt = revisionFor(model, byGenerationId, 'currentGenerationId');
    const currentGenerationId = text(model.currentGenerationId);
    const currentRecovery = currentGenerationId ? recoveryByGenerationId.get(currentGenerationId) || null : null;
    const identityQuarantine = modelRows.find((row) => row?.identityQuarantined)
      || modelRows.flatMap((row) => Array.isArray(row?.variants) ? row.variants : [])
        .find((variant) => variant?.identityQuarantined)
      || acceptedPointer?.identityQuarantined
      || currentAttempt?.identityQuarantined
      || null;
    const identityQuarantined = Boolean(identityQuarantine);
    const latestReadyMatchesSource = Boolean(acceptedPointer
      && String(acceptedPointer.sourceId || '') === skuKey);
    const latestIsRejected = Boolean(acceptedPointer?.reviewStatus === 'rejected');
    const replacementRequired = Boolean(model.replacementRequired === true || latestIsRejected);
    const retryRequired = Boolean(model.retryRequired === true);
    const savedFactsManualReview = Boolean(acceptedPointer?.factsManualReviewRequired === true
      || (currentAttempt?.factsManualReviewRequired === true
        && (!acceptedPointer || String(currentAttempt.generationId) === String(acceptedPointer.generationId))));

    const acceptedFacts = factForRevision(acceptedPointer, facts);
    const acceptedHasImage = latestReadyMatchesSource && hasImage(acceptedPointer);
    const acceptedArtifactCheck = acceptedHasImage ? artifactCheckFor(acceptedPointer, artifactChecks) : null;
    const acceptedArtifactVerified = Boolean(acceptedArtifactCheck?.verified);
    const acceptedFactsValid = acceptedHasImage && factsMatchRevision(acceptedPointer, acceptedFacts)
      && factsChatBindingConsistent(acceptedPointer, acceptedFacts);
    const acceptedTupleReady = Boolean(latestReadyMatchesSource && !latestIsRejected
      && acceptedPointer.status === 'READY' && acceptedFactsValid);
    const acceptedReady = Boolean(acceptedTupleReady && acceptedArtifactVerified && !replacementRequired);

    const currentAttemptMatchesSource = Boolean(currentAttempt
      && String(currentAttempt.sourceId || '') === skuKey
      && String(currentAttempt.generationId || '') === currentGenerationId);
    const explicitOutputPending = Boolean(currentAttemptMatchesSource
      && (currentAttempt.outputVerificationPending === true
        || String(currentAttempt.status || '').toUpperCase() === 'OUTPUT_VERIFICATION_PENDING'))
      || Boolean(currentGenerationId
        && String(model.generationStatus || '').toUpperCase() === 'OUTPUT_VERIFICATION_PENDING');
    const recoveryState = String(currentRecovery?.state || '').toLowerCase();
    const recoveryTuplePresent = Boolean(text(currentRecovery?.outputPath)
      && HASH_PATTERN.test(text(currentRecovery?.outputHash)));
    const recoveryJournalPending = Boolean(currentRecovery
      && (recoveryState === 'file_verified'
        || (recoveryState === 'attempt_started' && recoveryTuplePresent))
      && recoveryTuplePresent
      && String(currentRecovery.generationId || '') === currentGenerationId
      && String(currentRecovery.sourceId || '') === skuKey);
    const historicalFactsAwaitingImage = currentAttemptMatchesSource
      && factsProveAttemptWithoutRegisteredImage(currentAttempt, factForRevision(currentAttempt, facts));
    const outputRecoveryRequired = Boolean(explicitOutputPending || recoveryJournalPending || historicalFactsAwaitingImage);
    const outputRecoveryReason = explicitOutputPending || recoveryJournalPending
      ? 'output_registration_pending'
      : historicalFactsAwaitingImage ? 'output_registration_manual_review' : null;
    const outputRecoveryGenerationId = outputRecoveryRequired ? currentGenerationId : null;

    const currentFacts = factForRevision(currentAttempt, facts);
    const currentHasImage = String(currentAttempt?.sourceId || '') === skuKey && hasImage(currentAttempt)
      && currentAttempt.reviewStatus !== 'rejected';
    const currentArtifactCheck = currentHasImage ? artifactCheckFor(currentAttempt, artifactChecks) : null;
    const currentArtifactVerified = Boolean(currentArtifactCheck?.verified);
    const currentFactsValid = currentHasImage && factsMatchRevision(currentAttempt, currentFacts)
      && factsChatBindingConsistent(currentAttempt, currentFacts);
    const currentAttemptStatus = text(currentAttempt?.status).toUpperCase();
    const attemptLooksActive = isAttemptActive(currentAttempt);
    const attemptIsLive = attemptLooksActive
      && (liveIds === null || liveIds.has(String(currentAttempt?.generationId || '')));
    const acceptedFactsRepairable = Boolean(acceptedHasImage && acceptedArtifactVerified && !acceptedFactsValid
      && factsChatBindingConsistent(acceptedPointer, acceptedFacts)
      && factsChatBindingAvailable(acceptedPointer, acceptedFacts)
      && HASH_PATTERN.test(text(acceptedPointer?.outputHash))
      && !(attemptIsLive && String(currentAttempt?.generationId || '') !== String(acceptedPointer?.generationId || '')));

    let status = 'NOT_READY';
    let nextTask = 'generate';
    let statusReason = null;
    let actionRevision = null;
    if (identityQuarantined) {
      status = 'NEEDS_VERIFICATION';
      nextTask = null;
      statusReason = 'identity_quarantined';
    } else if (identityStatus === 'AMBIGUOUS') {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      statusReason = 'identity_collision';
    } else if (savedFactsManualReview) {
      status = 'NEEDS_VERIFICATION';
      nextTask = null;
      actionRevision = acceptedPointer || currentAttempt;
      statusReason = 'saved_image_binding_manual_review';
    } else if (acceptedReady) {
      status = 'READY';
      nextTask = null;
    } else if (outputRecoveryRequired && !acceptedFactsRepairable) {
      status = 'NEEDS_VERIFICATION';
      nextTask = null;
      actionRevision = currentAttemptMatchesSource ? currentAttempt : null;
      statusReason = outputRecoveryReason;
    } else if (acceptedPointer && latestIsRejected) {
      status = 'NOT_READY';
      nextTask = 'generate';
      statusReason = 'accepted_result_rejected';
    } else if (replacementRequired) {
      status = 'NOT_READY';
      nextTask = 'generate';
      statusReason = 'replacement_required';
    } else if (latestReadyId && (!acceptedPointer || !latestReadyMatchesSource)) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      statusReason = 'accepted_pointer_unresolved';
    } else if (acceptedHasImage && !acceptedArtifactVerified) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      actionRevision = acceptedPointer;
      statusReason = acceptedArtifactCheck?.reason || 'accepted_artifact_unverified';
    } else if (acceptedHasImage && acceptedArtifactVerified && !acceptedFactsValid) {
      if (!factsChatBindingConsistent(acceptedPointer, acceptedFacts)
        || !factsChatBindingAvailable(acceptedPointer, acceptedFacts)
        || !HASH_PATTERN.test(text(acceptedPointer?.outputHash))) {
        status = 'NEEDS_VERIFICATION';
        nextTask = null;
        actionRevision = acceptedPointer;
        statusReason = 'saved_image_binding_manual_review';
      } else if (attemptIsLive && String(currentAttempt?.generationId || '') !== String(acceptedPointer?.generationId || '')) {
        status = 'NEEDS_VERIFICATION';
        nextTask = null;
        actionRevision = acceptedPointer;
        statusReason = 'facts_conflict_with_live_attempt';
      } else {
        status = 'NEEDS_FACTS';
        nextTask = 'facts';
        actionRevision = acceptedPointer;
        statusReason = 'accepted_image_facts_incomplete';
      }
    } else if (acceptedHasImage && acceptedArtifactVerified && acceptedFactsValid) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      actionRevision = acceptedPointer;
      statusReason = 'accepted_pointer_not_ready';
    } else if (currentHasImage && !currentArtifactVerified) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      actionRevision = currentAttempt;
      statusReason = currentArtifactCheck?.reason || 'current_artifact_unverified';
    } else if (currentHasImage && currentArtifactVerified && !currentFactsValid) {
      if (!factsChatBindingConsistent(currentAttempt, currentFacts)
        || !factsChatBindingAvailable(currentAttempt, currentFacts)
        || !HASH_PATTERN.test(text(currentAttempt?.outputHash))) {
        status = 'NEEDS_VERIFICATION';
        nextTask = null;
        actionRevision = currentAttempt;
        statusReason = 'saved_image_binding_manual_review';
      } else {
        status = 'NEEDS_FACTS';
        nextTask = 'facts';
        actionRevision = currentAttempt;
        statusReason = 'current_image_facts_incomplete';
      }
    } else if (currentHasImage && currentArtifactVerified && currentFactsValid) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      actionRevision = currentAttempt;
      statusReason = 'complete_current_revision_unaccepted';
    } else if (currentAttempt && !hasImage(currentAttempt) && attemptIsLive) {
      nextTask = null;
      statusReason = 'attempt_active';
    } else if (latestReadyId && acceptedPointer && !acceptedHasImage) {
      status = 'NEEDS_VERIFICATION';
      nextTask = 'verify';
      statusReason = 'accepted_revision_missing_artifact';
    }

    // An active attempt is informational and never changes accepted readiness.
    // Keep the row schedulable only when it has reached an actionable stage.
    const activeAttempt = currentAttempt ? {
      generationId: currentAttempt.generationId,
      status: currentAttemptStatus || 'UNKNOWN',
      startedAt: currentAttempt.generationStartedAt || currentAttempt.createdAt || null,
      updatedAt: currentAttempt.updatedAt || currentAttempt.completedAt || null,
      outputPath: currentAttempt.outputPath || null,
      outputHash: currentAttempt.outputHash || null,
      factsJobId: currentAttempt.factsJobId || null,
      active: attemptIsLive,
      stale: attemptLooksActive && !attemptIsLive
    } : null;
    // The snapshot is a view, not a write model. Attach only the exact facts
    // row that passed generation/job/hash/chat binding so downstream consumers
    // (especially the gallery) see the same accepted tuple used by readiness.
    const acceptedRevision = latestReadyMatchesSource && !latestIsRejected
      ? (acceptedFactsValid && acceptedFacts !== acceptedPointer.facts
        ? { ...acceptedPointer, facts: acceptedFacts }
        : acceptedPointer)
      : null;
    const artifactVerification = acceptedArtifactCheck || currentArtifactCheck || {
      status: 'UNKNOWN', verified: false, exists: null, hashMatches: null, checkedAt: null, reason: 'no_artifact'
    };
    const actionRevisionTuple = actionRevision ? {
      generationId: text(actionRevision.generationId) || null,
      sourceId: text(actionRevision.sourceId) || null,
      factsJobId: text(actionRevision.factsJobId) || null,
      outputHash: text(actionRevision.outputHash) || null,
      outputPath: text(actionRevision.outputPath) || null,
      chatUrl: text(actionRevision.chatUrl || actionRevision.facts?.chatUrl) || null,
      imageUrlFingerprint: text(actionRevision.imageUrlFingerprint) || null,
      status: text(actionRevision.status) || null
    } : null;
    const verificationActionable = status === 'NEEDS_VERIFICATION'
      && (isExplicitArtifactFailure(acceptedArtifactCheck) || isExplicitArtifactFailure(currentArtifactCheck));
    const candidateActionable = nextTask === 'generate' || nextTask === 'facts' || verificationActionable;
    const entry = {
      skuKey,
      brandId,
      model,
      identityStatus,
      identityCandidates,
      identityQuarantined,
      identityQuarantine: identityQuarantine ? {
        reason: identityQuarantine.reason || 'ambiguous_identity',
        quarantineId: identityQuarantine.quarantineId || null,
        evidence: Array.isArray(identityQuarantine.evidence) ? identityQuarantine.evidence : []
      } : null,
      revisionCount: (revisionsBySku.get(skuKey) || []).length,
      status,
      statusReason,
      acceptedRevision,
      acceptedGenerationId: acceptedRevision?.generationId || null,
      actionRevision: actionRevisionTuple,
      artifactVerification,
      currentGenerationId: text(model.currentGenerationId) || null,
      activeAttempt,
      replacementRequired,
      retryRequired,
      outputRecoveryRequired,
      artifactRecoveryPending: outputRecoveryRequired,
      outputRecoveryReason,
      outputRecoveryGenerationId,
      sourcePresent: model.sourcePresent !== false,
      groupIds: [...new Set((model.variants || []).map((variant) => text(variant?.groupId)).filter(Boolean))],
      nextTask,
      candidateActionable
    };
    entries.push(entry);
    bySku.set(skuKey, entry);
  }

  const selected = entries.filter((entry) => scopeEntry(entry, scope));
  const countsFor = (rows) => ({
    total: rows.length,
    ready: rows.filter((entry) => entry.status === 'READY').length,
    needsFacts: rows.filter((entry) => entry.status === 'NEEDS_FACTS').length,
    notReady: rows.filter((entry) => entry.status === 'NOT_READY').length,
    needsVerification: rows.filter((entry) => entry.status === 'NEEDS_VERIFICATION').length
  });
  const eligible = selected.filter((entry) => entry.sourcePresent);
  const counts = countsFor(selected);
  const eligibleCounts = countsFor(eligible);
  const candidates = eligible.flatMap((entry) => {
    if (!entry.nextTask || !entry.candidateActionable
      || (entry.activeAttempt?.active && ['generate', 'facts'].includes(entry.nextTask))) return [];
    const targetRevision = ['facts', 'verify'].includes(entry.nextTask) ? entry.actionRevision : null;
    return [{
      skuKey: entry.skuKey,
      task: entry.nextTask,
      generationId: targetRevision?.generationId || null,
      factsJobId: targetRevision?.factsJobId || null,
      outputHash: targetRevision?.outputHash || null,
      outputPath: targetRevision?.outputPath || null,
      chatUrl: targetRevision?.chatUrl || null,
      imageUrlFingerprint: targetRevision?.imageUrlFingerprint || null,
      targetRevision,
      status: entry.status,
      groupIds: entry.groupIds
    }];
  });
  const quarantinedEntries = selected.filter((entry) => entry.identityQuarantined);
  const outputRecoveryRequiredEntries = selected.filter((entry) => entry.outputRecoveryRequired);

  return {
    version: 1,
    entries: selected,
    bySku,
    counts,
    eligibleCounts,
    quarantinedCount: quarantinedEntries.length,
    quarantinedEntries,
    outputRecoveryRequiredCount: outputRecoveryRequiredEntries.length,
    outputRecoveryRequiredEntries,
    candidates,
    candidateCounts: {
      total: candidates.length,
      generate: candidates.filter((item) => item.task === 'generate').length,
      facts: candidates.filter((item) => item.task === 'facts').length,
      verify: candidates.filter((item) => item.task === 'verify').length
    }
  };
}
