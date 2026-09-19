import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createFlowPlanRunner } from "../backend/services/weeklyFlow/weeklyFlowPlanRunner.js";

function fakePlanner() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.send = (message) => { child.request = message; };
  child.kill = () => { child.killed = true; };
  return child;
}

test("flow planning returns a child result without moving playlist mutation state", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 500 });
    const pending = run({ id: "flow-1" }, { listenHistoryProfile: null });
    assert.deepEqual(child.request, {
      type: "build-flow-plan",
      flow: { id: "flow-1" },
      options: { listenHistoryProfile: null },
    });
    child.emit("message", { type: "flow-plan-result", plan: { primaryTracks: [] } });
    assert.deepEqual(await pending, { primaryTracks: [] });
    assert.equal(child.killed, true);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("an overdue flow plan stops only its planner process", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const child = fakePlanner();
  try {
    const run = createFlowPlanRunner({ forkProcess: () => child, timeoutMs: 20 });
    await assert.rejects(run({ id: "flow-2" }), /Flow planning timed out/);
    assert.equal(child.killed, true);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});
