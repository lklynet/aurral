import * as v from "valibot";
import { asAppError } from "../../../lib/errors.ts";
import { getDatabaseDataVersion } from "../../config/db-sqlite.ts";
import { logger, withLogContext } from "../logger.ts";
import { onQueueWake, ownsQueueHere, type ClaimedJob, type Queue } from "./queue.ts";

type PreparedJob = { release?: () => void };
type RetryDecision = { action?: "fail" | "retry"; message?: string; delayMs?: number };
export type TypedJob<Payload> = ClaimedJob<Payload>;

interface WorkerOptions<Payload> {
  schema: v.GenericSchema<unknown, Payload>;
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
  shouldRestart?: () => boolean;
  onStart?: () => boolean;
  filterJob?: (job: TypedJob<Payload>) => boolean;
  resolveRetry?: (error: unknown, job: TypedJob<Payload>) => RetryDecision | null | undefined;
  onJobDequeue?: (payload: Payload, job: TypedJob<Payload>) => void;
  onJobSuccess?: (payload: Payload, job: TypedJob<Payload>) => void;
  onJobError?: (error: unknown, job: TypedJob<Payload>) => void;
  onFinalFailure?: (job: TypedJob<Payload>, error: unknown) => unknown;
  onLoopError?: (error: unknown) => void;
  shouldLogFailure?: (job: TypedJob<Payload>) => boolean;
}

interface RegisteredWorker {
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

const workers = new Map<string, RegisteredWorker>();
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const restartAttempts = new Map<string, number>();
const shutdownHandlers: (() => unknown)[] = [];
let shuttingDown = false;
let activeJobCount = 0;

const INTERRUPTED = "JOB_INTERRUPTED";
const CANCELLED = "JOB_CANCELLED";
const HEARTBEAT_MAX_MS = 5000;
const MAX_TIMER_MS = 2_147_483_647;

export function jobInterruption(message = "Background job interrupted") {
  return Object.assign(new Error(message), { code: INTERRUPTED });
}

export function isJobInterruption(error: unknown) {
  return asAppError(error)?.code === INTERRUPTED;
}

export function isShuttingDown() {
  return shuttingDown;
}

export function hasActiveJobs() {
  return activeJobCount > 0;
}

export function getWorkerStatuses() {
  return [...workers.entries()]
    .map(([name, worker]) => ({ name, running: worker.isRunning() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function registerShutdownHandler(handler: () => unknown) {
  shutdownHandlers.push(handler);
}

function scheduleRestart(name: string, start: () => unknown, shouldRestart: () => boolean) {
  if (shuttingDown || process.env.NODE_ENV === "test" || !shouldRestart()) return;
  const attempts = restartAttempts.get(name) ?? 0;
  restartAttempts.set(name, attempts + 1);
  clearTimeout(restartTimers.get(name));
  const timer = setTimeout(
    () => {
      restartTimers.delete(name);
      if (shuttingDown || !shouldRestart()) return;
      start();
      restartAttempts.set(name, 0);
    },
    Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)),
  );
  timer.unref?.();
  restartTimers.set(name, timer);
}

function payloadSummary(payload: unknown) {
  const text = JSON.stringify(payload ?? null);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

let lastDataVersion: number | null = null;

async function reloadChangedCaches() {
  const group = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  if (!group) return;
  const version = getDatabaseDataVersion();
  if (version === lastDataVersion) return;
  lastDataVersion = version;
  const [{ dbOps }, { invalidateFlowPlaylistConfigCache }] = await Promise.all([
    import("../../db/helpers/index.ts"),
    import("../playlists/flowPlaylistConfig.ts"),
  ]);
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
  if (group.startsWith("discovery-") || group === "inbox") {
    const { reloadDiscoveryPersistedCache } = await import("../discovery/persistence.ts");
    reloadDiscoveryPersistedCache();
  }
}

export function createJobWorker<Payload extends object>(
  queue: Queue<Payload>,
  {
    schema,
    processJob,
    prepareJob,
    interruptible = false,
    shouldRestart = () => true,
    onStart,
    filterJob,
    resolveRetry,
    onJobDequeue,
    onJobSuccess,
    onJobError,
    onFinalFailure,
    onLoopError,
    shouldLogFailure = () => true,
  }: WorkerOptions<Payload>,
) {
  const { name } = queue;
  let running = false;
  let stopRequested = false;
  let loopPromise: Promise<void> | null = null;
  let jobController: AbortController | null = null;
  let activeInterruptible = false;
  let woken = false;
  let wakeUp: (() => void) | null = null;

  onQueueWake(name, () => {
    woken = true;
    wakeUp?.();
  });

  const canInterrupt = (payload: Payload) =>
    typeof interruptible === "function" ? interruptible(payload) : interruptible;

  function waitForWork() {
    if (woken || stopRequested) {
      woken = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const due = queue.nextDueAt();
      const timer =
        due == null
          ? null
          : setTimeout(() => done(), Math.min(MAX_TIMER_MS, Math.max(0, due - Date.now()) + 5));
      timer?.unref?.();
      function done() {
        if (timer) clearTimeout(timer);
        wakeUp = null;
        woken = false;
        resolve();
      }
      wakeUp = done;
    });
  }

  async function handleJobFailure(error: unknown, job: TypedJob<Payload>) {
    const message = asAppError(error)?.message || String(error);
    const kind: unknown = Reflect.get(job.payload, "kind");
    const logFailure = (action: "fail" | "retry") => {
      if (!shouldLogFailure(job)) return;
      logger[action === "fail" ? "error" : "warn"](
        "jobs",
        action === "fail" ? "Job failed" : "Job attempt failed; retrying",
        {
          queue: name,
          jobId: job.id,
          kind: typeof kind === "string" ? kind : null,
          attempt: job.attempts,
          reason: message,
          ...(error instanceof Error && { error }),
        },
      );
    };
    const finalFailure = async (reason: string) => {
      logFailure("fail");
      job.fail(reason);
      await onFinalFailure?.(job, error);
    };
    onJobError?.(error, job);
    const decision = resolveRetry?.(error, job);
    if (decision?.action === "fail") return finalFailure(decision.message ?? message);
    if (decision?.action === "retry" || job.attempts < job.maxAttempts) {
      logFailure("retry");
      job.retry(
        decision?.delayMs ?? queue.retryDelayFor(job.attempts),
        decision?.message ?? message,
      );
      return;
    }
    return finalFailure(message);
  }

  async function runJob(job: TypedJob<Payload>) {
    if (filterJob && !filterJob(job)) {
      job.ack();
      return;
    }
    onJobDequeue?.(job.payload, job);
    const controller = new AbortController();
    jobController = controller;
    activeInterruptible = canInterrupt(job.payload);
    if (stopRequested && activeInterruptible) {
      controller.abort(jobInterruption("Background worker shutting down"));
    }
    const heartbeat = setInterval(
      () => {
        const state = job.heartbeat();
        if (state === "lost") controller.abort(jobInterruption("Background job claim lost"));
        if (state === "cancelled") {
          controller.abort(Object.assign(new Error("Job cancelled"), { code: CANCELLED }));
        }
      },
      Math.min(HEARTBEAT_MAX_MS, Math.max(1000, Math.floor(queue.leaseMs / 3))),
    );
    heartbeat.unref?.();
    let waitingAttempt = false;
    const resources: { prepared?: PreparedJob | null } = {};
    let announced = false;
    activeJobCount += 1;
    try {
      await withLogContext({ job: `${name}:${job.id}` }, async () => {
        if (activeInterruptible && prepareJob) {
          if (!job.adjustAttempts(-1)) throw jobInterruption("Background job claim lost");
          waitingAttempt = true;
        }
        resources.prepared = prepareJob
          ? await prepareJob(job.payload, job, { signal: controller.signal })
          : null;
        if (waitingAttempt) {
          if (!job.adjustAttempts(1)) throw jobInterruption("Background job claim lost");
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
        await processJob(job.payload, job, { signal: controller.signal, ...resources.prepared });
      });
      if (!job.ack()) {
        logger.info("jobs", "Job finished after losing its claim", { queue: name, jobId: job.id });
      }
      onJobSuccess?.(job.payload, job);
    } catch (error) {
      const code = asAppError(error)?.code;
      if (code === INTERRUPTED) {
        job.requeue({ refundAttempt: !waitingAttempt });
      } else if (code === CANCELLED) {
        job.retry(0, "Cancelled");
      } else {
        if (waitingAttempt) job.adjustAttempts(1);
        await withLogContext({ job: `${name}:${job.id}` }, () => handleJobFailure(error, job));
      }
    } finally {
      activeJobCount -= 1;
      clearInterval(heartbeat);
      resources.prepared?.release?.();
      jobController = null;
      activeInterruptible = false;
      if (announced && process.connected && process.send) {
        process.send({ type: "job-finished", queue: name, jobId: job.id });
      }
    }
  }

  async function runLoop() {
    let failed = false;
    try {
      while (!stopRequested) {
        const job = queue.claim();
        if (!job) {
          await waitForWork();
          continue;
        }
        const parsed = v.safeParse(schema, job.payload);
        if (!parsed.success) {
          const reason = v.summarize(parsed.issues);
          logger.error("jobs", "Job payload unreadable", { queue: name, jobId: job.id, reason });
          job.fail(`Aurral can't read this job: ${reason}`);
          continue;
        }
        if (stopRequested) {
          job.requeue({ refundAttempt: true });
          break;
        }
        await reloadChangedCaches();
        await runJob(job.withPayload(parsed.output));
      }
    } catch (error) {
      failed = true;
      if (onLoopError) onLoopError(error);
      else console.error(`[${name}] loop error:`, error);
    } finally {
      running = false;
      loopPromise = null;
      stopRequested = false;
      if (failed) scheduleRestart(name, start, shouldRestart);
    }
  }

  function start() {
    if (running || shuttingDown || !ownsQueueHere(name)) return loopPromise ?? undefined;
    if (onStart && !onStart()) return;
    running = true;
    stopRequested = false;
    loopPromise = runLoop();
    return loopPromise;
  }

  function stop() {
    stopRequested = true;
    wakeUp?.();
    if (activeInterruptible) {
      jobController?.abort(jobInterruption("Background worker shutting down"));
    }
    return loopPromise ?? Promise.resolve();
  }

  const isRunning = () => running;
  workers.set(name, { stop, isRunning });
  return { start, stop, isRunning };
}

export async function shutdownJobWorkers({ timeoutMs = 30_000 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  const stops = Promise.allSettled([...workers.values()].map((worker) => worker.stop()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    stops,
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    }),
  ]);
  clearTimeout(timer);
  const stillRunning = getWorkerStatuses()
    .filter((worker) => worker.running)
    .map((worker) => worker.name);
  if (stillRunning.length) {
    console.warn(`[jobs] Shutdown timed out waiting for workers: ${stillRunning.join(", ")}`);
  }
  for (const handler of shutdownHandlers) {
    try {
      await handler();
    } catch (error) {
      console.error("[jobs] Shutdown handler error:", error);
    }
  }
}
