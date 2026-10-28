import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { getTrendingCharts, getTrendingGenreChart, refreshTrendingCharts },
] = await setupIsolatedBackend(
  "trending-charts",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/discovery/trendingCharts.ts"),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_ONE = Date.parse("2026-10-01T12:00:00Z");
const ARTIST_MBID = "00000000-0000-4000-8000-000000000010";
const USER_ID = 1;

const track = (id: number, title: string = `Song ${id}`) => ({
  id,
  title,
  duration: 180,
  preview: `https://cdnt-preview.dzcdn.net/${id}.mp3`,
  artist: { name: `Artist ${id}` },
  album: { id: id * 10, title: `Album ${id}`, cover_medium: `https://img/${id}.jpg` },
});

const appleAlbum = (id: number, genre: string) => ({
  id: String(id),
  name: `Record ${id}`,
  artistName: `Band ${id}`,
  artworkUrl100: `https://is1.mzstatic.com/${id}/100x100bb.jpg`,
  releaseDate: "2026-09-01",
  genres: [{ name: genre }, { name: "Music" }],
});

type Source = {
  region: string;
  playlists: { id: number; title: string }[];
  chartTracks: number[];
  appleStorefronts: Record<string, ReturnType<typeof appleAlbum>[]>;
  genreTracks: Record<string, number[]>;
  artistsFail?: boolean;
};

let source: Source;
let requests: URL[] = [];

const json = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const respond = (url: URL) => {
  if (url.hostname === "rss.marketingtools.apple.com") {
    const storefront = url.pathname.split("/")[3];
    const albums = source.appleStorefronts[storefront];
    return albums ? json({ feed: { results: albums } }) : json({}, 404);
  }
  if (url.hostname !== "api.deezer.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/infos") return json({ country_iso: source.region });
  if (url.pathname === "/user/637006841/playlists") return json({ data: source.playlists });
  if (/^\/playlist\/\d+\/tracks$/.test(url.pathname)) {
    return json({ data: source.chartTracks.map((id) => track(id)) });
  }
  if (url.pathname === "/chart/0/artists") {
    if (source.artistsFail) return json({}, 500);
    return json({ data: [{ id: 77, name: "Chart Star", picture_xl: "https://img/star.jpg" }] });
  }
  if (url.pathname === "/artist/77") return json({ id: 77, nb_fan: 4200 });
  const genreTracks = source.genreTracks[url.pathname.match(/^\/chart\/(\d+)\/tracks$/)?.[1] ?? ""];
  if (genreTracks) return json({ data: genreTracks.map((id) => track(id)) });
  return json({ error: { code: 800 } });
};

const refreshAt = (now: number) => refreshTrendingCharts({ now, force: true });

beforeEach(() => {
  resetDatabase(db);
  dbOps.setMusicbrainzArtistMbidCache("chart star", ARTIST_MBID);
  requests = [];
  source = {
    region: "GB",
    playlists: [
      { id: 1, title: "Top Worldwide" },
      { id: 2, title: "Top UK" },
    ],
    chartTracks: [1, 2, 3],
    appleStorefronts: { gb: [appleAlbum(1, "Pop"), appleAlbum(2, "Pop"), appleAlbum(3, "Rock")] },
    genreTracks: { 132: [501, 502] },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return respond(url);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanupIsolatedState(isolatedState);
});

test("a refresh stores every chart for the server's region", async () => {
  assert.equal(await refreshAt(DAY_ONE), true);

  const charts = getTrendingCharts(USER_ID);
  assert.equal(charts.region, "GB");
  assert.equal(charts.songs?.playlistId, "2");
  assert.equal(charts.songs?.playlistName, "Top UK");
  assert.deepEqual(
    charts.songs?.items.map((item) => [item.position, item.trackName, item.movement]),
    [
      [1, "Song 1", null],
      [2, "Song 2", null],
      [3, "Song 3", null],
    ],
  );
  assert.equal(charts.songs?.spotlight, null);
  assert.deepEqual(
    charts.albums?.map((album) => [album.position, album.name, album.genre, album.artworkUrl]),
    [
      [1, "Record 1", "Pop", "https://is1.mzstatic.com/1/500x500bb.jpg"],
      [2, "Record 2", "Pop", "https://is1.mzstatic.com/2/500x500bb.jpg"],
      [3, "Record 3", "Rock", "https://is1.mzstatic.com/3/500x500bb.jpg"],
    ],
  );
  assert.deepEqual(charts.genreShare, {
    total: 3,
    other: 0,
    genres: [
      { name: "Pop", count: 2 },
      { name: "Rock", count: 1 },
    ],
  });
  assert.deepEqual(
    charts.artists?.map((artist) => [artist.name, artist.fans, artist.mbid]),
    [["Chart Star", 4200, ARTIST_MBID]],
  );
  assert.deepEqual(
    charts.genres.map((genre) => [genre.id, genre.name, genre.artists]),
    [[132, "Pop", ["Artist 501", "Artist 502"]]],
  );
  assert.deepEqual(
    getTrendingGenreChart(132)?.items.map((item) => item.trackName),
    ["Song 501", "Song 502"],
  );
  assert.equal(getTrendingGenreChart(152), null);
});

test("a region without its own charts falls back to worldwide songs and US albums", async () => {
  source.region = "NZ";
  source.appleStorefronts = { us: [appleAlbum(9, "Country")] };

  await refreshAt(DAY_ONE);

  const charts = getTrendingCharts(USER_ID);
  assert.equal(charts.region, "NZ");
  assert.equal(charts.songs?.playlistName, "Top Worldwide");
  assert.deepEqual(
    charts.albums?.map((album) => album.name),
    ["Record 9"],
  );
  assert.deepEqual(
    requests
      .filter((url) => url.hostname === "rss.marketingtools.apple.com")
      .map((url) => url.pathname.split("/")[3]),
    ["nz", "us"],
  );
});

test("stored days drive song movement and the No. 1 spotlight", async () => {
  await refreshAt(DAY_ONE);
  source.chartTracks = [1, 3, 4];
  await refreshAt(DAY_ONE + DAY_MS);

  const second = getTrendingCharts(USER_ID).songs;
  assert.deepEqual(
    second?.items.map((item) => [item.key, item.movement]),
    [
      ["1", 0],
      ["3", 1],
      ["4", "new"],
    ],
  );
  assert.equal(second?.spotlight?.daysAtTop, 2);
  assert.deepEqual(second?.spotlight?.ranks.slice(-3), [null, 1, 1]);

  source.chartTracks = [1, 4, 3];
  await refreshAt(DAY_ONE + 3 * DAY_MS);

  const afterGap = getTrendingCharts(USER_ID).songs;
  assert.equal(afterGap?.spotlight?.daysAtTop, 1);
  assert.deepEqual(afterGap?.spotlight?.ranks.slice(-4), [1, 1, null, 1]);
});

test("a No. 1 streak keeps counting past the 14 days the rank line shows", async () => {
  for (let day = 0; day < 20; day += 1) await refreshAt(DAY_ONE + day * DAY_MS);

  const spotlight = getTrendingCharts(USER_ID).songs?.spotlight;
  assert.equal(spotlight?.daysAtTop, 20);
  assert.equal(spotlight?.ranks.length, 14);
});

test("a failing source keeps its last chart while the others update", async () => {
  source.genreTracks = { 132: [501], 152: [601] };
  await refreshAt(DAY_ONE);
  source.chartTracks = [2, 1];
  source.appleStorefronts = {};
  source.artistsFail = true;
  source.genreTracks = { 152: [602] };

  assert.equal(await refreshAt(DAY_ONE + DAY_MS), true);

  const charts = getTrendingCharts(USER_ID);
  assert.deepEqual(
    charts.songs?.items.map((item) => item.trackName),
    ["Song 2", "Song 1"],
  );
  assert.deepEqual(
    charts.albums?.map((album) => album.name),
    ["Record 1", "Record 2", "Record 3"],
  );
  assert.deepEqual(
    charts.artists?.map((artist) => artist.name),
    ["Chart Star"],
  );
  assert.deepEqual(
    charts.genres.map((genre) => [genre.name, genre.artists]),
    [
      ["Pop", ["Artist 501"]],
      ["Rock", ["Artist 602"]],
    ],
  );
});

test("a scheduled refresh skips charts that are still fresh", async () => {
  assert.equal(await refreshTrendingCharts({ now: DAY_ONE }), true);
  requests = [];

  assert.equal(await refreshTrendingCharts({ now: DAY_ONE + 60 * 60 * 1000 }), false);
  assert.deepEqual(requests, []);

  assert.equal(await refreshTrendingCharts({ now: DAY_ONE + 6 * 60 * 60 * 1000 }), true);
});
