import * as v from "valibot";
import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vite-plus/test";

process.env.NODE_ENV = "test";

const [{ default: createHonkerWorker }, runtime] = await Promise.all([
  import("../../backend/services/honkerWorkerFactory.ts"),
  import("../../backend/services/honkerWorkerRuntime.ts"),
]);

test("Honker shutdown waits for in-flight worker work before closing infrastructure", async () => {
  let releaseWork!: () => void;
  const workStarted = Promise.withResolvers<void>();
  const workReleased = new Promise<void>((resolve) => {
    releaseWork = resolve;
  });
  let acknowledged = false;

  const job = {
    id: 1,
    queue: "shutdown-test",
    workerId: "test-worker",
    claimExpiresAt: null,
    attempts: 0,
    payload: { kind: "shutdown-test" },
    heartbeat() {
      return true;
    },
    ack() {
      acknowledged = true;
      return true;
    },
    fail() {
      return true;
    },
    retry() {
      return true;
    },
  };
  const queue = {
    name: "shutdown-test",
    getJob: () => ({ max_attempts: 1 }),
    maxAttempts: 1,
    visibilityTimeoutS: 30,
    async *claim() {
      yield job;
    },
  };

  const worker = createHonkerWorker({
    name: "shutdown-regression-test",
    schema: v.unknown(),
    getQueue: () => queue,
    processJob: async () => {
      workStarted.resolve();
      await workReleased;
    },
  });

  void worker.start();
  await workStarted.promise;

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  let shutdownSettled = false;
  const shutdown = runtime.shutdownHonkerInfrastructure({ timeoutMs: 2000 }).then(() => {
    shutdownSettled = true;
  });

  await vi.advanceTimersByTimeAsync(1999);
  const returnedBeforeWorkFinished = shutdownSettled;
  releaseWork();
  await shutdown;

  assert.equal(returnedBeforeWorkFinished, false);
  assert.equal(acknowledged, true);
});
