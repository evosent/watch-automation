export function galleryRecordsFromAccountingSnapshot(snapshot, catalog = [], revisions = []) {
  // Reconciliation gates new work, while the ledger may already contain
  // individually verified accepted results. Keep those results visible while
  // a deferred legacy migration is pending.
  if (!snapshot || !Array.isArray(snapshot.entries)) return [];
  const catalogBySku = new Map((catalog || []).filter((model) => model?.skuKey)
    .map((model) => [String(model.skuKey), model]));
  const revisionCounts = new Map();
  const countedGenerationIds = new Set();
  for (const revision of revisions || []) {
    const generationId = String(revision?.generationId || '');
    const status = String(revision?.status || '').toUpperCase();
    if (!revision?.sourceId || !generationId || countedGenerationIds.has(generationId)
      || !revision.outputPath || !/^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))
      || ['GENERATING', 'PENDING', 'CANCELLED', 'FAILED'].includes(status)) continue;
    countedGenerationIds.add(generationId);
    const key = String(revision.sourceId);
    revisionCounts.set(key, Number(revisionCounts.get(key) || 0) + 1);
  }

  return snapshot.entries.flatMap((entry) => {
    const skuKey = String(entry?.skuKey || '');
    const generationId = String(entry?.acceptedGenerationId || entry?.acceptedRevision?.generationId || '');
    const revision = entry?.acceptedRevision;
    const physical = entry?.artifactVerification;
    const model = entry?.model || catalogBySku.get(skuKey) || {};
    const verified = physical?.verified === true || String(physical?.status || '').toUpperCase() === 'VERIFIED';
    if (!skuKey || !generationId || entry.identityStatus !== 'OK' || entry.status !== 'READY'
      || !verified || !revision || String(revision.generationId || '') !== generationId
      || String(revision.sourceId || '') !== skuKey
      || revision.reviewStatus === 'rejected'
      || String(revision.status || '').toUpperCase() !== 'READY'
      || String(revision.factsStatus || '').toLowerCase() !== 'ok'
      || !revision.factsJobId
      || !revision.outputPath
      || !/^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))) return [];

    const facts = revision.facts;
    if (facts?.status !== 'ok'
      || String(facts.generationId || '') !== generationId
      || String(facts.factsJobId || '') !== String(revision.factsJobId)
      || String(facts.outputHash || '').toLowerCase() !== String(revision.outputHash).toLowerCase()) return [];

    const catalogRecord = catalogBySku.get(skuKey);
    return [{
      ...revision,
      sourceId: skuKey,
      skuKey,
      generationId,
      generatedAt: revision.generatedAt || revision.completedAt || revision.downloadedAt || null,
      modelName: revision.modelName || model.modelName || catalogRecord?.modelName || '',
      groupId: revision.groupId || model.variants?.[0]?.groupId || catalogRecord?.variants?.[0]?.groupId || '',
      profileId: model.profileId || model.brandId || catalogRecord?.brandId || null,
      facts,
      factsStatus: 'ok',
      chatUrl: revision.chatUrl || facts.chatUrl || null,
      versionCount: Number(entry.revisionCount || revisionCounts.get(skuKey) || 1),
      artifactMode: String(revision.outputPath).startsWith('custom://') ? 'custom' : 'watcher',
      modifiedAt: Date.parse(revision.completedAt || revision.downloadedAt || '') || 0,
      outsideCurrentCatalog: model.sourcePresent === false || catalogRecord?.sourcePresent === false,
      accountingStatus: entry.status
    }];
  }).sort((left, right) => Number(right.modifiedAt || 0) - Number(left.modifiedAt || 0));
}

export function galleryRecordsFromCatalog(catalog = [], revisions = [], accountingSnapshot = null) {
  if (arguments.length >= 3) return galleryRecordsFromAccountingSnapshot(accountingSnapshot, catalog, revisions);
  const byGenerationId = new Map((revisions || [])
    .filter((revision) => revision?.generationId)
    .map((revision) => [String(revision.generationId), revision]));
  const revisionCounts = new Map();
  const countedGenerationIds = new Set();
  for (const revision of revisions || []) {
    const generationId = String(revision?.generationId || '');
    const status = String(revision?.status || '').toUpperCase();
    if (!revision?.sourceId || !generationId || countedGenerationIds.has(generationId)
      || !revision.outputPath
      || !/^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))
      || ['GENERATING', 'PENDING', 'CANCELLED', 'FAILED'].includes(status)) continue;
    countedGenerationIds.add(generationId);
    const key = String(revision.sourceId);
    revisionCounts.set(key, Number(revisionCounts.get(key) || 0) + 1);
  }

  return (catalog || []).flatMap((model) => {
    const skuKey = String(model?.skuKey || '');
    const generationId = String(model?.latestReadyGenerationId || '');
    const revision = byGenerationId.get(generationId);
    if (!skuKey || !generationId || !revision
      || String(revision.sourceId || '') !== skuKey
      || revision.reviewStatus === 'rejected'
      || revision.status !== 'READY'
      || revision.factsStatus !== 'ok'
      || !revision.factsJobId
      || !revision.outputPath
      || !/^[a-f0-9]{64}$/i.test(String(revision.outputHash || ''))) return [];

    const facts = revision.facts;
    if (facts?.status !== 'ok'
      || String(facts.generationId || '') !== generationId
      || String(facts.factsJobId || '') !== String(revision.factsJobId)
      || String(facts.outputHash || '').toLowerCase() !== String(revision.outputHash).toLowerCase()) return [];

    return [{
      ...revision,
      sourceId: skuKey,
      skuKey,
      generationId,
      generatedAt: revision.generatedAt || revision.completedAt || revision.downloadedAt || null,
      modelName: revision.modelName || model.modelName || '',
      groupId: revision.groupId || model.variants?.[0]?.groupId || '',
      facts,
      factsStatus: 'ok',
      chatUrl: revision.chatUrl || facts.chatUrl || null,
      versionCount: revisionCounts.get(skuKey) || 1,
      artifactMode: String(revision.outputPath).startsWith('custom://') ? 'custom' : 'watcher',
      modifiedAt: Date.parse(revision.completedAt || revision.downloadedAt || '') || 0
    }];
  }).sort((left, right) => Number(right.modifiedAt || 0) - Number(left.modifiedAt || 0));
}

export function currentRevisionsForCatalog(catalog = [], revisions = []) {
  const byGenerationId = new Map((revisions || [])
    .filter((revision) => revision?.generationId)
    .map((revision) => [String(revision.generationId), revision]));
  return (catalog || [])
    .map((model) => byGenerationId.get(String(model?.currentGenerationId || '')))
    .filter(Boolean);
}
