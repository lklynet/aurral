import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

import {
  cleanupIsolatedState,
  createMockHttpServer,
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
  { getLibraryFileOperation, listLibraryFileOperationItems },
  { resolveDownloadRoot },
  { clearMetadataProviderCaches },
  { writeAudioTags },
] = await setupIsolatedBackend(
  "library-tag-fill",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryFiles/operations.js",
  "backend/services/libraryFiles/operationStore.js",
  "backend/services/downloadPaths.js",
  "backend/services/providers/brainzmashProvider.js",
  "backend/services/audioTags.js",
);

const root = resolveDownloadRoot();
const outside = path.join(isolatedState.baseDir, "outside");
const releaseGroup = "4f4f4f4f-0000-4000-8000-000000000001";
const release = "4f4f4f4f-0000-4000-8000-0000000000e1";
const artistMbid = "4f4f4f4f-0000-4000-8000-0000000000aa";
const reissue = "4f4f4f4f-0000-4000-8000-0000000000e2";
const deluxe = "4f4f4f4f-0000-4000-8000-0000000000e3";
const radioEdit = "4f4f4f4f-0000-4000-8000-0000000000e5";
const guestMbid = "4f4f4f4f-0000-4000-8000-0000000000bb";
const recording = (position) => `4f4f4f4f-0000-4000-8000-00000000000${position}`;
const edition = (id, titles, { lengths = {}, artists = {} } = {}) => ({
  id,
  status: "Official",
  tracks: titles.map((trackname, index) => ({
    id: `${id}-track-${index + 1}`,
    recordingid: recording({ "Song One": 1, "Song Two": 2, "Bonus Intro": 9 }[trackname]),
    trackname,
    artistid: artists[trackname] || artistMbid,
    durationms: lengths[trackname] || 200,
    trackposition: index + 1,
    mediumnumber: 1,
  })),
});
let tone = 400;
let sources = 0;

const album = {
  id: releaseGroup,
  title: "Fill Album",
  artistid: artistMbid,
  artists: [{ id: artistMbid, artistname: "Fill Artist" }],
  releasedate: "2011-05-20",
  genres: ["dream pop", "shoegaze"],
  releases: [
    edition(release, ["Song One", "Song Two"], { lengths: { "Song Two": 600000 } }),
    edition(reissue, ["Song One", "Song Two"], { lengths: { "Song Two": 600000 } }),
    edition(deluxe, ["Bonus Intro", "Song One", "Song Two"], { artists: { "Bonus Intro": guestMbid } }),
    edition(radioEdit, ["Song One", "Song Two"]),
  ],
};

const laterReleaseGroup = "4f4f4f4f-0000-4000-8000-000000000002";
const laterAlbum = {
  ...album,
  id: laterReleaseGroup,
  releasedate: "2020-01-10",
  genres: ["slowcore"],
  releases: [{
    id: "4f4f4f4f-0000-4000-8000-0000000000e4",
    status: "Official",
    tracks: [{
      id: "later-track-1",
      recordingid: recording(7),
      trackname: "Song Three",
      artistid: artistMbid,
      durationms: 200,
      trackposition: 1,
      mediumnumber: 1,
    }],
  }],
};

const metadataServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === `/album/${releaseGroup}`) return response.end(JSON.stringify(album));
  if (pathname === `/album/${laterReleaseGroup}`) return response.end(JSON.stringify(laterAlbum));
  if (pathname === "/search/album") {
    return response.end(JSON.stringify([album, laterAlbum].map((entry) => ({
      id: entry.id,
      title: entry.title,
      artistid: artistMbid,
      artists: entry.artists,
      releasedate: entry.releasedate,
      type: "Album",
    }))));
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not found" }));
});

async function makeTrack(filePath, tags = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", `sine=frequency=${tone += 13}:duration=0.2`];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  await execFileAsync("ffmpeg", [...args, filePath]);
  return filePath;
}

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

async function checkAndRun(operation) {
  const checked = await runUntilChecked(operation.id);
  const preview = operations.describeLibraryFileOperationItems(checked, {});
  const finished = await runUntilSettled(operation.id);
  assert.equal(finished.status, "complete");
  return { preview, items: operations.describeLibraryFileOperationItems(finished, {}) };
}

const originalSettings = dbOps.getSettings();

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  clearMetadataProviderCaches();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadataServer.url, enableNarrowFallbacks: false },
    },
  });
});

test.after(async () => {
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

test("ingest fills in only the tags a file is missing and keeps it with the album the Library has", async () => {
  await makeTrack(path.join(root, "Fill Artist", "Fill Album", "01 - Song One.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song One", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = path.join(isolatedState.baseDir, `source-${sources += 1}`);
  const sourceFile = await makeTrack(path.join(source, "old rip", "two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", track: "2", genre: "My Genre",
  });
  const sourceBytes = await readFile(sourceFile);

  const operation = await operations.startIngest({ sourcePath: source, mode: "copy", fillTags: true });
  const { preview, items } = await checkAndRun(operation);

  assert.deepEqual(preview[0].actions, ["file", "tags"]);
  assert.equal(preview[0].tagFields.includes("Genre"), false);
  assert.equal(items[0].status, "done");
  const target = path.join(root, "Fill Artist", "Fill Album", "02 - Song Two.flac");
  const { common } = await parseFile(target);
  assert.equal(common.musicbrainz_releasegroupid, releaseGroup);
  assert.equal(common.musicbrainz_recordingid, recording(2));
  assert.equal(common.year, 2011);
  assert.deepEqual(common.genre, ["My Genre"]);
  assert.equal(common.title, "Song Two");
  assert.deepEqual(await readFile(sourceFile), sourceBytes);

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const albums = db.prepare("SELECT * FROM library_albums WHERE title = 'Fill Album'").all();
  assert.equal(albums.length, 1);
  assert.equal(albums[0].identity_key, `release-group:${releaseGroup}`);
  assert.equal(db.prepare("SELECT COUNT(*) FROM library_album_tracks WHERE album_id = ?").pluck().get(albums[0].id), 2);
});

test("ingest tells apart albums that share a title by their year", async () => {
  const source = path.join(isolatedState.baseDir, `source-${sources += 1}`);
  await makeTrack(path.join(source, "2011", "two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", track: "2", date: "2011",
  });
  await makeTrack(path.join(source, "2020", "three.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Three", track: "1", date: "2020",
  });

  const operation = await operations.startIngest({ sourcePath: source, mode: "copy", fillTags: true });
  const { items } = await checkAndRun(operation);

  assert.deepEqual(items.map((item) => item.status), ["done", "done"]);
  const tagsOf = async (name) => (await parseFile(path.join(root, "Fill Artist", "Fill Album", name))).common;
  assert.equal((await tagsOf("02 - Song Two.flac")).musicbrainz_releasegroupid, releaseGroup);
  assert.equal((await tagsOf("01 - Song Three.flac")).musicbrainz_releasegroupid, laterReleaseGroup);
});

test("an ingest a restart stopped after filling in tags finishes on resume", async () => {
  await makeTrack(path.join(root, "Fill Artist", "Fill Album", "01 - Song One.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song One", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const source = path.join(isolatedState.baseDir, `source-${sources += 1}`);
  const sourceFile = await makeTrack(path.join(source, "two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", track: "2",
  });
  const sourceBytes = await readFile(sourceFile);
  const operation = await operations.startIngest({ sourcePath: source, mode: "copy", fillTags: true });
  await runUntilChecked(operation.id);
  const [planned] = listLibraryFileOperationItems(operation.id, { statuses: ["pending"] });
  await mkdir(path.dirname(planned.targetPath), { recursive: true });
  await copyFile(sourceFile, planned.targetPath);
  await writeAudioTags(planned.targetPath, planned.details.tags, { fillOnly: true });
  const filledBytes = await readFile(planned.targetPath);

  const { items } = await checkAndRun(operation);

  assert.equal(items[0].status, "done");
  assert.deepEqual(await readFile(planned.targetPath), filledBytes);
  assert.deepEqual(await readFile(sourceFile), sourceBytes);
});

test("clean up fills in missing tags, keeps favorites, and leaves unmatched files and other links alone", async () => {
  const seed = await makeTrack(path.join(outside, "seed.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song One", track: "1",
  });
  const matched = path.join(root, "Fill Artist", "Fill Album", "01 - Song One.flac");
  await mkdir(path.dirname(matched), { recursive: true });
  await link(seed, matched);
  const unmatched = await makeTrack(path.join(root, "Fill Artist", "Fill Album", "09 - Mystery.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Mystery", track: "9",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const track = db.prepare("SELECT * FROM library_tracks WHERE title = 'Song One'").get();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (9, 'fan', 'x')").run();
  db.prepare("INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (9, 'song', ?, 1)")
    .run(track.identity_key);
  const seedBytes = await readFile(seed);
  const unmatchedBytes = await readFile(unmatched);

  const operation = await operations.startCleanup();
  const { preview, items } = await checkAndRun(operation);

  const planned = preview.find((item) => item.source.endsWith("01 - Song One.flac"));
  assert.equal(planned.hardlinked, true);
  assert.deepEqual(items.map((item) => item.status).sort(), ["done", "skipped"]);
  const { common } = await parseFile(matched);
  assert.equal(common.musicbrainz_recordingid, recording(1));
  assert.deepEqual(common.genre, ["dream pop", "shoegaze"]);
  assert.deepEqual(await readFile(seed), seedBytes);
  assert.notEqual((await stat(seed)).ino, (await stat(matched)).ino);
  assert.deepEqual(await readFile(unmatched), unmatchedBytes);
  const starred = db.prepare("SELECT entity_key FROM subsonic_stars WHERE user_id = 9").pluck().get();
  assert.equal(starred, `recording:${recording(1)}`);
});

test("clean up fills in a file's tags and gives it Aurral's name in one pass, and the Library follows", async () => {
  const loose = await makeTrack(path.join(root, "loose", "track.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song One", track: "1",
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const { preview, items } = await checkAndRun(await operations.startCleanup());

  const named = path.join(root, "Fill Artist", "Fill Album", "01 - Song One.flac");
  assert.deepEqual(preview.map((item) => [item.actions, item.target]), [[["tags", "rename"], path.relative(root, named)]]);
  assert.equal(items[0].status, "done");
  assert.equal(await stat(loose).then(() => true, () => false), false);
  assert.equal((await parseFile(named)).common.musicbrainz_recordingid, recording(1));
  assert.deepEqual(
    db.prepare(
      `SELECT media.path, track.mbid FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id WHERE media.available = 1`,
    ).all().map((row) => [row.path, row.mbid]),
    [[named, recording(1)]],
  );
});

test("a file tagged with one edition gets that edition's track number", async () => {
  const filePath = await makeTrack(path.join(root, "Fill Artist", "Fill Album", "Song Two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", MUSICBRAINZ_ALBUMID: deluxe,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const operation = await operations.startCleanup();
  const { items } = await checkAndRun(operation);

  assert.equal(items[0].status, "done");
  const { common } = await parseFile(filePath);
  assert.equal(common.track.no, 3);
  assert.equal(common.musicbrainz_albumid, deluxe);
  assert.equal(common.musicbrainz_recordingid, recording(2));
});

test("a file's track number picks the edition that fills its tags, and a position no edition has gets none", async () => {
  const deluxeTrack = await makeTrack(path.join(root, "Fill Artist", "Fill Album", "03 - Song Two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", track: "3",
  });
  const misplaced = await makeTrack(path.join(root, "Fill Artist", "Fill Album", "05 - Song One.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song One", track: "5",
  });
  const otherEdition = await makeTrack(path.join(root, "Fill Artist", "Fill Album (Standard)", "03 - Song Two.flac"), {
    artist: "Fill Artist", album: "Fill Album (Standard)", title: "Song Two", track: "3", MUSICBRAINZ_ALBUMID: release,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const misplacedBytes = await readFile(misplaced);
  const otherEditionBytes = await readFile(otherEdition);

  const operation = await operations.startCleanup();
  const { items } = await checkAndRun(operation);

  const statusOf = (filePath) => items.find((item) => path.resolve(root, item.source) === filePath).status;
  assert.equal(statusOf(deluxeTrack), "done");
  const { common } = await parseFile(deluxeTrack);
  assert.equal(common.musicbrainz_albumid, deluxe);
  assert.equal(common.musicbrainz_recordingid, recording(2));
  assert.equal(statusOf(misplaced), "skipped");
  assert.deepEqual(await readFile(misplaced), misplacedBytes);
  assert.equal(statusOf(otherEdition), "skipped");
  assert.deepEqual(await readFile(otherEdition), otherEditionBytes);
});

test("a track that fits another edition's length takes that edition, and a guest keeps an unfilled artist name", async () => {
  const radioTrack = await makeTrack(path.join(root, "Fill Artist", "Fill Album", "02 - Song Two.flac"), {
    artist: "Fill Artist", album: "Fill Album", title: "Song Two", track: "2",
  });
  const guestTrack = await makeTrack(path.join(root, "Fill Artist", "Fill Album (Deluxe)", "01 - Bonus Intro.flac"), {
    album_artist: "Fill Artist", album: "Fill Album (Deluxe)", title: "Bonus Intro", track: "1", MUSICBRAINZ_ALBUMID: deluxe,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const operation = await operations.startCleanup();
  const { items } = await checkAndRun(operation);

  assert.deepEqual(items.map((item) => item.status), ["done", "done"]);
  assert.equal((await parseFile(radioTrack)).common.musicbrainz_albumid, radioEdit);
  const guest = (await parseFile(guestTrack)).common;
  assert.equal(guest.musicbrainz_artistid?.[0], guestMbid);
  assert.equal(guest.artist, undefined);
});
