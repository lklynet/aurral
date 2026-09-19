import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.js";
import {
  ISOLATED_WORKER_GROUPS,
  isQueueOwnedByGroup,
  shouldStartQueueHere,
} from "../backend/services/backgroundWorkerQueues.js";

test("only the owning process supervises isolated queues", () => {
  assert.deepEqual(ISOLATED_WORKER_GROUPS, [
    "library", "discovery-refresh", "discovery-playlist-build",
    "discovery-user-refresh", "maintenance", "inbox", "notifications",
    "play-events", "flow", "scheduler",
  ]);
  assert.equal(isQueueOwnedByGroup("library-scan"), false);
  assert.equal(isQueueOwnedByGroup("library-scan", "library"), true);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "library"), false);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "discovery-refresh"), true);
  assert.equal(isQueueOwnedByGroup("system-task-inbox", "inbox"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:notifications", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:play-events", "play-events"), true);
  assert.equal(isQueueOwnedByGroup("notification-outbox", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("system-task", "flow"), true);
  assert.equal(isQueueOwnedByGroup("weekly-flow-operation", "flow"), true);
  assert.equal(isQueueOwnedByGroup("slskd-pipeline", "flow"), true);
  assert.equal(isQueueOwnedByGroup("system-task"), false);
  assert.equal(isQueueOwnedByGroup("system-task", "library"), false);
  assert.equal(isQueueOwnedByGroup("playlist-mbid-enrichment", "flow"), true);
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
    process.env.AURRAL_BACKGROUND_WORKER_GROUP = "flow";
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

test("supervisor starts each group, forwards messages, and stops without respawning", async () => {
  const launches = [];
  const messages = [];
  const fakeFork = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.sent = [];
    child.send = (message) => {
      child.sent.push(message);
      if (message.type === "shutdown") {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
    };
    child.kill = () => { throw new Error("graceful shutdown should suffice"); };
    launches.push({ child, options });
    return child;
  };
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library", "discovery"],
    forkProcess: fakeFork,
    onMessage: (message, group) => messages.push({ message, group }),
  });

  assert.equal(supervisor.start(), true);
  assert.equal(supervisor.start(), false);
  assert.deepEqual(launches.map(({ options }) => options.env.AURRAL_BACKGROUND_WORKER_GROUP),
    ["library", "discovery"]);
  assert.deepEqual(supervisor.getGroups(), ["library", "discovery"]);
  launches[0].child.emit("message", { type: "websocket-broadcast", channel: "library" });
  assert.deepEqual(messages, [{ message: { type: "websocket-broadcast", channel: "library" }, group: "library" }]);
  launches[0].child.emit("message", {
    type: "heartbeat",
    workers: [{ name: "library-scan", running: true }],
  });
  assert.deepEqual(supervisor.getWorkerStatuses(), [{ name: "library-scan", running: true }]);

  assert.equal(supervisor.wake("discovery"), true);
  assert.deepEqual(launches[1].child.sent, [{ type: "queue-wake" }]);
  assert.equal(supervisor.wake("missing"), false);

  await supervisor.stop();
  assert.deepEqual(launches.map(({ child }) => child.sent),
    [[{ type: "shutdown" }], [{ type: "queue-wake" }, { type: "shutdown" }]]);
  assert.deepEqual(supervisor.getGroups(), []);
  assert.deepEqual(supervisor.getWorkerStatuses(), []);
});

test("supervisor restarts an unexpectedly exited worker", async () => {
  const children = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    logger: { warn() {}, error() {} },
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
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2);
    assert.deepEqual(supervisor.getGroups(), ["library"]);
  } finally {
    await supervisor.stop();
  }
});

test("flow requests return replies and reject when their owner exits", async () => {
  const children = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["flow"],
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
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
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    const first = supervisor.request("flow", "start");
    const request = children[0].sent.at(-1);
    assert.equal(request.type, "flow-command");
    assert.equal(request.method, "start");
    children[0].emit("message", { type: "flow-response", requestId: request.requestId, result: true });
    assert.equal(await first, true);

    children[0].emit("message", {
      type: "heartbeat", workers: [], flowStatus: { running: true },
    });
    assert.deepEqual(supervisor.getFlowStatus(), { running: true });
    const pending = supervisor.request("flow", "waitForIdle");
    children[0].emit("exit", 1, null);
    await assert.rejects(pending, /exited before responding/);
    assert.equal(supervisor.getFlowStatus(), null);
  } finally {
    await supervisor.stop();
  }
});

test("flow restart waits for job recovery", async () => {
  const children = [];
  let finishRecovery;
  const recovery = new Promise((resolve) => { finishRecovery = resolve; });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["flow"],
    logger: { warn() {}, error() {} },
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
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 1);
    finishRecovery();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2);
  } finally {
    await supervisor.stop();
  }
});

test("only the worker with an overdue job is terminated", async () => {
  const children = new Map();
  const killed = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["inbox", "maintenance"],
    jobTimeoutsMs: { inbox: 25, maintenance: 25 },
    unresponsiveMs: 1000,
    watchdogIntervalMs: 10,
    logger: { warn() {}, error() {} },
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
      child.kill = () => { killed.push(group); };
      children.set(group, child);
      return child;
    },
  });
  try {
    supervisor.start();
    children.get("inbox").emit("message", { type: "job-started", jobId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.deepEqual(killed, ["inbox"]);
    assert.deepEqual(supervisor.getGroups(), ["inbox", "maintenance"]);
  } finally {
    await supervisor.stop();
  }
});
