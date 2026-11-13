import PQueue from "p-queue";
import { reserveMetadataProviderRequest } from "../metadataProviderBudget.ts";

const createError = (message: string, code: string) => Object.assign(new Error(message), { code });

type ScheduleOptions = { signal?: AbortSignal; timeoutMs?: number; priority?: number };

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Background workers are separate processes, so a service's pace is booked in
// SQLite by wall clock. A booking more than one turn ahead means the clock went
// back, and the process paces itself alone instead of waiting it out.
async function waitForSharedTurn(service: string, intervalMs: number, signal?: AbortSignal) {
  let waitMs;
  while ((waitMs = reserveMetadataProviderRequest(service, intervalMs)) > 0) {
    if (waitMs > intervalMs) return;
    signal?.throwIfAborted();
    await sleep(waitMs, signal);
  }
}

export default function createRateLimiter(
  minTime: number,
  {
    maxQueue = Infinity,
    check,
    shared,
  }: { maxQueue?: number; check?: () => void; shared?: string } = {},
) {
  const intervalMs = Math.max(0, Number(minTime) || 0);
  const takeTurn = async <T>(run: () => T, signal: AbortSignal | undefined) => {
    if (shared && intervalMs > 0) await waitForSharedTurn(shared, intervalMs, signal);
    return run();
  };
  const queue = new PQueue({
    interval: intervalMs,
    intervalCap: 1,
    strict: intervalMs > 0,
  });

  function schedule<T>(
    fn: (remainingMs: number) => T,
    options: ScheduleOptions & { timeoutMs: number },
  ): Promise<Awaited<T>>;
  function schedule<T>(fn: () => T, options?: ScheduleOptions): Promise<Awaited<T>>;
  function schedule<T>(
    fn: (...args: number[]) => T,
    { signal, timeoutMs, priority = 0 }: ScheduleOptions = {},
  ) {
    if (typeof fn !== "function") {
      return Promise.reject(new TypeError("Rate limiter callback must be a function"));
    }
    try {
      check?.();
    } catch (error) {
      return Promise.reject(error);
    }
    if (queue.size >= maxQueue) {
      return Promise.reject(createError("Rate limiter queue is full", "EQUEUEFULL"));
    }

    const parsedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(parsedTimeoutMs)) {
      return queue.add(() => takeTurn(() => fn(), signal), { signal, priority });
    }

    const deadline = Date.now() + Math.max(0, parsedTimeoutMs);
    const expired = new AbortController();
    const timer = setTimeout(
      () => expired.abort(createError("Rate limiter request deadline exceeded", "ETIMEDOUT")),
      Math.max(0, parsedTimeoutMs),
    );
    const signals = signal ? [signal, expired.signal] : [expired.signal];
    const queuedSignal = AbortSignal.any(signals);
    return queue
      .add(
        () =>
          takeTurn(() => {
            clearTimeout(timer);
            return fn(deadline - Date.now());
          }, queuedSignal),
        { signal: queuedSignal, priority },
      )
      .finally(() => clearTimeout(timer));
  }

  let resumeAt = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const pauseFor = (ms: number) => {
    const until = Date.now() + Math.max(0, Number(ms) || 0);
    if (until <= resumeAt) return;
    resumeAt = until;
    queue.pause();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => queue.start(), until - Date.now());
  };

  return {
    schedule,
    pauseFor,
    wrap<A extends unknown[], R>(fn: (...args: A) => R) {
      return (...args: A) => schedule(() => fn(...args));
    },
  };
}
