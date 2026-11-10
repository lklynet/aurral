import assert from "node:assert/strict";
import { beforeEach, test } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [, { db }, store, { artistQueueTracks }] = await setupIsolatedBackend(
  "library-artist-queue",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/queueTracks.ts"),
);

const MBID = "8bfac288-ccc5-448d-9573-c33ea2aa5c30";

function addAlbum(
  artistId: number,
  title: string,
  releaseDate: string,
  tracks: { title: string; disc: number; number: number; hasFile?: boolean }[],
) {
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${title}`,
    artistId,
    title,
    releaseDate,
  });
  for (const entry of tracks) {
    const track = store.upsertLibraryTrack({
      identityKey: `track:${title}:${entry.title}`,
      title: entry.title,
    });
    store.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      discNumber: entry.disc,
      trackNumber: entry.number,
    });
    if (entry.hasFile === false) continue;
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/music/${title}/${entry.title}.flac`,
      format: "flac",
    });
  }
}

beforeEach(() => resetDatabase(db));

test("an artist queue plays only that artist's playable tracks in release and track order", () => {
  const artist = store.upsertLibraryArtist({
    identityKey: "artist:mbid",
    name: "Red Hot Chili Peppers",
    mbid: MBID,
  });
  addAlbum(artist.id, "Californication", "1999-06-08", [
    { title: "Around the World", disc: 1, number: 1 },
    { title: "Parallel Universe", disc: 1, number: 2, hasFile: false },
  ]);
  addAlbum(artist.id, "Blood Sugar Sex Magik", "1991-09-24", [
    { title: "Sir Psycho Sexy", disc: 2, number: 1 },
    { title: "Give It Away", disc: 1, number: 9 },
    { title: "The Power of Equality", disc: 1, number: 1 },
  ]);
  const other = store.upsertLibraryArtist({ identityKey: "artist:other", name: "Other" });
  addAlbum(other.id, "Elsewhere", "1995-01-01", [{ title: "Not This", disc: 1, number: 1 }]);

  assert.deepEqual(
    artistQueueTracks(MBID).map((track) => track.title),
    ["The Power of Equality", "Give It Away", "Sir Psycho Sexy", "Around the World"],
  );
});
