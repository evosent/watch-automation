import { sessionWatchdogBlock, SESSION_STALL_TIMEOUT_MS } from './session-watchdog-utils.js';

// The persisted intent is independent of `run`: clearing the temporary session
// must not erase the exact playlist or the obligation to continue it.
export function createSessionRestartController(ports) {
  let inFlight = null;
  const now = ports.now || Date.now;
  const stamp = () => new Date(now()).toISOString();
  const clone = value => structuredClone(value);
  const writeIntent = intent => ports.storage.set({ sessionRestartIntent: intent });
  const isCancelled = async intent => (await ports.storage.get('sessionRestartCancellation'))
    .sessionRestartCancellation?.restartId === intent.restartId;

  async function log(run, queue, type, data) {
    if (!run) return;
    ports.record(run, type, data);
    await ports.save(run, queue);
    await ports.persistDiagnostics(run, queue);
  }

  async function logFreshById(operationId, type, data) {
    if (!operationId) return;
    await ports.lock(async () => {
      const latest = await ports.getStored();
      if (latest.run?.operationId !== operationId) return;
      await log(latest.run, latest.queue, type, data);
    });
  }

  async function restoreFrozenRun(intent, { pausedByUser = false } = {}) {
    return ports.lock(async () => {
      if (!pausedByUser && await isCancelled(intent)) return;
      const latest = await ports.getStored();
      if (latest.manualExtensionUpdateLock?.active || latest.resultsImportJournal) {
        throw new Error('Ожидаю завершения обновления приложения или импорта результатов');
      }
      if (latest.run && latest.run.operationId !== intent.nextOperationId) {
        throw new Error('Another run appeared during session recovery');
      }
      const snapshot = intent.runSnapshot;
      const completedIds = [], retryIds = [];
      for (const sourceId of snapshot.plannedIds) {
        const entry = ports.findEntry(latest.queue, snapshot, sourceId);
        if (!entry) throw new Error(`Товар исходного списка не найден: ${sourceId}`);
        const model = await ports.readModel(sourceId);
        const currentId = model?.currentGenerationId || entry.generationId
          || latest.generationMemory?.items?.[sourceId]?.generationId;
        const revision = currentId ? await ports.readRevision(currentId) : null;
        if (ports.isComplete(revision) && !revision.supersededBySessionRestartId
          && ports.revisionMatches(entry, revision)) {
          completedIds.push(sourceId);
          continue;
        }
        if (model?.currentGenerationId) {
          const marked = await ports.markRetry(sourceId, model.currentGenerationId, {
            restartId: intent.restartId, inputSourceId: entry.inputSourceId || entry.sourceVariantId
          });
          if (!marked.marked && !marked.alreadyMarked) {
            const updated = await ports.readRevision(model.currentGenerationId);
            if (ports.isComplete(updated) && ports.revisionMatches(entry, updated)) {
              completedIds.push(sourceId);
              continue;
            }
            throw new Error(`Не удалось безопасно вернуть товар в очередь: ${sourceId} (${marked.reason || 'CAS'})`);
          }
        }
        ports.resetEntry(latest, entry);
        retryIds.push(sourceId);
      }
      const next = { ...clone(snapshot), operationId: intent.nextOperationId,
        buildId: ports.buildId || snapshot.buildId,
        originOperationId: snapshot.originOperationId || intent.operationId,
        previousOperationId: intent.operationId, sessionRestartId: intent.restartId,
        sessionRestartCount: Number(snapshot.sessionRestartCount || 0) + 1,
        jobSnapshot: clone(intent.jobSnapshot), state: retryIds.length ? 'PAUSED' : 'DONE',
        status: retryIds.length ? 'SESSION_RESTART_READY' : 'DONE',
        pauseReason: retryIds.length ? 'SESSION_RESTART' : null, pendingIds: retryIds,
        slots: {}, postprocessTabs: {}, recoveryTabs: {}, factsProgress: {},
        conversationRecovery: null, stalledBatchRecovery: null,
        automationWindowId: null, automationWindowOwned: false,
        error: null, unresolvedError: false, stopBlocked: null, clockStopped: false,
        clockActiveSinceMs: null, clockVersion: 1,
        rateLimitPauseUntil: null, rateLimitPauseStartedAt: null, rateLimitReason: null,
        rateLimitIgnoreUntil: null, uploadCooldownActive: false, uploadManualPause: false,
        uploadLimitDetected: false, imageLimitDetected: false, uploadPauseSettled: false,
        preparationRecoveryAttempts: 0, attachmentFailureWindow: [],
        lastGenerationLaunchAt: null, lastAnySendAt: null, lastPostprocessSendAt: null,
        startedAt: stamp(), finishedAt: retryIds.length ? null : stamp(),
        lastActivityAt: stamp(), lastProgressAt: stamp(), noProgressSince: null, noProgressCycles: 0,
        eventJournal: [], eventSequence: 0, eventCount: 0, diagnosticsPersistedSequence: 0,
        diagnosticsHeaderFingerprint: null, diagnosticsLastKnownCompletedCount: completedIds.length,
        sessionWatchdog: { lastUsefulAt: stamp(), armedAt: now(), blockedReason: null,
          resultKeys: [], restartCount: Number(snapshot.sessionRestartCount || 0) + 1 },
        currentAction: 'Продолжаю исходный список после восстановления сессии'
      };
      if (pausedByUser && retryIds.length) {
        next.state = 'PAUSED'; next.status = 'PAUSED'; next.pauseReason = 'USER';
        next.currentAction = 'Пауза сохранена. Исходный список можно продолжить вручную.';
      }
      ports.record(next, 'session_restart_restored', {
        restartId: intent.restartId, previousOperationId: intent.operationId,
        completedCount: completedIds.length, retryCount: retryIds.length,
        completedIds, retryIds, plannedCount: snapshot.plannedIds.length
      });
      // The new run becomes visible only together with its cleared memory and
      // history. A recreated worker can then safely skip directly to RESUMING.
      await ports.save(next, latest.queue, latest.history, latest.generationMemory);
      await ports.persistDiagnostics(next, latest.queue);
    });
  }

  async function cancel(intent, stored, reason) {
    const cancellation = (await ports.storage.get('sessionRestartCancellation')).sessionRestartCancellation;
    const pausedByUser = reason === 'user_pause' || (cancellation?.restartId === intent.restartId
      && cancellation.reason === 'pause');
    if (!stored.run && pausedByUser) {
      await restoreFrozenRun(intent, { pausedByUser: true });
      stored = await ports.getStored();
    }
    if (pausedByUser && [intent.operationId, intent.nextOperationId].includes(stored.run?.operationId)
      && !['DONE', 'STOPPED'].includes(stored.run.state)) {
      // The cancellation marker is written before the ordinary Pause handler
      // obtains the state lock. Keep that pause durable even if this worker
      // stops before the queued handler can update the restored run.
      await ports.lock(async () => {
        const latest = await ports.getStored();
        if (![intent.operationId, intent.nextOperationId].includes(latest.run?.operationId)
          || ['DONE', 'STOPPED'].includes(latest.run.state)) return;
        latest.run.state = 'PAUSED'; latest.run.status = 'PAUSED'; latest.run.pauseReason = 'USER';
        latest.run.currentAction = 'Пауза сохранена. Исходный список можно продолжить вручную.';
        await ports.save(latest.run, latest.queue);
      });
      stored = await ports.getStored();
    }
    await logFreshById(stored.run?.operationId, 'session_restart_cancelled', { restartId: intent.restartId, reason });
    await ports.storage.remove('sessionRestartIntent');
    return { cancelled: true, reason };
  }

  async function perform() {
    let stored = await ports.getStored();
    let intent = stored.sessionRestartIntent;
    if (!intent) return { skipped: true };
    try {
      if (await isCancelled(intent)) return await cancel(intent, stored, 'user_action');
      const run = stored.run;
      if (run && ![intent.operationId, intent.nextOperationId].includes(run.operationId)) {
        return await cancel(intent, stored, 'another_run_started');
      }
      const blocked = run ? sessionWatchdogBlock(run, now(), stored) : null;
      if (blocked?.reason === 'application_operation') {
        throw new Error('Ожидаю завершения обновления приложения или импорта результатов');
      }
      if (blocked && !['finished', 'no_run', 'configured_launch_pause'].includes(blocked.reason)) {
        return await cancel(intent, stored, blocked.reason);
      }
      if (intent.retryAt > now()) return { waiting: true, dueAt: intent.retryAt };
      // When a worker was suspended after restoring the new run, resume its
      // persisted state rather than creating another set of attempts.
      if (run?.operationId === intent.nextOperationId) intent.stage = 'RESUMING';

      if (intent.stage === 'RESETTING') {
        let cancelledReason = null;
        await ports.lock(async () => {
          const latest = await ports.getStored();
          if (latest.run?.operationId !== intent.operationId) return;
          const block = sessionWatchdogBlock(latest.run, now(), latest);
          if (block) { cancelledReason = block.reason; return; }
          if (ports.shouldRestart && !ports.shouldRestart(latest.run)) {
            cancelledReason = 'useful_progress_arrived'; return;
          }
          latest.run.state = 'PAUSED';
          latest.run.status = 'SESSION_RESTARTING';
          latest.run.pauseReason = 'SESSION_RESTART';
          latest.run.currentAction = 'Десять минут без новых результатов. Восстанавливаю сессию…';
          await log(latest.run, latest.queue, 'session_restart_started', {
            restartId: intent.restartId, nextOperationId: intent.nextOperationId,
            reason: intent.reason, timeoutMs: SESSION_STALL_TIMEOUT_MS,
            lastUsefulAt: latest.run.sessionWatchdog?.lastUsefulAt || null,
            plannedCount: intent.runSnapshot.plannedIds.length
          });
        });
        stored = await ports.getStored();
        if (cancelledReason) return await cancel(intent, stored, cancelledReason);
        const raceBlock = stored.run ? sessionWatchdogBlock(stored.run, now(), stored) : null;
        if (raceBlock && !['finished', 'configured_launch_pause'].includes(raceBlock.reason)) {
          return await cancel(intent, stored, raceBlock.reason);
        }
        if (stored.run?.operationId === intent.operationId) await ports.stopPages(stored.run);
        const snapshot = intent.runSnapshot;
        const cleanupTabIds = [...Object.values(snapshot.slots || {}).map(slot => slot.tabId),
          ...Object.keys(snapshot.postprocessTabs || {}), ...Object.keys(snapshot.recoveryTabs || {})]
          .map(Number).filter(id => id > 0);
        await ports.reset({ automatic: true, sessionRestart: true, preserveLogs: true, salvageReady: true,
          plannedOnly: snapshot.plannedIds, reason: intent.reason,
          cleanupTabIds, cleanupWindowId: snapshot.automationWindowId || 0,
          cleanupWindowOwned: snapshot.automationWindowOwned === true });
        if (await isCancelled(intent)) return await cancel(intent, await ports.getStored(), 'user_action');
        intent = { ...intent, stage: 'RESTORING', resetAt: stamp(), retryAt: null };
        await writeIntent(intent);
      }

      if (intent.stage === 'RESTORING') {
        await restoreFrozenRun(intent);
        if (await isCancelled(intent)) return await cancel(intent, await ports.getStored(), 'user_action');
        intent = { ...intent, stage: 'RESUMING', restoredAt: stamp(), retryAt: null };
        await writeIntent(intent);
      }

      if (intent.stage === 'RESUMING') {
        stored = await ports.getStored();
        if (await isCancelled(intent)) return await cancel(intent, stored, 'user_action');
        if (stored.run?.operationId !== intent.nextOperationId) throw new Error('Restored session is missing');
        if (stored.run.pauseReason === 'USER' || stored.run.clockStopped || stored.run.stopBlocked) {
          return await cancel(intent, stored, 'user_pause');
        }
        if (stored.run.state !== 'RUNNING' && stored.run.state !== 'DONE') {
          await ports.resume({ sessionRestartInternal: true });
        }
        stored = await ports.getStored();
        await logFreshById(intent.nextOperationId, 'session_restart_completed', {
          restartId: intent.restartId, previousOperationId: intent.operationId,
          plannedCount: intent.runSnapshot.plannedIds.length,
          pendingCount: stored.run.pendingIds?.length || 0
        });
        await ports.storage.remove('sessionRestartIntent');
        return { restarted: true, operationId: intent.nextOperationId };
      }
      return { skipped: true };
    } catch (error) {
      intent = { ...intent, failedAt: stamp(), error: String(error?.message || error), retryAt: now() + 60_000 };
      await writeIntent(intent);
      stored = await ports.getStored();
      const failure = {
        restartId: intent.restartId, stage: intent.stage, error: intent.error, retryAt: intent.retryAt
      };
      if (stored.run?.operationId) {
        await logFreshById(stored.run.operationId, 'session_restart_failed', failure).catch(() => {});
      } else {
        await ports.recordDetachedFailure?.('session_restart_failed', error, intent).catch(() => {});
      }
      return { failed: true, error: intent.error, retryAt: intent.retryAt };
    }
  }

  function continueRestart() {
    if (inFlight) return inFlight;
    inFlight = perform().finally(() => { inFlight = null; });
    return inFlight;
  }

  function begin(run, jobSnapshot, reason = 'Десять минут без сохранённого фото или спецификации') {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const existing = (await ports.getStored()).sessionRestartIntent;
      if (!existing) {
        await writeIntent({ restartId: ports.newId(), operationId: run.operationId,
          nextOperationId: ports.newId(), requestedAt: stamp(), stage: 'RESETTING', reason,
          runSnapshot: clone(run), jobSnapshot: clone(jobSnapshot), retryAt: null });
      }
      return perform();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return { begin, continueRestart };
}

