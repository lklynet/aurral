import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { insertJob } from "../helpers/jobs.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { dbOps }, { downloadTracker }, ownership, cancellation] =
  await setupIsolatedBackend(
    "download-ownership",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
    () => import("../../backend/services/downloadJobs/downloadOwnership.ts"),
    () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
  );
beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
});
afterAll(() => cleanupIsolatedState(state));

function albumPeers(trackName: string) {
  const [leader, peer] = ["Lead", "Held"].map((role) =>
    createTrackedJob(
      downloadTracker,
      { artistName: "Artist", trackName: `${trackName} ${role}`, albumMbid: trackName },
      "library",
    ),
  );
  assert.ok(leader != null && peer != null);
  db.prepare("UPDATE download_jobs SET request_group_id = ? WHERE id IN (?, ?)").run(
    `${trackName}-request`,
    leader,
    peer,
  );
  downloadTracker.reconcileCommittedJobs();
  downloadTracker.setDownloading(peer);
  return { leader, peer };
}

const handOff = ({ leader, peer }: { leader: string; peer: string }) =>
  ownership.replaceAlbumDownloadLeaderInTransaction(leader, peer);

const transferKeys = () =>
  db
    .prepare<[], { key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'downloadJobTransfers:%' ORDER BY key",
    )
    .all()
    .map((row) => row.key.slice("downloadJobTransfers:".length));

test("a saved handoff Aurral can't read never redirects a queued download", () => {
  const peers = albumPeers("Unreadable");
  const payload = {
    jobId: peers.leader,
    playlistId: "library",
    playlistGeneration: 0,
    downloadAttemptId: cancellation.beginDownloadAttempt(peers.leader),
  };
  db.transaction(() => handOff(peers))();
  downloadTracker.reconcileCommittedJobs();
  db.prepare(
    "UPDATE settings SET value = json_set(value, '$[0].destination', 5) WHERE key = ?",
  ).run(`downloadJobTransfers:${peers.leader}`);

  const resolved = ownership.resolveTransferredDownloadPayload(payload);

  assert.equal(resolved.jobId, peers.leader);
  assert.equal(cancellation.isPipelinePayloadActive(resolved), false);
});

test("rolled-back handoff leaves the continuing process and queued payload unchanged", () => {
  const peers = albumPeers("Rollback");
  const payload = { jobId: peers.leader, playlistId: "library", playlistGeneration: 0 };
  const queueId = insertJob(db, "download-pipeline", payload);
  assert.throws(
    () =>
      db.transaction(() => {
        handOff(peers);
        throw new Error("fixture rollback");
      })(),
    /fixture rollback/,
  );
  downloadTracker.reconcileCommittedJobs();
  assert.ok(downloadTracker.getJob(peers.leader));
  assert.deepEqual(ownership.resolveTransferredDownloadPayload(payload), payload);
  assert.deepEqual(
    JSON.parse(
      db
        .prepare<[number], { payload: string }>("SELECT payload FROM jobs WHERE id = ?")
        .get(queueId)!.payload,
    ),
    payload,
  );
});

test("album leadership moves to a held peer without cancelling shared provider work", () => {
  const leader = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "First", albumMbid: "album" },
    "library",
  );
  assert.ok(leader != null);
  const peer = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Second", albumMbid: "album" },
    "library",
  );
  assert.ok(peer != null);
  db.prepare("UPDATE download_jobs SET request_group_id = ? WHERE id IN (?, ?)").run(
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
    playlistId: "library",
    playlistGeneration: 0,
    phase: "poll",
    albumGrab: true,
    albumGroupJobIds: [leader, peer],
    queueUuid: "existing-queue",
  };
  insertJob(db, "download-pipeline", payload);
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
  const peers = albumPeers("Unread list");
  const save = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  save.run("downloadJobTransfers:not-json", "{");
  save.run("downloadJobTransfers:not-objects", '["bad"]');

  db.transaction(() => handOff(peers))();

  assert.deepEqual(transferKeys(), [peers.leader]);
});

test("recording a handoff prunes handoff history for settled downloads only", () => {
  const [done, failed, removed, active, next] = ["Done", "Failed", "Removed", "Active", "Next"].map(
    albumPeers,
  );
  assert.ok(done && failed && removed && active && next);
  for (const peers of [done, failed, removed, active]) db.transaction(() => handOff(peers))();
  db.prepare("UPDATE download_jobs SET status = 'done' WHERE id = ?").run(done.peer);
  db.prepare("UPDATE download_jobs SET status = 'failed' WHERE id = ?").run(failed.peer);
  db.prepare("DELETE FROM download_jobs WHERE id = ?").run(removed.peer);
  db.transaction(() => handOff(next))();

  assert.deepEqual(transferKeys(), [active.leader, next.leader].sort());
});

test("downloads never name a folder or file with a leading dot", () => {
  assert.equal(
    ownership.downloadDestinationForJob({
      artistName: ".wav_909 & 7thRaw",
      albumName: "...",
      playlistType: "library",
    }),
    "wav_909 & 7thRaw/Unknown Album",
  );
});
