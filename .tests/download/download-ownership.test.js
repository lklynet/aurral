import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig }, { downloadTracker }, honker, ownership, cancellation] = await setupIsolatedBackend(
  "download-ownership", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js", "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/honkerDb.js", "backend/services/downloadJobs/downloadOwnership.js",
  "backend/services/downloadJobs/downloadCancellation.js",
);
test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
test.after(() => cleanupIsolatedState(state));

test("album leadership moves to a held peer without cancelling shared provider work", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Album" });
  const leader = downloadTracker.addJob({ artistName: "Artist", trackName: "First", albumMbid: "album" }, playlist.id);
  const peer = downloadTracker.addJob({ artistName: "Artist", trackName: "Second", albumMbid: "album" }, playlist.id);
  db.prepare("UPDATE download_jobs SET request_group_id = ? WHERE id IN (?, ?)").run("album-request", leader, peer);
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(peer);
  downloadTracker.markSlskdDispatched(leader);
  downloadTracker.updateDownloadMetadata(leader, { downloadSource: "deemix", downloadClientId: "existing-queue" });
  const payload = { jobId: leader, ownerId: playlist.id, ownerGeneration: 0, phase: "poll", albumGrab: true, albumGroupJobIds: [leader, peer], queueUuid: "existing-queue" };
  honker.getPipelineQueue().enqueue(payload);
  const redirect = db.transaction(() => ownership.replaceAlbumDownloadLeaderInTransaction(leader, peer))();
  downloadTracker.reconcileCommittedJobs([redirect]);
  assert.equal(downloadTracker.getJob(leader), null);
  assert.equal(downloadTracker.getJob(peer).downloadClientId, "existing-queue");
  assert.equal(downloadTracker.isSlskdDispatched(peer), true);
  const continued = ownership.resolveTransferredDownloadPayload(payload);
  assert.equal(continued.jobId, peer);
  assert.deepEqual(continued.albumGroupJobIds, [peer]);
  assert.equal(continued.queueUuid, "existing-queue");
  assert.equal(cancellation.isPipelinePayloadActive(continued), true);
});

test("completed and removed jobs release their active attempt records", () => {
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Finished" }, "attempt-owner");
  const attempt = cancellation.beginDownloadAttempt(jobId);
  downloadTracker.setDone(jobId, "/disposable/finished.flac");
  assert.equal(cancellation.getActiveDownloadAttemptId(jobId), null);
  assert.equal(cancellation.isPipelinePayloadActive({ jobId, ownerId: "attempt-owner", ownerGeneration: 0, downloadAttemptId: attempt }), false);
  const pendingId = downloadTracker.addJob({ artistName: "Artist", trackName: "Removed" }, "attempt-owner");
  cancellation.beginDownloadAttempt(pendingId);
  downloadTracker.removeJob(pendingId);
  assert.equal(cancellation.getActiveDownloadAttemptId(pendingId), null);
});

