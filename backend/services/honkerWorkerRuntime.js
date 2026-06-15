const workers = new Map();
const restartTimers = new Map();
const restartAttempts = new Map();
const shutdownHandlers = [];

let shuttingDown = false;

export function isHonkerShuttingDown() {
  return shuttingDown;
}

export function withJobHeartbeat(job, queue, fn, extendSeconds = null) {
  const visibilityTimeoutS = Number(queue?.visibilityTimeoutS) || 300;
  const extendS =
    extendSeconds != null
      ? Number(extendSeconds)
      : Math.max(60, Math.floor(visibilityTimeoutS * 0.5));
  const heartbeatMs = Math.max(1000, Math.floor(extendS * 1000 * 0.33));
  const heartbeat = setInterval(() => {
    try {
      job.heartbeat(extendS);
    } catch {}
  }, heartbeatMs);
  return Promise.resolve(fn()).finally(() => clearInterval(heartbeat));
}

export function registerHonkerWorker(name, { start, stop, isRunning }) {
  workers.set(String(name), { start, stop, isRunning });
}

export function registerHonkerShutdownHandler(handler) {
  if (typeof handler === "function") {
    shutdownHandlers.push(handler);
  }
}

export function scheduleHonkerComponentRestart(name, startFn, options = {}) {
  if (shuttingDown || process.env.NODE_ENV === "test") return;
  const safeName = String(name || "component");
  const shouldRestart =
    typeof options.shouldRestart === "function"
      ? options.shouldRestart
      : () => true;
  if (!shouldRestart()) return;

  const attempts = Number(restartAttempts.get(safeName) || 0);
  const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
  restartAttempts.set(safeName, attempts + 1);

  const existing = restartTimers.get(safeName);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    restartTimers.delete(safeName);
    if (shuttingDown || !shouldRestart()) return;
    try {
      startFn();
      restartAttempts.set(safeName, 0);
    } catch (error) {
      console.error(`[honkerRuntime] failed to restart ${safeName}:`, error);
      scheduleHonkerComponentRestart(safeName, startFn, options);
    }
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  restartTimers.set(safeName, timer);
}

export function markHonkerWorkerLoopEnded(name, startFn, options = {}) {
  const safeName = String(name || "worker");
  if (options.intentional || shuttingDown) return;
  const entry = workers.get(safeName);
  if (entry?.isRunning?.()) return;
  scheduleHonkerComponentRestart(safeName, startFn, options);
}

export async function shutdownHonkerInfrastructure({
  timeoutMs = 30000,
} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const timer of restartTimers.values()) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  try {
    const { stopHonkerScheduler } = await import("./honkerDb.js");
    stopHonkerScheduler();
  } catch {}

  for (const [, entry] of workers) {
    try {
      entry.stop?.();
    } catch {}
  }

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const anyRunning = [...workers.values()].some((entry) => entry.isRunning?.());
    if (!anyRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  for (const handler of shutdownHandlers) {
    try {
      await handler();
    } catch (error) {
      console.error("[honkerRuntime] shutdown handler error:", error);
    }
  }

  try {
    const { closeHonkerDb } = await import("./honkerDb.js");
    closeHonkerDb();
  } catch {}
}
