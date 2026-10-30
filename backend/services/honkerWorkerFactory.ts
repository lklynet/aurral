import {
  createIdleAbortController,
  getWorkerIdleStopMs,
  honkerJobInterruption,
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.ts";
import { getWorkerId, requeueInterruptedHonkerJob, adjustHonkerClaimAttempts } from "./honkerDb.ts";
import { shouldStartQueueHere } from "./backgroundWorkerQueues.ts";
import { asAppError } from "../../lib/errors.ts";
import { logger } from "./logger.ts";
import * as v from "valibot";
import type { Job, Queue } from "@russellthehippo/honker-node";

type PreparedJob = { release?: () => void };

type RetryDecision = { action?: "fail" | "retry"; message?: string; delayS?: number };

type TypedJob<Payload> = Job & { payload: Payload };

type WorkerQueue = Pick<Queue, "name" | "claim" | "maxAttempts" | "visibilityTimeoutS"> & {
  getJob(jobId: number): { max_attempts: number } | null;
};

type HonkerWorkerOptions<Payload> = {
  name: string;
  schema: v.GenericSchema<Payload>;
  getQueue: () => WorkerQueue;
  processJob: (
    payload: Payload,
    job: TypedJob<Payload>,
    context: { signal: AbortSignal } & PreparedJob,
  ) => unknown;
  prepareJob?: (
    payload: Payload,
    job: TypedJob<Payload>,
    context: { signal: AbortSignal },
  ) => PreparedJob | null | Promise<PreparedJob | null>;
  interruptible?: boolean | ((payload: Payload) => boolean);
  idlePollS?: number;
  retryDelayS?: number;
  shouldRestart?: () => boolean;
  onStart?: () => unknown;
  filterJob?: (job: TypedJob<Payload>) => boolean;
  resolveRetry?: (error: unknown, job: TypedJob<Payload>) => RetryDecision | null | undefined;
  onJobDequeue?: (payload: Payload, job: TypedJob<Payload>) => void;
  onJobSuccess?: (payload: Payload, job: TypedJob<Payload>) => void;
  onJobError?: (error: unknown, job: TypedJob<Payload>) => void;
  onFinalFailure?: (job: TypedJob<Payload>, error: unknown) => unknown;
  onLoopError?: (error: unknown) => void;
  shouldLogFailure?: (job: TypedJob<Payload>) => boolean;
};

function payloadSummary(payload: unknown) {
  if (payload == null) return null;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function createHonkerWorker<Payload>({
  name,
  schema,
  getQueue,
  processJob,
  prepareJob,
  interruptible = false,
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
}: HonkerWorkerOptions<Payload>) {
  let running = false;
  let stopRequested = false;
  let idleController: ReturnType<typeof createIdleAbortController> | null = null;
  let loopPromise: Promise<void> | null = null;
  let jobController: AbortController | null = null;
  let activeInterruptible = false;

  const readable = (job: Job): job is TypedJob<Payload> => v.is(schema, job.payload);

  function failUnreadable(job: Job) {
    const result = v.safeParse(schema, job.payload);
    const reason = result.success ? "unknown" : v.summarize(result.issues);
    logger.error("jobs", "Job payload unreadable", { queue: name, jobId: job.id, reason });
    job.fail(`Aurral can't read this job: ${reason}`);
  }

  async function handleJobFailure(error: unknown, job: TypedJob<Payload>, queue: WorkerQueue) {
    const failure = asAppError(error);
    const message = failure?.message || String(error);
    const kind: unknown =
      job.payload && typeof job.payload === "object" ? Reflect.get(job.payload, "kind") : undefined;
    const logFailure = (action: "fail" | "retry") => {
      if (!shouldLogFailure(job)) return;
      logger[action === "fail" ? "error" : "warn"](
        "jobs",
        `Job ${action === "fail" ? "failed" : "attempt failed; retrying"}`,
        {
          queue: name,
          jobId: job.id,
          kind: typeof kind === "string" ? kind : null,
          attempt: job.attempts,
          reason: message,
        },
      );
    };
    let attemptLimit = Number(queue.maxAttempts) || 3;
    try {
      const storedJob = queue.getJob(job.id);
      const storedLimit = Number(storedJob?.max_attempts);
      if (Number.isFinite(storedLimit) && storedLimit > 0) {
        attemptLimit = storedLimit;
      }
    } catch (lookupError) {
      const lookupFailure = asAppError(lookupError);
      logger.warn("jobs", "Could not read job retry limit", {
        queue: name,
        jobId: job.id,
        reason: lookupFailure?.message || String(lookupError),
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
        if (!readable(job)) {
          failUnreadable(job);
          idleController.arm();
          continue;
        }
        if (!running || stopRequested) {
          const canInterrupt =
            typeof interruptible === "function" ? interruptible(job.payload) : interruptible;
          if (canInterrupt) requeueInterruptedHonkerJob(job, queue);
          break;
        }
        if (process.env.AURRAL_BACKGROUND_WORKER_GROUP) {
          const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
            import("../db/helpers/index.ts"),
            import("./playlists/flowPlaylistConfig.ts"),
          ]);
          dbOps.invalidateSettingsCache();
          invalidateFlowPlaylistConfigCache();
          if (
            process.env.AURRAL_BACKGROUND_WORKER_GROUP.startsWith("discovery-") ||
            process.env.AURRAL_BACKGROUND_WORKER_GROUP === "inbox"
          ) {
            const { reloadDiscoveryPersistedCache } = await import("./discovery/persistence.ts");
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
        jobController = new AbortController();
        activeInterruptible =
          typeof interruptible === "function" ? interruptible(job.payload) : interruptible;
        let waitingAttempt = false;
        if (stopRequested && activeInterruptible)
          jobController.abort(honkerJobInterruption("Background worker shutting down"));
        let prepared: PreparedJob | null | undefined;
        let announced = false;
        try {
          await withJobHeartbeat(job, queue, async () => {
            if (activeInterruptible && typeof prepareJob === "function") {
              if (!adjustHonkerClaimAttempts(job, queue, -1))
                throw honkerJobInterruption("Background job claim lost");
              waitingAttempt = true;
            }
            prepared =
              typeof prepareJob === "function"
                ? await prepareJob(job.payload, job, { signal: jobController!.signal })
                : null;
            if (waitingAttempt) {
              if (!adjustHonkerClaimAttempts(job, queue, 1))
                throw honkerJobInterruption("Background job claim lost");
              waitingAttempt = false;
            }
            if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected && process.send) {
              process.send({
                type: "job-started",
                queue: name,
                jobId: job.id,
                payload: payloadSummary(job.payload),
              });
              announced = true;
            }
            return processJob(job.payload, job, { signal: jobController!.signal, ...prepared });
          });
          job.ack();
          if (typeof onJobSuccess === "function") {
            onJobSuccess(job.payload, job);
          }
        } catch (error) {
          if (asAppError(error)?.code === "HONKER_JOB_INTERRUPTED") {
            requeueInterruptedHonkerJob(job, queue, { refundAttempt: !waitingAttempt });
          } else {
            if (waitingAttempt) adjustHonkerClaimAttempts(job, queue, 1);
            await handleJobFailure(error, job, queue);
          }
        } finally {
          prepared?.release?.();
          jobController = null;
          activeInterruptible = false;
          if (announced && process.connected && process.send) {
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
    if (activeInterruptible)
      jobController?.abort(honkerJobInterruption("Background worker shutting down"));
    return loopPromise || Promise.resolve();
  }

  function isRunning() {
    return running;
  }

  registerHonkerWorker(name, { start, stop, isRunning });
  return { start, stop, isRunning };
}
