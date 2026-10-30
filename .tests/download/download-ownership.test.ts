import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  honker,
  ownership,
  cancellation,
] = await setupIsolatedBackend(
  "download-ownership",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/downloadJobs/downloadOwnership.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
);
beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
afterAll(() => cleanupIsolatedState(state));

test("ownership transfer preserves a provider attempt and rejects it after explicit retry", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Target" });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    source.id,
  );
  assert.ok(jobId != null);
  const job = downloadTracker.getJob(jobId);
  assert.ok(job != null);
  const attempt = cancellation.beginDownloadAttempt(jobId);
  const payload = {
    jobId,
    playlistId: source.id,
    playlistGeneration: 0,
    downloadAttemptId: attempt,
    phase: "poll",
    queueUuid: "existing-provider-work",
    albumGroupJobIds: [jobId],
  };
  const queueId = honker.getPipelineQueue().enqueue(payload);
  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
  assert.equal(job.playlistType, source.id);
  downloadTracker.reconcileCommittedJobs();
  assert.equal(trackedJob(downloadTracker, jobId), job);
  assert.equal(job.playlistType, target.id);
  const resolved = ownership.resolveTransferredDownloadPayload(payload);
  assert.equal(resolved.playlistId, target.id);
  assert.equal(resolved.queueUuid, "existing-provider-work");
  assert.deepEqual(resolved.albumGroupJobIds, [jobId]);
  assert.equal(cancellation.isPipelinePayloadActive(resolved), true);
  assert.equal(
    JSON.parse(
      db
        .prepare<[number], { payload: string }>("SELECT payload FROM _honker_live WHERE id = ?")
        .get(queueId)!.payload,
    ).playlistId,
    target.id,
  );
  cancellation.beginDownloadAttempt(jobId);
  assert.equal(
    cancellation.isPipelinePayloadActive(ownership.resolveTransferredDownloadPayload(payload)),
    false,
  );
});

test("a saved handoff Aurral can't read never redirects a queued download", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Handoff Source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Handoff Target" });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    source.id,
  );
  assert.ok(jobId != null);
  const payload = {
    jobId,
    playlistId: source.id,
    playlistGeneration: 0,
    downloadAttemptId: cancellation.beginDownloadAttempt(jobId),
  };
  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
  downloadTracker.reconcileCommittedJobs();
  db.prepare(
    "UPDATE settings SET value = json_set(value, '$[0].destination', 5) WHERE key = ?",
  ).run(`downloadJobTransfers:${jobId}`);

  const resolved = ownership.resolveTransferredDownloadPayload(payload);

  assert.equal(resolved.playlistId, source.id);
  assert.equal(cancellation.isPipelinePayloadActive(resolved), false);
});

test("rolled-back transfer leaves the continuing process and queued payload unchanged", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Rollback source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Rollback target" });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    source.id,
  );
  assert.ok(jobId != null);
  const payload = { jobId, playlistId: source.id, playlistGeneration: 0, phase: "poll" };
  const queueId = honker.getPipelineQueue().enqueue(payload);
  assert.throws(
    () =>
      db.transaction(() => {
        ownership.transferDownloadOwnershipInTransaction(jobId, target.id);
        throw new Error("fixture rollback");
      })(),
    /fixture rollback/,
  );
  downloadTracker.reconcileCommittedJobs();
  assert.equal(trackedJob(downloadTracker, jobId).playlistType, source.id);
  assert.deepEqual(ownership.resolveTransferredDownloadPayload(payload), payload);
  assert.deepEqual(
    JSON.parse(
      db
        .prepare<[number], { payload: string }>("SELECT payload FROM _honker_live WHERE id = ?")
        .get(queueId)!.payload,
    ),
    payload,
  );
});

test("album leadership moves to a held peer without cancelling shared provider work", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Album" });
  const leader = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "First", albumMbid: "album" },
    playlist.id,
  );
  assert.ok(leader != null);
  const peer = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Second", albumMbid: "album" },
    playlist.id,
  );
  assert.ok(peer != null);
  db.prepare("UPDATE playlist_download_jobs SET request_group_id = ? WHERE id IN (?, ?)").run(
    "album-request",
    leader,
    peer,
  );
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(peer);
  downloadTracker.markSlskdDispatched(leader);
  downloadTracker.updateDownloadMetadata(leader, {
    downloadSource: "deemix",
    downloadClientId: "existing-queue",
  });
  const payload = {
    jobId: leader,
    playlistId: playlist.id,
    playlistGeneration: 0,
    phase: "poll",
    albumGrab: true,
    albumGroupJobIds: [leader, peer],
    queueUuid: "existing-queue",
  };
  honker.getPipelineQueue().enqueue(payload);
  const redirect = db.transaction(() =>
    ownership.replaceAlbumDownloadLeaderInTransaction(leader, peer),
  )();
  downloadTracker.reconcileCommittedJobs([redirect]);
  assert.equal(downloadTracker.getJob(leader), null);
  assert.equal(trackedJob(downloadTracker, peer).downloadClientId, "existing-queue");
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
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Review" },
    source.id,
  );
  assert.ok(jobId != null);
  const payload = { jobId, playlistId: source.id, playlistGeneration: 0 };
  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
  downloadTracker.reconcileCommittedJobs();
  let committed = false;
  const result = await cancellation.withPipelineCommitLock(payload, () => {
    committed = true;
  });
  assert.equal(result.cancelled, true);
  assert.equal(committed, false);
});

test("completed and removed jobs release their active attempt records", () => {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Finished" },
    "attempt-owner",
  );
  assert.ok(jobId != null);
  const attempt = cancellation.beginDownloadAttempt(jobId);
  downloadTracker.setDone(jobId, "/disposable/finished.flac");
  assert.equal(cancellation.getActiveDownloadAttemptId(jobId), null);
  assert.equal(
    cancellation.isPipelinePayloadActive({
      jobId,
      playlistId: "attempt-owner",
      playlistGeneration: 0,
      downloadAttemptId: attempt,
    }),
    false,
  );
  const pendingId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Removed" },
    "attempt-owner",
  );
  assert.ok(pendingId != null);
  cancellation.beginDownloadAttempt(pendingId);
  downloadTracker.removeJob(pendingId);
  assert.equal(cancellation.getActiveDownloadAttemptId(pendingId), null);
});

test("a saved attempt Aurral can't read lets no queued download step through", () => {
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Unread attempt" },
    "attempt-check",
  );
  assert.ok(jobId != null);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '123')").run(
    `activeDownloadAttempt:${jobId}`,
  );
  const owner: {
    jobId: string;
    playlistId: string;
    playlistGeneration: number;
    downloadAttemptId?: null;
  } = { jobId, playlistId: "attempt-check", playlistGeneration: 0 };

  assert.equal(cancellation.isPipelinePayloadActive({ ...owner, downloadAttemptId: null }), false);
  for (const payload of [owner, { ...owner, downloadAttemptId: null }]) {
    assert.equal(
      ownership.resolveTransferredDownloadPayload(payload).downloadAttemptId,
      "unmatched-download-attempt",
    );
  }
});

test("a saved handoff list Aurral can't read never blocks another handoff", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "Unread list source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "Unread list target" });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Moves" },
    source.id,
  );
  assert.ok(jobId != null);
  const save = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  save.run("downloadJobTransfers:not-json", "{");
  save.run("downloadJobTransfers:not-objects", '["bad"]');

  db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();

  assert.deepEqual(
    db
      .prepare<[], { key: string }>(
        "SELECT key FROM settings WHERE key LIKE 'downloadJobTransfers:%' ORDER BY key",
      )
      .all()
      .map((row) => row.key),
    [`downloadJobTransfers:${jobId}`],
  );
});

test("recording a transfer prunes transfer history for settled downloads only", () => {
  const source = flowPlaylistConfig.createStaticPlaylist({ name: "History source" });
  const target = flowPlaylistConfig.createStaticPlaylist({ name: "History target" });
  const add = (trackName: string) =>
    createTrackedJob(downloadTracker, { artistName: "Artist", trackName }, source.id);
  const [doneId, failedId, removedId, activeId, nextId] = [
    "Done",
    "Failed",
    "Removed",
    "Active",
    "Next",
  ].map(add);
  const move = (jobId: string) => {
    db.transaction(() => ownership.transferDownloadOwnershipInTransaction(jobId, target.id))();
    downloadTracker.reconcileCommittedJobs();
  };
  for (const jobId of [doneId, failedId, removedId, activeId]) move(jobId);
  db.prepare("UPDATE playlist_download_jobs SET status = 'done' WHERE id = ?").run(doneId);
  db.prepare("UPDATE playlist_download_jobs SET status = 'failed' WHERE id = ?").run(failedId);
  db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(removedId);
  move(nextId);
  const history = db
    .prepare<[], { key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'downloadJobTransfers:%' ORDER BY key",
    )
    .all()
    .map((row) => row.key.slice("downloadJobTransfers:".length));
  assert.deepEqual(history, [activeId, nextId].sort());
});
