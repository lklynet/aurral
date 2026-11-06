import assert from "node:assert/strict";
import { beforeEach, test } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [, { db }, store, { getUserMixes, clearUserMixes }, subsonic] = await setupIsolatedBackend(
  "discovery-mixes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/discovery/mixes.ts"),
  () => import("../../backend/services/subsonicLibraryService.ts"),
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12);

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

const insertPlay = db.prepare<[number, string, string, string, number]>(`
  INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at)
  VALUES (?, ?, ?, ?, ?, 'test', 0)
`);

function play(trackId: string, title: string, artist: string, times: number, daysAgo: number) {
  for (let index = 0; index < times; index += 1) {
    insertPlay.run(userId, trackId, title, artist, NOW - daysAgo * DAY - index * 1000);
  }
}

const artistOf = (trackId: number) =>
  db
    .prepare<[number], { name: string }>(
      "SELECT artist_name AS name FROM library_tracks WHERE id = ?",
    )
    .get(trackId)!.name;

let userId = 0;

beforeEach(() => {
  resetDatabase(db);
  clearUserMixes();
  userId = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('listener', 'x') RETURNING id",
    )
    .get()!.id;
});

test("listening mixes rank Library tracks by when and how often they were played", async () => {
  const boards = addArtist("Boards", 12);
  const caribou = addArtist("Caribou", 12);
  const daft = addArtist("Daft", 12);
  boards.tracks.forEach((track, index) => {
    const id =
      index % 3 === 0
        ? String(track.id)
        : index % 3 === 1
          ? `song:${encodeURIComponent(`track:Boards:${index}`)}`
          : `plex:${index}`;
    play(id, track.title, "Boards", 14 - index, 3);
  });
  caribou.tracks.forEach((track) => play(String(track.id), track.title, "Caribou", 3, 120));
  daft.tracks.forEach((track) => play(String(track.id), track.title, "Daft", 4, 400));
  play("lastfm:gone", "Not In Library", "Boards", 20, 2);

  const mixes = await getUserMixes(userId, NOW);
  const byId = new Map(mixes.map((mix) => [mix.id, mix]));

  assert.deepEqual(
    byId.get("on-repeat")?.trackIds,
    boards.tracks.map((track) => track.id).slice(0, 12),
  );
  assert.ok(byId.get("rewind")?.trackIds.every((id) => artistOf(id) === "Caribou"));
  assert.equal(byId.get("rewind")?.trackIds.length, 12);
  assert.ok(byId.get("rediscover")?.trackIds.every((id) => artistOf(id) === "Daft"));
  assert.deepEqual(
    mixes.filter((mix) => mix.id.startsWith("radio-")).map((mix) => mix.name),
    ["Boards Radio"],
  );

  const repeat = await subsonic.getSubsonicMixPlaylist("mix:on-repeat", testUser(userId));
  assert.equal(repeat?.entry[0]?.title, "Boards 0");
  await assert.rejects(
    subsonic.updateSubsonicPlaylist(testUser(userId), { playlistId: "mix:on-repeat", name: "x" }),
    { code: "SUBSONIC_PLAYLIST_READ_ONLY" },
  );
});

test("Daily Mixes group the most played artists by shared genre", async () => {
  for (const [name, genre, plays] of [
    ["Avalon", "house", 9],
    ["Bicep", "house", 8],
    ["Coltrane", "jazz", 7],
    ["Davis", "jazz", 6],
  ] as const) {
    const { tracks } = addArtist(name, 12, [genre]);
    for (const track of tracks) play(String(track.id), track.title, name, plays, 5);
  }

  const daily = (await getUserMixes(userId, NOW)).filter((mix) => mix.id.startsWith("daily-"));

  assert.deepEqual(
    daily.map((mix) => [mix.name, mix.description]),
    [
      ["Daily Mix 1", "Avalon and Bicep"],
      ["Daily Mix 2", "Coltrane and Davis"],
    ],
  );
  const built = await getUserMixes(userId, NOW);
  const later = NOW + 31 * 60_000;
  assert.equal(await getUserMixes(userId, later), built);
  insertPlay.run(userId, "lastfm:new", "New Song", "Avalon", later);
  assert.notEqual(await getUserMixes(userId, later + 31 * 60_000), built);
});
