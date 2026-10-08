import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  { checkIngestSource },
  { resolveDownloadRoot },
] = await setupIsolatedBackend(
  "library-ingest",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryFiles/operations.js",
  "backend/services/libraryFiles/operationStore.js",
  "backend/services/libraryFiles/ingest.js",
  "backend/services/downloadPaths.js",
);

const root = resolveDownloadRoot();
let sourceCount = 0;
let tone = 200;

async function makeTrack(filePath, tags = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", `sine=frequency=${tone += 7}:duration=0.2`];
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

async function ingest(sourcePath, mode) {
  const operation = await operations.startIngest({ sourcePath, mode });
  assert.match((await runUntilSettled(operation.id)).status, /^(ready|complete)$/);
  return operation.id;
}

async function apply(id) {
  if (getLibraryFileOperation(id).status === "ready") {
    assert.equal(await operations.confirmLibraryFileOperation(id), true);
  }
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
  const [album] = libraryAlbums();
  assert.equal(album.title, "Copy Album");
  assert.equal(JSON.parse(album.metadata_json).monitored, false);
  assert.deepEqual(db.prepare("SELECT monitored FROM library_tracks").pluck().all(), [0, 0]);
  assert.equal(db.prepare("SELECT monitor_mode FROM library_management WHERE entity_kind = 'artist'").get(), undefined);
});

test("never overwrites: a different file in the way stays, and the source is listed for review", async () => {
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
  assert.equal(planned.status, "conflict");
  const items = await apply(id);

  assert.equal(items[0].status, "conflict");
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

test("a track the Library has in a different file is listed for review, not replaced", async () => {
  const library = await makeTrack(path.join(root, "Held", "Album", "01 - Song.flac"), {
    artist: "Held", album: "Album", title: "Song", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  const incoming = await makeTrack(path.join(source, "Held", "Album", "song.mp3"), {
    artist: "Held", album: "Album", title: "Song", track: "1",
  });

  const [item] = await apply(await ingest(source, "move"));

  assert.equal(item.status, "conflict");
  assert.equal(item.target, path.relative(root, library));
  assert.equal(await exists(incoming), true);
  assert.equal(await exists(path.join(root, "Held", "Album", "01 - Song.mp3")), false);
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

test("untagged music joins the album and artist the Library already has", async () => {
  await makeTrack(path.join(root, "Known Artist", "Known Album", "01 - Tagged.flac"), {
    artist: "Known Artist",
    album_artist: "Known Artist",
    album: "Known Album",
    title: "Tagged",
    track: "1",
    MUSICBRAINZ_ALBUMARTISTID: "11111111-1111-4111-8111-111111111111",
    MUSICBRAINZ_RELEASEGROUPID: "22222222-2222-4222-8222-222222222222",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = newSource();
  await makeTrack(path.join(source, "known artist", "KNOWN ALBUM", "02 untagged.flac"), {
    artist: "known artist", album: "known album", title: "Untagged", track: "2",
  });

  const [item] = await apply(await ingest(source, "copy"));
  assert.equal(item.target, path.join("Known Artist", "Known Album", "02 - Untagged.flac"));

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const albums = libraryAlbums();
  assert.equal(albums.length, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM library_album_tracks WHERE album_id = ?").pluck().get(albums[0].id),
    2,
  );
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

test("the source check rejects the Downloads Folder and flags a Lidarr root folder", async () => {
  await mkdir(root, { recursive: true });
  await assert.rejects(checkIngestSource({ sourcePath: path.join(root) }), /already in the Downloads Folder/);
  await assert.rejects(checkIngestSource({ sourcePath: isolatedState.baseDir }), /Downloads Folder is inside/);

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

  const ready = await runUntilSettled(operation.id);

  assert.deepEqual(
    operations.describeLibraryFileOperationItems(ready, {}).map((item) => item.status),
    ["pending"],
  );
});

test("album art stays with music that is left for review", async () => {
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

  assert.deepEqual(items.map((item) => item.status), ["done", "conflict"]);
  assert.equal(await readFile(path.join(source, "Split", "Album", "cover.jpg"), "utf8"), "art");
});
