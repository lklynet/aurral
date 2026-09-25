import test from "node:test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [isolatedState, trackerModule, cancellation] = await setupIsolatedBackend(
  "aurral-album-lifecycle",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadCancellation.js",
);

const { downloadTracker, WeeklyFlowDownloadTracker } = trackerModule;

function addAlbumJob(trackName, requestGroupId = "group-1") {
  return downloadTracker.addJob(
    {
      artistName: "Lifecycle Artist",
      trackName,
      albumName: "Lifecycle Album",
      albumMbid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      managedBy: "aurral",
      requestGroupId,
    },
    "library",
  );
}

test.beforeEach(() => {
  downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("restart returns interrupted album jobs to pending and never revives cancelled work", () => {
  const pending = addAlbumJob("Pending");
  const interrupted = addAlbumJob("Interrupted");
  const cancelledWhileDownloading = addAlbumJob("Cancelled while downloading");
  const cancelRequested = addAlbumJob("Cancel requested");
  const cancelled = addAlbumJob("Cancelled");

  for (const id of [interrupted, cancelledWhileDownloading, cancelRequested]) {
    downloadTracker.setDownloading(id);
  }
  cancellation.cancelDownloadJobs([cancelledWhileDownloading, cancelRequested, cancelled]);
  downloadTracker.setCancelRequested(cancelRequested);
  downloadTracker.setCancelled(cancelled);

  const restarted = new WeeklyFlowDownloadTracker();
  const expected = {
    [pending]: "pending",
    [interrupted]: "pending",
    [cancelledWhileDownloading]: "cancelled",
    [cancelRequested]: "cancelled",
    [cancelled]: "cancelled",
  };
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(restarted.getJob(id).status, status, restarted.getJob(id).trackName);
  }
  assert.deepEqual(
    restarted.getPending(10).map((job) => job.id).sort(),
    [pending, interrupted].sort(),
  );

  downloadTracker.resetDownloadingToPending();
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(downloadTracker.getJob(id).status, status, downloadTracker.getJob(id).trackName);
  }
  assert.equal(downloadTracker.getStats().cancelled, 3);
});

test("a cancelled album job ignores late pipeline transitions until it is retried", () => {
  const id = addAlbumJob("Late failure");
  downloadTracker.setDownloading(id);
  cancellation.cancelDownloadJobs([id]);
  downloadTracker.setCancelRequested(id);

  downloadTracker.setFailed(id, "slskd transfer aborted");
  downloadTracker.setPending(id, "retry");
  downloadTracker.setBlocked(id, "needs review");
  assert.equal(downloadTracker.getJob(id).status, "cancel_requested");
  assert.equal(downloadTracker.getJob(id).error, null);

  downloadTracker.setCancelled(id);
  downloadTracker.setDownloading(id);
  assert.equal(downloadTracker.getJob(id).status, "cancelled");
  assert.equal(downloadTracker.getNextPending(), null);

  cancellation.restoreDownloadJobCancellations([id]);
  assert.equal(downloadTracker.setPending(id, "Retrying", { asRetryCycle: true }), true);
  assert.equal(downloadTracker.getJob(id).status, "pending");
  assert.equal(downloadTracker.getNextPending()?.id, id);
});
