import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../config/db-sqlite.js";
import { getHonkerDb } from "./honkerDb.js";
import { honkerJobInterruption } from "./honkerWorkerRuntime.js";

const LOCK_NAME = "release-metadata-refresh";
const TTL_SECONDS = 120;

export async function acquireReleaseMetadataLease({ signal } = {}) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(honkerJobInterruption("Metadata refresh interrupted"));
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const owner = `metadata-${process.pid}-${randomUUID()}`;
  let lock;
  try {
    while (!lock) {
      controller.signal.throwIfAborted();
      lock = getHonkerDb().tryLock(LOCK_NAME, owner, TTL_SECONDS);
      if (!lock) await delay(250, undefined, { signal: controller.signal });
    }
  } catch (error) {
    signal?.removeEventListener("abort", interrupt);
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  }
  const heartbeat = setInterval(() => {
    try {
      if (!lock.heartbeat(TTL_SECONDS)) interrupt();
    } catch {
      interrupt();
    }
  }, 30000);
  heartbeat.unref();
  const write = db.transaction((fn) => {
    controller.signal.throwIfAborted();
    const held = db.prepare(
      "SELECT 1 FROM _honker_locks WHERE name = ? AND owner = ? AND expires_at > unixepoch()",
    ).get(LOCK_NAME, owner);
    if (!held) {
      interrupt();
      throw controller.signal.reason;
    }
    return fn();
  });
  return {
    signal: controller.signal,
    write(fn) { return write.immediate(fn); },
    release() {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", interrupt);
      try { lock.release(); } catch {}
    },
  };
}
