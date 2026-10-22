import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const execFileAsync = promisify(execFile);

const [isolatedState, { db }, { scanMusicRoot }, { linkTrackFile }, { resolveDownloadRoot }] =
  await setupIsolatedBackend(
    "library-link-track-file",
    "backend/config/db-sqlite.js",
    "backend/services/libraryFileScanner.js",
    "backend/services/libraryFiles/linkTrackFile.js",
    "backend/services/downloadPaths.js",
  );

const root = resolveDownloadRoot();
const outside = path.join(isolatedState.baseDir, "elsewhere");
const track = {
  artistName: "Linked Artist",
  albumName: "Linked Album",
  trackName: "Right Title",
  artistMbid: "4a4a4a4a-0000-4000-8000-000000000001",
  albumMbid: "4a4a4a4a-0000-4000-8000-000000000002",
  trackMbid: "4a4a4a4a-0000-4000-8000-0000000000a1",
  trackNumber: 3,
  releaseYear: "2001",
};
const filed = path.join(root, "Linked Artist", "Linked Album", "03 - Right Title.flac");
const unmatched = { artist: "Someone", album: "Something", title: "wrong title" };

async function makeTrack(filePath, tags = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=0.2");
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  await execFileAsync("ffmpeg", [...args, filePath]);
  return filePath;
}

const exists = (filePath) =>
  stat(filePath).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a Library file moves to the track's name, gets its tags, and keeps its favorites", async () => {
  const oldPath = await makeTrack(path.join(root, "misc", "unknown.flac"), unmatched);
  await writeFile(path.join(root, "misc", "unknown.lrc"), "[00:00.00]la");
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const before = db.prepare("SELECT * FROM library_tracks").get();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (8, 'listener', 'x')").run();
  db.prepare(
    "INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (8, 'song', ?, 1)",
  ).run(before.identity_key);

  assert.deepEqual(await linkTrackFile({ sourcePath: oldPath, track }), {
    path: filed,
    moved: true,
  });

  assert.equal(await exists(path.join(root, "misc")), false);
  assert.equal(await exists(filed.replace(/\.flac$/, ".lrc")), true);
  const { common } = await parseFile(filed);
  assert.equal(common.title, "Right Title");
  assert.equal(common.album, "Linked Album");
  assert.equal(common.musicbrainz_recordingid, track.trackMbid);
  const tracks = db.prepare("SELECT * FROM library_tracks").all();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].identity_key, `recording:${track.trackMbid}`);
  assert.equal(
    db.prepare("SELECT entity_key FROM subsonic_stars WHERE user_id = 8").pluck().get(),
    tracks[0].identity_key,
  );
  assert.deepEqual(
    db.prepare("SELECT path FROM library_media_files WHERE track_id = ?").pluck().all(tracks[0].id),
    [filed],
  );
});

test("a file from outside the Downloads Folder is copied in, and the source keeps its tags", async () => {
  const source = await makeTrack(path.join(outside, "rip.flac"), unmatched);

  assert.deepEqual(await linkTrackFile({ sourcePath: source, track }), {
    path: filed,
    moved: false,
  });

  assert.equal((await parseFile(source)).common.title, "wrong title");
  assert.equal((await parseFile(filed)).common.musicbrainz_recordingid, track.trackMbid);
  assert.equal(
    db.prepare("SELECT identity_key FROM library_tracks").pluck().get(),
    `recording:${track.trackMbid}`,
  );
});

const albumOf = (filePath) =>
  db
    .prepare(
      `SELECT album.* FROM library_media_files AS media
     JOIN library_albums AS album ON album.id = media.album_id WHERE media.path = ?`,
    )
    .get(filePath);

test("an untagged copy of the album becomes the album, so its other tracks stay with it", async () => {
  const folder = path.join(root, "Linked Artist", "Linked Album");
  const tags = { artist: "Linked Artist", album: "Linked Album" };
  const source = await makeTrack(path.join(folder, "a.flac"), { ...tags, title: "a" });
  const other = await makeTrack(path.join(folder, "b.flac"), { ...tags, title: "b" });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  await linkTrackFile({ sourcePath: source, track });

  assert.equal(albumOf(filed).identity_key, `release-group:${track.albumMbid}`);
  assert.equal(albumOf(other).id, albumOf(filed).id);
});

test("a file from another album leaves that album as it was", async () => {
  const source = await makeTrack(path.join(root, "misc", "a.flac"), unmatched);
  const other = await makeTrack(path.join(root, "misc", "b.flac"), { ...unmatched, title: "b" });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const before = albumOf(other);

  await linkTrackFile({ sourcePath: source, track });

  assert.equal(albumOf(other).identity_key, before.identity_key);
  assert.equal(albumOf(filed).identity_key, `release-group:${track.albumMbid}`);
});

test("a name another file has stops the link and leaves both files alone", async () => {
  await makeTrack(filed, { title: "Other" });
  const source = await makeTrack(path.join(root, "misc", "unknown.flac"), unmatched);

  await assert.rejects(
    linkTrackFile({ sourcePath: source, track }),
    /already has this track's name/,
  );

  assert.equal(await exists(source), true);
  assert.equal((await parseFile(filed)).common.title, "Other");
});
