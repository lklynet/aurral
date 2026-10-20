import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, config, { downloadTracker }, { playlistManager }, operations, honker,
  { downloadWorker }, { scanMusicRoot }, { getLibrary }, { repairReusableTrackLinks }] = await setupIsolatedBackend(
  "shared-job-retention", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js", "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js", "backend/services/playlists/playlistOperations.js",
  "backend/services/honkerDb.js", "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/libraryFileScanner.js", "backend/services/libraryQueryService.js",
  "backend/services/downloadJobs/fileReuse.js",
);
test.beforeEach(() => {
  resetDatabase(db);
  config.invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
test.after(() => cleanupIsolatedState(state));

function fixture(t) {
  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => {});
  const track = { artistName: "Artist", trackName: "Track", albumName: "Album" };
  const source = config.flowPlaylistConfig.createStaticPlaylist({ name: "Source", tracks: [track] });
  const jobId = downloadTracker.addJob(track, source.id);
  const survivor = config.flowPlaylistConfig.createStaticPlaylist({ name: "Survivor", tracks: [{ ...track, canonicalJobId: jobId }] });
  return { source, survivor, jobId };
}

test("single-track removal retains the job and provider work needed by another library membership", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const queuedId = honker.getPipelineQueue().enqueue({ jobId, playlistId: source.id, playlistGeneration: 0, phase: "poll", source: "deemix", queueUuid: "needed-provider-work" });
  await operations.processPlaylistOperation({ kind: "shared-playlist-delete-track", playlistId: source.id, jobId });
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 0);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(survivor.id).tracks[0].canonicalJobId, jobId);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM _honker_live WHERE id = ?").get(queuedId).payload).playlistId, survivor.id);
});

test("deleting the original playlist preserves a survivor's completed media", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const root = process.env.WEEKLY_FLOW_FOLDER;
  const file = path.join(root, "aurral-weekly-flow", source.id, "Artist", "Album", "Track.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "disposable audio");
  downloadTracker.setDone(jobId, file);
  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: source.id });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  const retained = downloadTracker.getJob(jobId);
  assert.equal(retained?.playlistType, survivor.id);
  assert.equal(await fs.readFile(retained.finalPath, "utf8"), "disposable audio");
});

test("replacing imported tracks preserves a removed job referenced by another playlist", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  await operations.updateStaticPlaylist({ playlistId: source.id, tracks: [], hasTracksUpdate: true });
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 0);
});

test("an import persistence failure preserves an unshared completed job and its file", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, "aurral-playlists", source.id, "Track.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "original audio");
  downloadTracker.setDone(jobId, file);
  db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'import save rejected'); END");
  t.after(() => db.exec("DROP TRIGGER IF EXISTS reject_import"));
  await assert.rejects(operations.updateStaticPlaylist({ playlistId: source.id, tracks: [], hasTracksUpdate: true, deleteUnsharedFiles: true }), /import save rejected/);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 1);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, file);
  assert.equal(await fs.readFile(file, "utf8"), "original audio");
  db.exec("DROP TRIGGER reject_import");
});

test("a single-removal retry refreshes the surviving playlist after a service failure", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  let fail = true;
  const refreshed = [];
  t.mock.method(playlistManager, "refreshPlaylist", async (id) => {
    refreshed.push(id);
    if (id === survivor.id && fail) throw new Error("survivor unavailable");
  });
  const operation = { kind: "shared-playlist-delete-track", playlistId: source.id, jobId };
  await assert.rejects(operations.processPlaylistOperation(operation), /survivor unavailable/);
  assert.equal(downloadTracker.getJob(jobId)?.playlistType, survivor.id);
  fail = false;
  refreshed.length = 0;
  await operations.processPlaylistOperation(operation);
  assert.ok(refreshed.includes(survivor.id));
});

test("removal locks include reused files and quality-upgrade album peers", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const fileOwner = config.flowPlaylistConfig.createStaticPlaylist({ name: "File owner" });
  const peerOwner = config.flowPlaylistConfig.createStaticPlaylist({ name: "Upgrade peer owner" });
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, "shared.flac");
  downloadTracker.setDone(jobId, file);
  const sharedJobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Shared" }, fileOwner.id);
  downloadTracker.setDone(sharedJobId, file);
  const upgradeId = downloadTracker.addReplacementSearchJob(downloadTracker.getJob(jobId));
  const peerId = downloadTracker.addJob({ artistName: "Artist", trackName: "Peer" }, peerOwner.id);
  honker.getPipelineQueue().enqueue({ jobId: upgradeId, playlistId: source.id, albumGrab: true, albumGroupJobIds: [upgradeId, peerId] });
  const { getPlaylistRemovalLockIds } = await import("../../backend/services/playlists/trackRemoval.js");
  const ids = getPlaylistRemovalLockIds(source.id, [downloadTracker.getJob(jobId)]);
  assert.ok(ids.includes(fileOwner.id), "the other file owner must be locked before paths change");
  assert.ok(ids.includes(peerOwner.id), "the upgrade peer must be locked before provider work changes");
});

test("a failed membership commit keeps both media copies and retries retained ownership", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, "aurral-playlists", source.id, "Retained.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "retained audio");
  downloadTracker.setDone(jobId, file);
  db.exec("CREATE TRIGGER reject_retained_membership BEFORE INSERT ON settings WHEN NEW.key = 'sharedPlaylists' BEGIN SELECT RAISE(ABORT, 'retained save rejected'); END");
  const operation = { kind: "shared-playlist-delete-track", playlistId: source.id, jobId };
  try {
    await assert.rejects(operations.processPlaylistOperation(operation), /retained save rejected/);
    assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 1);
    assert.equal(downloadTracker.getJob(jobId).playlistType, source.id);
    assert.equal(downloadTracker.getJob(jobId).finalPath, file);
    assert.equal(await fs.readFile(file, "utf8"), "retained audio");
    const intent = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get(`playlistMediaRelocation:${jobId}`).value);
    assert.equal(await fs.readFile(intent.to, "utf8"), "retained audio");
  } finally { db.exec("DROP TRIGGER reject_retained_membership"); }
  await operations.processPlaylistOperation(operation);
  assert.equal(downloadTracker.getJob(jobId).playlistType, survivor.id);
  assert.equal(await fs.readFile(downloadTracker.getJob(jobId).finalPath, "utf8"), "retained audio");
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("whole-playlist deletion resumes external cleanup after membership commits", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, "aurral-playlists", source.id, "Completed.flac");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "completed retained audio");
  downloadTracker.setDone(jobId, file);
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  let fail = true;
  t.mock.method(playlistManager, "deletePlaybackPlaylist", async () => {
    if (fail) throw new Error("playback unavailable");
  });
  const operation = { kind: "shared-playlist-delete", playlistId: source.id };
  await assert.rejects(operations.processPlaylistOperation(operation), /playback unavailable/);
  assert.equal(downloadTracker.getJob(jobId).playlistType, survivor.id);
  assert.ok(config.flowPlaylistConfig.getStaticPlaylist(source.id));
  fail = false;
  await operations.processPlaylistOperation(operation);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  assert.equal(downloadTracker.getJob(jobId).playlistType, survivor.id);
});

async function addLibraryFile({ artistName, albumName, trackName }) {
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, artistName, albumName, `${trackName}.flac`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
    "-metadata", `album_artist=${artistName}`, "-metadata", `artist=${artistName}`,
    "-metadata", `album=${albumName}`, "-metadata", `title=${trackName}`, file,
  ]);
  await scanMusicRoot({ rootPath: process.env.WEEKLY_FLOW_FOLDER, source: "aurral" });
  return file;
}

async function assertStillInLibrary(file) {
  await fs.access(file);
  await scanMusicRoot({ rootPath: process.env.WEEKLY_FLOW_FOLDER, source: "aurral" });
  assert.ok(getLibrary({ availableOnly: true }).tracks.some((track) => track.files.some((media) => media.path === file)),
    "the Library must still have the reused file");
}

function mockPlaylistServices(t) {
  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  t.mock.method(downloadWorker, "start", async () => false);
}

async function createPlaylist(tracks, extra = {}) {
  const { playlist } = await operations.processPlaylistOperation({ kind: "shared-playlist-create", name: "From the Library", tracks, ...extra });
  const jobFor = (track) => downloadTracker.getByPlaylistType(playlist.id).find((job) => job.trackName === track.trackName);
  return { playlist, jobFor };
}

async function finishDownload(job) {
  const file = path.join(process.env.WEEKLY_FLOW_FOLDER, job.artistName, job.albumName, `${job.trackName}.flac`);
  downloadTracker.setDownloading(job.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "downloaded for the playlist");
  downloadTracker.setDone(job.id, file, job.albumName);
  return file;
}

test("deleting a playlist keeps the Library files it reused and deletes the files it downloaded", async (t) => {
  const reused = { artistName: "Reuse Band", albumName: "Reuse Record", trackName: "Already Here" };
  const downloaded = { artistName: "Fresh Band", albumName: "Fresh Record", trackName: "Fetched" };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices(t);
  const { playlist, jobFor } = await createPlaylist([reused, downloaded]);
  assert.equal(jobFor(reused).status, "done");
  assert.equal(jobFor(reused).finalPath, libraryFile);
  const downloadedFile = await finishDownload(jobFor(downloaded));

  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: playlist.id });

  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(playlist.id), null);
  await assert.rejects(fs.access(downloadedFile), { code: "ENOENT" });
  await assertStillInLibrary(libraryFile);
});

test("removing a reused track from a playlist keeps its Library file", async (t) => {
  const reused = { artistName: "Reuse Band", albumName: "Single Removal", trackName: "Stays Put" };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices(t);
  const { playlist, jobFor } = await createPlaylist([reused]);
  const jobId = jobFor(reused).id;

  await operations.processPlaylistOperation({ kind: "shared-playlist-delete-track", playlistId: playlist.id, jobId });

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(playlist.id).tracks.length, 0);
  await assertStillInLibrary(libraryFile);
});

test("a synced playlist that drops a reused track keeps its Library file when removed tracks are not kept", async (t) => {
  const reused = { artistName: "Reuse Band", albumName: "Synced Record", trackName: "Dropped Upstream" };
  const libraryFile = await addLibraryFile(reused);
  mockPlaylistServices(t);
  const { playlist, jobFor } = await createPlaylist([reused], {
    importSource: { provider: "spotify-playlist", externalId: "synced", syncEnabled: true, syncIntervalHours: 24, keepRemovedTracks: false },
  });
  const jobId = jobFor(reused).id;

  await operations.processPlaylistOperation({
    kind: "shared-playlist-update", playlistId: playlist.id, tracks: [], hasTracksUpdate: true,
    hasImportSourceUpdate: true, importSource: { lastSyncAt: Date.now() }, mergeImportSource: true,
  });

  assert.equal(downloadTracker.getJob(jobId), null);
  await assertStillInLibrary(libraryFile);
});

test("a playlist track repaired onto a Library file keeps that file when the playlist is deleted", async (t) => {
  const track = { artistName: "Repair Band", albumName: "Repair Record", trackName: "Lost Download" };
  mockPlaylistServices(t);
  const { playlist, jobFor } = await createPlaylist([track]);
  const lostFile = path.join(process.env.WEEKLY_FLOW_FOLDER, "aurral-playlists", playlist.id, "Lost Download.flac");
  downloadTracker.setDownloading(jobFor(track).id);
  downloadTracker.setDone(jobFor(track).id, lostFile, track.albumName);
  const libraryFile = await addLibraryFile(track);

  await repairReusableTrackLinks({ downloadRoot: process.env.WEEKLY_FLOW_FOLDER });
  assert.equal(jobFor(track).finalPath, libraryFile);
  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: playlist.id });

  await assertStillInLibrary(libraryFile);
});

test("a file one playlist downloaded and another reused is deleted once neither playlist uses it", async (t) => {
  const track = { artistName: "Shared Band", albumName: "Shared Record", trackName: "Passed Along" };
  mockPlaylistServices(t);
  const first = await createPlaylist([track], { name: "Downloaded it" });
  const file = await finishDownload(first.jobFor(track));
  const second = await createPlaylist([track], { name: "Reused it" });
  assert.equal(second.jobFor(track).finalPath, file);

  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: first.playlist.id });
  await fs.access(file);
  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: second.playlist.id });

  await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("a Library file two playlists reused stays after both playlists are deleted", async (t) => {
  const track = { artistName: "Reuse Band", albumName: "Twice Reused", trackName: "Popular" };
  const libraryFile = await addLibraryFile(track);
  mockPlaylistServices(t);
  const first = await createPlaylist([track], { name: "Reused first" });
  const second = await createPlaylist([track], { name: "Reused second" });
  assert.equal(second.jobFor(track).finalPath, libraryFile);

  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: first.playlist.id });
  await operations.processPlaylistOperation({ kind: "shared-playlist-delete", playlistId: second.playlist.id });

  await assertStillInLibrary(libraryFile);
});
