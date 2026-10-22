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
  "backend/config/db-sqlite.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/deemixOrchestrator.ts",
  "backend/services/download/downloadClientSettings.ts",
  "backend/services/logger.ts",
);

beforeEach(() => resetDatabase(db));
afterAll(async () => cleanupIsolatedState(isolatedState));

test("deemix queue cleanup logs a safe diagnostic when removal fails", async () => {
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Song" }, "playlist-id");
  const client = getDownloadClient("deemix");
  vi.spyOn(client, "removeFromQueue").mockImplementation(async () => {
    throw new Error("Failed at https://user:pass@example.test/api?token=secret-value");
  });
  const warnings = [];
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
  assert.equal(warning[2].jobId, jobId);
  assert.match(warning[2].reason, /\[redacted URL\]/);
  assert.doesNotMatch(warning[2].reason, /secret-value|user:pass/);
});
