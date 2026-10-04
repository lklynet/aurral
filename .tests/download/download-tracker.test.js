import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, trackerModule, qualityProfileService, workerModule, orchestratorWorker, honkerDb] = await setupIsolatedBackend(
  "download-tracker",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/qualityProfileService.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/downloadPipelineWorker.js",
  "backend/services/honkerDb.js",
);

const { DownloadTracker } = trackerModule;
const { DownloadWorker } = workerModule;

test.beforeEach(async () => {
  await resetDatabase(db);
  trackerModule.downloadTracker.clearAll();
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("getNextPendingMatching skips future-dated retry jobs and returns ready work", () => {
  const tracker = new DownloadTracker();
  const [firstId, secondId] = tracker.addJobs(
    [
      { artistName: "Artist A", trackName: "Song A" },
      { artistName: "Artist B", trackName: "Song B" },
    ],
    "discover",
  );

  tracker.setPending(firstId, "retry later", { asRetryCycle: true });

  const ready = tracker.getNextPendingMatching(
    (job) => job.id === secondId,
    null,
  );

  assert.equal(ready?.id, secondId);
});

test("one album pipeline reserves sibling jobs before queue handoff", () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: {
    ...settings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const queued = [];
  const tracker = new DownloadTracker({ enqueuePipeline: (payload) => queued.push(payload) });
  const tracks = ["First", "Second", "Third"].map((trackName, index) => ({
    artistName: "The Band", albumName: "Album", albumMbid: "album-test",
    trackName, trackNumber: index + 1, requestGroupId: "album-request",
  }));
  const jobIds = tracks.map((track) => tracker.addJob(track, "library"));

  assert.equal(tracker.enqueueDownloadPipeline(jobIds[0]), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].albumGrab, true);
  assert.deepEqual(queued[0].albumGroupJobIds, jobIds);
  assert.deepEqual(jobIds.slice(1).map((id) => tracker.getJob(id).status),
    ["downloading", "downloading"]);
  assert.equal(tracker.getNextPending(), null);
});

test("a queued album grab exposes durable membership without replacing track activity", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = trackerModule.downloadTracker;
  const ids = ["First", "Second"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "activity-album",
    trackName, trackNumber: index + 1, requestGroupId: "activity-request",
  }, "library"));
  assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
  const { getAurralHistoryRequests, recordTrackJobSearching } = await import("../../backend/services/aurralHistoryService.js");
  recordTrackJobSearching(tracker.getJob(ids[0]));
  const requests = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.kind === "track_download"));
  assert.ok(requests[0].albumGrab?.id);
  assert.equal(requests[0].albumGrab.id, requests[1].albumGrab.id);
  assert.deepEqual(requests[0].albumGrab.memberJobIds, ids);
  assert.equal(requests[0].albumGrab.phase, "search");
  assert.equal(requests[0].albumGrab.source, null);
  assert.ok(requests.every((item) => item.requestedAt === requests[0].albumGrab.requestedAt));
});

test("failed queue handoff and attempted flags alone do not create album activity", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = new DownloadTracker({ enqueuePipeline: () => { throw new Error("handoff rejected"); } });
  const ids = ["First", "Second"].map((trackName) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "failed-activity-album",
    trackName, requestGroupId: "failed-activity-request",
  }, "library"));
  assert.throws(() => tracker.enqueueDownloadPipeline(ids[0]), /handoff rejected/);
  trackerModule.downloadTracker._load();
  trackerModule.downloadTracker.setAlbumGrabAttempted(ids[0], true);
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const requests = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => !item.albumGrab));
});

test("album track outcomes retain source, failures, and timestamps after retry and job cleanup", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = trackerModule.downloadTracker;
  const ids = ["First", "Second"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "outcome-album",
    trackName, trackNumber: index + 1, requestGroupId: "outcome-request",
  }, "library"));
  tracker.enqueueDownloadPipeline(ids[0]);
  tracker.updateDownloadMetadata(ids[0], { downloadSource: "slskd" });
  tracker.setDone(ids[0], path.join(isolatedState.baseDir, "first.flac"));
  tracker.setFailed(ids[1], "Album file missing");
  tracker.setPending(ids[1], "Retrying missing track");
  tracker.updateDownloadMetadata(ids[1], { downloadSource: "ytdlp" });
  tracker.setDone(ids[1], path.join(isolatedState.baseDir, "second.m4a"));
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const before = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.equal(before.length, 2);
  assert.ok(before.every((item) => item.status === "completed"));
  assert.ok(before.every((item) => item.completedAt && item.requestedAt === item.albumGrab.requestedAt));
  assert.deepEqual(before.map((item) => item.actualDownloadSource).sort(), ["slskd", "ytdlp"]);
  assert.ok(before.find((item) => item.jobId === ids[1]).previousErrors.includes("Album file missing"));
  tracker.clearCompleted();
  const after = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.deepEqual(after, before);
});

test("history limits keep an album together and pruning does not recreate removed track records", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = trackerModule.downloadTracker;
  const ids = ["First", "Second", "Third"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "limited-album",
    trackName, trackNumber: index + 1, requestGroupId: "limited-request",
  }, "library"));
  tracker.enqueueDownloadPipeline(ids[0]);
  const older = Date.now() - 60 * 60 * 1000;
  for (const id of ids) db.prepare("UPDATE aurral_history SET created_at = ? WHERE id = ?").run(older, `aurral-track_download-${id}`);
  for (let index = 0; index < 320; index += 1) {
    dbOps.insertAurralHistory({ id: `unrelated-${index}`, kind: "artist_added", title: "Unrelated event", status: "completed", createdAt: Date.now() });
  }
  tracker.setDone(ids[0], path.join(isolatedState.baseDir, "first.flac"));
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const limited = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.equal(limited.length, 3);
  for (const id of ids.slice(1)) tracker.setDone(id, path.join(isolatedState.baseDir, `${id}.flac`));
  tracker.clearCompleted();
  const grab = limited[0].albumGrab;
  db.prepare("DELETE FROM aurral_history WHERE id = ?").run(`aurral-track_download-${ids[1]}`);
  const retained = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.equal(retained.length, 2);
  assert.deepEqual(retained[0].albumGrab.memberJobIds, grab.memberJobIds);
  assert.equal(dbOps.getAurralHistoryById(`aurral-track_download-${ids[1]}`), null);
});

test("album activity preserves canonical disc order and does not revive expired history", async () => {
  const { upsertLibraryArtist, upsertLibraryAlbum, upsertLibraryTrack, linkLibraryAlbumTrack } = await import("../../backend/services/libraryMediaStore.js");
  const artist = upsertLibraryArtist({ identityKey: "artist:discs", name: "The Band" });
  const album = upsertLibraryAlbum({ identityKey: "release-group:discs", mbid: "discs", artistId: artist.id, title: "Album" });
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = trackerModule.downloadTracker;
  const ids = [2, 1].map((discNumber) => {
    const track = upsertLibraryTrack({ identityKey: `recording:disc-${discNumber}`, mbid: `disc-${discNumber}`, title: `Disc ${discNumber}`, artistName: "The Band" });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber, trackNumber: 1 });
    return tracker.addJob({ artistName: "The Band", albumName: "Album", albumMbid: "discs", trackMbid: track.mbid,
      trackName: track.title, trackNumber: 1, requestGroupId: "discs-request" }, "library");
  });
  tracker.enqueueDownloadPipeline(ids[0]);
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const active = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.deepEqual(ids.map((id) => active.find((item) => item.jobId === id).discNumber), [2, 1]);
  for (const id of ids) tracker.setDone(id, path.join(isolatedState.baseDir, `${id}.flac`));
  tracker.clearCompleted();
  db.prepare("UPDATE aurral_history SET created_at = ? WHERE id = ?").run(1, `aurral-track_download-${ids[0]}`);
  const retained = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
  assert.deepEqual(retained.map((item) => item.jobId), [ids[1]]);
});

test("album activity excludes hidden member identities from an authorized response", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const tracker = trackerModule.downloadTracker;
  const ids = ["Public", "Private"].map((trackName) => tracker.addJob({ artistName: "Artist", albumName: "Album",
    albumMbid: "visible-album", trackName, requestGroupId: "visible-request" }, "library"));
  tracker.enqueueDownloadPipeline(ids[0]);
  const privateEntry = dbOps.getAurralHistoryById(`aurral-track_download-${ids[1]}`);
  dbOps.insertAurralHistory({ ...privateEntry, metadata: { ...privateEntry.metadata, ownerUserId: 99 } });
  const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
  const visible = (await getAurralHistoryRequests(null, { id: 42, role: "user" })).filter((item) => ids.includes(item.jobId));
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].albumGrab.memberJobIds, [ids[0]]);
  const admin = (await getAurralHistoryRequests(null, { role: "admin" })).filter((item) => ids.includes(item.jobId));
  assert.equal(admin.length, 2);
  assert.deepEqual(admin[0].albumGrab.memberJobIds, ids);
});

test("activity write failures do not interrupt or duplicate an album handoff", () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), integrations: { slskd: { enabled: true, url: "http://127.0.0.1:9" } } });
  const queued = [];
  const tracker = new DownloadTracker({ enqueuePipeline: (payload) => queued.push(payload) });
  const ids = ["One", "Two"].map((trackName) => tracker.addJob({ artistName: "Artist", albumName: "Album",
    albumMbid: "write-failure-album", trackName, requestGroupId: "write-failure-request" }, "library"));
  db.exec("CREATE TRIGGER reject_album_activity BEFORE INSERT ON aurral_history WHEN NEW.kind = 'album_grab' BEGIN SELECT RAISE(ABORT, 'Activity unavailable'); END");
  try {
    assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].albumGrab, true);
    assert.equal(tracker.getJob(ids[1]).status, "downloading");
  } finally {
    db.exec("DROP TRIGGER reject_album_activity");
  }
});

test("album grabs are skipped when only a per-track source is enabled", async () => {
  const binDir = path.join(isolatedState.baseDir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "yt-dlp"), "#!/bin/sh\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({ ...settings, integrations: {
      ...settings.integrations,
      slskd: { enabled: false },
      ytdlp: { enabled: true },
    } });
    const queued = [];
    const tracker = new DownloadTracker({ enqueuePipeline: (payload) => queued.push(payload) });
    const ids = ["First", "Second"].map((trackName, index) => tracker.addJob({
      artistName: "The Band", albumName: "Album", albumMbid: "ytdlp-album",
      trackName, trackNumber: index + 1, requestGroupId: "ytdlp-request",
    }, "library"));

    assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
    assert.equal(queued[0].albumGrab, undefined);
    assert.equal(tracker.getJob(ids[1]).status, "pending");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("album siblings return to individual searches when the leader stops mid-grab", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: {
    ...settings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const tracker = trackerModule.downloadTracker;
  const ids = ["First", "Second", "Third"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "stopped-album",
    trackName, trackNumber: index + 1, requestGroupId: "stopped-request",
  }, "library"));
  assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
  const grab = honkerDb.listHonkerJobs("slskd-pipeline")
    .find((entry) => entry.payload?.jobId === ids[0]).payload;
  assert.equal(grab.albumGrab, true);

  tracker.setFailed(ids[0], "Stopped by the user");
  await orchestratorWorker.processPipelineJob(grab);

  for (const id of ids.slice(1)) {
    const sibling = tracker.getJob(id);
    assert.equal(sibling.status, "pending");
    assert.match(sibling.error, /album download ended/);
  }
});

test("partial album fallback persists per-track mode across restart", () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: {
    ...settings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const queued = [];
  const tracker = new DownloadTracker({ enqueuePipeline: (payload) => queued.push(payload) });
  const ids = ["First", "Second", "Third"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "partial-album",
    trackName, trackNumber: index + 1, requestGroupId: "partial-request",
  }, "library"));
  assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
  tracker.setPending(ids[1]);
  tracker.setPending(ids[2]);

  const restarted = new DownloadTracker({ enqueuePipeline: (payload) => queued.push(payload) });
  assert.equal(restarted.enqueueDownloadPipeline(ids[1]), true);
  assert.equal(queued.length, 2);
  assert.equal(queued[1].albumGrab, undefined);
  assert.equal(restarted.getJob(ids[2]).status, "pending");
});

test("restart reuses the queued album pipeline instead of submitting another grab", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: {
    ...settings.integrations,
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  const tracker = new DownloadTracker();
  const ids = ["First", "Second"].map((trackName, index) => tracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: "restart-album",
    trackName, trackNumber: index + 1, requestGroupId: "restart-request",
  }, "library"));
  assert.equal(tracker.enqueueDownloadPipeline(ids[0]), true);
  const { listHonkerJobs } = await import("../../backend/services/honkerDb.js");
  const before = listHonkerJobs("slskd-pipeline").filter((entry) => entry.payload?.jobId === ids[0]);
  assert.equal(before.length, 1);
  assert.equal(tracker.enqueueDownloadPipeline(ids[1]), true);
  assert.equal(listHonkerJobs("slskd-pipeline").filter((entry) =>
    entry.payload?.albumGroupJobIds?.includes(ids[1])).length, 1);

  tracker.resetDownloadingToPending();
  const restarted = new DownloadTracker();
  assert.equal(restarted.enqueueDownloadPipeline(ids[1]), true);
  assert.equal(restarted.enqueueDownloadPipeline(ids[0]), true);
  const after = listHonkerJobs("slskd-pipeline").filter((entry) => entry.payload?.jobId === ids[0]);
  assert.equal(after.length, 1);
  assert.equal(restarted.getJob(ids[1]).status, "downloading");
});

test("a web-side tracker reads job changes made by the flow owner", () => {
  const tracker = new DownloadTracker();
  const id = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "playlist");
  const flowConnection = new Database(isolatedState.dbPath);
  try {
    flowConnection.prepare(
      "UPDATE playlist_download_jobs SET status = 'done' WHERE id = ?",
    ).run(id);
    const previousEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.equal(tracker.getJob(id)?.status, "done");
      assert.equal(tracker.getStats().done, 1);
      assert.equal(tracker.getStatsByPlaylistType(["playlist"]).playlist.done, 1);
      assert.deepEqual(tracker.getByPlaylistType("playlist").map((job) => job.id), [id]);
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  } finally {
    flowConnection.close();
  }
});

test("a web-side tracker does not reset an active flow download on import", () => {
  const tracker = new DownloadTracker();
  const id = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "playlist");
  tracker.setDownloading(id);
  const previousEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const webTracker = new DownloadTracker();
    assert.equal(webTracker.getJob(id)?.status, "downloading");
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("a web-side tracker preserves pending upgrades but excludes them from normal pending work", () => {
  const tracker = new DownloadTracker();
  const sourceId = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "playlist");
  tracker.setDone(sourceId, "/library/Song.mp3", "Album");
  tracker.updateQuality(sourceId, { tier: "mp3-128", format: "mp3" });
  const upgradeId = tracker.addUpgradeJob(tracker.getJob(sourceId));
  assert.ok(upgradeId);
  const pendingId = tracker.addJob({ artistName: "Artist", trackName: "Other" }, "playlist");
  const previousEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const webTracker = new DownloadTracker();
    assert.equal(webTracker.getJob(upgradeId)?.status, "pending");
    assert.equal(tracker.getJob(upgradeId)?.status, "pending");
    assert.deepEqual(webTracker.peekPending(10).map((job) => job.id), [pendingId]);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("worker does not select a job that is already active", () => {
  const tracker = trackerModule.downloadTracker;
  const worker = new DownloadWorker(isolatedState.baseDir);
  const jobId = tracker.addJob(
    { artistName: "Artist", trackName: "Library Song" },
    "library",
  );

  assert.equal(worker._getNextReadyPendingJob()?.id, jobId);
  worker.activeJobs.set(jobId, { promise: Promise.resolve() });
  assert.equal(worker._getNextReadyPendingJob(), null);
});

test("a started worker keeps its process busy only while downloads are pending", async () => {
  const worker = new DownloadWorker(isolatedState.baseDir);
  await worker.start();
  await worker.reuseRepairInFlight;
  try {
    assert.equal(worker.hasWork(), false);
    trackerModule.downloadTracker.addJob(
      { artistName: "Artist", trackName: "Pending Song" },
      "library",
    );
    assert.equal(worker.hasWork(), true);
  } finally {
    worker.stop();
  }
});

test("a worker starts no more searches than its concurrency allows", async (t) => {
  const worker = new DownloadWorker(isolatedState.baseDir);
  worker.updateWorkerSettings({ concurrency: 1 });
  const dispatched = t.mock.method(worker, "processJob", async () => {});
  t.mock.method(worker, "scheduleReuseLinkRepair", () => {});
  const transaction = honkerDb.getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'");
  transaction.commit();
  honkerDb.enqueuePipelineJob({ phase: "search", source: "slskd", jobId: "already-searching" });
  const jobId = trackerModule.downloadTracker.addJob(
    { artistName: "Artist", trackName: "Waiting Song" },
    "library",
  );
  await worker.start();
  try {
    assert.equal(dispatched.mock.callCount(), 0);
    worker.updateWorkerSettings({ concurrency: 2 });
    worker.processLoop();
    assert.deepEqual(dispatched.mock.calls.map((call) => call.arguments[0].id), [jobId]);
  } finally {
    worker.stop();
  }
});

test("persists enriched album context for slskd matching", () => {
  const tracker = new DownloadTracker();
  const jobId = tracker.addJob(
    {
      artistName: "Artist",
      trackName: "Song",
      albumName: "Album",
    },
    "discover",
  );

  tracker.updateMetadata(jobId, {
    trackNumber: 3,
    albumTrackCount: 10,
    albumTrackTitles: ["Intro", "Other Song", "Song"],
  });

  const reloaded = new DownloadTracker();
  const job = reloaded.getJob(jobId);

  assert.equal(job.trackNumber, 3);
  assert.equal(job.albumTrackCount, 10);
  assert.deepEqual(job.albumTrackTitles, ["Intro", "Other Song", "Song"]);
});

test("returns complete playlist job lists unless a caller explicitly limits them", () => {
  const tracker = new DownloadTracker();
  const tracks = Array.from({ length: 650 }, (_, index) => ({
    artistName: `Artist ${index}`,
    trackName: `Song ${index}`,
  }));

  tracker.addJobs(tracks, "large-static-playlist");

  assert.equal(tracker.getByPlaylistType("large-static-playlist").length, 650);
  assert.equal(
    tracker.getByPlaylistType("large-static-playlist", 500).length,
    500,
  );
});

test("drops orphaned upgrade jobs on restart and updates every shared file reference", () => {
  const tracker = new DownloadTracker();
  const firstId = tracker.addJob(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "flow-one",
  );
  const secondId = tracker.addJob(
    { artistName: "Artist", trackName: "Song", albumName: "Album" },
    "static-two",
  );
  for (const id of [firstId, secondId]) {
    tracker.setDone(id, "/library/Song.mp3", "Album");
    tracker.updateQuality(id, { tier: "mp3-128", format: "mp3", bitrateKbps: 128 });
  }

  const upgradeId = tracker.addUpgradeJob(tracker.getJob(firstId));
  assert.ok(upgradeId);
  assert.equal(tracker.addUpgradeJob(tracker.getJob(secondId)), null);
  const reloaded = new DownloadTracker();
  assert.equal(reloaded.getJob(upgradeId), null);
  assert.ok(reloaded.addUpgradeJob(reloaded.getJob(secondId)));

  const changed = reloaded.replaceFinalPath("/library/Song.mp3", "/library/Song.flac", {
    tier: "flac-standard",
    format: "flac",
    sampleRate: 44100,
    bitDepth: 16,
  });
  assert.equal(changed.length, 2);
  assert.equal(reloaded.getJob(firstId)?.finalPath, "/library/Song.flac");
  assert.equal(reloaded.getJob(secondId)?.qualityTier, "flac-standard");
});

test("finalizes an upgrade when optional quality metadata is absent", async () => {
  const tracker = trackerModule.downloadTracker;
  const library = path.join(isolatedState.baseDir, "weekly-flow", "aurral-weekly-flow");
  const oldPath = path.join(library, "old.mp3");
  const finalPath = path.join(library, "new.m4a");
  await mkdir(library, { recursive: true });
  await writeFile(oldPath, "old");
  await writeFile(finalPath, "new");

  const sourceId = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "discover");
  tracker.setDone(sourceId, oldPath, "Album");
  tracker.updateQuality(sourceId, { tier: "mp3-128", format: "mp3" });
  const upgradeId = tracker.addUpgradeJob(tracker.getJob(sourceId));

  await assert.doesNotReject(
    qualityProfileService.finalizeQualityUpgradeSuccess(
      tracker.getJob(upgradeId),
      finalPath,
      undefined,
    ),
  );
  assert.equal(tracker.getJob(upgradeId), null);
  assert.equal(tracker.getJob(sourceId)?.finalPath, finalPath);
});

test("classifies reused Lidarr files without making them eligible for upgrades", async () => {
  const tracker = trackerModule.downloadTracker;
  const lidarrPath = path.join(isolatedState.baseDir, "lidarr", "Song.mp3");
  await mkdir(path.dirname(lidarrPath), { recursive: true });
  await writeFile(
    lidarrPath,
    Buffer.from(
      "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/+5DAAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAAAIAAATkAKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr//////////////////////////////////////////////////////////////////wAAAABMYXZjNjEuMTkAAAAAAAAAAAAAAAAkBQcAAAAAAAAE5MAlg1kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      "base64",
    ),
  );
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    downloadFolderPath: path.join(isolatedState.baseDir, "managed"),
  });
  const jobId = tracker.addJob({ artistName: "Artist", trackName: "Song" }, "discover");
  tracker.setDone(jobId, lidarrPath, "Album", "/music/Artist/Album/Song.mp3");

  const result = await qualityProfileService.reclassifyQualityJobs();
  const job = tracker.getJob(jobId);
  const decorated = qualityProfileService.decorateJobQuality(job);

  assert.equal(result.classified, 1);
  assert.equal(job.qualityTier, "mp3-128");
  assert.equal(decorated.qualityLabel, "MP3 128");
  assert.equal(decorated.qualityState, "external");
  assert.equal(await qualityProfileService.queueQualityUpgrade(job), "ineligible");
});
