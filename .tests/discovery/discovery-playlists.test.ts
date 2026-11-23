import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const ARTISTS = [
  { name: "Mogwai", mbid: "11111111-1111-4111-8111-111111111111" },
  { name: "Slowdive", mbid: "22222222-2222-4222-8222-222222222222" },
  { name: "Low", mbid: "33333333-3333-4333-8333-333333333333" },
  { name: "Lush", mbid: "44444444-4444-4444-8444-444444444444" },
] as const;
const ALBUM_MBID = (index: number) => `aaaa0000-0000-4000-8000-${String(index).padStart(12, "0")}`;

vi.mock("../../backend/services/discovery/freshReleases.ts", () => ({
  refreshFreshReleases: async () => {},
  getFreshReleasesByArtists: () =>
    Array.from({ length: 12 }, (_, index) => ({
      releaseGroupMbid: ALBUM_MBID(index),
      artistMbid: ARTISTS[0].mbid,
      artistName: ARTISTS[0].name,
      albumName: `Record ${index}`,
      albumType: "Album",
      releaseDate: "2026-10-01",
    })),
}));

const [, { db }, store, { buildDiscoveryPlaylists, getDiscoveryPlaylist }, metadata, { http }] =
  await setupIsolatedBackend(
    "discovery-playlists",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/discovery/discoveryPlaylists.ts"),
    () => import("../../backend/services/providers/metadataProvider.ts"),
    () => import("../../lib/http.ts"),
  );

const NOW = Date.UTC(2026, 10, 5, 12);

const ok = (data: unknown) => ({ status: 200, statusText: "OK", headers: {}, data });

function stubMetadata(hosts: string[] = []) {
  vi.spyOn(http, "get").mockImplementation(async (rawUrl, config) => {
    const url = new URL(String(rawUrl));
    hosts.push(url.hostname);
    if (url.hostname === "data.aurral.org" && url.pathname === "/v1/search/artist") {
      const q = String(config?.query?.q || "");
      const artist = ARTISTS.find((entry) => entry.name === q);
      return ok({
        artists: artist ? [{ id: artist.mbid, name: artist.name }] : [],
        total: artist ? 1 : 0,
      });
    }
    if (url.hostname === "data.aurral.org" && url.pathname.startsWith("/v1/artist/")) {
      const mbid = url.pathname.slice("/v1/artist/".length);
      const artist = ARTISTS.find((entry) => entry.mbid === mbid);
      if (artist) {
        const albumId = ALBUM_MBID(100 + ARTISTS.indexOf(artist));
        return ok({
          id: artist.mbid,
          name: artist.name,
          albums: [{ id: albumId, title: "Album", type: "Album" }],
          topTracks: Array.from({ length: 20 }, (_, index) => ({
            recordingId: `rec-${artist.name.toLowerCase()}-${index}`,
            title: `${artist.name} ${index}`,
            albumId,
            durationMs: 200_000,
            listeners: 1000 - index,
          })),
        });
      }
    }
    if (url.hostname === "data.aurral.org" && url.pathname.startsWith("/v1/album/")) {
      const albumMbid = url.pathname.slice("/v1/album/".length);
      return ok({
        id: albumMbid,
        title: `Record ${albumMbid}`,
        artistId: ARTISTS[0].mbid,
        artists: [{ id: ARTISTS[0].mbid, name: ARTISTS[0].name }],
        releases: [
          {
            id: `rel-${albumMbid}`,
            title: `Record ${albumMbid}`,
            status: "Official",
            tracks: [
              {
                id: `trk-intro-${albumMbid}`,
                recordingId: `rec-intro-${albumMbid}`,
                title: "Intro",
                trackNumber: 1,
                durationMs: 25_000,
              },
              {
                id: `trk-lead-${albumMbid}`,
                recordingId: `rec-lead-${albumMbid}`,
                title: `Single ${albumMbid.slice(-2)}`,
                trackNumber: 2,
                durationMs: 215_000,
              },
            ],
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${rawUrl}`);
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
  metadata.clearMetadataProviderCaches();
  store.upsertLibraryArtist({
    identityKey: "artist:releases",
    name: ARTISTS[0].name,
    mbid: ARTISTS[0].mbid,
  });
  userId = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('listener', 'x') RETURNING id",
    )
    .get()!.id;
  const insertPlay = db.prepare<[number, string, string, number]>(`
    INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at)
    VALUES (?, 'history:1', ?, ?, ?, 'test', 0)
  `);
  for (const artist of ARTISTS) insertPlay.run(userId, "Song", artist.name, NOW);
});

test("Deep Cuts and New Releases build from data.aurral.org with MBIDs and lazy previews", async () => {
  const hosts: string[] = [];
  stubMetadata(hosts);
  own("Mogwai", "Mogwai 7");

  await buildDiscoveryPlaylists(userId, NOW);

  assert.deepEqual([...new Set(hosts)], ["data.aurral.org"]);

  const deepCuts = getDiscoveryPlaylist(userId, "deep-cuts")?.tracks ?? [];
  assert.equal(deepCuts.length, 12);
  for (const artist of ARTISTS) {
    assert.equal(deepCuts.filter((track) => track.artistName === artist.name).length, 3);
  }
  const titles = deepCuts.map((track) => track.trackName);
  assert.ok(!titles.includes("Mogwai 7"));
  assert.ok(titles.every((title) => Number(title.split(" ").at(-1)) >= 5));
  assert.ok(deepCuts.every((track) => track.artistMbid && track.albumMbid && track.trackMbid));
  assert.ok(deepCuts.every((track) => track.preview_url?.startsWith("/api/deezer/preview?")));

  const newReleases = getDiscoveryPlaylist(userId, "new-releases")?.tracks ?? [];
  assert.equal(newReleases.length, 12);
  assert.ok(newReleases.every((track) => track.trackName.startsWith("Single ")));
  assert.equal(newReleases[0]?.artistMbid, ARTISTS[0].mbid);
  assert.equal(newReleases[0]?.albumMbid, ALBUM_MBID(0));
  assert.equal(newReleases[0]?.trackMbid, `rec-lead-${ALBUM_MBID(0)}`);
});

test("a rebuild that can't reach metadata keeps last week's playlist", async () => {
  stubMetadata();
  await buildDiscoveryPlaylists(userId, NOW);
  const before = ["deep-cuts", "new-releases"].map((id) => getDiscoveryPlaylist(userId, id));
  assert.ok(before.every(Boolean));

  vi.restoreAllMocks();
  metadata.clearMetadataProviderCaches();
  vi.spyOn(http, "get").mockRejectedValue(new Error("offline"));
  await buildDiscoveryPlaylists(userId, NOW + 7 * 24 * 60 * 60 * 1000);

  assert.deepEqual(
    ["deep-cuts", "new-releases"].map((id) => getDiscoveryPlaylist(userId, id)),
    before,
  );
});
