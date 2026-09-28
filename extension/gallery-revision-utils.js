export function galleryRecordsFromCatalog(catalog = [], revisions = []) {
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
