import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, queryService, libraryStore] = await setupIsolatedBackend(
  "measured-query-slice",
  "backend/config/db-sqlite.js",
  "backend/services/libraryQueryService.js",
  "backend/services/libraryMediaStore.js",
);

let artist;
let album;
let track;

test.before(() => {
  resetDatabase(db);
  artist = libraryStore.upsertLibraryArtist({
    identityKey: "measured:artist",
    name: "Measured Artist",
  });
  album = libraryStore.upsertLibraryAlbum({
    identityKey: "measured:album",
    artistId: artist.id,
    title: "Measured Album",
    albumArtist: artist.name,
  });
  track = libraryStore.upsertLibraryTrack({
    identityKey: "measured:track",
    title: "Needle Song",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: "/tmp/measured-query-slice.flac",
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("substring search uses the trigram index and stays order-sort free", (t) => {
  const prepared = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });

  const result = queryService.getCanonicalSearchPage({
    source: "all",
    query: "Needle",
    artistLimit: 20,
    albumLimit: 20,
    songLimit: 20,
  });
  assert.deepEqual(result.tracks.tracks.map((entry) => entry.title), ["Needle Song"]);
  const searchSql = prepared.find((sql) =>
    sql.includes("FROM library_tracks AS track") && sql.includes("library_search_fts"));
  assert.ok(searchSql);
  assert.match(searchSql, /MATCH \?/);
  assert.doesNotMatch(searchSql, /ORDER BY/);
  const plan = prepare(`EXPLAIN QUERY PLAN ${searchSql}`).all(
    '"nee" AND "eed" AND "edl" AND "dle"',
    "%needle%",
    "%needle%",
    "%needle%",
    20,
    0,
  );
  assert.ok(plan.some((row) => row.detail.includes("SCAN search_fts VIRTUAL TABLE")));
  assert.equal(plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY")), false);
});

test("unchanged canonical upserts do not rewrite search documents", () => {
  db.exec(`
    CREATE TEMP TABLE search_update_probe (count INTEGER NOT NULL);
    INSERT INTO search_update_probe VALUES (0);
    CREATE TEMP TRIGGER search_update_probe_trigger
    AFTER UPDATE ON library_search_documents
    BEGIN
      UPDATE search_update_probe SET count = count + 1;
    END;
  `);
  try {
    libraryStore.upsertLibraryArtist({
      identityKey: "measured:artist",
      name: "Measured Artist",
    });
    libraryStore.upsertLibraryAlbum({
      identityKey: "measured:album",
      artistId: artist.id,
      title: "Measured Album",
      albumArtist: artist.name,
    });
    libraryStore.upsertLibraryTrack({
      identityKey: "measured:track",
      title: "Needle Song",
      artistName: artist.name,
    });
    assert.equal(db.prepare("SELECT count FROM search_update_probe").get().count, 0);
  } finally {
    db.exec(`
      DROP TRIGGER search_update_probe_trigger;
      DROP TABLE search_update_probe;
    `);
  }
});

test("canonical page search uses FTS and genre reads use the stored scan snapshot", (t) => {
  queryService.rebuildCanonicalGenreStats();
  queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });
  const storedBefore = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'libraryGenreStats:%' ORDER BY key",
  ).all();
  const prepared = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });

  const page = queryService.getCanonicalLibraryPage({
    kind: "tracks",
    page: 1,
    pageSize: 20,
    source: "lidarr",
    query: "Needle",
  });
  assert.deepEqual(page.tracks.map((entry) => entry.title), ["Needle Song"]);
  const pageSearchSql = prepared.find((sql) =>
    sql.includes("COUNT(DISTINCT track.id)") && sql.includes("library_search_fts MATCH ?"));
  assert.ok(pageSearchSql);
  const plan = prepare(`EXPLAIN QUERY PLAN ${pageSearchSql}`).all(
    '"nee" AND "eed" AND "edl" AND "dle"',
    "lidarr",
    "%needle%",
    "%needle%",
    "%needle%",
  );
  assert.ok(plan.some((row) => row.detail.includes("SCAN search_fts VIRTUAL TABLE")));
  assert.ok(plan.some((row) =>
    row.detail.includes("idx_library_media_files_track_album_source_available")));
  assert.deepEqual(
    prepare("SELECT key, value FROM settings WHERE key LIKE 'libraryGenreStats:%' ORDER BY key").all(),
    storedBefore,
  );
});

test("search documents update transactionally and random reads use rowid sampling", (t) => {
  libraryStore.upsertLibraryTrack({
    identityKey: "measured:track",
    title: "Renamed Needle Song",
    artistName: artist.name,
  });
  assert.equal(
    queryService.getCanonicalSearchPage({ query: "Renamed Needle", songLimit: 20 }).tracks.tracks[0].title,
    "Renamed Needle Song",
  );

  const prepared = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });
  t.mock.method(Math, "random", () => 0.999);
  const result = queryService.getCanonicalTrackPage({
    source: "all",
    availableOnly: true,
    random: true,
    limit: 1,
  });
  assert.equal(result.tracks.length, 1);
  const randomSql = prepared.find((sql) => sql.includes("FROM library_tracks AS track") && sql.includes("track.id >= ?"));
  assert.ok(randomSql);
  assert.match(randomSql, /ORDER BY track\.id/);
  assert.doesNotMatch(randomSql, /random\(\)/i);
  const plan = prepare(`EXPLAIN QUERY PLAN ${randomSql}`).all(2, 1);
  assert.ok(plan.some((row) => row.detail.includes("SEARCH track USING INTEGER PRIMARY KEY")));
  assert.equal(plan.some((row) => row.detail.includes("USE TEMP B-TREE")), false);
});

test("artist pages project a large discography without canonical row hydration", (t) => {
  const key = `measured-artist-page-${process.pid}-${Date.now()}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "A Huge Discography",
  });
  const albumCount = 120;
  for (let index = 0; index < albumCount; index += 1) {
    const album = libraryStore.upsertLibraryAlbum({
      identityKey: `${key}:album:${index}`,
      artistId: artist.id,
      title: `Huge Album ${index}`,
    });
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `${key}:track:${index}`,
      title: `Huge Track ${index}`,
      artistName: artist.name,
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/${key}/${index}.flac`,
    });
  }

  const prepared = [];
  const prepare = db.prepare.bind(db);
  const spy = t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });
  try {
    const page = queryService.getCanonicalLibraryPage({
      source: "aurral",
      kind: "artists",
      page: 1,
      pageSize: 1,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].albumCount, albumCount);
    assert.deepEqual(page.items[0].albumIds, []);
    assert.equal(
      prepared.filter((sql) =>
        sql.includes("track.id AS track_id") && sql.includes("media.id AS media_id"),
      ).length,
      0,
    );
  } finally {
    spy.mock.restore();
    db.prepare("DELETE FROM library_media_files WHERE path LIKE ?").run(`/tmp/${key}/%`);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id IN (SELECT id FROM library_albums WHERE identity_key LIKE ?)").run(`${key}:album:%`);
    db.prepare("DELETE FROM library_tracks WHERE identity_key LIKE ?").run(`${key}:track:%`);
    db.prepare("DELETE FROM library_albums WHERE identity_key LIKE ?").run(`${key}:album:%`);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("album track pages count and hydrate only the requested track slice", (t) => {
  const key = `measured-album-page-${process.pid}-${Date.now()}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: `${key}:artist-mbid`,
    name: "A Huge Album",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}:album-mbid`,
    releaseGroupMbid: `${key}:release-group`,
    artistId: artist.id,
    title: "A Huge Album",
  });
  const trackCount = 140;
  for (let index = 0; index < trackCount; index += 1) {
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `${key}:track:${index}`,
      title: `Album Track ${String(index).padStart(3, "0")}`,
      artistName: artist.name,
    });
    libraryStore.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      trackNumber: index + 1,
    });
    if (index % 2 === 0) {
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "aurral",
        path: `/tmp/${key}/${index}.flac`,
      });
    }
  }

  const prepared = [];
  const prepare = db.prepare.bind(db);
  const spy = t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });
  try {
    const page = queryService.getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: album.id,
      page: 2,
      pageSize: 3,
      sort: "name",
      direction: "desc",
    });
    const hydration = prepared.filter((sql) =>
      sql.includes("track.id AS track_id") && sql.includes("media.id AS media_id"),
    );
    assert.equal(hydration.length, 1);
    assert.match(hydration[0], /track\.id IN \(\?,\?,\?\)/);
    assert.equal(page.total, trackCount);
    assert.equal(page.items.length, 3);
    assert.equal(page.albums[0].trackCount, trackCount);
    assert.equal(page.albums[0].availableTrackCount, trackCount / 2);
    assert.equal(page.albums[0].trackIds.length, 3);
    assert.equal(page.albums[0].identityKey, `${key}:album`);
    assert.equal(page.artists[0].identityKey, `${key}:artist`);
    assert.ok(page.items.some((track) => track.files.length === 0));
    assert.ok(page.items.every((track) =>
      track.albums.every((relation) => relation.albumId === album.id)));
  } finally {
    spy.mock.restore();
    db.prepare("DELETE FROM library_media_files WHERE path LIKE ?").run(`/tmp/${key}/%`);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE identity_key LIKE ?").run(`${key}:track:%`);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});
