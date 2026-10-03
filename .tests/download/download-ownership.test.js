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
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
test.after(() => cleanupIsolatedState(state));

test("ownership transfer preserves a provider attempt and rejects it after explicit retry", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Target" });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, source.id);
  const job = downloadTracker.getJob(jobId);
  const attempt = cancellation.beginDownloadAttempt(jobId);
  const payload = { jobId, playlistId: source.id, playlistGeneration: 0, downloadAttemptId: attempt,
    phase: "poll", queueUuid: "existing-provider-work", albumGroupJobIds: [jobId] };
  const queueId = honker.getPipelineQueue().enqueue(payload);
  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
  assert.equal(job.playlistType, source.id);
  downloadTracker.reconcileCommittedJobs();
  assert.equal(downloadTracker.getJob(jobId), job);
  assert.equal(job.playlistType, target.id);
  const resolved = ownership.resolveTransferredDownloadPayload(payload);
  assert.equal(resolved.playlistId, target.id);
  assert.equal(resolved.queueUuid, "existing-provider-work");
  assert.deepEqual(resolved.albumGroupJobIds, [jobId]);
  assert.equal(cancellation.isPipelinePayloadActive(resolved), true);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM _honker_live WHERE id = ?").get(queueId).payload).playlistId, target.id);
  cancellation.beginDownloadAttempt(jobId);
  assert.equal(cancellation.isPipelinePayloadActive(ownership.resolveTransferredDownloadPayload(payload)), false);
});

test("rolled-back transfer leaves the continuing process and queued payload unchanged", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Rollback source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Rollback target" });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, source.id);
  const payload = { jobId, playlistId: source.id, playlistGeneration: 0, phase: "poll" };
  const queueId = honker.getPipelineQueue().enqueue(payload);
  assert.throws(() => db.transaction(() => {
    ownership.transferDownloadOwnershipInTransaction(jobId, target.id);
    throw new Error("fixture rollback");
  })(), /fixture rollback/);
  downloadTracker.reconcileCommittedJobs();
  assert.equal(downloadTracker.getJob(jobId).playlistType, source.id);
  assert.deepEqual(ownership.resolveTransferredDownloadPayload(payload), payload);
  assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM _honker_live WHERE id = ?").get(queueId).payload), payload);
});

test("album leadership moves to a held peer without cancelling shared provider work", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Album" });
  const leader = downloadTracker.addJob({ artistName: "Artist", trackName: "First", albumMbid: "album" }, playlist.id);
  const peer = downloadTracker.addJob({ artistName: "Artist", trackName: "Second", albumMbid: "album" }, playlist.id);
  db.prepare("UPDATE playlist_download_jobs SET request_group_id = ? WHERE id IN (?, ?)").run("album-request", leader, peer);
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(peer);
  downloadTracker.markSlskdDispatched(leader);
  downloadTracker.updateDownloadMetadata(leader, { downloadSource: "deemix", downloadClientId: "existing-queue" });
  const payload = { jobId: leader, playlistId: playlist.id, playlistGeneration: 0, phase: "poll", albumGrab: true, albumGroupJobIds: [leader, peer], queueUuid: "existing-queue" };
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

test("tokenless manual commits reject ownership captured before a transfer", async () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Approval source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Approval target" });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Review" }, source.id);
  const payload = { jobId, playlistId: source.id, playlistGeneration: 0 };
  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
  downloadTracker.reconcileCommittedJobs();
  let committed = false;
  const result = await cancellation.withPipelineCommitLock(payload, () => { committed = true; });
  assert.equal(result.cancelled, true);
  assert.equal(committed, false);
});

test("completed and removed jobs release their active attempt records", () => {
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Finished" }, "attempt-owner");
  const attempt = cancellation.beginDownloadAttempt(jobId);
  downloadTracker.setDone(jobId, "/disposable/finished.flac");
  assert.equal(cancellation.getActiveDownloadAttemptId(jobId), null);
  assert.equal(cancellation.isPipelinePayloadActive({ jobId, playlistId: "attempt-owner", playlistGeneration: 0, downloadAttemptId: attempt }), false);
  const pendingId = downloadTracker.addJob({ artistName: "Artist", trackName: "Removed" }, "attempt-owner");
  cancellation.beginDownloadAttempt(pendingId);
  downloadTracker.removeJob(pendingId);
  assert.equal(cancellation.getActiveDownloadAttemptId(pendingId), null);
});

test("recording a transfer prunes transfer history for settled downloads only", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "History source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "History target" });
  const add = (trackName) => downloadTracker.addJob({ artistName: "Artist", trackName }, source.id);
  const [doneId, failedId, removedId, activeId, nextId] = ["Done", "Failed", "Removed", "Active", "Next"].map(add);
  const move = (jobId) => {
    db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
    downloadTracker.reconcileCommittedJobs();
  };
  for (const jobId of [doneId, failedId, removedId, activeId]) move(jobId);
  db.prepare("UPDATE playlist_download_jobs SET status = 'done' WHERE id = ?").run(doneId);
  db.prepare("UPDATE playlist_download_jobs SET status = 'failed' WHERE id = ?").run(failedId);
  db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(removedId);
  move(nextId);
  const history = db.prepare("SELECT key FROM settings WHERE key LIKE 'downloadJobTransfers:%' ORDER BY key").all()
    .map((row) => row.key.slice("downloadJobTransfers:".length));
  assert.deepEqual(history, [activeId, nextId].sort());
});
