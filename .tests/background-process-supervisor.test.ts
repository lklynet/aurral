import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { test, vi } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { setupIsolatedBackend, cleanupIsolatedState } from "./helpers/backendTestHarness.ts";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.ts";
import {
  ISOLATED_WORKER_GROUPS,
  isQueueOwnedByGroup,
  shouldStartQueueHere,
} from "../backend/services/backgroundWorkerQueues.ts";

test("only the owning process supervises isolated queues", () => {
  assert.deepEqual(ISOLATED_WORKER_GROUPS, [
    "release-metadata",
    "library",
    "discovery-refresh",
    "discovery-user-refresh",
    "maintenance",
    "inbox",
    "notifications",
    "play-events",
    "downloads",
    "scheduler",
  ]);
  assert.equal(isQueueOwnedByGroup("library-scan"), false);
  assert.equal(isQueueOwnedByGroup("library-scan", "library"), true);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "library"), false);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "discovery-refresh"), true);
  assert.equal(isQueueOwnedByGroup("system-task-inbox", "inbox"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:notifications", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:play-events", "play-events"), true);
  assert.equal(isQueueOwnedByGroup("notification-outbox", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("system-task", "downloads"), true);
  assert.equal(isQueueOwnedByGroup("release-metadata-refresh", "release-metadata"), true);
  assert.equal(isQueueOwnedByGroup("release-metadata-refresh", "downloads"), false);
  assert.equal(isQueueOwnedByGroup("weekly-flow-operation", "downloads"), true);
  assert.equal(isQueueOwnedByGroup("slskd-pipeline", "downloads"), true);
  assert.equal(isQueueOwnedByGroup("system-task"), false);
  assert.equal(isQueueOwnedByGroup("system-task", "library"), false);
  assert.equal(isQueueOwnedByGroup("playlist-mbid-enrichment", "downloads"), true);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
    assert.equal(shouldStartQueueHere("library-scan"), false);
    assert.equal(shouldStartQueueHere("system-task"), false);
    process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
    assert.equal(shouldStartQueueHere("library-scan"), true);
    assert.equal(shouldStartQueueHere("system-task"), false);
    assert.equal(shouldStartQueueHere("discovery-refresh"), false);
    process.env.AURRAL_BACKGROUND_WORKER_GROUP = "downloads";
    assert.equal(shouldStartQueueHere("system-task"), true);
    assert.equal(shouldStartQueueHere("weekly-flow-operation"), true);
    assert.equal(shouldStartQueueHere("library-scan"), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
    else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  }
});

const quietLogger = { warn() {}, error() {} };
const heapFixture = fileURLToPath(
  new URL("./fixtures/heap-limit-background-child.mts", import.meta.url),
);

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function forkHeapFixture(onReady) {
  return (_entry, _args, options) => {
    const child = fork(heapFixture, [], {
      ...options,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.once("message", () => onReady(child));
    return child;
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeFork() {
  const launches = [];
  const forkProcess = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.group = options.env.AURRAL_BACKGROUND_WORKER_GROUP;
    child.exitCode = null;
    child.signalCode = null;
    child.connected = true;
    child.sent = [];
    child.send = (message) => {
      child.sent.push(message);
      if (message.type === "shutdown") {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
    };
    child.kill = () => {};
    launches.push(child);
    return child;
  };
  return { launches, forkProcess };
}

function exitIdle(child) {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

function reply(child, result) {
  const command = child.sent.findLast((message) => message.type === "download-owner-command");
  child.emit("message", { type: "download-owner-response", requestId: command.requestId, result });
  return command.method;
}

test("supervisor launches only groups with work, forwards messages, and stops without respawning", async () => {
  const { launches, forkProcess } = createFakeFork();
  const messages = [];
  let withWork = ["library"];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library", "discovery"],
    findGroupsWithWork: () => withWork,
    forkProcess,
    onMessage: (message, group) => messages.push({ message, group }),
  });

  assert.equal(supervisor.start(), true);
  assert.equal(supervisor.start(), false);
  assert.deepEqual(
    launches.map((child) => child.group),
    ["library"],
  );
  launches[0].emit("message", { type: "websocket-broadcast", channel: "library" });
  assert.deepEqual(messages, [
    { message: { type: "websocket-broadcast", channel: "library" }, group: "library" },
  ]);
  launches[0].emit("message", {
    type: "heartbeat",
    workers: [{ name: "library-scan", running: true }],
  });
  assert.deepEqual(supervisor.getWorkerStatuses(), [{ name: "library-scan", running: true }]);

  withWork = ["library", "discovery"];
  assert.equal(supervisor.wake("discovery"), false);
  assert.deepEqual(
    launches.map((child) => child.group),
    ["library", "discovery"],
  );
  assert.equal(supervisor.wake("discovery"), false);
  launches[1].emit("message", { type: "ready" });
  assert.equal(supervisor.wake("discovery"), true);
  assert.deepEqual(launches[1].sent, [{ type: "queue-wake" }]);
  assert.equal(supervisor.wake("missing"), false);

  await supervisor.stop();
  assert.deepEqual(
    launches.map((child) => child.sent),
    [[{ type: "shutdown" }], [{ type: "queue-wake" }, { type: "shutdown" }]],
  );
  assert.deepEqual(supervisor.getGroups(), []);
  assert.deepEqual(supervisor.getWorkerStatuses(), []);
});

test("an idle worker exits without a restart and returns when work arrives", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: 0,
  });
  const { launches, forkProcess } = createFakeFork();
  const exits = [];
  const warnings = [];
  let withWork = ["library"];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => withWork,
    forkProcess,
    logger: { warn: (...args) => warnings.push(args), error() {} },
    onExit: (group, _code, _signal, _pid, _reason, retired) => {
      exits.push({ group, retired });
    },
  });
  try {
    supervisor.start();
    launches[0].emit("message", { type: "ready" });
    withWork = [];
    launches[0].emit("message", { type: "idle" });
    assert.deepEqual(launches[0].sent, [{ type: "retire" }]);
    exitIdle(launches[0]);
    await flush();
    vi.advanceTimersByTime(60000);
    await flush();
    assert.equal(launches.length, 1);
    assert.deepEqual(supervisor.getGroups(), []);
    assert.deepEqual(exits, [{ group: "library", retired: true }]);
    assert.deepEqual(warnings, []);

    withWork = ["library"];
    vi.advanceTimersByTime(2000);
    assert.equal(launches.length, 2);
  } finally {
    await supervisor.stop();
  }
});

test("a flow request starts its worker and holds off retirement until answered", async () => {
  const { launches, forkProcess } = createFakeFork();
  const supervisor = createBackgroundProcessSupervisor({ groups: ["downloads"], forkProcess });
  try {
    supervisor.start();
    assert.equal(launches.length, 0);
    const pending = supervisor.request("downloads", "waitForIdle");
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].sent, []);
    launches[0].emit("message", { type: "ready" });
    launches[0].emit("message", { type: "idle" });
    assert.equal(
      launches[0].sent.some((message) => message.type === "retire"),
      false,
    );
    assert.equal(reply(launches[0], true), "waitForIdle");
    assert.equal(await pending, true);
    launches[0].emit("message", { type: "idle" });
    assert.deepEqual(launches[0].sent.at(-1), { type: "retire" });
  } finally {
    await supervisor.stop();
  }
});

test("a flow request made while its worker retires reaches the next worker", async () => {
  const { launches, forkProcess } = createFakeFork();
  const supervisor = createBackgroundProcessSupervisor({ groups: ["downloads"], forkProcess });
  try {
    supervisor.start();
    const first = supervisor.request("downloads", "start");
    launches[0].emit("message", { type: "ready" });
    reply(launches[0], true);
    await first;
    launches[0].emit("message", { type: "idle" });
    const second = supervisor.request("downloads", "wakeOrStart");
    assert.deepEqual(launches[0].sent.at(-1), { type: "retire" });
    exitIdle(launches[0]);
    await flush();
    assert.equal(launches.length, 2);
    launches[1].emit("message", { type: "ready" });
    assert.equal(reply(launches[1], "woken"), "wakeOrStart");
    assert.equal(await second, "woken");
  } finally {
    await supervisor.stop();
  }
});

test("a worker that is busy again keeps running and receives waiting requests", async () => {
  const { launches, forkProcess } = createFakeFork();
  const supervisor = createBackgroundProcessSupervisor({ groups: ["downloads"], forkProcess });
  try {
    supervisor.start();
    const first = supervisor.request("downloads", "start");
    launches[0].emit("message", { type: "ready" });
    reply(launches[0], true);
    await first;
    launches[0].emit("message", { type: "idle" });
    const second = supervisor.request("downloads", "blockPlaylist", ["disposable"]);
    launches[0].emit("message", { type: "busy" });
    assert.equal(reply(launches[0], true), "blockPlaylist");
    assert.equal(await second, true);
    assert.equal(launches.length, 1);
  } finally {
    await supervisor.stop();
  }
});

test("supervisor restarts an unexpectedly exited worker", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: 0,
  });
  const children = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => ["library"],
    logger: quietLogger,
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = () => queueMicrotask(() => child.emit("exit", 0, null));
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    children[0].exitCode = 1;
    children[0].emit("close", 1, null);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(children.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(children.length, 2);
    assert.deepEqual(supervisor.getGroups(), ["library"]);
  } finally {
    await supervisor.stop();
  }
});

test("flow requests return replies and reject when their owner exits", async () => {
  const { launches, forkProcess } = createFakeFork();
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["downloads"],
    logger: quietLogger,
    forkProcess,
  });
  try {
    supervisor.start();
    const first = supervisor.request("downloads", "start");
    launches[0].emit("message", { type: "ready" });
    const request = launches[0].sent.at(-1);
    assert.equal(request.type, "download-owner-command");
    assert.equal(request.method, "start");
    reply(launches[0], true);
    assert.equal(await first, true);

    launches[0].emit("message", {
      type: "heartbeat",
      workers: [],
      downloadOwnerStatus: { running: true },
    });
    assert.deepEqual(supervisor.getDownloadOwnerStatus(), { running: true });
    const pending = supervisor.request("downloads", "waitForIdle");
    launches[0].emit("exit", 1, null);
    await assert.rejects(pending, /exited before responding/);
    assert.equal(supervisor.getDownloadOwnerStatus(), null);
  } finally {
    await supervisor.stop();
  }
});

test("flow restart waits for job recovery", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: 0,
  });
  const children = [];
  let finishRecovery;
  const recovery = new Promise((resolve) => {
    finishRecovery = resolve;
  });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["downloads"],
    findGroupsWithWork: () => ["downloads"],
    logger: quietLogger,
    onExit: () => recovery,
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(60000);
    assert.equal(children.length, 1);
    finishRecovery();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(children.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(children.length, 2);
  } finally {
    await supervisor.stop();
  }
});

test("only the worker with an overdue job is terminated", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: 0,
  });
  const children = new Map();
  const killed = [];
  const errors = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["inbox", "maintenance"],
    findGroupsWithWork: () => ["inbox", "maintenance"],
    jobTimeoutsMs: { inbox: 25, maintenance: 25 },
    unresponsiveMs: 1000,
    watchdogIntervalMs: 10,
    logger: { warn() {}, error: (line) => errors.push(line) },
    forkProcess: (_entry, _args, options) => {
      const group = options.env.AURRAL_BACKGROUND_WORKER_GROUP;
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {
        killed.push(group);
      };
      children.set(group, child);
      return child;
    },
  });
  try {
    supervisor.start();
    children.get("inbox").emit("message", {
      type: "heartbeat",
      workers: [],
      memory: { rss: 300 * 1024 * 1024, heapUsed: 200 * 1024 * 1024 },
    });
    children.get("inbox").emit("message", {
      type: "job-started",
      queue: "system-task-inbox",
      jobId: 42,
      payload: '{"kind":"disposable"}',
    });
    vi.advanceTimersByTime(20);
    assert.deepEqual(killed, []);
    vi.advanceTimersByTime(45);
    assert.deepEqual(killed, ["inbox"]);
    assert.deepEqual(supervisor.getGroups(), ["inbox", "maintenance"]);
    assert.deepEqual(errors, [
      '[BackgroundWorkers] inbox system-task-inbox job 42 timed out; running system-task-inbox job 42 {"kind":"disposable"}; last memory 300 MB RSS, 200 MB heap; restarting its worker',
    ]);
  } finally {
    await supervisor.stop();
  }
});

test("a worker that runs out of heap stops at the configured limit and the log names its job", async (t) => {
  withEnv(t, "NODE_OPTIONS", undefined);
  withEnv(t, "AURRAL_WORKER_MAX_HEAP_MB", "64");
  const warned = Promise.withResolvers();
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["notifications"],
    findGroupsWithWork: () => ["notifications"],
    logger: { warn: (line) => warned.resolve(line), error() {} },
    forkProcess: forkHeapFixture((child) =>
      child.send({
        type: "run-job",
        queue: "_outbox:notifications",
        jobId: 42,
        payload: '{"kind":"disposable"}',
        defaultHeapLimit: v8.getHeapStatistics().heap_size_limit,
      }),
    ),
  });
  t.onTestFinished(() => supervisor.stop());
  supervisor.start();
  assert.match(
    await warned.promise,
    /^\[BackgroundWorkers\] notifications exited \(SIGABRT\); running _outbox:notifications job 42 \{"kind":"disposable"\}; last memory \d+ MB RSS, \d+ MB heap; restarting$/,
  );
});

test("a heap limit set in NODE_OPTIONS reaches background workers unchanged", async (t) => {
  withEnv(t, "NODE_OPTIONS", "--max-old-space-size=123");
  withEnv(t, "AURRAL_WORKER_MAX_HEAP_MB", undefined);
  const expected = Number(
    execFileSync(process.execPath, ["-p", "v8.getHeapStatistics().heap_size_limit"]),
  );
  const reported = Promise.withResolvers();
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => ["library"],
    logger: quietLogger,
    forkProcess: forkHeapFixture((child) => child.send({ type: "report-heap-limit" })),
    onMessage: (message) => {
      if (message.type === "heap-limit") reported.resolve(message.bytes);
    },
  });
  t.onTestFinished(() => supervisor.stop());
  supervisor.start();
  assert.equal(await reported.promise, expected);
});

test("a failed deadline inspection retries without requiring another commit", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    now: 0,
  });
  const { launches, forkProcess } = createFakeFork();
  let fail = true;
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    forkProcess,
    logger: quietLogger,
    getWorkRevision: () => "unchanged",
    getNextWorkAt: () => (Date.now() < 1000 ? 1000 : null),
    findGroupsWithWork: () => {
      if (Date.now() < 1000) return [];
      if (fail) {
        fail = false;
        throw new Error("Database temporarily busy");
      }
      return ["library"];
    },
  });
  try {
    supervisor.start();
    vi.advanceTimersByTime(1000);
    assert.deepEqual(launches, []);
    vi.advanceTimersByTime(1000);
    assert.deepEqual(supervisor.getGroups(), ["library"]);
  } finally {
    await supervisor.stop();
  }
});

test("idle demand checks skip queue scans and discover unannounced commits", async () => {
  const [state, { db }, honker] = await setupIsolatedBackend(
    "idle-demand",
    "backend/config/db-sqlite.ts",
    "backend/services/honkerDb.ts",
  );
  const queue = honker.getMaintenanceTaskQueue();
  const revision = db.prepare(
    "SELECT data_version, total_changes() AS changes FROM pragma_data_version",
  );
  const { launches, forkProcess } = createFakeFork();
  let inspections = 0;
  let crossDeadline = false;
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["maintenance", "scheduler"],
    forkProcess,
    getWorkRevision: () => JSON.stringify(revision.get()),
    getNextWorkAt: honker.getNextBackgroundWorkAt,
    findGroupsWithWork: (now) => {
      inspections++;
      const groups = honker.listBackgroundGroupsWithWork(now);
      if (crossDeadline) {
        crossDeadline = false;
        vi.setSystemTime(Date.now() + 1100);
      }
      return groups;
    },
  });
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    now: Math.floor(Date.now() / 1000) * 1000,
  });
  try {
    supervisor.start();
    vi.advanceTimersByTime(60000);
    assert.equal(inspections, 1, "an unchanged database must not be repeatedly scanned");
    assert.deepEqual(launches, []);
    const delayedId = queue.enqueue(
      { kind: "session-cleanup" },
      { runAt: Math.floor(Date.now() / 1000) + 5 },
    );
    vi.advanceTimersByTime(2000);
    assert.deepEqual(launches, [], "a future job must stay pending");
    vi.advanceTimersByTime(3000);
    assert.deepEqual(
      supervisor.getGroups(),
      ["maintenance"],
      "unchanged delayed work must wake at its deadline",
    );
    launches[0].emit("message", { type: "ready" });
    launches[0].emit("message", { type: "idle" });
    queue.cancel(delayedId);
    exitIdle(launches[0]);
    await flush();
    vi.advanceTimersByTime(2000);
    assert.deepEqual(supervisor.getGroups(), []);
    const immediateId = queue.enqueue({ kind: "session-cleanup" });
    vi.advanceTimersByTime(2000);
    assert.deepEqual(supervisor.getGroups(), ["maintenance"]);
    queue.cancel(immediateId);
    launches[1].emit("message", { type: "ready" });
    launches[1].emit("message", { type: "idle" });
    exitIdle(launches[1]);
    await flush();
    vi.advanceTimersByTime(2000);
    for (const kind of ["pending", "processing", "schedule"]) {
      const dueAt = Math.floor(Date.now() / 1000) + 1;
      let crossingId;
      let scheduler;
      const name = "disposable-crossing-schedule";
      if (kind === "schedule") {
        scheduler = honker.getHonkerDb().scheduler();
        scheduler.add({
          name,
          queue: "system-task-maintenance",
          schedule: "@every 1h",
          payload: { kind: "session-cleanup" },
        });
        const tx = honker.getHonkerDb().transaction();
        tx.execute("UPDATE _honker_scheduler_tasks SET next_fire_at = ? WHERE name = ?", [
          dueAt,
          name,
        ]);
        tx.commit();
      } else {
        crossingId = queue.enqueue(
          { kind: "session-cleanup" },
          { runAt: kind === "pending" ? dueAt : dueAt - 120 },
        );
        if (kind === "processing") {
          assert.equal(queue.claimOne("disposable-crossing-owner")?.id, crossingId);
          const tx = honker.getHonkerDb().transaction();
          tx.execute("UPDATE _honker_live SET claim_expires_at = ? WHERE id = ?", [
            dueAt,
            crossingId,
          ]);
          tx.commit();
        }
      }
      crossDeadline = true;
      const group = kind === "schedule" ? "scheduler" : "maintenance";
      supervisor.wake(group);
      vi.advanceTimersByTime(1);
      assert.deepEqual(
        supervisor.getGroups(),
        [group],
        `${kind} work crossed during inspection must still launch its owner`,
      );
      if (scheduler) scheduler.remove(name);
      else queue.cancel(crossingId);
      const child = launches.at(-1);
      child.emit("message", { type: "ready" });
      child.emit("message", { type: "idle" });
      exitIdle(child);
      await flush();
      vi.advanceTimersByTime(2000);
      assert.deepEqual(supervisor.getGroups(), []);
    }
  } finally {
    await supervisor.stop();
    vi.useRealTimers();
    await cleanupIsolatedState(state);
  }
});
