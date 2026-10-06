import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

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
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
  honker.getPipelineQueue();
  db.prepare("DELETE FROM _honker_live WHERE queue = 'slskd-pipeline'").run();
});
test.after(() => cleanupIsolatedState(state));

function fixture(t) {
  t.mock.method(playlistManager, "refreshPlaylist", async () => {});
  t.mock.method(playlistManager, "scheduleScanLibrary", async () => {});
  t.mock.method(playlistManager, "ensureSmartPlaylists", async () => {});
  const track = { artistName: "Artist", trackName: "Track", albumName: "Album" };
  const source = config.flowPlaylistConfig.createStaticPlaylist({ name: "Source", tracks: [] });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig: config.flowPlaylistConfig }, source.id, [track]);
  const survivor = config.flowPlaylistConfig.createStaticPlaylist({ name: "Survivor", tracks: [{ ...track, jobId }] });
  return { source, survivor, jobId };
}

async function libraryFile(name, contents) {
  const file = path.join(process.env.DOWNLOAD_FOLDER, "Artist", "Album", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

test("single-track removal keeps a queued job and its provider work while another playlist references it", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const payload = { jobId, ownerId: "library", ownerGeneration: 0, phase: "poll", source: "deemix", queueUuid: "needed-provider-work" };
  const queuedId = honker.getPipelineQueue().enqueue(payload);
  await operations.processPlaylistOperation({ kind: "static-playlist-delete-track", playlistId: source.id, jobId });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 0);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(survivor.id).tracks[0].jobId, jobId);
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
  assert.equal(downloadTracker.getJob(jobId)?.queuedForPlaylist, true);
  assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM _honker_live WHERE id = ?").get(queuedId).payload), payload);
});

test("deleting a playlist with file deletion keeps finished media another playlist references", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const file = await libraryFile("Track.flac", "disposable audio");
  downloadTracker.setDone(jobId, file);
  await operations.processPlaylistOperation({ kind: "static-playlist-delete", playlistId: source.id });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(survivor.id).tracks[0].jobId, jobId);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, file);
  assert.equal(await fs.readFile(file, "utf8"), "disposable audio");
});

test("removing a downloaded track keeps it while another playlist references it", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const file = await libraryFile("Track.flac", "referenced audio");
  downloadTracker.setDone(jobId, file);
  await operations.processPlaylistOperation({ kind: "static-playlist-delete-track", playlistId: source.id, jobId });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 0);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(survivor.id).tracks[0].jobId, jobId);
  assert.equal(await fs.readFile(file, "utf8"), "referenced audio");
});

test("removing the last reference deletes queued work and downloaded files but keeps other Library tracks", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const [queuedId, reusedId] = addStaticPlaylistJobs(
    { downloadTracker, flowPlaylistConfig: config.flowPlaylistConfig },
    source.id,
    [{ artistName: "Artist", trackName: "Queued" }, { artistName: "Artist", trackName: "Reused" }],
  );
  const downloaded = await libraryFile("Track.flac", "playlist download");
  const reused = await libraryFile("Reused.flac", "library audio");
  downloadTracker.setDone(jobId, downloaded);
  downloadTracker.setDone(reusedId, reused);
  downloadTracker.setQueuedForPlaylist(reusedId, false);
  const libraryJobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Requested" }, "library");

  await operations.processPlaylistOperation({ kind: "static-playlist-delete", playlistId: source.id });

  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(downloadTracker.getJob(queuedId), null);
  await assert.rejects(fs.access(downloaded));
  assert.equal(downloadTracker.getJob(reusedId)?.finalPath, reused);
  assert.equal(await fs.readFile(reused, "utf8"), "library audio");
  assert.ok(downloadTracker.getJob(libraryJobId));
});

test("removing tracks without file deletion keeps finished downloads in the Library", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const file = await libraryFile("Track.flac", "kept audio");
  downloadTracker.setDone(jobId, file);
  await operations.updateStaticPlaylist({ playlistId: source.id, tracks: [], hasTracksUpdate: true });
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 0);
  assert.equal(downloadTracker.getJob(jobId)?.queuedForPlaylist, false);
  assert.equal(await fs.readFile(file, "utf8"), "kept audio");
});

test("a removal that cannot be saved preserves an unshared completed job and its file", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  config.flowPlaylistConfig.deleteStaticPlaylist(survivor.id);
  const file = await libraryFile("Track.flac", "original audio");
  downloadTracker.setDone(jobId, file);
  db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON settings WHEN NEW.key = 'staticPlaylists' BEGIN SELECT RAISE(ABORT, 'import save rejected'); END");
  t.after(() => db.exec("DROP TRIGGER IF EXISTS reject_import"));
  await assert.rejects(
    operations.processPlaylistOperation({ kind: "static-playlist-delete-track", playlistId: source.id, jobId }),
    /import save rejected/,
  );
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id).tracks.length, 1);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, file);
  assert.equal(downloadTracker.getJob(jobId)?.queuedForPlaylist, true);
  assert.equal(await fs.readFile(file, "utf8"), "original audio");
  db.exec("DROP TRIGGER reject_import");
});

test("whole-playlist deletion resumes external cleanup after membership commits", async (t) => {
  const { source, survivor, jobId } = fixture(t);
  const file = await libraryFile("Completed.flac", "completed retained audio");
  downloadTracker.setDone(jobId, file);
  let fail = true;
  t.mock.method(playlistManager, "deletePlaybackPlaylist", async () => {
    if (fail) throw new Error("playback unavailable");
  });
  const operation = { kind: "static-playlist-delete", playlistId: source.id };
  await assert.rejects(operations.processPlaylistOperation(operation), /playback unavailable/);
  assert.ok(config.flowPlaylistConfig.getStaticPlaylist(source.id));
  fail = false;
  await operations.processPlaylistOperation(operation);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(source.id), null);
  assert.equal(config.flowPlaylistConfig.getStaticPlaylist(survivor.id).tracks[0].jobId, jobId);
  assert.equal(await fs.readFile(file, "utf8"), "completed retained audio");
});
