import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, subsonic, libraryStore] = await setupIsolatedBackend(
  "subsonic-bounded-reads",
  "backend/config/db-sqlite.js",
  "backend/services/subsonicLibraryService.js",
  "backend/services/libraryMediaStore.js",
);

test.before(() => {
  resetDatabase(db);
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "bounded:artist",
    mbid: "bounded-artist-mbid",
    name: "Bounded Artist",
    metadata: { genres: ["Rock"] },
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "bounded:album",
    mbid: "bounded-album-mbid",
    releaseGroupMbid: "bounded-release-group",
    artistId: artist.id,
    title: "Bounded Album",
    metadata: { genres: ["Rock"] },
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "bounded:track",
    title: "Bounded Track",
    artistName: artist.name,
    metadata: { genres: ["Rock"] },
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: "/tmp/bounded-track.flac",
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("focused Subsonic requests never execute an unfiltered complete-library query", (t) => {
  const prepared = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });
  db.prepare("UPDATE library_tracks SET metadata_json = '{' WHERE identity_key = ?")
    .run("bounded:track");

  assert.ok(subsonic.listArtists().length);
  assert.ok(subsonic.getArtist(`artist:${encodeURIComponent("bounded:artist")}`));
  assert.ok(subsonic.getAlbum(`album:${encodeURIComponent("bounded:album")}`));
  assert.ok(subsonic.searchLibrary("Bounded", { songCount: 1 }).song.length);
  assert.ok(subsonic.getAlbumList({ size: 1 }).length);
  assert.ok(subsonic.getSongsByGenre("Rock", { count: 1 }).length);
  assert.deepEqual(subsonic.getGenres(), [{ albumCount: 1, songCount: 1, value: "Rock" }]);

  const completeQueries = prepared.filter((sql) =>
    sql.includes("FROM library_tracks AS track")
      && sql.includes("LEFT JOIN library_media_files AS media")
      && !/\bWHERE\b/.test(sql),
  );
  assert.deepEqual(completeQueries, []);
  const hydration = prepared.filter((sql) =>
    sql.includes("track.id AS track_id") && sql.includes("FROM library_tracks AS track"),
  );
  assert.ok(hydration.length > 0);
  assert.equal(hydration.every((sql) => /WHERE (artist|album|track)\.id IN/.test(sql)), true);
  const artistIndexQuery = prepared.find((sql) =>
    sql.includes("COUNT(DISTINCT album.id) AS album_count")
      && sql.includes("FROM library_artists AS artist"),
  );
  assert.ok(artistIndexQuery);
  assert.doesNotMatch(artistIndexQuery, /library_(album_tracks|media_files)/);
});
