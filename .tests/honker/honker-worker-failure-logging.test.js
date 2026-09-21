import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const [{ default: createHonkerWorker }, { logger }] = await Promise.all([
  import("../../backend/services/honkerWorkerFactory.js"),
  import("../../backend/services/logger.js"),
]);

test("background workers log retrying and final failures without exposing the job payload", async () => {
  const events = [];
  const originalWarn = logger.warn;
  const originalError = logger.error;
  logger.warn = (...args) => events.push(["warn", ...args]);
  logger.error = (...args) => events.push(["error", ...args]);
  try {
    const outcomes = [];
    const jobs = [1, 2].map((attempts) => ({
      id: attempts,
      attempts,
      payload: { kind: "test-operation", secret: "do-not-log" },
      heartbeat() {},
      retry() { outcomes.push("retry"); },
      fail() { outcomes.push("fail"); },
    }));
    const queue = {
      maxAttempts: 2,
      visibilityTimeoutS: 30,
      getJob: () => ({ max_attempts: 2 }),
      async *claim() { yield* jobs; },
    };
    const worker = createHonkerWorker({
      name: "failure-logging-test",
      getQueue: () => queue,
      processJob: () => { throw new Error("source unavailable"); },
      shouldRestart: () => false,
    });
    await worker.start();

    assert.deepEqual(outcomes, ["retry", "fail"]);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(([level, category, message]) => [level, category, message]), [
      ["warn", "jobs", "Job attempt failed; retrying"],
      ["error", "jobs", "Job failed"],
    ]);
    assert.equal(events[0][3].reason, "source unavailable");
    assert.equal(events[1][3].attempt, 2);
    assert.doesNotMatch(JSON.stringify(events), /do-not-log/);
  } finally {
    logger.warn = originalWarn;
    logger.error = originalError;
  }
});
