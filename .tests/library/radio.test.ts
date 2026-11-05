import assert from "node:assert/strict";
import { beforeEach, test } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [, { db }, store, { addDiscoveryFeedback }, { buildRadio }, { getSimilarSongs }] =
  await setupIsolatedBackend(
    "library-radio",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/discovery/feedback.ts"),
    () => import("../../backend/services/radio.ts"),
    () => import("../../backend/services/subsonicLibraryService.ts"),
  );

const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

function addArtist(name: string, trackCount: number, genres: string[] = []) {
  const artist = store.upsertLibraryArtist({
    identityKey: `artist:${name}`,
    name,
    metadata: genres.length ? { genres } : null,
  });
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${name}`,
    artistId: artist.id,
    title: `${name} LP`,
  });
  const tracks = Array.from({ length: trackCount }, (_, index) => {
    const track = store.upsertLibraryTrack({
      identityKey: `track:${name}:${index}`,
      title: `${name} ${index}`,
      artistName: name,
    });
    store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/music/${name}/${index}.flac`,
      format: "flac",
    });
    return track;
  });
  return { artist, tracks };
}

const artistOf = (trackId: number) =>
  db
    .prepare<[number], { name: string }>(
      `SELECT artist.name FROM library_tracks AS track
       JOIN library_album_tracks AS link ON link.track_id = track.id
       JOIN library_albums AS album ON album.id = link.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE track.id = ?`,
    )
    .get(trackId)!.name;

const countByArtist = (trackIds: number[]) =>
  trackIds.map(artistOf).reduce<Record<string, number>>((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});

let userId = 0;

beforeEach(() => {
  resetDatabase(db);
  userId = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('listener', 'x') RETURNING id",
    )
    .get()!.id;
});

test("a track radio mixes the seed artist with similar and same-genre artists, never blocked ones", async () => {
  const seed = addArtist("Massive Attack", 8, ["trip hop"]);
  addArtist("Portishead", 4);
  addArtist("Tricky", 4, ["Trip Hop"]);
  addArtist("Morcheeba", 4, ["trip hop"]);
  addArtist("Metallica", 4, ["metal"]);
  addDiscoveryFeedback(userId, { action: "block_artist", artistName: "Morcheeba" });
  const [seedTrack, excludedTrack] = seed.tracks;

  const picks = await buildRadio({
    userId,
    seed: { trackIds: [String(seedTrack!.id)] },
    exclude: [String(excludedTrack!.id)],
    limit: 6,
    random: seeded(7),
    similarArtists: async () => [
      { mbid: null, name: "Portishead", match: 1 },
      { mbid: null, name: "Morcheeba", match: 0.9 },
    ],
  });

  assert.deepEqual(countByArtist(picks), { "Massive Attack": 2, Portishead: 2, Tricky: 2 });
  assert.ok(!picks.includes(seedTrack!.id));
  assert.ok(!picks.includes(excludedTrack!.id));
  const artists = picks.map(artistOf);
  assert.ok(artists.every((name, index) => name !== artists[index - 1]));
});

test("a blocked similar artist with a big catalog doesn't leave the station empty", async () => {
  const seed = addArtist("Massive Attack", 1);
  addArtist("Morcheeba", 20);
  addArtist("Tricky", 3);
  addDiscoveryFeedback(userId, { action: "block_artist", artistName: "Morcheeba" });

  const picks = await buildRadio({
    userId,
    seed: { trackIds: [String(seed.tracks[0]!.id)] },
    limit: 4,
    random: seeded(5),
    similarArtists: async () => [{ mbid: null, name: "Morcheeba", match: 1 }],
  });

  assert.deepEqual(countByArtist(picks), { Tricky: 3 });
});

test("an artist radio still plays when similar artists can't be reached", async () => {
  addArtist("Massive Attack", 8, ["trip hop"]);
  addArtist("Portishead", 4);
  addArtist("Tricky", 4, ["trip hop"]);

  const picks = await buildRadio({
    userId,
    seed: { artists: [{ name: "massive attack" }] },
    limit: 6,
    random: seeded(3),
    similarArtists: () => Promise.reject(new Error("offline")),
  });

  assert.equal(picks.length, 6);
  assert.deepEqual(Object.keys(countByArtist(picks)).sort(), ["Massive Attack", "Tricky"]);
});

test("a radio for an artist outside the library plays its similar artists from the library", async () => {
  addArtist("Portishead", 3);
  addArtist("Tricky", 3);

  const picks = await buildRadio({
    userId,
    seed: { artists: [{ name: "Beth Gibbons", mbid: "beth" }] },
    limit: 4,
    random: seeded(11),
    similarArtists: async (artist) =>
      artist.mbid === "beth" ? [{ mbid: null, name: "Portishead", match: 1 }] : [],
  });

  assert.deepEqual(countByArtist(picks), { Portishead: 2, Tricky: 2 });
});

test("Subsonic similar songs follow the song id and leave out the song itself", async () => {
  const seed = addArtist("Massive Attack", 3, ["trip hop"]);
  addArtist("Tricky", 3, ["trip hop"]);
  const user = { id: userId, username: "listener", role: "user" as const, permissions: {} };
  const seedId = store.subsonicId("song", seed.tracks[0]!.identity_key);

  const songs = await getSimilarSongs(seedId, { count: "10" }, user);

  assert.equal(songs?.length, 5);
  assert.ok(songs?.every((song) => song.id !== seedId));
  assert.deepEqual(await getSimilarSongs(seedId, { artistOnly: true }, user), []);
  assert.deepEqual(await getSimilarSongs("song:missing", {}, user), []);
});
