import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";

process.env.NODE_ENV = "test";

const [{ default: createHonkerWorker }, runtime] = await Promise.all([
  import("../../backend/services/honkerWorkerFactory.js"),
  import("../../backend/services/honkerWorkerRuntime.js"),
]);

test("Honker shutdown waits for in-flight worker work before closing infrastructure", async () => {
  let releaseWork;
  const workStarted = Promise.withResolvers();
  const workReleased = new Promise((resolve) => {
    releaseWork = resolve;
  });
  let acknowledged = false;

  const job = {
    id: 1,
    attempts: 0,
    payload: { kind: "shutdown-test" },
    heartbeat() {},
    ack() {
      acknowledged = true;
    },
    fail() {},
    retry() {},
  };
  const queue = {
    maxAttempts: 1,
    visibilityTimeoutS: 30,
    async *claim() {
      yield job;
    },
  };

  const worker = createHonkerWorker({
    name: "shutdown-regression-test",
    getQueue: () => queue,
    processJob: async () => {
      workStarted.resolve();
      await workReleased;
    },
  });

  void worker.start();
  await workStarted.promise;

  let shutdownSettled = false;
  const shutdown = runtime.shutdownHonkerInfrastructure({ timeoutMs: 2000 }).then(() => {
    shutdownSettled = true;
  });

  await delay(50);
  const returnedBeforeWorkFinished = shutdownSettled;
  releaseWork();
  await shutdown;

  assert.equal(returnedBeforeWorkFinished, false);
  assert.equal(acknowledged, true);
});
