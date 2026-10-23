import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { ISOLATED_WORKER_GROUPS } from "./backgroundWorkerQueues.ts";
import type { getHonkerWorkerStatuses } from "./honkerWorkerRuntime.ts";
import type { WebSocketChannelPayload } from "./websocketService.ts";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";

type HonkerWorkerStatus = ReturnType<typeof getHonkerWorkerStatuses>[number];

export type WorkerMessage =
  | { type: "ready"; group: string }
  | {
      type: "heartbeat";
      group: string;
      memory: { rss: number; heapUsed: number };
      workers: HonkerWorkerStatus[];
      downloadOwnerStatus?: unknown;
    }
  | { type: "idle" }
  | { type: "busy" }
  | { type: "job-started"; queue: string; jobId: number; payload: string | null }
  | { type: "job-finished"; queue: string; jobId: number }
  | { type: "queue-wake"; queue: string }
  | { type: "cache-invalidate"; cache: "playlists" | "lidarr-artists" | "news" }
  | {
      type: "websocket-broadcast";
      channel: string;
      data: WebSocketChannelPayload;
      userId?: number | null;
    }
  | {
      type: "download-owner-client-request";
      requestId: number;
      method: string;
      args: unknown[];
      timeoutMs: number;
    }
  | { type: "download-owner-response"; requestId: number; result?: unknown; error?: undefined }
  | { type: "download-owner-response"; requestId: number; error: string; result?: undefined };

const ENTRY = fileURLToPath(new URL("./backgroundWorkerProcess.ts", import.meta.url));
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const UNRESPONSIVE_MS = 120000;
const DEMAND_POLL_MS = 2000;
const JOB_TIMEOUT_MS = Object.freeze({
  library: 6 * 60 * 60 * 1000,
  "discovery-refresh": 2 * 60 * 60 * 1000,
  "discovery-user-refresh": 2 * 60 * 60 * 1000,
  maintenance: 15 * 60 * 1000,
  inbox: 15 * 60 * 1000,
  notifications: 15 * 60 * 1000,
  "play-events": 15 * 60 * 1000,
  "release-metadata-refresh": 2 * 60 * 60 * 1000,
  "system-task": 2 * 60 * 60 * 1000,
  playback: 2 * 60 * 60 * 1000,
  "weekly-flow-operation": 2 * 60 * 60 * 1000,
  "slskd-pipeline": 6 * 60 * 60 * 1000,
  "playlist-mbid-enrichment": 2 * 60 * 60 * 1000,
});
const MB = 1024 * 1024;
const DEFAULT_HEAP_LIMIT_MB = 2048;

function workerExecArgv() {
  const execArgv = process.execArgv.filter(
    (arg) =>
      !/^--(?:watch|watch-path|inspect|inspect-brk|test(?:-.*)?|experimental-test-.*)(?:=|$)/.test(
        arg,
      ),
  );
  const configuredMb = Number(process.env.AURRAL_WORKER_MAX_HEAP_MB);
  if (Number.isInteger(configuredMb) && configuredMb > 0) {
    return [...execArgv, `--max-old-space-size=${configuredMb}`];
  }
  const userLimit = /--max[-_]old[-_]space[-_]size/.test(
    `${process.env.NODE_OPTIONS || ""} ${execArgv.join(" ")}`,
  );
  if (userLimit || DEFAULT_HEAP_LIMIT_MB * MB >= v8.getHeapStatistics().heap_size_limit)
    return execArgv;
  return [...execArgv, `--max-old-space-size=${DEFAULT_HEAP_LIMIT_MB}`];
}

// A group's process runs only while it has work: queued jobs or a due schedule
// reported by findGroupsWithWork, or flow requests. Idle processes exit.
export function createBackgroundProcessSupervisor({
  groups = ISOLATED_WORKER_GROUPS,
  findGroupsWithWork = () => [],
  getWorkRevision = null,
  getNextWorkAt = () => null,
  forkProcess = fork,
  onMessage = () => {},
  onExit = () => {},
  logger = console,
  jobTimeoutsMs = JOB_TIMEOUT_MS,
  unresponsiveMs = UNRESPONSIVE_MS,
  watchdogIntervalMs = 15000,
  demandPollMs = DEMAND_POLL_MS,
}: {
  groups?: readonly string[];
  findGroupsWithWork?: (now: number) => string[];
  getWorkRevision?: (() => unknown) | null;
  getNextWorkAt?: (now: number) => unknown;
  forkProcess?: (entry: string, args: readonly string[], options: ForkOptions) => ChildProcess;
  onMessage?: (message: WorkerMessage, group: string, child: ChildProcess) => void;
  onExit?: (
    group: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    pid: number | undefined,
    exitReason: string | null,
    retired: boolean,
  ) => void | Promise<void>;
  logger?: Pick<Console, "error" | "warn">;
  jobTimeoutsMs?: Readonly<Record<string, number | undefined>>;
  unresponsiveMs?: number;
  watchdogIntervalMs?: number;
  demandPollMs?: number;
} = {}) {
  const children = new Map();
  const restartTimers = new Map();
  const attempts = new Map();
  const lastSeen = new Map();
  const workerStatuses = new Map();
  const workerMemory = new Map();
  const activeJobs = new Map();
  const exitReasons = new Map<string, string>();
  const pendingRequests = new Map();
  const downloadOwnerStatuses = new Map();
  const readyGroups = new Set();
  const retiringGroups = new Set();
  const recoveringGroups = new Set();
  const relaunchGroups = new Set();
  let nextRequestId = 0;
  let watchdogInterval: NodeJS.Timeout | null = null;
  let demandInterval: NodeJS.Timeout | null = null;
  let demandTimer: NodeJS.Timeout | null = null;
  let lastWorkRevision: unknown = null;
  let started = false;
  let stopping = false;

  function canSend(group: string) {
    const child = children.get(group);
    return (
      Boolean(child) &&
      readyGroups.has(group) &&
      !retiringGroups.has(group) &&
      child.connected !== false
    );
  }

  function hasRequests(group: string) {
    return [...pendingRequests.values()].some((pending) => pending.group === group);
  }

  function sendRequest(requestId: number) {
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.sent || !canSend(pending.group)) return false;
    try {
      children.get(pending.group).send(pending.message);
      pending.sent = true;
    } catch (error) {
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    return true;
  }

  function flushRequests(group: string) {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.group === group) sendRequest(requestId);
    }
  }

  function describeRun(group: string) {
    const jobs = [...(activeJobs.get(group)?.values() || [])].map(
      ({ queue, jobId, payload }) => `${queue} job ${jobId}${payload ? ` ${payload}` : ""}`,
    );
    const memory = workerMemory.get(group);
    return `${jobs.length ? `; running ${jobs.join(", ")}` : ""}${
      memory
        ? `; last memory ${Math.round(memory.rss / MB)} MB RSS, ${Math.round(memory.heapUsed / MB)} MB heap`
        : ""
    }`;
  }

  function retire(group: string, child: ChildProcess) {
    if (stopping || !canSend(group) || hasRequests(group) || activeJobs.get(group)?.size) return;
    retiringGroups.add(group);
    try {
      child.send({ type: "retire" });
    } catch {
      retiringGroups.delete(group);
    }
  }

  function launch(group: string) {
    if (stopping || !started || children.has(group) || recoveringGroups.has(group)) return;
    let child;
    try {
      child = forkProcess(ENTRY, [], {
        env: { ...process.env, AURRAL_BACKGROUND_WORKER_GROUP: group },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        execArgv: workerExecArgv(),
      });
    } catch (error) {
      logger.error?.(`[BackgroundWorkers] Could not start ${group}:`, error);
      scheduleRestart(group);
      return;
    }
    children.set(group, child);
    startWatchdog();
    lastSeen.set(group, Date.now());
    const startedAt = Date.now();
    child.on("message", (message: WorkerMessage) => {
      lastSeen.set(group, Date.now());
      if (message?.type === "idle") {
        retire(group, child);
        return;
      }
      if (message?.type === "busy") {
        retiringGroups.delete(group);
        relaunchGroups.delete(group);
        flushRequests(group);
        return;
      }
      if (message?.type === "ready") {
        readyGroups.add(group);
        flushRequests(group);
      }
      if (message?.type === "heartbeat" && Array.isArray(message.workers)) {
        workerStatuses.set(group, message.workers);
        if (message.memory) workerMemory.set(group, message.memory);
        if (message.downloadOwnerStatus)
          downloadOwnerStatuses.set(group, message.downloadOwnerStatus);
      }
      if (message?.type === "download-owner-response") {
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
          queue: message.queue,
          jobId: message.jobId,
          startedAt: Date.now(),
          payload: typeof message.payload === "string" ? message.payload : null,
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
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      const run = describeRun(group);
      if (children.get(group) === child) children.delete(group);
      if (!children.size) {
        if (watchdogInterval) clearInterval(watchdogInterval);
        watchdogInterval = null;
      }
      lastWorkRevision = null;
      const retiring = retiringGroups.delete(group);
      readyGroups.delete(group);
      lastSeen.delete(group);
      workerStatuses.delete(group);
      workerMemory.delete(group);
      activeJobs.delete(group);
      downloadOwnerStatuses.delete(group);
      for (const [id, pending] of pendingRequests) {
        if (pending.group !== group || !pending.sent) continue;
        pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`${group} worker exited before responding`));
      }
      const exitReason = exitReasons.get(group) || null;
      exitReasons.delete(group);
      if (stopping) return;
      const retired = retiring && code === 0 && !exitReason;
      if (!retired) {
        if (Date.now() - startedAt > 60000) attempts.delete(group);
        logger.warn?.(`[BackgroundWorkers] ${group} exited (${signal || code})${run}; restarting`);
      }
      recoveringGroups.add(group);
      Promise.resolve()
        .then(() => onExit(group, code, signal, child.pid, exitReason, retired))
        .catch((error) => {
          logger.error?.(`[BackgroundWorkers] Could not handle ${group} exit:`, error);
        })
        .finally(() => {
          recoveringGroups.delete(group);
          const wanted = relaunchGroups.delete(group) || hasRequests(group);
          if (!retired) scheduleRestart(group);
          else if (wanted) launch(group);
        });
    };
    child.once("exit", handleExit);
    child.once("close", handleExit);
  }

  function scheduleRestart(group: string) {
    if (stopping || restartTimers.has(group)) return;
    const count = attempts.get(group) || 0;
    attempts.set(group, count + 1);
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(count, 5));
    const timer = setTimeout(() => {
      restartTimers.delete(group);
      launch(group);
    }, delay);
    timer.unref?.();
    restartTimers.set(group, timer);
  }

  function ensure(group: string) {
    if (!started || stopping || !groups.includes(group)) return false;
    if (retiringGroups.has(group) || recoveringGroups.has(group)) relaunchGroups.add(group);
    else if (!restartTimers.has(group)) launch(group);
    return true;
  }

  function launchGroupsWithWork() {
    if (!started || stopping) return;
    try {
      const inspectedAt = Date.now();
      const revision = getWorkRevision?.();
      for (const group of findGroupsWithWork(inspectedAt)) ensure(group);
      const nextWorkAt = Number(getNextWorkAt(inspectedAt));
      if (demandTimer) clearTimeout(demandTimer);
      demandTimer = null;
      if (nextWorkAt > 0) {
        demandTimer = setTimeout(
          launchGroupsWithWork,
          Math.max(1, Math.min(nextWorkAt - Date.now(), 2147483647)),
        );
        demandTimer.unref?.();
      }
      lastWorkRevision = revision;
    } catch (error) {
      lastWorkRevision = null;
      logger.warn?.(
        "[BackgroundWorkers] Could not check for queued work:",
        asAppError(error)?.message || error,
      );
    }
  }

  function checkDemand() {
    try {
      if (!getWorkRevision || getWorkRevision() !== lastWorkRevision) launchGroupsWithWork();
    } catch (error) {
      logger.warn?.(
        "[BackgroundWorkers] Could not check database changes:",
        asAppError(error)?.message || error,
      );
      launchGroupsWithWork();
    }
  }

  function jobTimeoutFor(key: string) {
    return isOwnKey(jobTimeoutsMs, key) ? jobTimeoutsMs[key] : undefined;
  }

  function startWatchdog() {
    if (watchdogInterval) return;
    watchdogInterval = setInterval(() => {
      for (const [group, child] of children) {
        const unresponsive = Date.now() - (lastSeen.get(group) || 0) > unresponsiveMs;
        const job = [...(activeJobs.get(group)?.values() || [])].find((entry) => {
          const limit = jobTimeoutFor(entry.queue) || jobTimeoutFor(group);
          return limit && Date.now() - entry.startedAt > limit;
        });
        const jobTimedOut = Boolean(job);
        if (!unresponsive && !jobTimedOut) continue;
        const reason = jobTimedOut
          ? `${group} ${job.queue || "worker"} job ${job.jobId} timed out`
          : `${group} worker stopped responding`;
        exitReasons.set(group, reason);
        logger.error?.(`[BackgroundWorkers] ${reason}${describeRun(group)}; restarting its worker`);
        lastSeen.set(group, Date.now());
        activeJobs.delete(group);
        try {
          child.kill("SIGKILL");
        } catch (error) {
          logger.error?.(`[BackgroundWorkers] Could not stop ${group}:`, error);
        }
      }
    }, watchdogIntervalMs);
    watchdogInterval.unref?.();
  }

  function start() {
    if (started) return false;
    started = true;
    launchGroupsWithWork();
    demandInterval = setInterval(checkDemand, demandPollMs);
    demandInterval.unref?.();
    return true;
  }

  async function stop({ timeoutMs = 3000 }: { timeoutMs?: number } = {}) {
    stopping = true;
    if (demandInterval) clearInterval(demandInterval);
    demandInterval = null;
    if (demandTimer) clearTimeout(demandTimer);
    demandTimer = null;
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = null;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    const pending = [...children.values()].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          let timer: NodeJS.Timeout | null = null;
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
              try {
                child.kill("SIGKILL");
              } catch {}
              resolve();
            }, timeoutMs);
          }
        }),
    );
    await Promise.all(pending);
    children.clear();
    readyGroups.clear();
    retiringGroups.clear();
    relaunchGroups.clear();
    workerStatuses.clear();
    workerMemory.clear();
    activeJobs.clear();
    exitReasons.clear();
    downloadOwnerStatuses.clear();
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Background workers stopped"));
    }
    pendingRequests.clear();
  }

  function request(
    group: string,
    method: string,
    args: unknown[] = [],
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ) {
    if (!started || stopping || !groups.includes(group)) {
      return Promise.reject(new Error(`${group} worker is unavailable`));
    }
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequestId;
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`${group} worker request timed out: ${method}`));
      }, timeoutMs);
      pendingRequests.set(requestId, {
        group,
        resolve,
        reject,
        timer,
        sent: false,
        message: { type: "download-owner-command", requestId, method, args },
      });
      if (!sendRequest(requestId)) ensure(group);
    });
  }

  function wake(group: string) {
    if (!canSend(group)) {
      launchGroupsWithWork();
      return false;
    }
    try {
      children.get(group).send({ type: "queue-wake" });
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
    getDownloadOwnerStatus: () => downloadOwnerStatuses.get("downloads") || null,
    request,
    wake,
  };
}
