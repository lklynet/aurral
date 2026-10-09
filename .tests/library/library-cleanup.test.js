import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const execFileAsync = promisify(execFile);

const [
  isolatedState,
  { db },
  { dbOps },
  { scanMusicRoot },
  operations,
  { getLibraryFileOperation },
  { resolveDownloadRoot },
  { downloadTracker },
  qualityProfileService,
  { playlistManager },
  { findUniqueLibrarySong },
  { getPlayQueue, savePlayQueue },
] = await setupIsolatedBackend(
  "library-cleanup",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryFiles/operations.js",
  "backend/services/libraryFiles/operationStore.js",
  "backend/services/downloadPaths.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/qualityProfileService.js",
  "backend/services/playlists/playlistManager.js",
  "backend/services/subsonicLibraryService.js",
  "backend/services/subsonicPlayQueueService.js",
);

const root = resolveDownloadRoot();
const outside = path.join(isolatedState.baseDir, "seed");
const releaseGroup = "3f3f3f3f-0000-4000-8000-000000000001";
const recording = "3f3f3f3f-0000-4000-8000-0000000000r1";
let tone = 300;

async function makeTrack(filePath, tags = {}, codec = []) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", `sine=frequency=${tone += 11}:duration=0.2`, ...codec];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  await execFileAsync("ffmpeg", [...args, filePath]);
  return filePath;
}

const exists = (filePath) => stat(filePath).then(() => true, () => false);

async function runUntilSettled(id) {
  for (let slice = 0; slice < 100; slice += 1) {
    if ((await operations.runLibraryFileOperation(id)).done) return getLibraryFileOperation(id);
  }
  throw new Error("operation did not settle");
}

async function runUntilChecked(id) {
  for (let slice = 0; slice < 100; slice += 1) {
    if (getLibraryFileOperation(id).status !== "planning") return getLibraryFileOperation(id);
    await operations.runLibraryFileOperation(id);
  }
  throw new Error("operation did not finish checking files");
}

async function cleanUp() {
  const operation = await operations.startCleanup();
  const checked = await runUntilChecked(operation.id);
  const preview = operations.describeLibraryFileOperationItems(checked, {});
  const finished = await runUntilSettled(operation.id);
  assert.equal(finished.status, "complete");
  return { preview, items: operations.describeLibraryFileOperationItems(finished, {}) };
}

const mediaAt = (filePath) => db.prepare("SELECT * FROM library_media_files WHERE path = ?").get(filePath);

const originalSettings = dbOps.getSettings();

function useSettings() {
  dbOps.updateSettings({
    ...originalSettings,
    qualityProfile: { ...originalSettings.qualityProfile, cutoff: "flac-standard" },
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    },
  });
}

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  downloadTracker.clearAll();
  useSettings();
});

test.after(async () => {
  dbOps.updateSettings(originalSettings);
  await cleanupIsolatedState(isolatedState);
});

test("rename gives a file Aurral's name and keeps its Library row, jobs, and lyrics", async () => {
  const oldPath = await makeTrack(path.join(root, "odd folder", "track.flac"), {
    artist: "Rename Artist", album: "Rename Album", title: "Song", track: "3",
  });
  await writeFile(path.join(root, "odd folder", "track.lrc"), "[00:00.00]la");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const before = mediaAt(oldPath);
  const jobId = downloadTracker.addJob({ artistName: "Rename Artist", trackName: "Song" }, "library");
  downloadTracker.setDone(jobId, oldPath, "Rename Album");

  const { preview, items } = await cleanUp();

  const newPath = path.join(root, "Rename Artist", "Rename Album", "03 - Song.flac");
  assert.deepEqual(preview.map((item) => [item.status, item.target]), [["pending", path.relative(root, newPath)]]);
  assert.equal(items[0].status, "done");
  assert.equal(await exists(newPath), true);
  assert.equal(await exists(path.join(root, "odd folder")), false);
  assert.equal(await readFile(path.join(root, "Rename Artist", "Rename Album", "03 - Song.lrc"), "utf8"), "[00:00.00]la");
  assert.equal(mediaAt(newPath)?.id, before.id);
  assert.equal(downloadTracker.getJob(jobId).finalPath, newPath);
});

test("a rename a restart interrupted still refreshes the playlists that use the file", async (t) => {
  const oldPath = await makeTrack(path.join(root, "loose", "track.flac"), {
    artist: "Resume Artist", album: "Resume Album", title: "Song", track: "2",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const jobId = downloadTracker.addJob({ artistName: "Resume Artist", trackName: "Song" }, "static-mix");
  downloadTracker.setDone(jobId, oldPath, "Resume Album");
  const refreshed = [];
  t.mock.method(playlistManager, "refreshPlaylist", async (playlistId) => { refreshed.push(playlistId); });

  const operation = await operations.startCleanup();
  await runUntilChecked(operation.id);
  const newPath = path.join(root, "Resume Artist", "Resume Album", "02 - Song.flac");
  await mkdir(path.dirname(newPath), { recursive: true });
  await link(oldPath, newPath);
  await rm(oldPath);
  downloadTracker.updateFinalPath(jobId, newPath);
  const finished = await runUntilSettled(operation.id);

  assert.equal(finished.status, "complete");
  assert.equal(operations.describeLibraryFileOperationItems(finished, {})[0].status, "done");
  assert.ok(mediaAt(newPath));
  assert.deepEqual(refreshed, ["static-mix"]);
});

test("rename never takes a name another file has", async () => {
  const oldPath = await makeTrack(path.join(root, "Clash", "x.flac"), {
    artist: "Clash", album: "Album", title: "Song", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const occupant = await makeTrack(path.join(root, "Clash", "Album", "01 - Song.flac"), {
    artist: "Clash", album: "Elsewhere", title: "Song", track: "1",
  });
  const occupantBytes = await readFile(occupant);

  const { items } = await cleanUp();

  assert.equal(items[0].status, "conflict");
  assert.equal(await exists(oldPath), true);
  assert.deepEqual(await readFile(occupant), occupantBytes);
});

test("automatic upgrades reach monitored Library tracks that Aurral did not download, and no others", async () => {
  const mp3 = ["-c:a", "libmp3lame", "-b:a", "128k"];
  const monitored = await makeTrack(path.join(root, "Upgrade", "Album", "01 - Low.mp3"), {
    artist: "Upgrade", album: "Album", title: "Low", track: "1",
  }, mp3);
  const unmonitored = await makeTrack(path.join(root, "Upgrade", "Album", "02 - Left.mp3"), {
    artist: "Upgrade", album: "Album", title: "Left", track: "2",
  }, mp3);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  db.prepare("UPDATE library_tracks SET monitored = 1 WHERE title = 'Low'").run();
  const queued = [];
  const originalEnqueue = downloadTracker.enqueueDownloadPipeline;
  downloadTracker.enqueueDownloadPipeline = (id) => queued.push(id) > 0;
  try {
    assert.equal(await qualityProfileService.runQualityUpgradeCheck({ force: true }), 1);
    const upgrade = downloadTracker.getJob(queued[0]);
    assert.equal(downloadTracker.getJob(upgrade.upgradeForJobId).finalPath, monitored);
    assert.equal(downloadTracker.getAll().some((job) => job.finalPath === unmonitored), false);
  } finally {
    downloadTracker.enqueueDownloadPipeline = originalEnqueue;
  }
});

test("an upgrade replaces a hardlinked file without touching its other link", async () => {
  const seed = await makeTrack(path.join(outside, "low.flac"), { title: "Low" });
  const seedBytes = await readFile(seed);
  const libraryPath = path.join(root, "Linked", "Album", "01 - Low.flac");
  await mkdir(path.dirname(libraryPath), { recursive: true });
  await link(seed, libraryPath);
  const upgraded = await makeTrack(path.join(root, "Linked", "Album", "01 - Low (2).flac"), { title: "Low" });
  const upgradedBytes = await readFile(upgraded);
  const jobId = downloadTracker.addJob({ artistName: "Linked", trackName: "Low" }, "library");
  downloadTracker.setDone(jobId, libraryPath, "Album");
  const upgradeId = downloadTracker.addUpgradeJob(downloadTracker.getJob(jobId));

  await qualityProfileService.finalizeQualityUpgradeSuccess(
    downloadTracker.getJob(upgradeId),
    upgraded,
    { tier: "flac-hires" },
  );

  assert.deepEqual(await readFile(seed), seedBytes);
  assert.deepEqual(await readFile(libraryPath), upgradedBytes);
  assert.equal(await exists(upgraded), false);
  assert.equal(downloadTracker.getJob(jobId).finalPath, libraryPath);
});

test("an upgrade with MusicBrainz tags keeps the Library track, its favorites, its monitoring, and saved play queues", async () => {
  const oldPath = await makeTrack(path.join(root, "Tagless", "Album", "01 - Low.mp3"), {
    artist: "Tagless", album: "Album (Old Rip)", title: "Low", track: "1",
  });
  await makeTrack(path.join(root, "Tagless", "Album", "02 - High.mp3"), {
    artist: "Tagless", album: "Album (Old Rip)", title: "High", track: "2",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const track = db.prepare("SELECT * FROM library_tracks WHERE title = 'Low'").get();
  db.prepare("UPDATE library_tracks SET monitored = 1 WHERE id = ?").run(track.id);
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (8, 'listener', 'x')").run();
  db.prepare("INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (8, 'song', ?, 1)")
    .run(track.identity_key);
  const listener = { id: 8, username: "listener" };
  const queued = findUniqueLibrarySong("Tagless", "Low", listener);
  savePlayQueue(listener, { ids: [queued.id], current: queued.id, position: 4200, changedBy: "test" });
  const upgraded = await makeTrack(path.join(root, "Tagless", "Album", "01 - Low.flac"), {
    artist: "Tagless", album: "Album", title: "Low", track: "1",
    MUSICBRAINZ_RELEASEGROUPID: releaseGroup, MUSICBRAINZ_TRACKID: recording,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral", filePaths: [upgraded] });
  const jobId = downloadTracker.addJob({ artistName: "Tagless", trackName: "Low" }, "library");
  downloadTracker.setDone(jobId, oldPath, "Album (Old Rip)");
  const upgradeId = downloadTracker.addUpgradeJob(downloadTracker.getJob(jobId));

  await qualityProfileService.finalizeQualityUpgradeSuccess(
    downloadTracker.getJob(upgradeId),
    upgraded,
    { tier: "flac-standard" },
  );

  assert.equal(await exists(oldPath), false);
  const tracks = db.prepare("SELECT * FROM library_tracks WHERE title = 'Low'").all();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].identity_key, `recording:${recording}`);
  assert.equal(tracks[0].monitored, 1);
  assert.equal(db.prepare("SELECT entity_key FROM subsonic_stars WHERE user_id = 8").pluck().get(), tracks[0].identity_key);
  assert.deepEqual(
    db.prepare("SELECT path FROM library_media_files WHERE track_id = ?").pluck().all(tracks[0].id),
    [upgraded],
  );
  const queue = getPlayQueue(listener);
  assert.deepEqual(queue.entry.map((song) => song.title), ["Low"]);
  assert.equal(queue.current, queue.entry[0].id);
  assert.equal(queue.position, 4200);
  assert.deepEqual(db.prepare("SELECT title FROM library_albums").pluck().all(), ["Album"]);
  assert.deepEqual(db.prepare(
    `SELECT document.album_name FROM library_search_documents AS document
     JOIN library_tracks AS track ON track.id = document.entity_id
     WHERE document.entity_kind = 'track' ORDER BY track.title`,
  ).pluck().all().map((name) => name.includes("Old Rip")), [false, false]);
});
