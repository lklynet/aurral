import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { scanMusicRoot },
  store,
  { setLibraryManagement },
  { getLibrary },
  subsonic,
] = await setupIsolatedBackend(
  "non-latin-library-keys",
  "backend/config/db-sqlite.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/libraryQueryService.js",
  "backend/services/subsonicLibraryService.js",
);

const root = path.join(isolatedState.baseDir, "music");

test.beforeEach(async () => {
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  await rm(root, { recursive: true, force: true });
});
test.after(() => cleanupIsolatedState(isolatedState));

async function writeLibrary(files) {
  const tagsByPath = new Map();
  for (const [relativePath, tags] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture");
    tagsByPath.set(filePath, tags);
  }
  const reads = [];
  const scan = ({ unreadable = [], ...options } = {}) => scanMusicRoot({
    rootPath: root,
    metadataReader: async (filePath) => {
      reads.push(filePath);
      if (unreadable.includes(filePath)) throw new Error("unreadable");
      return { common: tagsByPath.get(filePath), format: {} };
    },
    ...options,
  });
  return { scan, reads, paths: [...tagsByPath.keys()] };
}

const indexedFiles = () => db.prepare(
  `SELECT artist.name AS artist, album.title AS album, track.title AS track
   FROM library_media_files AS media
   JOIN library_tracks AS track ON track.id = media.track_id
   JOIN library_albums AS album ON album.id = media.album_id
   JOIN library_artists AS artist ON artist.id = album.artist_id
   ORDER BY media.path`,
).all().map((row) => ({ ...row }));

const rowCounts = () => ({
  artists: db.prepare("SELECT COUNT(*) FROM library_artists").pluck().get(),
  albums: db.prepare("SELECT COUNT(*) FROM library_albums").pluck().get(),
  tracks: db.prepare("SELECT COUNT(*) FROM library_tracks").pluck().get(),
});

test("untagged artists named in other scripts stay apart, each with their own albums", async () => {
  const { scan } = await writeLibrary({
    "宇多田ヒカル/初恋/01 初恋.flac": {
      artist: "宇多田ヒカル",
      album: "初恋",
      title: "初恋",
      track: { no: 1 },
      musicbrainz_artistid: "7f7f7f7f-0000-4000-8000-000000000001",
    },
    "宇多田ヒカル/ファントーム/01 道.flac": {
      artist: "宇多田ヒカル",
      album: "ファントーム",
      title: "道",
      track: { no: 1 },
      musicbrainz_artistid: "7f7f7f7f-0000-4000-8000-000000000001",
    },
    "椎名林檎/無罪モラトリアム/01 正しい街.flac": {
      artist: "椎名林檎",
      album: "無罪モラトリアム",
      title: "正しい街",
      track: { no: 1 },
    },
    "Кино/Группа крови/01 Группа крови.flac": {
      artist: "Кино",
      album: "Группа крови",
      title: "Группа крови",
      track: { no: 1 },
    },
  });

  await scan();

  assert.deepEqual(indexedFiles(), [
    { artist: "Кино", album: "Группа крови", track: "Группа крови" },
    { artist: "宇多田ヒカル", album: "ファントーム", track: "道" },
    { artist: "宇多田ヒカル", album: "初恋", track: "初恋" },
    { artist: "椎名林檎", album: "無罪モラトリアム", track: "正しい街" },
  ]);
  assert.deepEqual(rowCounts(), { artists: 3, albums: 4, tracks: 4 });
});

test("Latin names keep the keys earlier scans stored and are not read again", async () => {
  const { scan, reads } = await writeLibrary({
    "Beyoncé/Lemonade/01 Formation.flac": {
      artist: "Beyoncé",
      album: "Lemonade",
      title: "Formation",
      track: { no: 1 },
    },
    "Sigur Rós/Ágætis byrjun/01 Svefn-g-englar.flac": {
      artist: "Sigur Rós",
      album: "Ágætis byrjun",
      title: "Svefn-g-englar",
      track: { no: 1 },
    },
  });

  await scan();
  reads.length = 0;
  await scan();

  assert.deepEqual(
    db.prepare("SELECT identity_key FROM library_artists ORDER BY identity_key").pluck().all(),
    ["name:artist:beyonce", "name:artist:sigur ros"],
  );
  assert.deepEqual(
    db.prepare("SELECT identity_key FROM library_albums ORDER BY identity_key").pluck().all(),
    ["name:album:name artist beyonce:lemonade", "name:album:name artist sigur ros:ag tis byrjun"],
  );
  assert.deepEqual(
    db.prepare("SELECT identity_key FROM library_tracks ORDER BY identity_key").pluck().all(),
    [
      "name:track:name album name artist beyonce lemonade:1:1:formation",
      "name:track:name album name artist sigur ros ag tis byrjun:1:1:svefn g englar",
    ],
  );
  assert.deepEqual(reads, []);
});

const MERGED_FILES = {
  "宇多田ヒカル/初恋/01 初恋.flac": {
    artist: "宇多田ヒカル",
    album: "初恋",
    title: "初恋",
    track: { no: 1 },
  },
  "椎名林檎/無罪モラトリアム/01 正しい街.flac": {
    artist: "椎名林檎",
    album: "無罪モラトリアム",
    title: "正しい街",
    track: { no: 1 },
  },
};

// Earlier scans dropped every letter of these names from their keys, so both
// files share one artist, album, and track, named for the file read last.
async function seedMergedLibrary(paths, artistKey = "name:artist", artistMbid = null) {
  const artist = store.upsertLibraryArtist({
    identityKey: artistKey,
    mbid: artistMbid,
    name: "椎名林檎",
    syncSearch: false,
  });
  const album = store.upsertLibraryAlbum({
    identityKey: "name:album:name artist",
    artistId: artist.id,
    title: "無罪モラトリアム",
    albumArtist: "椎名林檎",
    metadata: { monitored: true },
    syncSearch: false,
  });
  const track = store.upsertLibraryTrack({
    identityKey: "name:track:name album name artist:1:1",
    title: "正しい街",
    artistName: "椎名林檎",
    syncSearch: false,
  });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1, syncSearch: false });
  setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const scanId = store.beginLibraryScan({ source: "aurral", rootPath: root });
  for (const filePath of paths) {
    const file = await stat(filePath);
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: filePath,
      format: "flac",
      size: file.size,
      mtimeMs: file.mtimeMs,
      scanId,
    });
  }
  store.finishLibraryScan(scanId);

  const user = db.prepare(
    "INSERT INTO users (username, password_hash) VALUES ('listener', 'hash') RETURNING id",
  ).get();
  assert.equal(subsonic.starMany(user, [
    subsonic.idFor("artist", artist.identity_key),
    subsonic.idFor("album", album.identity_key),
    subsonic.idFor("song", track.identity_key),
  ]), true);
  const addPlay = db.prepare(
    `INSERT INTO play_events (user_id, track_id, title, artist, album, album_key, played_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'subsonic', ?)`,
  );
  addPlay.run(user.id, "1", "初恋", "宇多田ヒカル", "初恋", album.identity_key, 1000, 1000);
  addPlay.run(user.id, "1", "初恋", "宇多田ヒカル", "初恋", album.identity_key, 2000, 2000);
  addPlay.run(user.id, "1", "正しい街", "椎名林檎", "無罪モラトリアム", album.identity_key, 3000, 3000);
  return { user, artist };
}

const playCounts = () => Object.fromEntries(db.prepare(
  `SELECT album.title, stats.play_count FROM play_album_stats AS stats
   JOIN library_albums AS album ON album.identity_key = stats.album_key`,
).all().map((row) => [row.title, row.play_count]));

test("a rescan splits an artist that earlier scans merged, with favorites, plays, and monitoring", async () => {
  const { scan, reads, paths } = await writeLibrary(MERGED_FILES);
  const { user } = await seedMergedLibrary(paths);

  await scan();

  assert.deepEqual(indexedFiles(), [
    { artist: "宇多田ヒカル", album: "初恋", track: "初恋" },
    { artist: "椎名林檎", album: "無罪モラトリアム", track: "正しい街" },
  ]);
  assert.deepEqual(rowCounts(), { artists: 2, albums: 2, tracks: 2 });
  const starred = subsonic.getStarred(user);
  assert.deepEqual(starred.artist.map((entry) => entry.name).sort(), ["宇多田ヒカル", "椎名林檎"]);
  assert.deepEqual(starred.album.map((entry) => entry.name).sort(), ["初恋", "無罪モラトリアム"]);
  assert.deepEqual(starred.song.map((entry) => entry.title).sort(), ["初恋", "正しい街"]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM subsonic_stars").pluck().get(), 6);
  assert.deepEqual(playCounts(), { 初恋: 2, 無罪モラトリアム: 1 });
  assert.deepEqual(
    getLibrary().albums.map((album) => [album.title, album.monitored]).sort(),
    [["初恋", true], ["無罪モラトリアム", true]],
  );

  reads.length = 0;
  await scan();
  assert.deepEqual(reads, []);
});

test("a rescan leaves no merged album behind when a track there has a recording ID", async () => {
  const recording = "7f7f7f7f-0000-4000-8000-000000000003";
  const files = structuredClone(MERGED_FILES);
  files["椎名林檎/無罪モラトリアム/01 正しい街.flac"].musicbrainz_recordingid = recording;
  const { scan, paths } = await writeLibrary(files);
  const artist = store.upsertLibraryArtist({ identityKey: "name:artist", name: "椎名林檎", syncSearch: false });
  const album = store.upsertLibraryAlbum({
    identityKey: "name:album:name artist",
    artistId: artist.id,
    title: "無罪モラトリアム",
    albumArtist: "椎名林檎",
    syncSearch: false,
  });
  const scanId = store.beginLibraryScan({ source: "aurral", rootPath: root });
  for (const [filePath, identityKey, title] of [
    [paths[0], "name:track:name album name artist:1:1", "初恋"],
    [paths[1], `recording:${recording}`, "正しい街"],
  ]) {
    const track = store.upsertLibraryTrack({ identityKey, title, syncSearch: false });
    store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1, syncSearch: false });
    const file = await stat(filePath);
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: filePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      scanId,
    });
  }
  store.finishLibraryScan(scanId);

  await scan();

  assert.deepEqual(indexedFiles(), [
    { artist: "宇多田ヒカル", album: "初恋", track: "初恋" },
    { artist: "椎名林檎", album: "無罪モラトリアム", track: "正しい街" },
  ]);
  assert.deepEqual(rowCounts(), { artists: 2, albums: 2, tracks: 2 });
});

test("a rescan keeps a merged artist that MusicBrainz matched for its own albums only", async () => {
  const mbid = "7f7f7f7f-0000-4000-8000-000000000002";
  const { scan, reads, paths } = await writeLibrary(MERGED_FILES);
  const { artist } = await seedMergedLibrary(paths, `mbid:${mbid}`, mbid);

  await scan();

  assert.deepEqual(indexedFiles(), [
    { artist: "宇多田ヒカル", album: "初恋", track: "初恋" },
    { artist: "椎名林檎", album: "無罪モラトリアム", track: "正しい街" },
  ]);
  assert.deepEqual(rowCounts(), { artists: 2, albums: 2, tracks: 2 });
  assert.deepEqual(
    db.prepare("SELECT id, mbid FROM library_artists WHERE name = '椎名林檎'").get(),
    { id: artist.id, mbid },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM library_albums WHERE identity_key = 'name:album:name artist'").pluck().get(),
    0,
  );

  reads.length = 0;
  await scan();
  assert.deepEqual(reads, []);
});

const libraryState = (user) => {
  const starred = subsonic.getStarred(user);
  return {
    starredArtists: starred.artist.map((entry) => entry.name).sort(),
    starredAlbums: starred.album.map((entry) => entry.name).sort(),
    monitoredAlbums: getLibrary().albums.filter((album) => album.monitored).map((album) => album.title).sort(),
  };
};

test("a scan of one changed file gives its own rows the merged rows' favorites and monitoring", async () => {
  const { scan, paths } = await writeLibrary(MERGED_FILES);
  const { user } = await seedMergedLibrary(paths);
  await writeFile(paths[0], "changed fixture");

  await scan({ changedPaths: [paths[0]] });

  assert.deepEqual(libraryState(user), {
    starredArtists: ["宇多田ヒカル", "椎名林檎"],
    starredAlbums: ["初恋", "無罪モラトリアム"],
    monitoredAlbums: ["初恋", "無罪モラトリアム"],
  });
});

test("a split that takes two scans keeps each album's plays and monitoring", async () => {
  const { scan, paths } = await writeLibrary(MERGED_FILES);
  const { user } = await seedMergedLibrary(paths);

  await scan({ unreadable: [paths[1]] });
  await scan();

  assert.deepEqual(rowCounts(), { artists: 2, albums: 2, tracks: 2 });
  assert.deepEqual(playCounts(), { 初恋: 2, 無罪モラトリアム: 1 });
  assert.deepEqual(libraryState(user), {
    starredArtists: ["宇多田ヒカル", "椎名林檎"],
    starredAlbums: ["初恋", "無罪モラトリアム"],
    monitoredAlbums: ["初恋", "無罪モラトリアム"],
  });
});

test("a scan that stops partway still gives the rows it split off their favorites, plays, and monitoring", async () => {
  const { scan, reads, paths } = await writeLibrary(MERGED_FILES);
  const { user } = await seedMergedLibrary(paths);
  const stopAfterFirstRead = () => {
    if (reads.length > 0) throw new Error("folder unreadable");
    return false;
  };

  await assert.rejects(scan({ isExcluded: stopAfterFirstRead }));
  await scan();

  assert.deepEqual(rowCounts(), { artists: 2, albums: 2, tracks: 2 });
  assert.deepEqual(playCounts(), { 初恋: 2, 無罪モラトリアム: 1 });
  assert.deepEqual(libraryState(user), {
    starredArtists: ["宇多田ヒカル", "椎名林檎"],
    starredAlbums: ["初恋", "無罪モラトリアム"],
    monitoredAlbums: ["初恋", "無罪モラトリアム"],
  });
});
