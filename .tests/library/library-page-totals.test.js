import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, store, { getLibraryPage }] = await setupIsolatedBackend(
  "library-page-totals",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryQueryService.js",
);
test.after(() => cleanupIsolatedState(state));

test("page totals stay exact after local writes, worker commits, and rollbacks", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "totals:artist", name: "Totals Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: "totals:album", artistId: artist.id, title: "Totals Album",
  });
  const track = store.upsertLibraryTrack({ identityKey: "totals:track", title: "Totals Track" });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const options = { kind: "tracks", artistId: artist.id, pageSize: 1, availableOnly: true };
  const read = () => getLibraryPage(options);
  assert.equal(read().total, 0);
  assert.equal(read().total, 0);

  store.upsertLibraryMediaFile({
    trackId: track.id, albumId: album.id, source: "aurral", path: "/totals/track.flac",
  });
  assert.equal(read().total, 1);
  assert.equal(read().hasMore, false);
  assert.equal(getLibraryPage({ ...options, source: "lidarr" }).total, 0);
  assert.equal(read().total, 1);

  const worker = new Database(state.dbPath);
  try {
    worker.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 0);
    assert.deepEqual(read().items, []);
    assert.equal(getLibraryPage({ ...options, availableOnly: false }).total, 1);
    worker.prepare("UPDATE library_media_files SET available = 1 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 1);

    db.exec("BEGIN");
    db.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(track.id);
    assert.equal(read().total, 0);
    db.exec("ROLLBACK");
    assert.equal(read().total, 1);
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    worker.close();
  }
});

test("broad search keeps stable ordering, page boundaries, and playable source filters", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "broad:artist", name: "Broad Artist" });
  const album = store.upsertLibraryAlbum({ identityKey: "broad:album", artistId: artist.id, title: "Broad Album" });
  const tracks = [];
  db.transaction(() => {
    for (let index = 0; index < 1105; index += 1) {
      const title = `${index % 2 ? "match" : "Match"} ${String(Math.floor(index / 3)).padStart(4, "0")}`;
      const track = store.upsertLibraryTrack({ identityKey: `broad:${index}`, title });
      store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
      const source = index % 4 === 0 ? "lidarr" : "aurral";
      const available = index % 11 !== 0;
      store.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source, available, path: `/broad/${index}.flac` });
      tracks.push({ id: track.id, title, source, available });
    }
  })();
  const ordered = tracks.sort((left, right) =>
    left.title.toLowerCase().localeCompare(right.title.toLowerCase()) || left.id - right.id);
  for (const direction of ["asc", "desc"]) {
    for (const filters of [{}, { source: "aurral", availableOnly: true }]) {
      const eligible = ordered.filter((track) => !filters.source || (track.source === filters.source && track.available));
      if (direction === "desc") eligible.reverse();
      for (const page of [1, 6, 11, 12]) {
        const result = getLibraryPage({ kind: "tracks", query: "match", direction, page, pageSize: 100, ...filters });
        assert.equal(result.total, eligible.length);
        assert.equal(result.hasMore, page * 100 < eligible.length);
        assert.deepEqual(result.items.map((item) => item.id), eligible.slice((page - 1) * 100, page * 100).map((track) => track.id));
      }
    }
  }
});
