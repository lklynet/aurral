import { createTrackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { processDeemixPipelinePayload },
  { getDownloadClient },
  { logger },
] = await setupIsolatedBackend(
  "deemix-log-safety",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/deemixOrchestrator.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/logger.ts"),
);

beforeEach(() => resetDatabase(db));
afterAll(async () => cleanupIsolatedState(isolatedState));

test("deemix queue cleanup logs a safe diagnostic when removal fails", async () => {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    "playlist-id",
  );
  const client = getDownloadClient("deemix");
  vi.spyOn(client, "removeFromQueue").mockImplementation(async () => {
    throw new Error("Failed at https://example.test/api?token=secret-value");
  });
  const warnings: Parameters<typeof logger.warn>[] = [];
  vi.spyOn(logger, "warn").mockImplementation((...args) => warnings.push(args));
  const failOrTryNextSource = vi.fn(async () => null);

  await processDeemixPipelinePayload(
    { phase: "poll", source: "deemix", jobId, queueUuid: "queue-id", pollAttempts: 200 },
    { failOrTryNextSource },
  );

  assert.equal(failOrTryNextSource.mock.calls.length, 1);
  const warning = warnings.find(
    ([, message]) => message === "Could not remove timed-out queue item",
  );
  assert.ok(warning);
  const details = warning[2] as { jobId: string; reason: string };
  assert.equal(details.jobId, jobId);
  assert.equal(details.reason, "Failed at https://example.test/api?token=***");
});
