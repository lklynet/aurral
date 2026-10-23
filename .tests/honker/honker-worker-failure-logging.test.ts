import { requireFixture } from "../playlists/fixtures.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

process.env.NODE_ENV = "test";

const [{ default: createHonkerWorker }, { logger }] = await Promise.all([
  import("../../backend/services/honkerWorkerFactory.ts"),
  import("../../backend/services/logger.ts"),
]);

test("background workers log retrying and final failures without exposing the job payload", async () => {
  const events: [string, string, string, { reason?: unknown; attempt?: unknown }?][] = [];
  const originalWarn = logger.warn;
  const originalError = logger.error;
  logger.warn = (category, message, data) => events.push(["warn", category, message, data]);
  logger.error = (category, message, data) => events.push(["error", category, message, data]);
  try {
    const outcomes: string[] = [];
    const jobs = [1, 2].map((attempts) => ({
      id: attempts,
      attempts,
      queue: "failure-logging-test",
      workerId: "test-worker",
      claimExpiresAt: null,
      ack() {
        return true;
      },
      payload: { kind: "test-operation", secret: "do-not-log" },
      heartbeat() {
        return true;
      },
      retry() {
        outcomes.push("retry");
        return true;
      },
      fail() {
        outcomes.push("fail");
        return true;
      },
    }));
    const queue = {
      name: "failure-logging-test",
      maxAttempts: 2,
      visibilityTimeoutS: 30,
      getJob: () => ({ max_attempts: 2 }),
      async *claim() {
        yield* jobs;
      },
    };
    const worker = createHonkerWorker({
      name: "failure-logging-test",
      getQueue: () => queue,
      processJob: () => {
        throw new Error("source unavailable");
      },
      shouldRestart: () => false,
    });
    await worker.start();

    assert.deepEqual(outcomes, ["retry", "fail"]);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map(([level, category, message]) => [level, category, message]),
      [
        ["warn", "jobs", "Job attempt failed; retrying"],
        ["error", "jobs", "Job failed"],
      ],
    );
    assert.equal(requireFixture(events[0][3]).reason, "source unavailable");
    assert.equal(requireFixture(events[1][3]).attempt, 2);
    assert.doesNotMatch(JSON.stringify(events), /do-not-log/);
  } finally {
    logger.warn = originalWarn;
    logger.error = originalError;
  }
});
