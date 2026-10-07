// A launch has one fixed plan, including across automatic session recovery.
// Status-only publications use this small durable snapshot instead of loading
// the full queue or treating an omitted queue as an empty queue.
export function runProgressIdentity(run) {
  return run?.originOperationId || run?.operationId || null;
}

export function syncRunProgress(run, entries) {
  if (!run) return {};
  const runId = runProgressIdentity(run);
  const ids = new Set(Array.isArray(run.plannedIds) ? run.plannedIds : []);
  const previous = run.progress?.runId === runId ? run.progress : null;
  const completed = new Set((previous?.completedIds || []).filter(id => ids.has(id)));
  const hasQueue = Array.isArray(entries);
  const readyTasks = run.progressCompletionMode === 'ready';
  if (readyTasks) {
    for (const id of run.completedTaskIds || []) {
      if (ids.has(id)) completed.add(id);
    }
  } else if (hasQueue) {
    for (const entry of entries) {
      if (entry?.status === 'done' && ids.has(entry.sourceId)) completed.add(entry.sourceId);
    }
  }
  const summary = { progressRunId: runId, runTotal: ids.size };
  // A legacy run may first wake on a lightweight page-state event. Preserve
  // its last published completed count until a queue-backed save migrates it.
  if (previous || hasQueue || readyTasks || ids.size === 0) {
    run.progress = { version: 1, runId, total: ids.size, completedIds: [...completed] };
    summary.runCompleted = completed.size;
    summary.runRemaining = Math.max(0, ids.size - completed.size);
  }
  return summary;
}

function snapshotIdentity(value) {
  return value?.progressRunId || value?.operationId
    || (value?.startedAt && ['DONE', 'STOPPED'].includes(value?.state) ? `legacy:${value.startedAt}` : null);
}

export function mergeRuntimeSnapshot(current = {}, patch = {}) {
  const oldSequence = Number(current.runtimeSequence || 0);
  const newSequence = Number(patch.runtimeSequence || 0);
  if (oldSequence && newSequence && newSequence < oldSequence) return current;
  const next = { ...current, ...patch };
  if (patch.state === 'IDLE' && patch.operationId === null) {
    return { ...next, progressRunId: null, runTotal: 0, runCompleted: 0, runRemaining: 0 };
  }
  const oldId = snapshotIdentity(current);
  const incomingId = snapshotIdentity(patch);
  const nextId = incomingId || snapshotIdentity(next);
  if (oldId && nextId === oldId) {
    const total = Math.max(0, Math.floor(Number(next.runTotal) || 0));
    // Status snapshots from older builds could explicitly carry zero counts.
    next.runTotal = total || Math.max(0, Number(current.runTotal) || 0);
    next.runCompleted = Math.min(next.runTotal, Math.max(
      0, Number(current.runCompleted) || 0, Number(next.runCompleted) || 0
    ));
    next.runRemaining = Math.max(0, next.runTotal - next.runCompleted);
  } else if (incomingId && incomingId !== oldId) {
    next.runTotal = Math.max(0, Number(patch.runTotal) || 0);
    next.runCompleted = Math.min(next.runTotal, Math.max(0, Number(patch.runCompleted) || 0));
    next.runRemaining = Math.max(0, next.runTotal - next.runCompleted);
    next.progressRunId = patch.progressRunId || patch.operationId || null;
  }
  return next;
}
