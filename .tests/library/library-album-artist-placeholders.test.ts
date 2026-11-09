import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, store, { db }] = await setupIsolatedBackend(
  "library-album-artist-placeholders",
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
);

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("an album artist change updates linked tracks that have no file", () => {
  const artist = store.upsertLibraryArtist({
    identityKey: "artist:stephane",
    name: "Stéphane Pompougnac",
  });
  const album = store.upsertLibraryAlbum({
    identityKey: "release-group:hotel-costes-9",
    mbid: "fce8fe8b-9402-3893-b4a2-5bacefdb8f1f",
    releaseGroupMbid: "fce8fe8b-9402-3893-b4a2-5bacefdb8f1f",
    artistId: artist.id,
    title: "Hôtel Costes 9",
    albumArtist: "One Self",
  });
  const placeholder = store.upsertLibraryTrack({
    identityKey: "recording:bluebird",
    title: "Bluebird",
    artistName: "One Self",
  });
  store.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: placeholder.id,
    discNumber: 1,
    trackNumber: 1,
  });
  const owned = store.upsertLibraryTrack({
    identityKey: "recording:owned-track",
    title: "Owned Track",
    artistName: "One Self",
  });
  store.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: owned.id,
    discNumber: 1,
    trackNumber: 2,
  });
  store.upsertLibraryMediaFile({
    trackId: owned.id,
    albumId: album.id,
    source: "test",
    path: "/music/one-self/owned-track.flac",
  });
  const credited = store.upsertLibraryTrack({
    identityKey: "recording:go-all-the-way",
    title: "Go All the Way",
    artistName: "Blue Swede",
  });
  store.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: credited.id,
    discNumber: 1,
    trackNumber: 3,
  });

  store.upsertLibraryAlbum({
    identityKey: "release-group:hotel-costes-9",
    mbid: "fce8fe8b-9402-3893-b4a2-5bacefdb8f1f",
    releaseGroupMbid: "fce8fe8b-9402-3893-b4a2-5bacefdb8f1f",
    artistId: artist.id,
    title: "Hôtel Costes 9",
    albumArtist: "Stéphane Pompougnac",
  });

  const artistName = (id: number) =>
    (
      db.prepare("SELECT artist_name FROM library_tracks WHERE id = ?").get(id) as
        | { artist_name: string | null }
        | undefined
    )?.artist_name ?? null;

  assert.equal(artistName(placeholder.id), "Stéphane Pompougnac");
  assert.equal(artistName(credited.id), "Blue Swede");
  assert.equal(artistName(owned.id), "One Self");
});
