import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

vi.mock("../../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});

vi.mock("../../backend/services/discovery/freshReleases.ts", () => ({
  refreshFreshReleases: async () => {},
  getFreshReleasesByArtists: () =>
    Array.from({ length: 12 }, (_, index) => ({
      artistName: "Mogwai",
      albumName: `Record ${index}`,
      albumType: "Album",
      releaseDate: "2026-10-01",
    })),
}));

const [
  ,
  { db },
  store,
  { buildDiscoveryPlaylists, getDiscoveryPlaylist },
  deezer,
  { default: axios },
] = await setupIsolatedBackend(
  "discovery-playlists",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/discovery/discoveryPlaylists.ts"),
  () => import("../../backend/services/apiClients/deezer.ts"),
  () => import("../../lib/axiosFetch.ts"),
);

const ARTISTS = ["Mogwai", "Slowdive", "Low", "Lush"];
const NOW = Date.UTC(2026, 10, 5, 12);

const ok = (data: unknown) => ({ status: 200, statusText: "OK", headers: {}, data });

function stubDeezer() {
  vi.spyOn(axios, "get").mockImplementation(async (url, config) => {
    const path = String(url).replace("https://api.deezer.com", "");
    if (path === "/search/artist") {
      const name = String(config?.params?.q);
      return ok({ data: [{ id: ARTISTS.indexOf(name) + 1, name }] });
    }
    if (/^\/artist\/\d+\/albums$/.test(path)) {
      return ok({
        data: Array.from({ length: 12 }, (_, index) => ({
          id: 500 + index,
          title: `Record ${index}`,
          record_type: "album",
          release_date: "2026-10-01",
        })),
      });
    }
    const albumTracks = /^\/album\/(\d+)\/tracks$/.exec(path);
    if (albumTracks) {
      const id = Number(albumTracks[1]);
      return ok({ data: [{ id: id * 10, title: `Single ${id}`, rank: 1, preview: "x" }] });
    }
    const top = /^\/artist\/(\d+)\/top$/.exec(path);
    if (top) {
      const name = ARTISTS[Number(top[1]) - 1];
      return ok({
        data: Array.from({ length: 20 }, (_, index) => ({
          id: Number(top[1]) * 100 + index,
          title: `${name} ${index}`,
          preview: "https://cdn.test/preview.mp3",
          duration: 200,
          artist: { name },
          album: { id: 9, title: "Album" },
        })),
      });
    }
    return ok({ data: [] });
  });
}

function own(artistName: string, title: string) {
  const artist = store.upsertLibraryArtist({
    identityKey: `artist:${artistName}`,
    name: artistName,
  });
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${artistName}`,
    artistId: artist.id,
    title: "Album",
  });
  const track = store.upsertLibraryTrack({ identityKey: `track:${title}`, title, artistName });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  store.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: `/music/${title}.flac`,
    format: "flac",
  });
}

let userId = 0;

beforeEach(() => {
  resetDatabase(db);
  deezer.deezerArtistCache.flushAll();
  deezer.deezerTopTrackCache.flushAll();
  deezer.deezerAlbumCache.flushAll();
  deezer.deezerAlbumTrackCache.flushAll();
  store.upsertLibraryArtist({ identityKey: "artist:releases", name: "Mogwai", mbid: "mbid-1" });
  userId = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('listener', 'x') RETURNING id",
    )
    .get()!.id;
  const insertPlay = db.prepare<[number, string, string, number]>(`
    INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at)
    VALUES (?, 'lastfm:1', ?, ?, ?, 'test', 0)
  `);
  for (const artist of ARTISTS) insertPlay.run(userId, "Song", artist, NOW);
});

test("Deep Cuts skips each artist's hits and songs already in the Library", async () => {
  stubDeezer();
  own("Mogwai", "Mogwai 7");

  await buildDiscoveryPlaylists(userId, NOW);

  const tracks = getDiscoveryPlaylist(userId, "deep-cuts")?.tracks ?? [];
  assert.equal(tracks.length, 12);
  for (const artist of ARTISTS) {
    assert.equal(tracks.filter((track) => track.artistName === artist).length, 3);
  }
  const titles = tracks.map((track) => track.trackName);
  assert.ok(!titles.includes("Mogwai 7"));
  assert.ok(titles.every((title) => Number(title.split(" ").at(-1)) >= 5));
});

test("a rebuild that can't reach Deezer keeps last week's playlist", async () => {
  stubDeezer();
  await buildDiscoveryPlaylists(userId, NOW);
  const before = ["deep-cuts", "new-releases"].map((id) => getDiscoveryPlaylist(userId, id));
  assert.ok(before.every(Boolean));

  vi.restoreAllMocks();
  deezer.deezerArtistCache.flushAll();
  deezer.deezerTopTrackCache.flushAll();
  deezer.deezerAlbumCache.flushAll();
  deezer.deezerAlbumTrackCache.flushAll();
  vi.spyOn(axios, "get").mockRejectedValue(new Error("offline"));
  await buildDiscoveryPlaylists(userId, NOW + 7 * 24 * 60 * 60 * 1000);

  assert.deepEqual(
    ["deep-cuts", "new-releases"].map((id) => getDiscoveryPlaylist(userId, id)),
    before,
  );
});
