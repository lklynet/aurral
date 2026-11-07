import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync, fork, ChildProcess, type ForkOptions } from "node:child_process";
import { test, vi } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "./helpers/backendTestHarness.ts";
import { insertJob } from "./helpers/jobs.ts";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.ts";
const quietLogger = { warn() {}, error() {} };
const heapFixture = fileURLToPath(
  new URL("./fixtures/heap-limit-background-child.mts", import.meta.url),
);

function withEnv(t: import("vite-plus/test").TestContext, name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function forkHeapFixture(onReady: (child: ChildProcess) => void) {
  return (_entry: string, _args: readonly string[], options: ForkOptions) => {
    const child = fork(heapFixture, [], {
      ...options,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.once("message", () => onReady(child));
    return child;
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeChild(group: string | undefined = "") {
  const child = Object.assign(new ChildProcess(), {
    group,
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    sent: [] as Record<string, unknown>[],
  });
  child.send = (message) => {
    assert.ok(message && typeof message === "object" && !Array.isArray(message));
    child.sent.push({ ...message });
    if ("type" in message && message.type === "shutdown") {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return true;
  };
  child.kill = () => true;
  return child;
}

function createFakeFork() {
  const launches: ReturnType<typeof fakeChild>[] = [];
  const forkProcess = (_entry: string, _args: readonly string[], options: ForkOptions) => {
    const child = fakeChild(options.env?.AURRAL_BACKGROUND_WORKER_GROUP);
    launches.push(child);
    return child;
  };
  return { launches, forkProcess };
}

function exitIdle(child: ReturnType<typeof fakeChild>) {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

function reply(child: ReturnType<typeof fakeChild>, result: string | boolean) {
  const command = child.sent.findLast((message) => message.type === "download-owner-command");
  assert.ok(command);
  child.emit("message", { type: "download-owner-response", requestId: command.requestId, result });
  return command.method;
}

test("supervisor launches only groups with work, forwards messages, and stops without respawning", async () => {
  const { launches, forkProcess } = createFakeFork();
  const messages: {
    message: import("../backend/services/backgroundProcessSupervisor.ts").WorkerMessage;
    group: string;
  }[] = [];
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
  requireFixture(launches[0]).emit("message", { type: "websocket-broadcast", channel: "library" });
  assert.deepEqual(messages, [
    { message: { type: "websocket-broadcast", channel: "library" }, group: "library" },
  ]);
  requireFixture(launches[0]).emit("message", {
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
  requireFixture(launches[1]).emit("message", { type: "ready" });
  assert.deepEqual(launches[1]?.sent, [{ type: "queue-wake" }]);
  assert.equal(supervisor.wake("discovery"), true);
  assert.deepEqual(launches[1]?.sent, [{ type: "queue-wake" }, { type: "queue-wake" }]);
  assert.equal(supervisor.wake("missing"), false);

  await supervisor.stop();
  assert.deepEqual(
    launches.map((child) => child.sent),
    [
      [{ type: "shutdown" }],
      [{ type: "queue-wake" }, { type: "queue-wake" }, { type: "shutdown" }],
    ],
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
  const exits: { group: string; retired: boolean }[] = [];
  const warnings: unknown[] = [];
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
    requireFixture(launches[0]).emit("message", { type: "ready" });
    withWork = [];
    requireFixture(launches[0]).emit("message", { type: "idle" });
    assert.deepEqual(launches[0]?.sent, [{ type: "queue-wake" }, { type: "retire" }]);
    exitIdle(launches[0]);
    await flush();
    vi.advanceTimersByTime(60000);
    await flush();
    assert.equal(launches.length, 1);
    assert.deepEqual(supervisor.getGroups(), []);
    assert.deepEqual(exits, [{ group: "library", retired: true }]);
    assert.deepEqual([...warnings], []);

    withWork = ["library"];
    supervisor.wake("library");
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
    assert.deepEqual([...requireFixture(launches[0]).sent], []);
    requireFixture(launches[0]).emit("message", { type: "ready" });
    requireFixture(launches[0]).emit("message", { type: "idle" });
    assert.equal(
      launches[0]?.sent.some((message) => message.type === "retire"),
      false,
    );
    assert.equal(reply(launches[0], true), "waitForIdle");
    assert.equal(await pending, true);
    launches[0].emit("message", { type: "idle" });
    assert.deepEqual(launches[0]?.sent.at(-1), { type: "retire" });
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
    requireFixture(launches[0]).emit("message", { type: "ready" });
    reply(requireFixture(launches[0]), true);
    await first;
    requireFixture(launches[0]).emit("message", { type: "idle" });
    const second = supervisor.request("downloads", "wakeOrStart");
    assert.deepEqual(launches[0]?.sent.at(-1), { type: "retire" });
    exitIdle(launches[0]);
    await flush();
    assert.equal(launches.length, 2);
    requireFixture(launches[1]).emit("message", { type: "ready" });
    assert.equal(reply(requireFixture(launches[1]), "woken"), "wakeOrStart");
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
    requireFixture(launches[0]).emit("message", { type: "ready" });
    reply(requireFixture(launches[0]), true);
    await first;
    requireFixture(launches[0]).emit("message", { type: "idle" });
    const second = supervisor.request("downloads", "blockPlaylist", ["disposable"]);
    requireFixture(launches[0]).emit("message", { type: "busy" });
    assert.equal(reply(requireFixture(launches[0]), true), "blockPlaylist");
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
  const children: ReturnType<typeof fakeChild>[] = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => ["library"],
    logger: quietLogger,
    forkProcess: () => {
      const child = fakeChild();
      child.exitCode = null;
      child.signalCode = null;
      child.send = () => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      };
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    requireFixture(children[0]).exitCode = 1;
    requireFixture(children[0]).emit("close", 1, null);
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
    requireFixture(launches[0]).emit("message", { type: "ready" });
    const request = requireFixture(launches[0]).sent.find(
      (message) => message.type === "download-owner-command",
    );
    assert.equal(requireFixture(request).type, "download-owner-command");
    assert.equal(requireFixture(request).method, "start");
    reply(requireFixture(launches[0]), true);
    assert.equal(await first, true);

    requireFixture(launches[0]).emit("message", {
      type: "heartbeat",
      workers: [],
      downloadOwnerStatus: { running: true },
    });
    assert.deepEqual(supervisor.getDownloadOwnerStatus(), { running: true });
    const pending = supervisor.request("downloads", "waitForIdle");
    requireFixture(launches[0]).emit("exit", 1, null);
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
  const children: ReturnType<typeof fakeChild>[] = [];
  let finishRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => {
    finishRecovery = resolve;
  });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["downloads"],
    findGroupsWithWork: () => ["downloads"],
    logger: quietLogger,
    onExit: () => recovery,
    forkProcess: () => {
      const child = fakeChild();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "shutdown"
        ) {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
        return true;
      };
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    requireFixture(children[0]).emit("exit", 1, null);
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
  const killed: (string | undefined)[] = [];
  const errors: unknown[] = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["inbox", "maintenance"],
    findGroupsWithWork: () => ["inbox", "maintenance"],
    jobTimeoutsMs: { inbox: 25, maintenance: 25 },
    unresponsiveMs: 1000,
    watchdogIntervalMs: 10,
    logger: { warn() {}, error: (line) => errors.push(line) },
    forkProcess: (_entry, _args, options) => {
      const group = options.env?.AURRAL_BACKGROUND_WORKER_GROUP;
      const child = fakeChild();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "shutdown"
        ) {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
        return true;
      };
      child.kill = () => {
        killed.push(group);
        return true;
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
    assert.deepEqual([...killed], []);
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

test("a worker that runs out of heap stops at the configured limit and the log names its job", async (t: import("vite-plus/test").TestContext) => {
  withEnv(t, "NODE_OPTIONS", undefined);
  withEnv(t, "AURRAL_WORKER_MAX_HEAP_MB", "64");
  const warned = Promise.withResolvers<string>();
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["notifications"],
    findGroupsWithWork: () => ["notifications"],
    logger: { warn: (line) => warned.resolve(line), error() {} },
    forkProcess: forkHeapFixture((child) =>
      child.send({
        type: "run-job",
        queue: "notifications",
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
    /^\[BackgroundWorkers\] notifications exited \(SIGABRT\); running notifications job 42 \{"kind":"disposable"\}; last memory \d+ MB RSS, \d+ MB heap; restarting$/,
  );
});

test("a heap limit set in NODE_OPTIONS reaches background workers unchanged", async (t: import("vite-plus/test").TestContext) => {
  withEnv(t, "NODE_OPTIONS", "--max-old-space-size=123");
  withEnv(t, "AURRAL_WORKER_MAX_HEAP_MB", undefined);
  const expected = Number(
    execFileSync(process.execPath, ["-p", "v8.getHeapStatistics().heap_size_limit"]),
  );
  const reported = Promise.withResolvers<number>();
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => ["library"],
    logger: quietLogger,
    forkProcess: forkHeapFixture((child) => child.send({ type: "report-heap-limit" })),
    onMessage: (message) => {
      if ("bytes" in message && typeof message.bytes === "number") reported.resolve(message.bytes);
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
    assert.deepEqual([...launches], []);
    vi.advanceTimersByTime(30000);
    assert.deepEqual(supervisor.getGroups(), ["library"]);
  } finally {
    await supervisor.stop();
  }
});

test("an idle supervisor sleeps until the next due job and catches work that comes due mid-check", async () => {
  const [state, { db }, jobQueue] = await setupIsolatedBackend(
    "idle-demand",
    () => import("../backend/config/db-sqlite.ts"),
    () => import("../backend/services/jobs/queue.ts"),
    () => import("../backend/services/jobs/queues.ts"),
  );
  resetDatabase(db);
  const { launches, forkProcess } = createFakeFork();
  let inspections = 0;
  let crossDeadline = false;
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["maintenance"],
    forkProcess,
    getNextWorkAt: jobQueue.getNextWorkAt,
    findGroupsWithWork: (now) => {
      inspections++;
      const groups = jobQueue.listGroupsWithWork(now);
      if (crossDeadline) {
        crossDeadline = false;
        vi.setSystemTime(Date.now() + 1100);
      }
      return groups;
    },
  });
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    now: Date.now(),
  });
  const retire = async () => {
    const child = requireFixture(launches.at(-1));
    child.emit("message", { type: "ready" });
    child.emit("message", { type: "idle" });
    exitIdle(child);
    await flush();
    assert.deepEqual(supervisor.getGroups(), []);
  };
  const job = (runAt: number) =>
    insertJob(db, "system-task-maintenance", { kind: "session-cleanup" }, { runAt });
  const cancel = (id: number) =>
    db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(id);
  try {
    supervisor.start();
    vi.advanceTimersByTime(60000);
    assert.equal(inspections, 1);
    assert.deepEqual([...launches], []);

    const delayed = job(Date.now() + 5000);
    supervisor.wake("maintenance");
    vi.advanceTimersByTime(2000);
    assert.deepEqual([...launches], []);
    vi.advanceTimersByTime(3000);
    assert.deepEqual(supervisor.getGroups(), ["maintenance"]);
    cancel(delayed);
    await retire();

    for (const kind of ["pending", "running"]) {
      const dueAt = Date.now() + 1000;
      const id = job(kind === "pending" ? dueAt : Date.now());
      if (kind === "running") {
        db.prepare(
          "UPDATE jobs SET state = 'running', attempts = 1, worker_id = 'gone', lease_until = ? WHERE id = ?",
        ).run(dueAt, id);
      }
      crossDeadline = true;
      supervisor.wake("maintenance");
      vi.advanceTimersByTime(1);
      assert.deepEqual(supervisor.getGroups(), ["maintenance"], `${kind} work came due mid-check`);
      cancel(id);
      await retire();
    }
  } finally {
    await supervisor.stop();
    vi.useRealTimers();
    await cleanupIsolatedState(state);
  }
});
