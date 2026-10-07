import { buildQueueProgressTree, QUEUE_GROUPS, WATCH_BRAND_FILTERS, RUN_PART_SIZE } from './queue-utils.js';
import { accountingMemoryStatus, accountingAttemptIsActive, canonicalAccountingIndex } from './accounting-ui-utils.js';

// Presentation only: backend queue status "done" also covers PNGs awaiting OCR.
// Keep queue membership/signatures intact while displaying complete results.
export function buildPlaylistProgressTree(groups, repairQueue = [], memory = {}, accountingSnapshot = undefined) {
  const activeRepairs = repairQueue.filter((item) => typeof item === 'string' || item?.status !== 'completed');
  const repairIds = new Set(activeRepairs.map((item) => String(typeof item === 'string' ? item : item.sourceId)));
  const tree = buildQueueProgressTree(groups, activeRepairs, RUN_PART_SIZE);
  const canonical = accountingSnapshot === undefined ? null : canonicalAccountingIndex(accountingSnapshot);
  const decorate = (node) => {
    const records = node.entries.map((entry) => {
      const canonicalEntry = canonical?.get(String(entry.skuKey || entry.sourceId || ''));
      // Queue status alone is not evidence that an image and its facts exist.
      const legacy = (memory.items || {})[entry.sourceId] || null;
      const status = canonical
        ? accountingMemoryStatus(canonicalEntry)
        : (legacy?.status || 'needs_verification');
      const activeAttempt = canonicalEntry?.activeAttempt;
      return {
        status,
        accountingStatus: String(canonicalEntry?.status || (canonical ? 'NEEDS_VERIFICATION' : '')).toUpperCase(),
        identityAmbiguous: canonicalEntry?.identityStatus === 'AMBIGUOUS' || canonicalEntry?.identityQuarantined === true,
        activeAttempt: canonical
          ? accountingAttemptIsActive(activeAttempt)
          : status === 'running',
        repair: repairIds.has(String(entry.sourceId))
      };
    });
    node.done = records.filter((record) => canonical
      ? record.status === 'ready'
      : record.status === 'ready' && !record.repair).length;
    // Active attempts are a secondary signal. A previously accepted result
    // remains READY while a replacement attempt is running.
    node.running = records.filter((record) => record.activeAttempt).length;
    node.imageSaved = canonical ? 0 : records.filter((record) => record.status === 'image_saved').length;
    node.factsPending = records.filter((record) => canonical
      ? record.accountingStatus === 'NEEDS_FACTS'
      : record.status === 'facts_pending').length;
    node.needsVerification = records.filter((record) => canonical
      ? record.accountingStatus === 'NEEDS_VERIFICATION'
      : record.status === 'needs_verification').length;
    node.identityAmbiguous = records.filter((record) => record.identityAmbiguous).length;
    node.notReady = records.filter((record) => canonical
      ? record.accountingStatus === 'NOT_READY'
      : record.status === 'not_ready' || record.status === 'identity_review').length;
    node.pending = Math.max(0, canonical
      ? node.total - node.done - node.factsPending
      : node.total - node.done - node.running - node.imageSaved - node.factsPending);
    node.percent = node.total ? Math.floor(node.done * 100 / node.total) : 0;
    node.children?.forEach(decorate);
  };
  tree.forEach(decorate);
  const regularRoot = tree.find((node) => node.mode === 'regular');
  const presentCounts = accountingSnapshot?.eligibleCounts;
  if (canonical && regularRoot && presentCounts && Number.isFinite(Number(presentCounts.total))) {
    // The queue root summarizes the canonical present-catalog universe once
    // per SKU. Descendants remain scoped to their queue/group membership.
    regularRoot.total = Number(presentCounts.total || 0);
    regularRoot.done = Number(presentCounts.ready || 0);
    regularRoot.factsPending = Number(presentCounts.needsFacts || 0);
    regularRoot.needsVerification = Number(presentCounts.needsVerification || 0);
    regularRoot.notReady = Number(presentCounts.notReady || 0);
    regularRoot.identityAmbiguous = (accountingSnapshot.entries || []).filter((entry) =>
      entry.sourcePresent !== false && (entry.identityStatus === 'AMBIGUOUS' || entry.identityQuarantined === true)).length;
    regularRoot.running = (accountingSnapshot.entries || []).filter((entry) =>
      entry.sourcePresent !== false && accountingAttemptIsActive(entry.activeAttempt)).length;
    regularRoot.pending = Math.max(0, regularRoot.total - regularRoot.done - regularRoot.factsPending);
    regularRoot.percent = regularRoot.total ? Math.floor(regularRoot.done * 100 / regularRoot.total) : 0;
  }
  return tree;
}

export function findPlaylistPart(nodes, predicate) {
  for (const node of nodes || []) {
    if (node.type === 'part' && predicate(node)) return node;
    const found = findPlaylistPart(node.children, predicate);
    if (found) return found;
  }
  return null;
}

export function playlistPath(part) {
  if (!part) return '';
  const brand = WATCH_BRAND_FILTERS.find((item) => item.id === part.brandId)?.label || part.brandId;
  const group = QUEUE_GROUPS[part.groupId]?.label || part.groupId;
  return `${part.mode === 'regeneration' ? 'Перегенерация' : 'Основная'} · ${brand} · ${group}`;
}
