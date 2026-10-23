import { createTrackedJob } from "./fixtures.ts";
import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state, { downloadTracker }, { cancelTrackDownload }] = await setupIsolatedBackend(
  "cancel-removed-track",
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/aurralAlbumJobs.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test("cancelling a track that is removed during the cancel reports it as not found", async () => {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Song" },
    "library",
  );
  assert.ok(jobId);
  downloadTracker.setPending(jobId, "Waiting", { asRetryCycle: true });
  const setCancelled = downloadTracker.setCancelled.bind(downloadTracker);
  vi.spyOn(downloadTracker, "setCancelled").mockImplementation((id) => {
    setCancelled(id);
    downloadTracker.removeJob(id);
    return true;
  });
  const result = await cancelTrackDownload(jobId);
  assert.deepEqual(result, { statusCode: 404, error: "Track not found" });
});
