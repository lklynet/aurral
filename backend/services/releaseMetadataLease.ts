import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../config/db-sqlite.ts";
import { WORKER_ID, ownsLock, releaseLock, renewLock, tryLock } from "./jobs/queue.ts";
import { jobInterruption } from "./jobs/worker.ts";

const LOCK_NAME = "release-metadata-refresh";
const TTL_MS = 120_000;

export async function acquireReleaseMetadataLease({ signal }: { signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(jobInterruption("Metadata refresh interrupted"));
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const owner = `${WORKER_ID}:${randomUUID()}`;
  try {
    while (!tryLock(LOCK_NAME, owner, TTL_MS)) {
      controller.signal.throwIfAborted();
      await delay(250, undefined, { signal: controller.signal });
    }
  } catch (error) {
    signal?.removeEventListener("abort", interrupt);
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  }
  const heartbeat = setInterval(() => {
    try {
      if (!renewLock(LOCK_NAME, owner, TTL_MS)) interrupt();
    } catch {
      interrupt();
    }
  }, 30_000);
  heartbeat.unref();
  const write = db.transaction((fn: () => unknown) => {
    controller.signal.throwIfAborted();
    if (!ownsLock(LOCK_NAME, owner)) {
      interrupt();
      throw controller.signal.reason;
    }
    return fn();
  });
  return {
    signal: controller.signal,
    write,
    release() {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", interrupt);
      try {
        releaseLock(LOCK_NAME, owner);
      } catch {}
    },
  };
}
