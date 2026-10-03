import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, config, { downloadTracker }, { playlistManager }, operations, honker] = await setupIsolatedBackend(
  "shared-job-retention", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js", "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/playlists/playlistManager.js", "backend/services/playlists/playlistOperations.js",
  "backend/services/honkerDb.js",
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

test("single-track removal retains the job and provider work needed by another canonical membership", async (t) => {
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
