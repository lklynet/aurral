import {
  createIdleAbortController,
  getWorkerIdleStopMs,
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";
import { getWorkerId } from "./honkerDb.js";
import { shouldStartQueueHere } from "./backgroundWorkerQueues.js";
import { logger } from "./logger.js";

export default function createHonkerWorker({
  name,
  getQueue,
  processJob,
  idlePollS,
  retryDelayS = 300,
  shouldRestart,
  onStart,
  filterJob,
  resolveRetry,
  onJobDequeue,
  onJobSuccess,
  onJobError,
  onFinalFailure,
  onLoopError,
  shouldLogFailure = () => true,
}) {
  let running = false;
  let stopRequested = false;
  let idleController = null;
  let loopPromise = null;

  async function handleJobFailure(error, job, queue) {
    const message = error?.message || String(error);
    const logFailure = (action) => {
      if (!shouldLogFailure(job)) return;
      logger[action === "fail" ? "error" : "warn"]("jobs", `Job ${action === "fail" ? "failed" : "attempt failed; retrying"}`, {
        queue: name,
        jobId: job.id,
        kind: typeof job.payload?.kind === "string" ? job.payload.kind : null,
        attempt: job.attempts,
        reason: message,
      });
    };
    let attemptLimit = Number(queue.maxAttempts) || 3;
    try {
      const storedJob = queue.getJob(job.id);
      const storedLimit = Number(storedJob?.max_attempts);
      if (Number.isFinite(storedLimit) && storedLimit > 0) {
        attemptLimit = storedLimit;
      }
    } catch (lookupError) {
      logger.warn("jobs", "Could not read job retry limit", {
        queue: name,
        jobId: job.id,
        reason: lookupError?.message || String(lookupError),
      });
    }
    if (typeof onJobError === "function") {
      onJobError(error, job);
    }
    if (typeof resolveRetry === "function") {
      const decision = resolveRetry(error, job);
      if (decision?.action === "fail") {
        logFailure("fail");
        job.fail(decision.message ?? message);
        if (typeof onFinalFailure === "function") {
          await onFinalFailure(job, error);
        }
        return;
      }
      if (decision?.action === "retry") {
        logFailure("retry");
        job.retry(decision.delayS ?? retryDelayS, decision.message ?? message);
        return;
      }
    }
    if (job.attempts >= attemptLimit) {
      logFailure("fail");
      job.fail(message);
      if (typeof onFinalFailure === "function") {
        await onFinalFailure(job, error);
      }
    } else {
      logFailure("retry");
      job.retry(retryDelayS, message);
    }
  }

  async function runLoop() {
    const queue = getQueue();
    const workerId = getWorkerId();
    idleController = createIdleAbortController({
      idleStopMs: getWorkerIdleStopMs(),
    });
    idleController.arm();
    try {
      for await (const job of queue.claim(workerId, {
        idlePollS,
        signal: idleController.signal,
      })) {
        idleController.disarm();
        if (!running || stopRequested) break;
        if (process.env.AURRAL_BACKGROUND_WORKER_GROUP) {
          const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
            import("../db/helpers/index.js"),
            import("./weeklyFlow/weeklyFlowPlaylistConfig.js"),
          ]);
          dbOps.invalidateSettingsCache();
          invalidateFlowPlaylistConfigCache();
          if (process.env.AURRAL_BACKGROUND_WORKER_GROUP.startsWith("discovery-") ||
              process.env.AURRAL_BACKGROUND_WORKER_GROUP === "inbox") {
            const { reloadDiscoveryPersistedCache } = await import("./discovery/persistence.js");
            reloadDiscoveryPersistedCache();
          }
        }
        if (typeof filterJob === "function" && filterJob(job) === false) {
          job.ack();
          idleController.arm();
          continue;
        }
        if (typeof onJobDequeue === "function") {
          onJobDequeue(job.payload, job);
        }
        if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected && process.send) {
          process.send({ type: "job-started", queue: name, jobId: job.id });
        }
        try {
          await withJobHeartbeat(job, queue, () => processJob(job.payload, job));
          job.ack();
          if (typeof onJobSuccess === "function") {
            onJobSuccess(job.payload, job);
          }
        } catch (error) {
          await handleJobFailure(error, job, queue);
        } finally {
          if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected && process.send) {
            process.send({ type: "job-finished", queue: name, jobId: job.id });
          }
        }
        idleController.arm();
      }
    } catch (error) {
      if (typeof onLoopError === "function") {
        onLoopError(error);
      } else if (!idleController?.idleStopped && !stopRequested) {
        console.error(`[${name}] loop error:`, error);
      }
    } finally {
      const idleStopped = idleController?.idleStopped === true;
      idleController?.dispose();
      idleController = null;
      running = false;
      loopPromise = null;
      const intentional = stopRequested || idleStopped;
      stopRequested = false;
      const restartAllowed = typeof shouldRestart === "function" ? shouldRestart() : true;
      markHonkerWorkerLoopEnded(name, restartAllowed ? start : null, {
        intentional,
        ...(typeof shouldRestart === "function" ? { shouldRestart } : {}),
      });
    }
  }

  function start() {
    if (running || isHonkerShuttingDown() || !shouldStartQueueHere(name)) return;
    if (typeof onStart === "function" && onStart() === false) return;
    running = true;
    stopRequested = false;
    loopPromise = runLoop();
    return loopPromise;
  }

  function stop() {
    stopRequested = true;
    idleController?.abort();
    return loopPromise || Promise.resolve();
  }

  function isRunning() {
    return running;
  }

  registerHonkerWorker(name, { start, stop, isRunning });
  return { start, stop, isRunning };
}
