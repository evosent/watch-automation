export function normalizedRepairQueue(queue) {
  if (!Array.isArray(queue.repairQueue)) queue.repairQueue = [];
  const seen = new Set();
  queue.repairQueue = queue.repairQueue.map((item) => {
    const sourceId = String(typeof item === 'string' ? item : item?.sourceId || '').trim();
    if (!sourceId || seen.has(sourceId)) return null;
    seen.add(sourceId);
    return typeof item === 'string'
      ? { sourceId, queuedAt: new Date().toISOString(), generationId: null }
      : { ...item, sourceId, queuedAt: item.queuedAt || new Date().toISOString() };
  }).filter(Boolean);
  return queue.repairQueue;
}

export function upsertRepairQueueItem(queue, sourceId, rejectedGenerationId = null) {
  const items = normalizedRepairQueue(queue);
  const key = String(sourceId || '').trim();
  if (!key) throw new Error('Repair queue sourceId is required');
  const current = items.find((item) => item.sourceId === key);
  if (current) {
    current.generationId = rejectedGenerationId || current.generationId || null;
    current.queuedAt = new Date().toISOString();
    current.updatedAt = current.queuedAt;
    current.status = 'pending';
    delete current.completedAt;
    delete current.completedGenerationId;
    return current;
  }
  const item = {
    sourceId: key,
    queuedAt: new Date().toISOString(),
    generationId: rejectedGenerationId || null,
    status: 'pending'
  };
  queue.repairQueue = [...items, item];
  return item;
}

export function selectRepairQueueEntries(entries = [], repairQueue = []) {
  const pendingIds = new Set((repairQueue || [])
    .filter((item) => item?.status !== 'completed')
    .map((item) => String(typeof item === 'string' ? item : item?.sourceId || ''))
    .filter(Boolean));
  return (entries || []).filter((entry) => pendingIds.has(String(entry?.sourceId || '')) && entry?.status !== 'running');
}

export function excludeRepairQueueEntries(entries = [], repairQueue = []) {
  const repairIds = new Set((repairQueue || []).map((item) => String(typeof item === 'string' ? item : item?.sourceId || '')));
  return (entries || []).filter((entry) => !repairIds.has(String(entry?.sourceId || '')));
}
