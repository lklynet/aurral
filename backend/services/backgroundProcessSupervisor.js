import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ISOLATED_WORKER_GROUPS } from "./backgroundWorkerQueues.js";

const ENTRY = fileURLToPath(new URL("./backgroundWorkerProcess.js", import.meta.url));
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const UNRESPONSIVE_MS = 120000;
const JOB_TIMEOUT_MS = Object.freeze({
  library: 6 * 60 * 60 * 1000,
  "discovery-refresh": 2 * 60 * 60 * 1000,
  "discovery-playlist-build": 2 * 60 * 60 * 1000,
  "discovery-user-refresh": 2 * 60 * 60 * 1000,
  maintenance: 15 * 60 * 1000,
  inbox: 15 * 60 * 1000,
  notifications: 15 * 60 * 1000,
  "play-events": 15 * 60 * 1000,
  "system-task": 2 * 60 * 60 * 1000,
  "weekly-flow-operation": 2 * 60 * 60 * 1000,
  "slskd-pipeline": 6 * 60 * 60 * 1000,
  "playlist-retry": 60 * 60 * 1000,
  "playlist-reserve-build": 2 * 60 * 60 * 1000,
  "playlist-mbid-enrichment": 2 * 60 * 60 * 1000,
});

export function createBackgroundProcessSupervisor({
  groups = ISOLATED_WORKER_GROUPS,
  forkProcess = fork,
  onMessage = () => {},
  onExit = () => {},
  logger = console,
  jobTimeoutsMs = JOB_TIMEOUT_MS,
  unresponsiveMs = UNRESPONSIVE_MS,
  watchdogIntervalMs = 15000,
} = {}) {
  const children = new Map();
  const restartTimers = new Map();
  const attempts = new Map();
  const lastSeen = new Map();
  const workerStatuses = new Map();
  const activeJobs = new Map();
  const exitReasons = new Map();
  const pendingRequests = new Map();
  const flowStatuses = new Map();
  let nextRequestId = 0;
  let watchdogInterval = null;
  let started = false;
  let stopping = false;

  function launch(group) {
    if (stopping || children.has(group)) return;
    let child;
    try {
      child = forkProcess(ENTRY, [], {
        env: { ...process.env, AURRAL_BACKGROUND_WORKER_GROUP: group },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        execArgv: process.execArgv.filter((arg) =>
          !/^--(?:watch|watch-path|inspect|inspect-brk|test(?:-.*)?|experimental-test-.*)(?:=|$)/.test(arg)),
      });
    } catch (error) {
      logger.error?.(`[BackgroundWorkers] Could not start ${group}:`, error);
      scheduleRestart(group);
      return;
    }
    children.set(group, child);
    lastSeen.set(group, Date.now());
    const startedAt = Date.now();
    child.on("message", (message) => {
      lastSeen.set(group, Date.now());
      if (message?.type === "heartbeat" && Array.isArray(message.workers)) {
        workerStatuses.set(group, message.workers);
        if (message.flowStatus) flowStatuses.set(group, message.flowStatus);
      }
      if (message?.type === "flow-response") {
        const pending = pendingRequests.get(message.requestId);
        if (pending && pending.group === group) {
          pendingRequests.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        }
        return;
      }
      if (message?.type === "job-started" && Number.isInteger(message.jobId)) {
        if (!activeJobs.has(group)) activeJobs.set(group, new Map());
        activeJobs.get(group).set(`${message.queue}:${message.jobId}`, {
          queue: message.queue, jobId: message.jobId, startedAt: Date.now(),
        });
      } else if (message?.type === "job-finished") {
        activeJobs.get(group)?.delete(`${message.queue}:${message.jobId}`);
      }
      try {
        onMessage(message, group, child);
      } catch (error) {
        logger.error?.(`[BackgroundWorkers] Could not handle ${group} message:`, error);
      }
    });
    child.once("error", (error) => {
      logger.error?.(`[BackgroundWorkers] ${group} process error:`, error);
    });
    let exited = false;
    const handleExit = (code, signal) => {
      if (exited) return;
      exited = true;
      if (children.get(group) === child) children.delete(group);
      lastSeen.delete(group);
      workerStatuses.delete(group);
      activeJobs.delete(group);
      flowStatuses.delete(group);
      for (const [id, pending] of pendingRequests) {
        if (pending.group !== group) continue;
        pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`${group} worker exited before responding`));
      }
      const exitReason = exitReasons.get(group) || null;
      exitReasons.delete(group);
      if (stopping) return;
      if (Date.now() - startedAt > 60000) attempts.delete(group);
      logger.warn?.(`[BackgroundWorkers] ${group} exited (${signal || code}); restarting`);
      Promise.resolve().then(() => onExit(group, code, signal, child.pid, exitReason))
        .catch((error) => {
          logger.error?.(`[BackgroundWorkers] Could not handle ${group} exit:`, error);
        })
        .finally(() => scheduleRestart(group));
    };
    child.once("exit", handleExit);
    child.once("close", handleExit);
  }

  function scheduleRestart(group) {
    if (stopping || restartTimers.has(group)) return;
    const count = attempts.get(group) || 0;
    attempts.set(group, count + 1);
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * (2 ** Math.min(count, 5)));
    const timer = setTimeout(() => {
      restartTimers.delete(group);
      launch(group);
    }, delay);
    timer.unref?.();
    restartTimers.set(group, timer);
  }

  function start() {
    if (started) return false;
    started = true;
    for (const group of groups) launch(group);
    watchdogInterval = setInterval(() => {
      for (const [group, child] of children) {
        const unresponsive = Date.now() - (lastSeen.get(group) || 0) > unresponsiveMs;
        const job = [...(activeJobs.get(group)?.values() || [])].find((entry) => {
          const limit = jobTimeoutsMs[entry.queue] || jobTimeoutsMs[group];
          return limit && Date.now() - entry.startedAt > limit;
        });
        const jobTimedOut = Boolean(job);
        if (!unresponsive && !jobTimedOut) continue;
        const reason = jobTimedOut
          ? `${group} ${job.queue || "worker"} job ${job.jobId} timed out`
          : `${group} worker stopped responding`;
        exitReasons.set(group, reason);
        logger.error?.(`[BackgroundWorkers] ${reason}; restarting its worker`);
        lastSeen.set(group, Date.now());
        activeJobs.delete(group);
        try { child.kill("SIGKILL"); } catch (error) {
          logger.error?.(`[BackgroundWorkers] Could not stop ${group}:`, error);
        }
      }
    }, watchdogIntervalMs);
    watchdogInterval.unref?.();
    return true;
  }

  async function stop({ timeoutMs = 3000 } = {}) {
    stopping = true;
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = null;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    const pending = [...children.values()].map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let timer = null;
      let exited = false;
      const done = () => {
        if (exited) return;
        exited = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.once("exit", done);
      child.once("close", done);
      try {
        child.send({ type: "shutdown" });
      } catch {
        child.kill();
      }
      if (!exited) {
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, timeoutMs);
      }
    }));
    await Promise.all(pending);
    children.clear();
    workerStatuses.clear();
    activeJobs.clear();
    exitReasons.clear();
    flowStatuses.clear();
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Background workers stopped"));
    }
    pendingRequests.clear();
  }

  function request(group, method, args = [], { timeoutMs = 30000 } = {}) {
    const child = children.get(group);
    if (!child?.connected && child?.connected !== undefined) {
      return Promise.reject(new Error(`${group} worker is unavailable`));
    }
    if (!child) return Promise.reject(new Error(`${group} worker is unavailable`));
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequestId;
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`${group} worker request timed out: ${method}`));
      }, timeoutMs);
      pendingRequests.set(requestId, { group, resolve, reject, timer });
      try {
        child.send({ type: "flow-command", requestId, method, args });
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  function wake(group) {
    const child = children.get(group);
    if (!child || child.connected === false) return false;
    try {
      child.send({ type: "queue-wake" });
      return true;
    } catch (error) {
      logger.warn?.(`[BackgroundWorkers] Could not wake ${group}:`, error);
      return false;
    }
  }

  return {
    start,
    stop,
    getGroups: () => [...children.keys()],
    getWorkerStatuses: () => [...workerStatuses.values()].flat(),
    getFlowStatus: () => flowStatuses.get("flow") || null,
    request,
    wake,
  };
}
