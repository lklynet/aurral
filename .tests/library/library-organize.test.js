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
] = await setupIsolatedBackend(
  "library-organize",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryFiles/operations.js",
  "backend/services/libraryFiles/operationStore.js",
  "backend/services/downloadPaths.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/qualityProfileService.js",
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

async function organize(scope, actions) {
  const operation = await operations.startOrganize({ scope, actions });
  const ready = await runUntilSettled(operation.id);
  const preview = operations.describeLibraryFileOperationItems(ready, {});
  if (ready.status === "ready") assert.equal(await operations.confirmLibraryFileOperation(operation.id), true);
  const finished = await runUntilSettled(operation.id);
  assert.equal(finished.status, "complete");
  return { preview, items: operations.describeLibraryFileOperationItems(finished, {}) };
}

const albumNamed = (title) => db.prepare("SELECT * FROM library_albums WHERE title = ?").get(title);
const mediaAt = (filePath) => db.prepare("SELECT * FROM library_media_files WHERE path = ?").get(filePath);

const originalSettings = dbOps.getSettings();

function useSettings({ rename = true, libraryTracks = true } = {}) {
  dbOps.updateSettings({
    ...originalSettings,
    libraryFiles: { rename },
    qualityProfile: { ...originalSettings.qualityProfile, cutoff: "flac-standard", libraryTracks },
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

  const { preview, items } = await organize({ kind: "album", id: albumNamed("Rename Album").id }, ["rename"]);

  const newPath = path.join(root, "Rename Artist", "Rename Album", "03 - Song.flac");
  assert.deepEqual(preview.map((item) => [item.status, item.target]), [["pending", path.relative(root, newPath)]]);
  assert.equal(items[0].status, "done");
  assert.equal(await exists(newPath), true);
  assert.equal(await exists(path.join(root, "odd folder")), false);
  assert.equal(await readFile(path.join(root, "Rename Artist", "Rename Album", "03 - Song.lrc"), "utf8"), "[00:00.00]la");
  assert.equal(mediaAt(newPath)?.id, before.id);
  assert.equal(downloadTracker.getJob(jobId).finalPath, newPath);
});

test("rename never takes a name another file has", async () => {
  const oldPath = await makeTrack(path.join(root, "Clash", "x.flac"), {
    artist: "Clash", album: "Album", title: "Song", track: "1",
  });
  const occupant = await makeTrack(path.join(root, "Clash", "Album", "01 - Song.flac"), {
    artist: "Clash", album: "Elsewhere", title: "Song", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const occupantBytes = await readFile(occupant);

  const { items } = await organize({ kind: "album", id: albumNamed("Album").id }, ["rename"]);

  assert.equal(items[0].status, "conflict");
  assert.equal(await exists(oldPath), true);
  assert.deepEqual(await readFile(occupant), occupantBytes);
});

test("organize refuses actions that are turned off", async () => {
  useSettings({ rename: false, libraryTracks: false });
  await assert.rejects(operations.startOrganize({ scope: { kind: "library" }, actions: ["rename"] }), /Turn on rename/);
});

test("upgrades reach monitored Library tracks that Aurral did not download", async () => {
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
    useSettings({ libraryTracks: false });
    assert.equal(await qualityProfileService.runQualityUpgradeCheck({ force: true }), 0);

    useSettings({ libraryTracks: true });
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

test("an upgrade with MusicBrainz tags keeps the Library track, its favorites, and its monitoring", async () => {
  const oldPath = await makeTrack(path.join(root, "Tagless", "Album", "01 - Low.mp3"), {
    artist: "Tagless", album: "Album", title: "Low", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const track = db.prepare("SELECT * FROM library_tracks WHERE title = 'Low'").get();
  db.prepare("UPDATE library_tracks SET monitored = 1 WHERE id = ?").run(track.id);
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (8, 'listener', 'x')").run();
  db.prepare("INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (8, 'song', ?, 1)")
    .run(track.identity_key);
  const upgraded = await makeTrack(path.join(root, "Tagless", "Album", "01 - Low.flac"), {
    artist: "Tagless", album: "Album", title: "Low", track: "1",
    MUSICBRAINZ_RELEASEGROUPID: releaseGroup, MUSICBRAINZ_TRACKID: recording,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral", filePaths: [upgraded] });
  const jobId = downloadTracker.addJob({ artistName: "Tagless", trackName: "Low" }, "library");
  downloadTracker.setDone(jobId, oldPath, "Album");
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
  assert.equal(db.prepare("SELECT COUNT(*) FROM library_albums WHERE title = 'Album'").pluck().get(), 1);
});
