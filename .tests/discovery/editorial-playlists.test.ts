import * as v from "valibot";
import { test, beforeEach, afterAll, afterEach, vi, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import { testUser } from "../helpers/userFixtures.ts";
import { localDownloadWorker } from "../download/fixtures.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

vi.mock("../../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});

const [
  isolatedState,
  { db },
  { dbOps },
  playlistConfigModule,
  operationsModule,
  operationQueueModule,
  workerModule,
  importSyncModule,
  editorialModule,
  persistenceModule,
  flowTemplatesModule,
  { FlowTrackSource },
  libraryStore,
  { getBrowsePlaylist },
] = await setupIsolatedBackend(
  "editorial-playlists",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/importLists/importListSync.ts"),
  () => import("../../backend/services/discovery/editorialPlaylists.ts"),
  () => import("../../backend/services/discovery/persistence.ts"),
  () => import("../../backend/services/flows/flowTemplates.ts"),
  () => import("../../backend/services/flows/flowTrackSource.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/discovery/browsePlaylists.ts"),
);

const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { processPlaylistOperation, playlistOperationSchema } = operationsModule;
const { playlistOperationQueue } = operationQueueModule;
const downloadWorker = localDownloadWorker(workerModule.downloadWorker);
const { syncStaticPlaylistImport } = importSyncModule;
const {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  getEditorialShelf,
  resolveEditorialTrackLinks,
} = editorialModule;

const { synchronizeDiscoveryCacheFromWorker } = persistenceModule;
const { buildFlowFromTemplate, listFlowTemplates } = flowTemplatesModule;

const OWNER = testUser(7);
const summary = (id: number, title: string, curator: string = "Rod - Deezer Rock Editor") => ({
  id,
  title,
  nb_tracks: 50,
  picture_xl: `https://img/${id}.jpg`,
  user: { name: curator },
});

let deezerTrackId = 0;
const deezerTrack = (title: string, artist: string, album = "Album") => ({
  id: ++deezerTrackId,
  title,
  artist: { name: artist },
  album: { title: album },
  duration: 200,
  preview: `https://cdnt-preview.dzcdn.net/${encodeURIComponent(title)}.mp3`,
});

type DeezerRoute = { status?: number; body: unknown };

function stubDeezer(
  t: TestContext,
  routes: Record<string, DeezerRoute | ((url: URL) => DeezerRoute)>,
) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) {
      return new Response(JSON.stringify({ error: { type: "DataException", code: 800 } }));
    }
    const { status = 200, body } = typeof route === "function" ? route(url) : route;
    return Response.json(body, { status });
  });
  return requests;
}

const rockEssentials = (
  tracks: (
    | {
        id: number;
        title: string;
        artist: { name: string };
        album: { title: string };
        duration: number;
        preview: string;
      }
    | { id: number; title: string; artist: { name: string } }
  )[],
) => ({
  "/playlist/1306931615": {
    body: {
      id: 1306931615,
      title: "Rock Essentials",
      description: "The rock songs everyone should know.",
      nb_tracks: tracks.length,
      picture_xl: "https://cdn-images.dzcdn.net/rock.jpg",
      creator: { name: "Rod - Deezer Rock Editor" },
    },
  },
  "/playlist/1306931615/tracks": { body: { data: tracks, total: tracks.length } },
});

const captureEnqueues = () => {
  const payloads: object[] = [];
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload) => {
    payloads.push(payload);
    return { queued: true, operationId: payloads.length };
  });
  return payloads;
};

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    staticPlaylists: [],
  });
  invalidateFlowPlaylistConfigCache();
});

afterEach(() => {
  downloadWorker.stop();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("adding a Deezer playlist creates one synced library playlist with its tracks", async (t: import("vite-plus/test").TestContext) => {
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  stubDeezer(
    t,
    rockEssentials([
      deezerTrack("Back In Black", "AC/DC"),
      deezerTrack("Back In Black", "AC/DC"),
      deezerTrack("Paranoid", "Black Sabbath"),
      { id: 99, title: "", artist: { name: "Nobody" } },
    ]),
  );
  const payloads = captureEnqueues();

  const added = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  assert.equal(payloads.length, 1);
  await processPlaylistOperation(v.parse(playlistOperationSchema, payloads[0]));

  const playlist = flowPlaylistConfig.getStaticPlaylist(added.playlistId);
  assert.ok(playlist != null);
  assert.equal(playlist.name, "Rock Essentials");
  assert.equal(playlist.ownerUserId, 7);
  assert.equal(playlist.description, "The rock songs everyone should know.");
  assert.deepEqual(
    playlist.tracks.map((track) => `${track.artistName} - ${track.trackName} (${track.albumName})`),
    ["AC/DC - Back In Black (Album)", "Black Sabbath - Paranoid (Album)"],
  );
  assert.equal(playlist.importSource?.provider, "deezer-playlist");
  assert.equal(playlist.importSource?.externalId, "1306931615");
  assert.equal(playlist.importSource?.syncEnabled, true);
  assert.equal(playlist.importSource?.keepRemovedTracks, true);

  const again = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  assert.equal(again.alreadyAdded, true);
  assert.equal(again.playlistId, added.playlistId);
  assert.equal(payloads.length, 1);
  assert.equal(
    (await getEditorialPlaylist(OWNER, "1306931615")).libraryPlaylistId,
    added.playlistId,
  );
  assert.equal((await getEditorialPlaylist(testUser(8), "1306931615")).libraryPlaylistId, null);
});

test("a Deezer playlist skips a track Aurral can't read and still pages by what Deezer sent", async (t) => {
  const routes = rockEssentials([]);
  const requests = stubDeezer(t, {
    ...routes,
    "/playlist/1306931615/tracks": (url) =>
      url.searchParams.get("index") === "0"
        ? {
            body: {
              data: [
                { id: 1, title: { text: "Broken" }, artist: { name: "Nobody" } },
                deezerTrack("Back In Black", "AC/DC"),
              ],
              next: "https://api.deezer.com/playlist/1306931615/tracks?index=2",
            },
          }
        : { body: { data: [deezerTrack("Paranoid", "Black Sabbath")] } },
  });

  const playlist = await getEditorialPlaylist(OWNER, "1306931615");

  assert.deepEqual(
    playlist.tracks.map((track) => `${track.artistName} - ${track.trackName}`),
    ["AC/DC - Back In Black", "Black Sabbath - Paranoid"],
  );
  assert.deepEqual(
    requests
      .filter((request) => request.startsWith("/playlist/1306931615/tracks"))
      .map((request) => new URLSearchParams(request.split("?")[1]).get("index")),
    ["0", "2"],
  );
});

test("a Deezer playlist keeps tracks whose album has no cover", async (t) => {
  stubDeezer(t, {
    ...rockEssentials([]),
    "/playlist/1306931615": {
      body: { id: 1306931615, title: "Rock Essentials", picture_xl: null, picture_big: null },
    },
    "/playlist/1306931615/tracks": {
      body: {
        data: [
          {
            ...deezerTrack("No Refunds", "Los Bitchos"),
            album: { id: 1, title: "No Refunds", cover_medium: null, cover_xl: null },
          },
        ],
      },
    },
  });

  const playlist = await getEditorialPlaylist(OWNER, "1306931615");

  assert.deepEqual(
    playlist.tracks.map((track) => [`${track.artistName} - ${track.trackName}`, track.artworkUrl]),
    [["Los Bitchos - No Refunds", null]],
  );
});

test("songs already in the Library play in full and the rest stay previews", async (t) => {
  stubDeezer(
    t,
    rockEssentials([deezerTrack("Owned Song", "Owned Band"), deezerTrack("New Song", "Someone")]),
  );
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "artist:owned",
    name: "Owned Band",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "album:owned",
    artistId: artist.id,
    title: "Album",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "track:owned",
    title: "Owned Song",
    artistName: "Owned Band",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: "/music/owned.flac",
    format: "flac",
  });

  const { tracks } = await getBrowsePlaylist(OWNER, "deezer", "1306931615");

  assert.deepEqual(
    tracks.map((entry) => [entry.trackName, entry.owned?.libraryTrackId ?? null]),
    [
      ["Owned Song", track.id],
      ["New Song", null],
    ],
  );
  assert.match(tracks[0]?.owned?.streamPath ?? "", /^\/library\/stream\//);
});

test("adding the same Deezer playlist twice at once queues it only once", async (t: import("vite-plus/test").TestContext) => {
  stubDeezer(t, rockEssentials([deezerTrack("Paranoid", "Black Sabbath")]));
  const payloads = captureEnqueues();

  const [first, second] = await Promise.all([
    addEditorialPlaylistToLibrary(OWNER, "1306931615"),
    addEditorialPlaylistToLibrary(OWNER, "1306931615"),
  ]);

  assert.equal(payloads.length, 1);
  assert.equal(second.playlistId, first.playlistId);
});

test("duplicate Deezer tracks keep the preview and artwork of the first entry", async (t: import("vite-plus/test").TestContext) => {
  const first = {
    ...deezerTrack("Paranoid", "Black Sabbath"),
    id: 101,
    preview: "https://p/first.mp3",
    album: { id: 1, title: "Paranoid", cover_medium: "https://c/first.jpg" },
  };
  const later = {
    ...deezerTrack("Paranoid", "Black Sabbath"),
    id: 102,
    preview: "https://p/later.mp3",
    album: { id: 2, title: "Paranoid", cover_medium: "https://c/later.jpg" },
  };
  stubDeezer(t, rockEssentials([first, later]));

  const { tracks } = await getEditorialPlaylist(OWNER, "1306931615");

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].preview_url, "/api/deezer/preview/101.mp3");
  assert.equal(tracks[0].artworkUrl, "https://c/first.jpg");
  assert.equal(tracks[0].deezerAlbumId, "1");
});

test("a Deezer playlist whose name is taken gets a distinct library name", async (t: import("vite-plus/test").TestContext) => {
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  stubDeezer(t, rockEssentials([deezerTrack("Paranoid", "Black Sabbath")]));
  const payloads = captureEnqueues();
  flowPlaylistConfig.createStaticPlaylist({ name: "rock essentials", ownerUserId: 7 });

  const added = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  await processPlaylistOperation(v.parse(playlistOperationSchema, payloads[0]));

  assert.equal(
    flowPlaylistConfig.getStaticPlaylist(added.playlistId)?.name,
    "Rock Essentials (Deezer)",
  );
});

test("adding fails without creating anything when Deezer is unavailable", async (t: import("vite-plus/test").TestContext) => {
  stubDeezer(t, { "/playlist/1306931615": { status: 503, body: {} } });
  const payloads = captureEnqueues();

  await assert.rejects(addEditorialPlaylistToLibrary(OWNER, "1306931615"), { statusCode: 502 });
  await assert.rejects(addEditorialPlaylistToLibrary(OWNER, "../admin"), { statusCode: 400 });
  assert.equal(payloads.length, 0);
  assert.deepEqual(flowPlaylistConfig.getStaticPlaylistsOwnedByUser(7), []);
});

test("syncing a Deezer library playlist follows the editor's changes", async (t: import("vite-plus/test").TestContext) => {
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  stubDeezer(t, rockEssentials([deezerTrack("Thunderstruck", "AC/DC")]));
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Rock Essentials",
    ownerUserId: 7,
    tracks: [{ artistName: "AC/DC", trackName: "Back In Black" }],
    importSource: {
      provider: "deezer-playlist",
      externalId: "1306931615",
      syncEnabled: true,
      syncIntervalHours: 24,
      keepRemovedTracks: false,
    },
  });

  const result = await syncStaticPlaylistImport({
    playlistId: playlist.id,
    user: OWNER,
    force: true,
  });

  assert.equal(result.trackCount, 1);
  assert.deepEqual(
    flowPlaylistConfig.getStaticPlaylist(playlist.id)!.tracks.map((track) => track.trackName),
    ["Thunderstruck"],
  );
});

test("the shelf keeps categories that loaded, lists each playlist once, and drops thin ones", async (t: import("vite-plus/test").TestContext) => {
  const moods = "Rudy - Deezer Moods Editor";
  const requests = stubDeezer(t, {
    "/chart/0/playlists": {
      body: {
        data: [summary(1, "80s Hits"), summary(2, "Today's Hits"), summary(4, "Viral Hits")],
      },
    },
    "/chart/152/playlists": {
      body: {
        data: [
          summary(1, "80s Hits"),
          summary(3, "Rock Essentials"),
          summary(5, "Rock Ballads"),
          summary(6, "Classic Rock"),
          summary(7, "Rap Bangers"),
        ],
      },
    },
    "/chart/116/playlists": { body: { data: [summary(7, "Rap Bangers")] } },
    "/chart/132/playlists": { status: 500, body: {} },
    "/search/playlist": (url: URL) => ({
      body: {
        data:
          url.searchParams.get("q") === "chill"
            ? [
                summary(8, "Chill Vibes", moods),
                summary(9, "Evening Chill", moods),
                summary(10, "my chill mix", "someone"),
                summary(11, "Chill Lofi", moods),
              ]
            : [],
      },
    }),
  });

  const { categories, forYou } = await getEditorialShelf(OWNER);

  assert.deepEqual(
    categories.map((category) => [
      category.group,
      category.name,
      category.playlists.map((playlist) => playlist.name),
    ]),
    [
      ["genre", "Popular", ["80s Hits", "Today's Hits", "Viral Hits"]],
      ["genre", "Rock", ["Rock Essentials", "Rock Ballads", "Classic Rock", "Rap Bangers"]],
      ["mood", "Chill", ["Chill Vibes", "Evening Chill", "Chill Lofi"]],
    ],
  );
  assert.deepEqual([...forYou], []);

  const loaded = requests.length;
  const featured = await getEditorialShelf(OWNER, "featured");
  assert.deepEqual(
    featured.categories.map((category) => category.name),
    ["Popular"],
  );
  assert.equal(requests.length, loaded);

  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  const stale = await getEditorialShelf(OWNER, "featured");
  clock.mockRestore();
  assert.deepEqual(stale.categories, featured.categories);
  assert.deepEqual(requests.slice(loaded), ["/chart/0/playlists?limit=24"]);
});

test("For you matches Deezer editor playlists to the user's top genres and tags", async (t: import("vite-plus/test").TestContext) => {
  synchronizeDiscoveryCacheFromWorker({
    topGenres: ["Shoegaze"],
    topTags: ["shoegaze", "Post-Punk"],
  });
  t.onTestFinished(() => synchronizeDiscoveryCacheFromWorker({ topGenres: [], topTags: [] }));
  const searches: (string | null)[] = [];
  stubDeezer(t, {
    "/search/playlist": (url: URL) => {
      const query = url.searchParams.get("q");
      searches.push(query);
      if (query === "post-punk") return { status: 500, body: {} };
      return {
        body: {
          data: [
            summary(10, "Shoegaze Essentials", "Georges - Deezer Alternative Editor"),
            summary(11, "my shoegaze mix", "someone"),
            summary(12, "Dream Pop & Shoegaze", "Georges - Deezer Alternative Editor"),
            summary(13, "Nu Gaze", "Georges - Deezer Alternative Editor"),
          ],
        },
      };
    },
  });

  const { forYou, categories } = await getEditorialShelf(OWNER);

  assert.deepEqual(searches.sort(), ["post-punk", "shoegaze"]);
  assert.deepEqual(
    forYou.map((playlist) => playlist.name),
    ["Shoegaze Essentials", "Dream Pop & Shoegaze"],
  );
  assert.ok(categories.length > 0);
});

test("an album link without a Deezer album ID still finds the album", async () => {
  const artistMbid = "00000000-0000-4000-8000-000000000001";
  const albumMbid = "00000000-0000-4000-8000-000000000002";
  dbOps.setMusicbrainzArtistMbidCache("chart artist", artistMbid);
  dbOps.setDeezerMbidCache("aa:chart artist\0chart record", albumMbid);

  assert.deepEqual(
    await resolveEditorialTrackLinks({
      artistName: "Chart Artist",
      albumName: "Chart Record",
      deezerAlbumId: undefined,
    }),
    { artistMbid, albumMbid },
  );
});

test("flow templates keep their recipe and need history for Listening History", () => {
  synchronizeDiscoveryCacheFromWorker({ basedOn: [] });
  const available = Object.fromEntries(
    listFlowTemplates(OWNER).map((template) => [template.id, template.available]),
  );
  assert.equal(available["release-radar"], true);
  assert.equal(available["focus-listening-history"], false);
  assert.throws(() => buildFlowFromTemplate(OWNER, "focus-listening-history"), {
    statusCode: 400,
  });
  assert.throws(() => buildFlowFromTemplate(OWNER, "nope"), { statusCode: 400 });

  const radar = buildFlowFromTemplate(OWNER, "release-radar");
  const created = flowPlaylistConfig.createFlow({ ...radar, ownerUserId: 7 });
  assert.equal(flowPlaylistConfig.getFlow(created.id)!.discoverPresetId, "release-radar");
  assert.equal(flowPlaylistConfig.getFlow(created.id)!.mix.newReleases, 100);

  synchronizeDiscoveryCacheFromWorker({
    basedOn: [{ name: "Slowdive", source: "lastfm" }],
  });
  const history = buildFlowFromTemplate(OWNER, "focus-listening-history");
  assert.equal(history.recentListening, true);
  assert.deepEqual(history.relatedArtists, []);
  synchronizeDiscoveryCacheFromWorker({ basedOn: [] });
});

test("Listening History flows follow recent listening each time they run", async () => {
  const source = new FlowTrackSource();
  const seeds: string[] = [];
  source._getSimilarArtists = async (artist) => {
    seeds.push(artist);
    return [];
  };
  const flow = { ownerUserId: OWNER.id, recentListening: true, relatedArtists: ["Pinned"] };
  const context = { ownerUserId: OWNER.id };

  synchronizeDiscoveryCacheFromWorker({ basedOn: [{ name: "Slowdive", source: "lastfm" }] });
  await source.getFocusTracks(4, flow, context);
  synchronizeDiscoveryCacheFromWorker({ basedOn: [{ name: "Ride", source: "lastfm" }] });
  await source.getFocusTracks(4, flow, context);
  synchronizeDiscoveryCacheFromWorker({ basedOn: [] });

  assert.deepEqual(seeds, ["Pinned", "Slowdive", "Pinned", "Ride"]);
});
