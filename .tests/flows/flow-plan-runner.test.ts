import assert from "node:assert/strict";
import { ChildProcess, type Serializable } from "node:child_process";
import { test, vi } from "vite-plus/test";
import { createFlowPlanRunner } from "../../backend/services/flows/flowPlanRunner.ts";

function fakePlanner() {
  const child = Object.assign(new ChildProcess(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    acknowledged: false,
    request: undefined as Serializable | undefined,
  });
  child.send = (message, callback?: unknown) => {
    assert.ok(message && typeof message === "object" && "type" in message);
    if (message.type === "flow-plan-ack") {
      child.acknowledged = true;
      child.exitCode = 0;
      if (typeof callback === "function") callback(null);
      queueMicrotask(() => child.emit("exit", 0, null));
    } else {
      child.request = message;
    }
    return true;
  };
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("flow planning returns a child result without moving playlist mutation state", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 500 });
    const pending = run({ id: "flow-1" });
    assert.deepEqual(child.request, {
      type: "build-flow-plan",
      flow: { id: "flow-1" },
      options: {},
    });
    child.emit("message", { type: "flow-plan-result", plan: { primaryTracks: [] } });
    assert.deepEqual(await pending, { primaryTracks: [] });
    assert.equal(child.acknowledged, true);
    assert.equal(child.killed, false);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("an overdue flow plan stops only its planner process", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 20 });
    const pending = run({ id: "flow-2" });
    const rejected = assert.rejects(pending, /Flow planning timed out/);
    await vi.advanceTimersByTimeAsync(19);
    assert.equal(child.killed, false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    assert.equal(child.killed, true);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("flow planning acknowledges an error before the planner exits", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 500 });
    const pending = run({ id: "flow-3" });
    child.emit("message", { type: "flow-plan-error", error: "Plan failed" });
    await assert.rejects(pending, /Plan failed/);
    assert.equal(child.acknowledged, true);
    assert.equal(child.killed, false);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("planner acknowledgement failures are handled while the child is exiting", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  let ackCallback: unknown;
  child.send = (message, callback?: unknown) => {
    assert.ok(message && typeof message === "object" && "type" in message);
    if (message.type === "flow-plan-ack") ackCallback = callback;
    return true;
  };
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 500 });
    const pending = run({ id: "flow-4" });
    child.emit("message", { type: "flow-plan-result", plan: { primaryTracks: [] } });
    await pending;
    assert.doesNotThrow(() => child.emit("error", new Error("child exited")));
    assert.ok(typeof ackCallback === "function");
    ackCallback(new Error("IPC closed"));
    assert.equal(child.killed, true);
    child.emit("exit", 1, null);
    assert.equal(child.listenerCount("error"), 0);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});
