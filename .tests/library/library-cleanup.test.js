import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
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
  { retryPlaybackRetainedFiles },
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
  "backend/services/playback/playbackFileRetention.js",
);

const root = resolveDownloadRoot();
const outside = path.join(isolatedState.baseDir, "seed");
const releaseGroup = "3f3f3f3f-0000-4000-8000-000000000001";
const recording = "3f3f3f3f-0000-4000-8000-0000000000r1";
let tone = 300;

async function makeTrack(filePath, tags = {}, codec = [], { seconds = 0.2 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", `sine=frequency=${tone += 11}:duration=${seconds}`, ...codec];
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
  return { id: operation.id, preview, items: operations.describeLibraryFileOperationItems(finished, {}) };
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

test("a second-disc file takes the disc in its name once, and first-disc and undisced names stay", async () => {
  const albumDir = path.join(root, "Bush", "Sixteen Stone");
  const tags = { artist: "Bush", album: "Sixteen Stone", title: "Bomb", track: "3" };
  const firstDisc = await makeTrack(path.join(albumDir, "03 - Bomb.flac"), { ...tags, disc: "1" });
  const secondDisc = await makeTrack(path.join(albumDir, "03 - Bomb (2).flac"), { ...tags, disc: "2" });
  const undisced = await makeTrack(path.join(albumDir, "05 - Swim.flac"), { ...tags, title: "Swim", track: "5" });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const before = mediaAt(secondDisc);
  const jobId = downloadTracker.addJob({ artistName: "Bush", trackName: "Bomb", trackNumber: 3 }, "library");
  downloadTracker.setDone(jobId, secondDisc, "Sixteen Stone");

  const { items } = await cleanUp();

  const renamed = path.join(albumDir, "2-03 - Bomb.flac");
  const renames = (list) => list.filter((item) => item.target).map((item) => [item.status, item.target]);
  assert.deepEqual(renames(items), [["done", path.relative(root, renamed)]]);
  assert.equal(await exists(secondDisc), false);
  assert.equal(mediaAt(renamed)?.id, before.id);
  assert.equal(downloadTracker.getJob(jobId).finalPath, renamed);
  for (const kept of [firstDisc, undisced]) assert.equal(mediaAt(kept)?.available, 1);
  assert.deepEqual(renames((await cleanUp()).items), []);
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

const describe = (id) => operations.describeLibraryFileOperation(getLibraryFileOperation(id));
const availablePaths = (title) => db.prepare(
  `SELECT media.path FROM library_media_files AS media JOIN library_tracks AS track ON track.id = media.track_id
   WHERE track.title = ? AND media.available = 1 ORDER BY media.path`,
).pluck().all(title);

test("a second copy of a track is a duplicate, removed only when asked, and playlists and favorites stay on the kept copy", async (t) => {
  const tags = { artist: "Twice", album: "Album", title: "Song", track: "1" };
  const first = await makeTrack(path.join(root, "loose a", "track.flac"), tags);
  const second = path.join(root, "loose b", "track.flac");
  await mkdir(path.dirname(second), { recursive: true });
  await copyFile(first, second);
  await writeFile(path.join(root, "loose b", "track.lrc"), "[00:00.00]la");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const track = db.prepare("SELECT * FROM library_tracks WHERE title = 'Song'").get();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'fan', 'x')").run();
  db.prepare("INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (7, 'song', ?, 1)")
    .run(track.identity_key);
  const jobId = downloadTracker.addJob({ artistName: "Twice", trackName: "Song" }, "static-mix");
  downloadTracker.setDone(jobId, second, "Album");
  const refreshed = [];
  t.mock.method(playlistManager, "refreshPlaylist", async (playlistId) => { refreshed.push(playlistId); });

  const { id, items } = await cleanUp();

  const named = path.join(root, "Twice", "Album", "01 - Song.flac");
  const itemFor = (filePath) => items.find((item) => path.resolve(root, item.source) === filePath);
  assert.equal(itemFor(first).status, "done");
  assert.equal(itemFor(second).status, "duplicate");
  assert.equal(itemFor(second).target, path.relative(root, named));
  assert.deepEqual(describe(id).sources, { removable: 1, removed: 0 });
  assert.equal(await exists(second), true);

  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");

  assert.equal(await exists(second), false);
  assert.equal(await exists(path.join(root, "loose b")), false);
  assert.equal(await readFile(path.join(root, "Twice", "Album", "01 - Song.lrc"), "utf8"), "[00:00.00]la");
  assert.deepEqual(availablePaths("Song"), [named]);
  assert.equal(db.prepare("SELECT id FROM library_tracks WHERE title = 'Song'").pluck().get(), track.id);
  assert.equal(db.prepare("SELECT entity_key FROM subsonic_stars WHERE user_id = 7").pluck().get(), track.identity_key);
  assert.equal(downloadTracker.getJob(jobId).finalPath, named);
  assert.ok(refreshed.includes("static-mix"));
  assert.deepEqual(describe(id).sources, { removable: 0, removed: 1 });
});

test("the better copy of a track keeps its name, and a copy of a different length stays a conflict", async () => {
  const tags = { artist: "Swap", album: "Album", title: "Song", track: "1" };
  const worse = await makeTrack(path.join(root, "Swap", "Album", "01 - Song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "96k"]);
  const middle = await makeTrack(path.join(root, "Swap", "Album", "song (2).mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "192k"]);
  const better = await makeTrack(path.join(root, "Swap", "Album", "song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "320k"]);
  const betterBytes = await readFile(better);
  const longTags = { artist: "Long", album: "Album", title: "Song", track: "1" };
  const short = await makeTrack(path.join(root, "Long", "Album", "01 - Song.flac"), longTags);
  const long = await makeTrack(path.join(root, "Long", "Album", "song.flac"), longTags, [], { seconds: 5 });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const swapTrack = db.prepare(
    "SELECT track.id FROM library_tracks AS track JOIN library_media_files AS media ON media.track_id = track.id WHERE media.path = ?",
  ).pluck().get(worse);

  const { id, items } = await cleanUp();
  const itemFor = (filePath) => items.find((item) => path.resolve(root, item.source) === filePath);

  assert.equal(itemFor(worse).status, "duplicate");
  assert.equal(itemFor(worse).target, path.relative(root, better));
  assert.equal(itemFor(middle).status, "duplicate");
  assert.equal(itemFor(middle).target, path.relative(root, worse));
  assert.equal(itemFor(long).status, "conflict");
  assert.match(itemFor(long).reason, /longer/);

  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");

  assert.deepEqual(await readFile(worse), betterBytes);
  assert.equal(await exists(better), false);
  assert.equal(await exists(middle), false);
  assert.equal(db.prepare("SELECT track_id FROM library_media_files WHERE path = ? AND available = 1").pluck().get(worse), swapTrack);
  assert.equal(await exists(long), true);
  assert.equal(await exists(short), true);
});

test("removing duplicates finishes a removal a restart interrupted, and a failed name transfer keeps playlists on the better copy", async (t) => {
  const pair = async (artist) => {
    const tags = { artist, album: "Album", title: "Song", track: "1" };
    return {
      worse: await makeTrack(path.join(root, artist, "Album", "01 - Song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "96k"]),
      better: await makeTrack(path.join(root, artist, "Album", "song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "320k"]),
    };
  };
  const gone = await pair("Gone");
  const stuck = await pair("Stuck");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const goneTrack = mediaAt(gone.worse).track_id;
  const goneBytes = await readFile(gone.better);
  const goneJob = downloadTracker.addJob({ artistName: "Gone", trackName: "Song" }, "gone-mix");
  downloadTracker.setDone(goneJob, gone.worse, "Album");
  const stuckJob = downloadTracker.addJob({ artistName: "Stuck", trackName: "Song" }, "stuck-mix");
  downloadTracker.setDone(stuckJob, stuck.better, "Album");
  const refreshed = [];
  t.mock.method(playlistManager, "refreshPlaylist", async (playlistId) => { refreshed.push(playlistId); });

  const { id } = await cleanUp();
  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });
  await rm(gone.worse);
  const realLink = fsPromises.link;
  t.mock.method(fsPromises, "link", async (from, to) => {
    if (path.resolve(from) === stuck.better) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return realLink(from, to);
  });
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");

  assert.deepEqual(await readFile(gone.worse), goneBytes);
  assert.equal(await exists(gone.better), false);
  assert.equal(mediaAt(gone.worse).track_id, goneTrack);
  assert.equal(mediaAt(gone.better), undefined);
  assert.equal(downloadTracker.getJob(goneJob).finalPath, gone.worse);

  assert.equal(await exists(stuck.worse), false);
  assert.equal(await exists(stuck.better), true);
  assert.deepEqual(availablePaths("Song").filter((filePath) => filePath.includes("Stuck")), [stuck.better]);
  assert.equal(downloadTracker.getJob(stuckJob).finalPath, stuck.better);
  assert.ok(refreshed.includes("stuck-mix"));
});

test("a duplicate stays when a playlist still uses it or its name is behind a linked folder, and nothing deletes it later", async (t) => {
  const pair = async (artist) => {
    const tags = { artist, album: "Album", title: "Song", track: "1" };
    return {
      worse: await makeTrack(path.join(root, artist, "Album", "01 - Song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "96k"]),
      better: await makeTrack(path.join(root, artist, "Album", "song.mp3"), tags, ["-c:a", "libmp3lame", "-b:a", "320k"]),
    };
  };
  const listed = await pair("Listed");
  const linked = await pair("Linked");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const { id } = await cleanUp();
  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });

  const realFolder = path.join(root, "Linked", "Real");
  await rename(path.dirname(linked.worse), realFolder);
  await symlink(realFolder, path.dirname(linked.worse));
  let referenced = [listed.worse];
  t.mock.method(playlistManager.destinationRegistry, "run", async (operation) =>
    (operation === "getReferencedPaths" ? [{ destination: "test", ok: true, paths: referenced }] : []));
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");
  referenced = [];
  await retryPlaybackRetainedFiles();

  assert.equal(await exists(listed.worse), true);
  assert.equal(await exists(listed.better), true);
  assert.equal(await exists(path.join(realFolder, "01 - Song.mp3")), true);
  assert.equal(await exists(path.join(realFolder, "song.mp3")), true);
  assert.deepEqual(describe(id).sources, { removable: 0, removed: 0 });
});

test("Clean up keeps a file's track number from its tags when the Library's album has no number for it", async () => {
  const recordingId = "3f3f3f3f-0000-4000-8000-0000000000r2";
  const tags = { artist: "Interpol", album: "Our Love To Admire", title: "Pace Is The Trick", MUSICBRAINZ_TRACKID: recordingId };
  const download = await makeTrack(path.join(root, "Interpol", "Our Love To Admire", "Pace Is The Trick.flac"), tags);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const numbered = await makeTrack(path.join(root, "Interpol", "Our Love to Admire", "06 - Pace Is The Trick.flac"), { ...tags, track: "6" });
  await rm(download);
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const { items } = await cleanUp();

  const named = path.join(root, "Interpol", "Our Love To Admire", "06 - Pace Is The Trick.flac");
  assert.deepEqual(items.map((item) => [item.status, item.target]), [["done", path.relative(root, named)]]);
  assert.equal(await exists(named), true);
  assert.equal(await exists(numbered), false);
  assert.equal(await exists(download), false);
});

test("Clean up leaves Lidarr's files alone when Lidarr shares the Downloads Folder", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: { ...settings.integrations, lidarr: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key", rootFolderPath: root } },
  });
  const lidarrFile = await makeTrack(path.join(root, "Shared Artist", "Shared Album (2001)", "Shared Artist - 01 - Song.flac"), {
    artist: "Shared Artist", album: "Shared Album", title: "Song", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const bytes = await readFile(lidarrFile);

  const { items } = await cleanUp();

  assert.deepEqual(items, []);
  assert.deepEqual(await readFile(lidarrFile), bytes);
  assert.equal(await exists(path.join(root, "Shared Artist", "Shared Album")), false);
});

test("Clean up never files music into a folder the Library scan skips", async () => {
  await makeTrack(path.join(root, "loose", "track.flac"), {
    artist: ".38 Special", album: "...And Justice for All", title: "Song", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const { items } = await cleanUp();
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const newPath = path.join(root, "38 Special", "And Justice for All", "01 - Song.flac");
  assert.equal(items[0].status, "done");
  assert.equal(mediaAt(newPath)?.available, 1);
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
