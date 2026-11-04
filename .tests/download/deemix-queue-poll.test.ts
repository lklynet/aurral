import { createTrackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { downloadTracker }, { processDeemixPipelinePayload }, settings] =
  await setupIsolatedBackend(
    "deemix-queue-poll",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
    () => import("../../backend/services/deemixOrchestrator.ts"),
    () => import("../../backend/services/download/downloadClientSettings.ts"),
  );

beforeEach(() => {
  resetDatabase(db);
  vi.restoreAllMocks();
});
afterAll(async () => cleanupIsolatedState(isolatedState));

function poll(queueItem: { status: string } | null) {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Kris Kristofferson", trackName: "Lover Please" },
    "playlist-id",
  );
  const client = settings.getDownloadClient("deemix");
  vi.spyOn(client, "getQueueItem").mockImplementation(async () => queueItem);
  vi.spyOn(client, "removeFromQueue").mockImplementation(async () => true);
  const failOrTryNextSource = vi.fn(
    async (_payload: unknown, _job: unknown, _reason: string) => null,
  );
  return processDeemixPipelinePayload(
    { phase: "poll", source: "deemix", jobId, queueUuid: "track_1_1", pollAttempts: 0 },
    { failOrTryNextSource },
  ).then((next) => ({ next, reasons: failOrTryNextSource.mock.calls.map((call) => call[2]) }));
}

test("a track deemix no longer lists moves on instead of waiting out the polling limit", async () => {
  assert.deepEqual(await poll(null), {
    next: null,
    reasons: ["deemix no longer lists this download in its queue"],
  });
});

test("a track deemix is still downloading keeps polling", async () => {
  const { next, reasons } = await poll({ status: "downloading" });
  assert.equal(next?.phase, "poll");
  assert.deepEqual(reasons, []);
});
