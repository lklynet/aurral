import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, link, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  { settleIngestedMusic, checkIngestSource },
  { resolveDownloadRoot },
  { clearScheduledLibraryScan },
] = await setupIsolatedBackend(
  "library-ingest",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryFiles/operations.js",
  "backend/services/libraryFiles/operationStore.js",
  "backend/services/libraryFiles/ingest.js",
  "backend/services/downloadPaths.js",
  "backend/services/libraryScanWorker.js",
);

const root = resolveDownloadRoot();
let sourceCount = 0;
let tone = 200;

async function makeTrack(filePath, tags = {}, { seconds = 0.2 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", `sine=frequency=${tone += 7}:duration=${seconds}`];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  await execFileAsync("ffmpeg", [...args, filePath]);
  return filePath;
}

const newSource = () => path.join(isolatedState.baseDir, `source-${sourceCount += 1}`);

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

async function ingest(sourcePath, mode, monitor) {
  const operation = await operations.startIngest({ sourcePath, mode, monitor });
  assert.match((await runUntilChecked(operation.id)).status, /^(running|complete)$/);
  return operation.id;
}

async function apply(id) {
  const finished = await runUntilSettled(id);
  assert.equal(finished.status, "complete");
  return operations.describeLibraryFileOperationItems(finished, {});
}

const exists = (filePath) => stat(filePath).then(() => true, () => false);
const libraryAlbums = () => db.prepare("SELECT * FROM library_albums ORDER BY id").all();

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("copy files music under Aurral's names, keeps the source, and starts unmonitored", async () => {
  const source = newSource();
  const first = await makeTrack(path.join(source, "rips", "a.flac"), {
    artist: "Copy Artist", album: "Copy Album", title: "First: Song", track: "1",
  });
  await makeTrack(path.join(source, "rips", "b.flac"), {
    artist: "Copy Artist", album: "Copy Album", title: "Second", track: "2",
  });
  await writeFile(path.join(source, "rips", "a.lrc"), "[00:00.00]Hello");
  await writeFile(path.join(source, "rips", "cover.jpg"), "cover");

  const items = await apply(await ingest(source, "copy"));

  const albumDir = path.join(root, "Copy Artist", "Copy Album");
  assert.deepEqual(items.map((item) => [item.status, item.target]), [
    ["done", path.join("Copy Artist", "Copy Album", "01 - First_ Song.flac")],
    ["done", path.join("Copy Artist", "Copy Album", "02 - Second.flac")],
  ]);
  assert.equal(await exists(first), true);
  assert.equal(await readFile(path.join(albumDir, "01 - First_ Song.lrc"), "utf8"), "[00:00.00]Hello");
  assert.equal(await readFile(path.join(albumDir, "cover.jpg"), "utf8"), "cover");
  assert.notEqual((await stat(first)).ino, (await stat(path.join(albumDir, "01 - First_ Song.flac"))).ino);

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  await settleIngestedMusic();
  const [album] = libraryAlbums();
  assert.equal(album.title, "Copy Album");
  assert.equal(JSON.parse(album.metadata_json).monitored, false);
  assert.deepEqual(db.prepare("SELECT monitored FROM library_tracks").pluck().all(), [0, 0]);
  assert.equal(db.prepare("SELECT monitor_mode FROM library_management WHERE entity_kind = 'artist'").get(), undefined);
});

test("a title on both discs of an album files twice, with the second disc in its name", async () => {
  const source = newSource();
  for (const [disc, folder] of [[1, "CD 01"], [2, "CD 02"]]) {
    await makeTrack(path.join(source, folder, "03 Bomb.flac"), {
      artist: "Bush", album: "Sixteen Stone", title: "Bomb", track: "3", disc: String(disc),
    });
  }

  const items = await apply(await ingest(source, "copy"));

  assert.deepEqual(items.map((item) => [item.status, item.target]), [
    ["done", path.join("Bush", "Sixteen Stone", "03 - Bomb.flac")],
    ["done", path.join("Bush", "Sixteen Stone", "2-03 - Bomb.flac")],
  ]);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.deepEqual(db.prepare(
    `SELECT link.disc_number, link.track_number, media.path FROM library_album_tracks AS link
     JOIN library_media_files AS media ON media.track_id = link.track_id ORDER BY link.disc_number`,
  ).all().map((row) => [row.disc_number, row.track_number, path.basename(row.path)]), [
    [1, 3, "03 - Bomb.flac"],
    [2, 3, "2-03 - Bomb.flac"],
  ]);
});

async function ingestBesideExistingTrack(monitor) {
  await makeTrack(path.join(root, "Watch", "Album", "01 - Kept.flac"), {
    artist: "Watch", album: "Album", title: "Kept", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  await makeTrack(path.join(source, "b.flac"), { artist: "Watch", album: "Album", title: "Added", track: "2" });
  await apply(await ingest(source, "copy", monitor));
  await settleIngestedMusic();
  const monitored = () => Object.fromEntries(
    db.prepare("SELECT title, monitored FROM library_tracks ORDER BY title").all().map((row) => [row.title, row.monitored]),
  );
  assert.deepEqual(monitored(), { Kept: 0 });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  await settleIngestedMusic();
  return {
    tracks: monitored(),
    album: db.prepare("SELECT monitor_mode FROM library_management WHERE entity_kind = 'album'").pluck().get(),
  };
}

test("ingesting as Tracks monitors the ingested tracks once the scan finds them, and nothing else", async () => {
  assert.deepEqual(await ingestBesideExistingTrack("tracks"), { tracks: { Added: 1, Kept: 0 }, album: null });
});

test("ingesting as Albums also monitors each ingested track's album", async () => {
  assert.deepEqual(await ingestBesideExistingTrack("albums"), { tracks: { Added: 1, Kept: 1 }, album: "monitored" });
});

test("an ingest that files nothing has nothing to monitor", async () => {
  const source = newSource();
  const gone = await makeTrack(path.join(source, "a.flac"), { artist: "Gone", album: "Album", title: "Gone", track: "1" });
  const id = await ingest(source, "copy", "tracks");
  await rm(gone);
  const finished = operations.describeLibraryFileOperation(await runUntilSettled(id));
  assert.deepEqual([finished.status, finished.counts.failed], ["complete", 1]);
  assert.equal(finished.summary.monitor, undefined);
});

test("an ingest refuses a Monitor choice it does not know", async () => {
  await assert.rejects(operations.startIngest({ sourcePath: newSource(), mode: "copy", monitor: "artists" }), /Choose None/);
});

test("never overwrites: a different file in the way stays, and the source is skipped", async () => {
  const source = newSource();
  const incoming = await makeTrack(path.join(source, "Busy", "Album", "01.flac"), {
    artist: "Busy", album: "Album", title: "Taken", track: "1",
  });
  const occupant = await makeTrack(path.join(root, "Busy", "Album", "01 - Taken.flac"), {
    artist: "Someone Else", album: "Other", title: "Taken",
  });
  const before = await readFile(occupant);

  const id = await ingest(source, "move");
  const [planned] = operations.describeLibraryFileOperationItems(getLibraryFileOperation(id), {});
  assert.equal(planned.status, "skipped");
  const items = await apply(id);

  assert.equal(items[0].status, "skipped");
  assert.deepEqual(await readFile(occupant), before);
  assert.equal(await exists(incoming), true);
});

test("an identical file already in the Library is kept once", async () => {
  const library = await makeTrack(path.join(root, "Twin", "Album", "01 - Same.flac"), {
    artist: "Twin", album: "Album", title: "Same", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const copySource = newSource();
  const copied = path.join(copySource, "Twin", "Album", "same.flac");
  await mkdir(path.dirname(copied), { recursive: true });
  await copyFile(library, copied);
  const moveSource = newSource();
  const moved = path.join(moveSource, "Twin", "Album", "same.flac");
  await mkdir(path.dirname(moved), { recursive: true });
  await copyFile(library, moved);

  assert.equal((await apply(await ingest(copySource, "copy")))[0].status, "duplicate");
  assert.equal(await exists(copied), true);

  assert.equal((await apply(await ingest(moveSource, "move")))[0].status, "duplicate");
  assert.equal(await exists(moved), false);
  assert.equal(await exists(library), true);
  assert.equal(await exists(path.join(moveSource, "Twin")), false);
});

const describe = (id) => operations.describeLibraryFileOperation(getLibraryFileOperation(id));

async function libraryTrack(relativePath, tags, options) {
  const filePath = await makeTrack(path.join(root, relativePath), tags, options);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  return filePath;
}

test("a track the Library has in a different file is skipped as already in the Library, and only Move offers to remove it", async () => {
  const library = await libraryTrack(path.join("Held", "Album", "01 - Song.flac"), {
    artist: "Held", album: "Album", title: "Song", track: "1",
  });
  const libraryBytes = await readFile(library);
  const tags = { artist: "Held", album: "Album", title: "Song", track: "1" };
  const copySource = newSource();
  const copied = await makeTrack(path.join(copySource, "Held", "Album", "song.mp3"), tags);
  const moveSource = newSource();
  const kept = await makeTrack(path.join(moveSource, "Held", "Album", "song.mp3"), tags);
  await makeTrack(path.join(moveSource, "Held", "Album", "other.mp3"), { ...tags, title: "Other", track: "2" });
  await writeFile(path.join(moveSource, "Held", "Album", "cover.jpg"), "art");

  const copyId = await ingest(copySource, "copy");
  const [copiedItem] = await apply(copyId);
  const moveId = await ingest(moveSource, "move");
  const keptItem = (await apply(moveId)).find((item) => item.source.endsWith("song.mp3"));

  assert.deepEqual([copiedItem.status, keptItem.status], ["duplicate", "duplicate"]);
  assert.equal(keptItem.target, path.relative(root, library));
  assert.equal(describe(copyId).sources, null);
  await assert.rejects(operations.removeDuplicateFiles(copyId), /Only a Move ingest/);
  assert.deepEqual(describe(moveId).sources, { removable: 1, removed: 0 });
  assert.equal(await exists(copied), true);
  assert.equal(await exists(kept), true);
  assert.equal(await exists(path.join(moveSource, "Held", "Album", "cover.jpg")), true);
  assert.deepEqual(await readFile(library), libraryBytes);
  assert.equal(await exists(path.join(root, "Held", "Album", "01 - Song.mp3")), false);
});

test("music joins the folders and names already on disk when the Library writes them in a different case", async () => {
  await libraryTrack(path.join("Cloud Nothings", "Turning On", "01 - Intro.flac"), {
    artist: "CLOUD NOTHINGS", album: "TURNING ON", title: "Intro", track: "1",
  });
  const unindexed = await makeTrack(path.join(root, "Cloud Nothings", "Turning On", "03 - closer.flac"), {
    title: "Something Else",
  });
  const before = await readFile(unindexed);
  const source = newSource();
  await makeTrack(path.join(source, "b.flac"), { artist: "Cloud Nothings", album: "Turning On", title: "Opening", track: "2" });
  const closer = await makeTrack(path.join(source, "c.flac"), {
    artist: "Cloud Nothings", album: "Turning On", title: "Closer", track: "3",
  });

  const items = await apply(await ingest(source, "copy"));

  assert.deepEqual(items.map((item) => [item.status, item.target]), [
    ["done", path.join("Cloud Nothings", "Turning On", "02 - Opening.flac")],
    ["skipped", path.join("Cloud Nothings", "Turning On", "03 - closer.flac")],
  ]);
  assert.deepEqual(await readdir(root), ["Cloud Nothings"]);
  assert.deepEqual(await readdir(path.join(root, "Cloud Nothings")), ["Turning On"]);
  assert.deepEqual(await readFile(unindexed), before);
  assert.equal(await exists(closer), true);
});

// Two albums with one title leave an untagged source without an album to
// match, but the scan still files its copy with the Library's track.
async function sourceTheScanJoinsToALibraryTrack({ keptFolder = "Album" } = {}) {
  const kept = await libraryTrack(path.join("Twice", keptFolder, "01 - Song.flac"), {
    artist: "Twice", album: "Album", title: "Song", track: "1",
  });
  await libraryTrack(path.join("Twice", "Album (Tagged)", "01 - Other.flac"), {
    artist: "Twice", album: "Album", title: "Other", track: "1",
    MUSICBRAINZ_RELEASEGROUPID: "99999999-9999-4999-8999-999999999999",
  });
  const source = newSource();
  const file = await makeTrack(path.join(source, "Twice", "Album", "song.mp3"), {
    artist: "Twice", album: "Album", title: "Song", track: "1",
  });
  return { kept, source, file, filed: path.join(root, "Twice", "Album", "01 - Song.mp3") };
}

const filesOfTrack = (title) => db.prepare(
  `SELECT media.path FROM library_media_files AS media JOIN library_tracks AS track ON track.id = media.track_id
   WHERE track.title = ? AND media.available = 1 ORDER BY media.path`,
).pluck().all(title);

test("a copy the Library scan files with a track the Library already had is taken back out, and the source stays", async () => {
  const { kept, source, file, filed } = await sourceTheScanJoinsToALibraryTrack();
  const keptLyrics = kept.replace(/\.flac$/, ".lrc");
  await writeFile(keptLyrics, "[00:00.00]kept");
  const id = await ingest(source, "copy", "tracks");
  const [placed] = await apply(id);
  assert.equal(placed.status, "done");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.deepEqual(filesOfTrack("Song"), [kept, filed]);

  await settleIngestedMusic();

  const [item] = operations.describeLibraryFileOperationItems(getLibraryFileOperation(id), {});
  assert.deepEqual([item.status, item.target], ["duplicate", path.relative(root, kept)]);
  assert.equal(await exists(filed), false);
  assert.equal(await exists(file), true);
  assert.equal(await exists(kept), true);
  assert.equal(await readFile(keptLyrics, "utf8"), "[00:00.00]kept");
  assert.deepEqual(describe(id).counts, { duplicate: 1 });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.deepEqual(filesOfTrack("Song"), [kept]);
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE title = 'Song'").pluck().get(), 0);
});

test("a filed track that shares its recording with another track of the album stays after the Library scan", async () => {
  const silence = { artist: "Silent", album: "Album", title: "[silence]", MUSICBRAINZ_TRACKID: "aaaaaaaa-0000-4000-8000-0000000000a1" };
  const first = await libraryTrack(path.join("Silent", "Album", "01 - [silence].flac"), { ...silence, track: "1" });
  const source = newSource();
  await makeTrack(path.join(source, "Silent", "Album", "silence.flac"), { ...silence, track: "2" });
  const id = await ingest(source, "copy", "tracks");
  const [placed] = await apply(id);
  assert.equal(placed.status, "done");
  const filed = path.resolve(root, placed.target);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.deepEqual(filesOfTrack("[silence]"), [first, filed]);

  await settleIngestedMusic();

  assert.equal(await exists(filed), true);
  assert.deepEqual(describe(id).counts, { done: 1 });
});

test("a copy taken back out is recorded and rescanned even when its lyrics cannot be removed", async () => {
  const { source, file, filed } = await sourceTheScanJoinsToALibraryTrack();
  await writeFile(file.replace(/\.mp3$/, ".lrc"), "[00:00.00]la");
  const id = await ingest(source, "copy", "tracks");
  await apply(id);
  const filedLyrics = filed.replace(/\.mp3$/, ".lrc");
  await rm(filedLyrics);
  await mkdir(filedLyrics);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  clearScheduledLibraryScan();

  await settleIngestedMusic();

  assert.equal(await exists(filed), false);
  assert.deepEqual(describe(id).counts, { duplicate: 1 });
  assert.equal(dbOps.getJSONSetting("pendingLibraryScanJob").changedPaths.includes(filed), true);
});

test("a moved file the Library scan files with a track the Library already had goes back to its source with its art and lyrics, offered for removal, and the Library keeps its own, even when two source folders filed into one album", async () => {
  const { kept, source, file, filed } = await sourceTheScanJoinsToALibraryTrack({ keptFolder: "Earlier Rip" });
  const art = path.join(path.dirname(file), "cover.jpg");
  await writeFile(art, "art");
  const lyrics = file.replace(/\.mp3$/, ".lrc");
  await writeFile(lyrics, "[00:00.00]la");
  const libraryArt = path.join(path.dirname(filed), "folder.jpg");
  await mkdir(path.dirname(libraryArt), { recursive: true });
  await writeFile(libraryArt, "library art");
  const otherTags = { artist: "Twice", album: "Album", title: "Tune", track: "2" };
  await libraryTrack(path.join("Twice", "Earlier Rip", "02 - Tune.flac"), otherTags);
  const otherFile = await makeTrack(path.join(source, "Twice", "Album CD2", "tune.mp3"), otherTags);
  const otherArt = path.join(path.dirname(otherFile), "back.jpg");
  await writeFile(otherArt, "back");
  const id = await ingest(source, "move");
  await apply(id);
  assert.equal(await exists(file), false);
  assert.equal(await readFile(path.join(path.dirname(filed), "cover.jpg"), "utf8"), "art");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  clearScheduledLibraryScan();

  await settleIngestedMusic();

  assert.equal(await exists(file), true);
  assert.equal(await readFile(art, "utf8"), "art");
  assert.equal(await readFile(lyrics, "utf8"), "[00:00.00]la");
  assert.equal(await exists(otherFile), true);
  assert.equal(await readFile(otherArt, "utf8"), "back");
  assert.deepEqual(await readdir(path.dirname(filed)), ["folder.jpg"]);
  const queued = dbOps.getJSONSetting("pendingLibraryScanJob");
  assert.equal(queued.includeLidarr, true);
  assert.equal(queued.changedPaths.includes(file), true);
  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");
  assert.equal(await exists(file), false);
  assert.equal(await exists(otherFile), false);
  assert.equal(await exists(kept), true);
});

test("a source whose MusicBrainz tags miss the Library's album is still the track at its Library name", async () => {
  const library = await libraryTrack(path.join("Quad", "Album", "01 - Song.flac"), {
    artist: "Quad", album: "Album", title: "Song", track: "1",
  });
  const source = newSource();
  await makeTrack(path.join(source, "song.flac"), {
    artist: "Quad",
    album: "Album",
    title: "Song",
    track: "1",
    MUSICBRAINZ_RELEASEGROUPID: "44444444-4444-4444-8444-444444444444",
  });

  const [item] = await apply(await ingest(source, "copy"));

  assert.equal(item.status, "duplicate");
  assert.equal(item.target, path.relative(root, library));
});

test("a Library file at the track's name is not the same track when its artist, album, or recording differs", async () => {
  const song = { title: "Song", track: "1" };
  await makeTrack(path.join(root, "Busy", "Album", "01 - Song.flac"), { ...song, artist: "Someone Else", album: "Album" });
  await makeTrack(path.join(root, "Shared", "Album", "01 - Song.flac"), { ...song, artist: "Shared", album: "Other" });
  await makeTrack(path.join(root, "Recorded", "Album", "01 - Song.flac"), {
    ...song, artist: "Recorded", album: "Album", MUSICBRAINZ_TRACKID: "66666666-6666-4666-8666-666666666666",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  await makeTrack(path.join(source, "busy.flac"), { ...song, artist: "Busy", album: "Album" });
  await makeTrack(path.join(source, "shared.flac"), { ...song, artist: "Shared", album: "Album" });
  await makeTrack(path.join(source, "recorded.flac"), {
    ...song,
    artist: "Recorded",
    album: "Album",
    MUSICBRAINZ_RELEASEGROUPID: "77777777-7777-4777-8777-777777777777",
    MUSICBRAINZ_TRACKID: "88888888-8888-4888-8888-888888888888",
  });

  const id = await ingest(source, "move");
  const items = await apply(id);

  assert.deepEqual(items.map((item) => [item.source, item.status]), [
    ["busy.flac", "skipped"],
    ["recorded.flac", "skipped"],
    ["shared.flac", "skipped"],
  ]);
  for (const item of items) assert.match(item.reason, /different file already has this name/);
  assert.deepEqual(describe(id).sources, { removable: 0, removed: 0 });
});

test("removing sources after a stopped Move ingest never files the music it stopped before", async () => {
  await libraryTrack(path.join("Halt", "Album", "01 - Kept.flac"), { artist: "Halt", album: "Album", title: "Kept", track: "1" });
  const source = newSource();
  const kept = await makeTrack(path.join(source, "kept", "kept.mp3"), { artist: "Halt", album: "Album", title: "Kept", track: "1" });
  const waiting = await makeTrack(path.join(source, "waiting", "waiting.flac"), {
    artist: "Halt", album: "Album", title: "Waiting", track: "2",
  });
  const id = await ingest(source, "move");
  assert.equal(operations.cancelLibraryFileOperation(id), true);
  await assert.rejects(operations.removeDuplicateFiles(id), /still stopping/);
  assert.equal((await runUntilSettled(id)).status, "cancelled");

  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");

  assert.equal(await exists(kept), false);
  assert.equal(await exists(waiting), true);
  assert.equal(await exists(path.join(root, "Halt", "Album", "02 - Waiting.flac")), false);
  const items = operations.describeLibraryFileOperationItems(getLibraryFileOperation(id), {});
  assert.equal(items.find((item) => item.source.endsWith("waiting.flac")).status, "skipped");
  assert.deepEqual(describe(id).counts, { duplicate: 1, skipped: 1 });
});

test("a source much longer or shorter than the Library's track is a different recording, held back and never offered for removal", async () => {
  await libraryTrack(path.join("Kweller", "Sha Sha", "03 - Wasted & Ready.flac"), {
    artist: "Kweller", album: "Sha Sha", title: "Wasted & Ready", track: "3",
  }, { seconds: 0.5 });
  const source = newSource();
  const demo = await makeTrack(path.join(source, "Kweller", "Sha Sha", "demo.flac"), {
    artist: "Kweller", album: "Sha Sha", title: "Wasted & Ready", track: "3",
  }, { seconds: 5 });

  const id = await ingest(source, "move");
  const [item] = await apply(id);

  assert.equal(item.status, "skipped");
  assert.match(item.reason, /Wasted & Ready.*0:0[45] longer/);
  assert.equal(describe(id).counts.duplicate, undefined);
  assert.deepEqual(describe(id).sources, { removable: 0, removed: 0 });
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");
  assert.equal(await exists(demo), true);
});

test("a lossless source of a track the Library has only in a lossy format is listed, not skipped as already in the Library", async () => {
  await libraryTrack(path.join("Lossy", "Album", "01 - Song.mp3"), {
    artist: "Lossy", album: "Album", title: "Song", track: "1",
  });
  const source = newSource();
  const flac = await makeTrack(path.join(source, "song.flac"), {
    artist: "Lossy", album: "Album", title: "Song", track: "1",
  });

  const id = await ingest(source, "move");
  const [item] = await apply(id);

  assert.equal(item.status, "skipped");
  assert.match(item.reason, /lossless/);
  assert.deepEqual(describe(id).sources, { removable: 0, removed: 0 });
  assert.equal(await exists(flac), true);
});

test("removing kept sources checks each against the Library again, removes emptied folders, and is safe to repeat", async () => {
  const tags = (title, track) => ({ artist: "Tidy", album: "Album", title, track: String(track) });
  await libraryTrack(path.join("Tidy", "Album", "01 - One.flac"), tags("One", 1));
  const second = await libraryTrack(path.join("Tidy", "Album", "02 - Two.flac"), tags("Two", 2));
  await libraryTrack(path.join("Tidy", "Album", "03 - Three.flac"), tags("Three", 3), { seconds: 0.5 });
  const source = newSource();
  const one = await makeTrack(path.join(source, "first", "one.mp3"), tags("One", 1));
  await writeFile(path.join(source, "first", "one.lrc"), "[00:00.00]One");
  await writeFile(path.join(source, "first", "cover.jpg"), "art");
  await writeFile(path.join(root, "Tidy", "Album", "cover.jpg"), "art");
  const two = await makeTrack(path.join(source, "second", "two.mp3"), tags("Two", 2));
  const three = await makeTrack(path.join(source, "second", "three.flac"), tags("Three", 3), { seconds: 5 });
  await makeTrack(path.join(source, "third", "four.flac"), tags("Four", 4));
  const id = await ingest(source, "move", "tracks");
  await apply(id);
  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  await settleIngestedMusic();
  const unmonitorFour = db.prepare("UPDATE library_tracks SET monitored = 0 WHERE title = 'Four'");
  assert.equal(unmonitorFour.run().changes, 1);

  await operations.removeDuplicateFiles(id);
  assert.equal(operations.cancelLibraryFileOperation(id), true);
  assert.equal((await runUntilSettled(id)).status, "cancelled");
  assert.deepEqual(describe(id).sources, { removable: 2, removed: 0 });
  assert.equal(await exists(one), true);

  await rm(second);
  await operations.removeDuplicateFiles(id);
  assert.equal((await runUntilSettled(id)).status, "complete");

  assert.equal(await exists(one), false);
  assert.equal(await exists(path.join(source, "first")), false);
  assert.equal(await readFile(path.join(root, "Tidy", "Album", "01 - One.lrc"), "utf8"), "[00:00.00]One");
  assert.equal(await exists(two), true);
  assert.equal(await exists(three), true);
  assert.equal(await exists(path.join(root, "Tidy", "Album", "01 - One.flac")), true);
  const after = describe(id);
  assert.deepEqual(after.sources, { removable: 0, removed: 1 });
  const items = operations.describeLibraryFileOperationItems(getLibraryFileOperation(id), {});
  const twoItem = items.find((item) => item.source.endsWith("two.mp3"));
  assert.equal(twoItem.status, "skipped");
  assert.match(twoItem.reason, /gone/);

  await operations.removeDuplicateFiles(id);
  assert.deepEqual(describe(id), after);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  await settleIngestedMusic();
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE title = 'Four'").pluck().get(), 0);
});

test("two files that claim the same track are not both filed, and the second says which track its tags claim", async () => {
  const source = newSource();
  await makeTrack(path.join(source, "a.flac"), { artist: "Demo", album: "Deluxe", title: "In Other Words", track: "5" });
  const demo = await makeTrack(path.join(source, "b.flac"), { artist: "Demo", album: "Deluxe", title: "In Other Words", track: "5" });

  const items = await apply(await ingest(source, "move"));

  assert.deepEqual(items.map((item) => item.status), ["done", "skipped"]);
  assert.match(items[1].reason, /track 5, In Other Words/);
  assert.equal(await exists(demo), true);
});

test("hardlink and move leave one file on disk under the Library name", async () => {
  const linkSource = newSource();
  const linked = await makeTrack(path.join(linkSource, "Linked", "Album", "x.flac"), {
    artist: "Linked", album: "Album", title: "Link", track: "3",
  });
  await apply(await ingest(linkSource, "hardlink"));
  const linkTarget = path.join(root, "Linked", "Album", "03 - Link.flac");
  assert.equal((await stat(linkTarget)).ino, (await stat(linked)).ino);

  const moveSource = newSource();
  const moved = await makeTrack(path.join(moveSource, "Moved", "Album", "x.flac"), {
    artist: "Moved", album: "Album", title: "Move", track: "4",
  });
  await writeFile(path.join(moveSource, "Moved", "Album", "folder.jpg"), "art");
  await apply(await ingest(moveSource, "move"));
  assert.equal(await exists(path.join(root, "Moved", "Album", "04 - Move.flac")), true);
  assert.equal(await readFile(path.join(root, "Moved", "Album", "folder.jpg"), "utf8"), "art");
  assert.equal(await exists(moved), false);
  assert.equal(await exists(path.join(moveSource, "Moved")), false);
  assert.equal(await exists(moveSource), true);
});

test("move never removes a source file that a link in the Downloads Folder leads back to", async () => {
  const source = newSource();
  const only = await makeTrack(path.join(source, "Alias", "Album", "01 - One.flac"), {
    artist: "Alias", album: "Album", title: "One", track: "1",
  });
  const bytes = await readFile(only);
  await mkdir(root, { recursive: true });
  await symlink(path.join(source, "Alias"), path.join(root, "Alias"));

  const [item] = await apply(await ingest(source, "move"));

  assert.notEqual(item.status, "done");
  assert.deepEqual(await readFile(only), bytes);
});

test("never files music through a linked folder in the Downloads Folder, which the Library scan does not follow", async () => {
  const source = newSource();
  const only = await makeTrack(path.join(source, "a.flac"), {
    artist: "Linked", album: "Album", title: "One", track: "1",
  });
  const bytes = await readFile(only);
  const elsewhere = path.join(isolatedState.baseDir, `elsewhere-${sourceCount}`);
  await mkdir(elsewhere, { recursive: true });
  await mkdir(root, { recursive: true });
  await symlink(elsewhere, path.join(root, "Linked"));

  const [item] = await apply(await ingest(source, "move"));

  assert.equal(item.status, "skipped");
  assert.deepEqual(await readFile(only), bytes);
  assert.equal(await exists(path.join(elsewhere, "Album")), false);
});

test("an artist named in another script is filed under its own name, not a different artist's", async () => {
  await makeTrack(path.join(root, "宇多田ヒカル", "First Love", "01 - Automatic.flac"), {
    artist: "宇多田ヒカル", album: "First Love", title: "Automatic", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  await makeTrack(path.join(source, "a.flac"), {
    artist: "椎名林檎", album: "無罪モラトリアム", title: "正しい街", track: "1",
  });

  const [item] = await apply(await ingest(source, "copy"));

  assert.equal(item.target, path.join("椎名林檎", "無罪モラトリアム", "01 - 正しい街.flac"));
});

test("a run interrupted after placing a file finishes it on resume", async () => {
  const source = newSource();
  const first = await makeTrack(path.join(source, "Resume", "Album", "a.flac"), {
    artist: "Resume", album: "Album", title: "One", track: "1",
  });
  const second = await makeTrack(path.join(source, "Resume", "Album", "b.flac"), {
    artist: "Resume", album: "Album", title: "Two", track: "2",
  });
  const id = await ingest(source, "move");
  const firstTarget = path.join(root, "Resume", "Album", "01 - One.flac");
  await mkdir(path.dirname(firstTarget), { recursive: true });
  await link(first, firstTarget);

  const items = await apply(id);

  assert.deepEqual(items.map((item) => item.status), ["done", "done"]);
  assert.equal(await exists(first), false);
  assert.equal(await exists(second), false);
  assert.equal(await exists(firstTarget), true);
  assert.equal(await exists(path.join(root, "Resume", "Album", "02 - Two.flac")), true);
});

test("untagged music joins the album and artist the Library already has, however its names are spelled, and no other album", async () => {
  await makeTrack(path.join(root, "Known Artist", "Known Æther Album", "01 - Tagged.flac"), {
    artist: "Known Artist",
    album_artist: "Known Artist",
    album: "Known Æther Album",
    title: "Tagged",
    track: "1",
    MUSICBRAINZ_ALBUMARTISTID: "11111111-1111-4111-8111-111111111111",
    MUSICBRAINZ_RELEASEGROUPID: "22222222-2222-4222-8222-222222222222",
  });
  await makeTrack(path.join(root, "Known Artist", "春 2024", "01 - Spring.flac"), {
    artist: "Known Artist",
    album: "春 2024",
    title: "Spring",
    track: "1",
    MUSICBRAINZ_ALBUMARTISTID: "11111111-1111-4111-8111-111111111111",
    MUSICBRAINZ_RELEASEGROUPID: "33333333-3333-4333-8333-333333333333",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  await makeTrack(path.join(source, "known artist", "KNOWN AETHER ALBUM", "02 untagged.flac"), {
    artist: "known artist", album: "known aether album", title: "Untagged", track: "2",
  });
  await makeTrack(path.join(source, "known artist", "冬 2024", "01 winter.flac"), {
    artist: "known artist", album: "冬 2024", title: "Winter", track: "1",
  });

  const items = await apply(await ingest(source, "copy"));
  assert.deepEqual(items.map((item) => item.target).sort(), [
    path.join("Known Artist", "Known Æther Album", "02 - Untagged.flac"),
    path.join("Known Artist", "冬 2024", "01 - Winter.flac"),
  ]);

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const albums = libraryAlbums();
  assert.deepEqual(albums.map((album) => album.title).sort(), ["Known Æther Album", "冬 2024", "春 2024"]);
  const trackCount = (title) => db.prepare(
    "SELECT COUNT(*) FROM library_album_tracks JOIN library_albums ON library_albums.id = album_id WHERE title = ?",
  ).pluck().get(title);
  assert.equal(trackCount("Known Æther Album"), 2);
  assert.equal(trackCount("春 2024"), 1);
});

test("files Aurral cannot place are skipped with a reason and left alone", async () => {
  const source = newSource();
  const loose = await makeTrack(path.join(source, "loose.flac"), { title: "No Album" });
  const operation = await operations.startIngest({ sourcePath: source, mode: "move" });
  const finished = await runUntilSettled(operation.id);
  assert.equal(finished.status, "complete");
  const [item] = operations.describeLibraryFileOperationItems(finished, {});
  assert.equal(item.status, "skipped");
  assert.match(item.reason, /artist and album/);
  assert.equal(await exists(loose), true);
});

test("the source check rejects the Downloads Folder and unreadable folders, and flags a Lidarr root folder", async () => {
  await mkdir(root, { recursive: true });
  await assert.rejects(checkIngestSource({ sourcePath: path.join(root) }), /already in the Downloads Folder/);
  await assert.rejects(checkIngestSource({ sourcePath: isolatedState.baseDir }), /Downloads Folder is inside/);
  if (process.getuid?.() !== 0) {
    const source = newSource();
    await makeTrack(path.join(source, "Readable", "Album", "01.flac"), { title: "x" });
    const locked = path.join(source, "Locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await assert.rejects(checkIngestSource({ sourcePath: source }), /cannot read .*Locked/);
    } finally {
      await chmod(locked, 0o755);
    }
  }

  const lidarrRoot = path.join(isolatedState.baseDir, "lidarr-music");
  const track = await makeTrack(path.join(lidarrRoot, "Artist", "Album", "01.flac"), { title: "x" });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: { ...settings.integrations, lidarr: { ...settings.integrations?.lidarr, rootFolderPath: lidarrRoot } },
  });
  try {
    const check = await checkIngestSource({ sourcePath: path.join(lidarrRoot, "Artist") });
    assert.equal(check.lidarrRoot, lidarrRoot);
    assert.equal(check.audioFiles, 1);
    assert.equal(check.hardlink.available, true);
    assert.equal(await exists(track), true);
  } finally {
    dbOps.updateSettings(settings);
  }
});

test("only one file operation runs at a time", async () => {
  const source = newSource();
  await makeTrack(path.join(source, "One", "Album", "a.flac"), { artist: "One", album: "Album", title: "A" });
  const first = await operations.startIngest({ sourcePath: source, mode: "copy" });
  await assert.rejects(operations.startIngest({ sourcePath: source, mode: "copy" }), /in progress/);
  assert.equal(operations.cancelLibraryFileOperation(first.id), true);
  assert.equal(getLibraryFileOperation(first.id).status, "cancelled");
});

test("a restart while listing files lists each file once", async () => {
  const source = newSource();
  const track = await makeTrack(path.join(source, "Listed", "Album", "a.flac"), {
    artist: "Listed", album: "Album", title: "Once", track: "1",
  });
  const operation = await operations.startIngest({ sourcePath: source, mode: "copy" });
  db.prepare(
    `INSERT INTO library_file_operation_items (operation_id, position, source_path, status, updated_at)
     VALUES (?, 0, ?, 'new', 1)`,
  ).run(operation.id, track);

  const checked = await runUntilChecked(operation.id);

  assert.deepEqual(
    operations.describeLibraryFileOperationItems(checked, {}).map((item) => item.status),
    ["pending"],
  );
});

test("album art stays with music that is skipped", async () => {
  const source = newSource();
  await makeTrack(path.join(source, "Split", "Album", "a.flac"), {
    artist: "Split", album: "Album", title: "Filed", track: "1",
  });
  await makeTrack(path.join(source, "Split", "Album", "b.flac"), {
    artist: "Split", album: "Album", title: "Blocked", track: "2",
  });
  await writeFile(path.join(source, "Split", "Album", "cover.jpg"), "art");
  await makeTrack(path.join(root, "Split", "Album", "02 - Blocked.flac"), { title: "Other" });

  const items = await apply(await ingest(source, "move"));

  assert.deepEqual(items.map((item) => item.status), ["done", "skipped"]);
  assert.equal(await readFile(path.join(source, "Split", "Album", "cover.jpg"), "utf8"), "art");
});

test("cancelling between slices still tidies what was already filed", async () => {
  const source = newSource();
  const filed = await makeTrack(path.join(source, "Stop", "First", "a.flac"), {
    artist: "Stop", album: "First", title: "Filed", track: "1",
  });
  await writeFile(path.join(source, "Stop", "First", "cover.jpg"), "art");
  const waiting = await makeTrack(path.join(source, "Stop", "Second", "b.flac"), {
    artist: "Stop", album: "Second", title: "Waiting", track: "1",
  });
  const id = await ingest(source, "move");
  const [first] = operations.describeLibraryFileOperationItems(getLibraryFileOperation(id), {});
  const target = path.join(root, first.target);
  await mkdir(path.dirname(target), { recursive: true });
  await link(filed, target);
  await rm(filed);
  db.prepare("UPDATE library_file_operation_items SET status = 'done' WHERE operation_id = ? AND position = ?")
    .run(id, first.position);
  assert.equal(operations.cancelLibraryFileOperation(id), true);

  assert.equal((await runUntilSettled(id)).status, "cancelled");

  assert.equal(await readFile(path.join(path.dirname(target), "cover.jpg"), "utf8"), "art");
  assert.equal(await exists(path.join(source, "Stop", "First")), false);
  assert.equal(await exists(waiting), true);
});
