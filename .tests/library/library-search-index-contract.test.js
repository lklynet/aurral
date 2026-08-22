import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, searchIndex] = await setupIsolatedBackend(
  "library-search-index-contract",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/librarySearchIndex.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("album and track search syncs report changed and unchanged documents", () => {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "search-contract:artist",
    name: "Search Contract Artist",
    syncSearch: false,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "search-contract:album",
    artistId: artist.id,
    title: "Search Contract Album",
    albumArtist: artist.name,
    syncSearch: false,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "search-contract:track",
    title: "Search Contract Track",
    artistName: artist.name,
    syncSearch: false,
  });
  libraryStore.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: track.id,
    syncSearch: false,
  });

  assert.equal(searchIndex.syncLibrarySearchAlbum(album.id), true);
  assert.equal(searchIndex.syncLibrarySearchAlbum(album.id), false);
  assert.equal(searchIndex.syncLibrarySearchTrack(track.id), true);
  assert.equal(searchIndex.syncLibrarySearchTrack(track.id), false);

  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM library_search_documents WHERE entity_id IN (?, ?)",
    ).get(album.id, track.id).count,
    2,
  );
});
