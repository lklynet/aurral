import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [, store, { toQueueTracks }] = await setupIsolatedBackend(
  "library-queue-tracks",
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/routes/library/handlers/queueTracks.ts"),
);

test("queue tracks link to the library artist only when the track is credited to them", () => {
  const artist = store.upsertLibraryArtist({
    identityKey: "artist:Massive Attack",
    name: "Massive Attack",
  });
  const album = store.upsertLibraryAlbum({
    identityKey: "album:Mezzanine",
    artistId: artist.id,
    title: "Mezzanine",
  });
  const [own, guest] = ["massive attack", "Elizabeth Fraser"].map((artistName, index) => {
    const track = store.upsertLibraryTrack({
      identityKey: `track:${index}`,
      title: `Track ${index}`,
      artistName,
    });
    store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/music/${index}.flac`,
      format: "flac",
    });
    return track;
  });

  const tracks = toQueueTracks([own!.id, guest!.id]);

  assert.deepEqual(
    tracks.map((track) => track.libraryArtistId),
    [artist.id, null],
  );
});
