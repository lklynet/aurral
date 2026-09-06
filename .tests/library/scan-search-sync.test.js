import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupIsolatedState,
  importFromRepo,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "scan-search-sync",
  "backend/config/db-sqlite.js",
);
const { indexLidarrLibrary } = await importFromRepo("backend/services/libraryLidarrIndexer.js");
const { scanConfiguredLibrary } = await importFromRepo("backend/services/libraryIndexService.js");
const queryService = await importFromRepo("backend/services/libraryQueryService.js");
const genreCache = await importFromRepo("backend/services/libraryGenreCache.js");

const ARTIST_MBID = "aaaaaaaa-1111-4111-8111-111111111111";
const ALBUM_MBID = "bbbbbbbb-2222-4222-8222-222222222222";
const TRACK_MBID = "cccccccc-3333-4333-8333-333333333333";

let root;
let filePath;

const buildClient = ({ artistName, albumTitle, trackTitle, genres = ["Rock"] }) => ({
  isConfigured: () => true,
  request: async () => [{
    id: 1,
    artistName,
    foreignArtistId: ARTIST_MBID,
    genres,
  }],
  getAllAlbums: async () => [{
    id: 2,
    artistId: 1,
    title: albumTitle,
    foreignAlbumId: ALBUM_MBID,
    path: path.dirname(filePath),
  }],
  getTracksByAlbumId: async () => [{
    id: 3,
    albumId: 2,
    title: trackTitle,
    trackNumber: 1,
    foreignRecordingId: TRACK_MBID,
    trackFileId: 4,
  }],
  getTrackFilesByAlbumId: async () => [{ id: 4, path: filePath, trackIds: [3] }],
  getRootFolders: async () => [{ path: root }],
});

const searchDocument = (kind, mbidColumn, table, mbid) => db.prepare(
  `SELECT document.title, document.artist_name, document.album_name
   FROM library_search_documents AS document
   JOIN ${table} AS entity ON entity.id = document.entity_id
   WHERE document.entity_kind = ? AND entity.${mbidColumn} = ?`,
).get(kind, mbid);

const searchTitles = (query) => queryService
  .getCanonicalSearchPage({ query, songLimit: 20 })
  .tracks.tracks.map((track) => track.title);

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aurral-scan-search-sync-"));
  filePath = path.join(root, "Sync Artist", "Sync Album", "01 Sync Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("a scan with syncSearch disabled syncs documents for the rows it wrote", async () => {
  const unrelated = db.prepare(
    "INSERT INTO library_search_documents (entity_kind, entity_id, title) VALUES ('track', 999999, 'Unrelated')",
  ).run().lastInsertRowid;
  const result = await indexLidarrLibrary({
    client: buildClient({ artistName: "Sync Artist", albumTitle: "Sync Album", trackTitle: "Sync Track" }),
    syncSearch: false,
  });

  assert.equal(result.changed, true);
  // A full rebuild would have dropped this row; incremental sync leaves it.
  assert.ok(db.prepare("SELECT 1 FROM library_search_documents WHERE id = ?").get(unrelated));
  db.prepare("DELETE FROM library_search_documents WHERE id = ?").run(unrelated);
  assert.deepEqual(searchDocument("artist", "mbid", "library_artists", ARTIST_MBID), {
    title: "Sync Artist",
    artist_name: "",
    album_name: "",
  });
  assert.deepEqual(searchDocument("album", "release_group_mbid", "library_albums", ALBUM_MBID), {
    title: "Sync Album",
    artist_name: "Sync Artist Sync Artist",
    album_name: "",
  });
  assert.deepEqual(searchDocument("track", "mbid", "library_tracks", TRACK_MBID), {
    title: "Sync Track",
    artist_name: "Sync Artist Sync Artist",
    album_name: "Sync Album Sync Artist",
  });
  assert.deepEqual(searchTitles("Sync Track"), ["Sync Track"]);
});

test("renaming an artist during a scan cascades to album and track documents", async () => {
  const result = await indexLidarrLibrary({
    client: buildClient({ artistName: "Renamed Artist", albumTitle: "Sync Album", trackTitle: "Sync Track" }),
    syncSearch: false,
  });

  assert.equal(result.changed, true);
  assert.equal(searchDocument("artist", "mbid", "library_artists", ARTIST_MBID).title, "Renamed Artist");
  assert.equal(
    searchDocument("album", "release_group_mbid", "library_albums", ALBUM_MBID).artist_name,
    "Renamed Artist Renamed Artist",
  );
  assert.equal(
    searchDocument("track", "mbid", "library_tracks", TRACK_MBID).artist_name,
    "Renamed Artist Renamed Artist",
  );
  assert.deepEqual(searchTitles("Renamed Artist"), ["Sync Track"]);
});

test("an unchanged scan writes no search documents", async () => {
  const client = buildClient({ artistName: "Renamed Artist", albumTitle: "Sync Album", trackTitle: "Sync Track" });
  const documentsBefore = db.prepare("SELECT total_changes() AS count").get().count;
  const configured = await scanConfiguredLibrary({
    musicRoot: path.join(root, "empty-aurral-root"),
    lidarrClient: client,
  });
  const documentsAfter = db.prepare("SELECT total_changes() AS count").get().count;

  assert.equal(configured.lidarr.changed, false);
  // Two scan runs, each with a begin and a finish row write.
  assert.equal(documentsAfter - documentsBefore, 4);
});

test("a scan closes an interrupted run and repairs documents it left stale", async () => {
  const mediaStore = await importFromRepo("backend/services/libraryMediaStore.js");
  const searchIndex = await importFromRepo("backend/services/librarySearchIndex.js");
  assert.deepEqual(
    searchIndex.findLibrarySearchDocumentGaps(),
    { artist: [], album: [], track: [] },
    "a consistent index reports nothing to repair",
  );
  // A worker killed mid-scan committed the rename but never synced documents.
  const interrupted = mediaStore.beginLibraryScan({ source: "lidarr" });
  db.prepare("UPDATE library_artists SET name = 'Ghost Rename' WHERE name = 'Renamed Artist'").run();
  assert.equal(
    db.prepare("SELECT title FROM library_search_documents WHERE entity_kind = 'artist'").get().title,
    "Renamed Artist",
  );
  assert.deepEqual(searchIndex.findLibrarySearchDocumentGaps().artist.length, 1);

  const client = buildClient({ artistName: "Ghost Rename", albumTitle: "Sync Album", trackTitle: "Sync Track" });
  await scanConfiguredLibrary({ musicRoot: path.join(root, "empty-aurral-root"), lidarrClient: client });

  const run = db.prepare("SELECT status, error FROM library_scan_runs WHERE id = ?").get(interrupted);
  assert.deepEqual(run, { status: "failed", error: "interrupted" });
  assert.equal(
    db.prepare("SELECT title FROM library_search_documents WHERE entity_kind = 'artist'").get().title,
    "Ghost Rename",
  );
  assert.match(
    db.prepare("SELECT artist_name FROM library_search_documents WHERE entity_kind = 'track'").get().artist_name,
    /Ghost Rename/,
  );
  assert.deepEqual(searchIndex.findLibrarySearchDocumentGaps(), { artist: [], album: [], track: [] });
});

test("library changes keep the stored genre snapshot until the background refresh lands", async () => {
  queryService.rebuildCanonicalGenreStats();
  const storedKeys = () => db.prepare(
    "SELECT key FROM settings WHERE key LIKE 'libraryGenre%' ORDER BY key",
  ).all().map((row) => row.key);
  assert.deepEqual(storedKeys(), [
    "libraryGenreList:all:all",
    "libraryGenreStats:all:all",
    "libraryGenreStats:all:available",
  ]);
  assert.deepEqual(queryService.getCanonicalGenres({ source: "all" }), [
    { albumCount: 1, songCount: 1, value: "Rock" },
  ]);

  await indexLidarrLibrary({
    client: buildClient({
      artistName: "Renamed Artist",
      albumTitle: "Sync Album",
      trackTitle: "Sync Track",
      genres: ["Jazz"],
    }),
    syncSearch: false,
  });

  // The mutation invalidated caches, but the persisted snapshot is still served.
  assert.deepEqual(storedKeys().length, 3);
  assert.deepEqual(queryService.getCanonicalGenres({ source: "all" }).map((genre) => genre.value), ["Rock"]);
  assert.deepEqual(
    queryService.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 10 }).genres
      .map((genre) => genre.name),
    ["Rock"],
  );

  await genreCache.runLibraryGenreRefresh();

  assert.deepEqual(queryService.getCanonicalGenres({ source: "all" }), [
    { albumCount: 1, songCount: 1, value: "Jazz" },
  ]);
  assert.deepEqual(
    queryService.getCanonicalLibraryPage({ kind: "artists", page: 1, pageSize: 10 }).genres,
    [{ name: "Jazz", artists: 1, albums: 0, tracks: 0 }],
  );
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'libraryGenreList:all:all'").get().value)[0].value,
    "Jazz",
  );
});
