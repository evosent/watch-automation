import { buildQueueProgressTree, QUEUE_GROUPS, WATCH_BRAND_FILTERS, RUN_PART_SIZE,
  generationMemoryRecordFromEntry } from './queue-utils.js';

// Presentation only: backend queue status "done" also covers PNGs awaiting OCR.
// Keep queue membership/signatures intact while displaying complete results.
export function buildPlaylistProgressTree(groups, repairQueue = [], memory = {}) {
  const activeRepairs = repairQueue.filter((item) => typeof item === 'string' || item?.status !== 'completed');
  const repairIds = new Set(activeRepairs.map((item) => String(typeof item === 'string' ? item : item.sourceId)));
  const tree = buildQueueProgressTree(groups, activeRepairs, RUN_PART_SIZE);
  const decorate = (node) => {
    const records = node.entries.map((entry) => ({
      ...((memory.items || {})[entry.sourceId] || generationMemoryRecordFromEntry(entry)),
      repair: repairIds.has(String(entry.sourceId))
    }));
    node.done = records.filter((record) => record.status === 'ready' && !record.repair).length;
    node.running = records.filter((record) => record.status === 'running').length;
    node.imageSaved = records.filter((record) => record.status === 'image_saved').length;
    node.factsPending = records.filter((record) => record.status === 'facts_pending').length;
    node.pending = Math.max(0, node.total - node.done - node.running - node.imageSaved - node.factsPending);
    node.percent = node.total ? Math.floor(node.done * 100 / node.total) : 0;
    node.children?.forEach(decorate);
  };
  tree.forEach(decorate);
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
