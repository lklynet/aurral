import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  playlistConfigModule,
  operationsModule,
  operationQueueModule,
  workerModule,
  trackerModule,
  importSyncModule,
  editorialModule,
  persistenceModule,
  flowTemplatesModule,
] = await setupIsolatedBackend(
  "editorial-playlists",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/weeklyFlow/weeklyFlowOperationQueue.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/importLists/importListSync.js",
  "backend/services/discovery/editorialPlaylists.js",
  "backend/services/discovery/persistence.js",
  "backend/services/weeklyFlow/flowTemplates.js",
);

const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { processWeeklyFlowOperation } = operationsModule;
const { weeklyFlowOperationQueue } = operationQueueModule;
const { weeklyFlowWorker } = workerModule;
const { downloadTracker } = trackerModule;
const { syncSharedPlaylistImport } = importSyncModule;
const {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  getEditorialShelf,
} = editorialModule;

const { synchronizeDiscoveryCacheFromWorker } = persistenceModule;
const { buildFlowFromTemplate, listFlowTemplates } = flowTemplatesModule;

const OWNER = { id: 7 };
const summary = (id, title, curator = "Rod - Deezer Rock Editor") => ({
  id,
  title,
  nb_tracks: 50,
  picture_xl: `https://img/${id}.jpg`,
  user: { name: curator },
});

const deezerTrack = (title, artist, album = "Album") => ({
  title,
  artist: { name: artist },
  album: { title: album },
  duration: 200,
  preview: `https://cdnt-preview.dzcdn.net/${encodeURIComponent(title)}.mp3`,
});

function stubDeezer(t, routes) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) {
      return new Response(JSON.stringify({ error: { type: "DataException", code: 800 } }));
    }
    const { status = 200, body } = typeof route === "function" ? route(url) : route;
    return new Response(JSON.stringify(body), { status });
  });
  return requests;
}

const rockEssentials = (tracks) => ({
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

const captureEnqueues = (t) => {
  const payloads = [];
  t.mock.method(weeklyFlowOperationQueue, "enqueuePayload", async (payload) => {
    payloads.push(payload);
    return { queued: true, operationId: payloads.length };
  });
  return payloads;
};

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true, flows: [], sharedPlaylists: [] });
  invalidateFlowPlaylistConfigCache();
});

test.afterEach(() => {
  weeklyFlowWorker.stop();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("adding a Deezer playlist creates one synced library playlist with its tracks", async (t) => {
  t.mock.method(weeklyFlowWorker, "start", async () => false);
  stubDeezer(t, rockEssentials([
    deezerTrack("Back In Black", "AC/DC"),
    deezerTrack("Back In Black", "AC/DC"),
    deezerTrack("Paranoid", "Black Sabbath"),
    { title: "", artist: { name: "Nobody" } },
  ]));
  const payloads = captureEnqueues(t);

  const added = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  assert.equal(payloads.length, 1);
  await processWeeklyFlowOperation(payloads[0]);

  const playlist = flowPlaylistConfig.getSharedPlaylist(added.playlistId);
  assert.equal(playlist.name, "Rock Essentials");
  assert.equal(playlist.ownerUserId, 7);
  assert.equal(playlist.description, "The rock songs everyone should know.");
  assert.deepEqual(
    playlist.tracks.map((track) => `${track.artistName} - ${track.trackName} (${track.albumName})`),
    ["AC/DC - Back In Black (Album)", "Black Sabbath - Paranoid (Album)"],
  );
  assert.equal(playlist.importSource.provider, "deezer-playlist");
  assert.equal(playlist.importSource.externalId, "1306931615");
  assert.equal(playlist.importSource.syncEnabled, true);
  assert.equal(playlist.importSource.keepRemovedTracks, true);

  const again = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  assert.equal(again.alreadyAdded, true);
  assert.equal(again.playlistId, added.playlistId);
  assert.equal(payloads.length, 1);
  assert.equal((await getEditorialPlaylist(OWNER, "1306931615")).libraryPlaylistId, added.playlistId);
  assert.equal((await getEditorialPlaylist({ id: 8 }, "1306931615")).libraryPlaylistId, null);
});

test("a Deezer playlist whose name is taken gets a distinct library name", async (t) => {
  t.mock.method(weeklyFlowWorker, "start", async () => false);
  stubDeezer(t, rockEssentials([deezerTrack("Paranoid", "Black Sabbath")]));
  const payloads = captureEnqueues(t);
  flowPlaylistConfig.createSharedPlaylist({ name: "rock essentials", ownerUserId: 7 });

  const added = await addEditorialPlaylistToLibrary(OWNER, "1306931615");
  await processWeeklyFlowOperation(payloads[0]);

  assert.equal(flowPlaylistConfig.getSharedPlaylist(added.playlistId)?.name, "Rock Essentials (Deezer)");
});

test("adding fails without creating anything when Deezer is unavailable", async (t) => {
  stubDeezer(t, { "/playlist/1306931615": { status: 503, body: {} } });
  const payloads = captureEnqueues(t);

  await assert.rejects(addEditorialPlaylistToLibrary(OWNER, "1306931615"), { statusCode: 502 });
  await assert.rejects(addEditorialPlaylistToLibrary(OWNER, "../admin"), { statusCode: 400 });
  assert.equal(payloads.length, 0);
  assert.deepEqual(flowPlaylistConfig.getSharedPlaylistsOwnedByUser(7), []);
});

test("syncing a Deezer library playlist follows the editor's changes", async (t) => {
  t.mock.method(weeklyFlowWorker, "start", async () => false);
  stubDeezer(t, rockEssentials([deezerTrack("Thunderstruck", "AC/DC")]));
  const playlist = flowPlaylistConfig.createSharedPlaylist({
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

  const result = await syncSharedPlaylistImport({ playlistId: playlist.id, user: OWNER, force: true });

  assert.equal(result.trackCount, 1);
  assert.deepEqual(
    flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks.map((track) => track.trackName),
    ["Thunderstruck"],
  );
});

test("the shelf keeps genres that loaded and lists each playlist once", async (t) => {
  stubDeezer(t, {
    "/chart/0/playlists": { body: { data: [summary(1, "80s Hits"), summary(2, "Today's Hits")] } },
    "/chart/152/playlists": { body: { data: [summary(1, "80s Hits"), summary(3, "Rock Essentials")] } },
    "/chart/132/playlists": { status: 500, body: {} },
  });

  const { genres, forYou } = await getEditorialShelf(OWNER);

  assert.deepEqual(
    genres.map((genre) => [genre.name, genre.playlists.map((playlist) => playlist.name)]),
    [
      ["Popular", ["80s Hits", "Today's Hits"]],
      ["Rock", ["Rock Essentials"]],
    ],
  );
  assert.deepEqual(forYou, []);
});

test("For you matches Deezer editor playlists to the user's top genres and tags", async (t) => {
  synchronizeDiscoveryCacheFromWorker({ topGenres: ["Shoegaze"], topTags: ["shoegaze", "Post-Punk"] });
  t.after(() => synchronizeDiscoveryCacheFromWorker({ topGenres: [], topTags: [] }));
  const searches = [];
  stubDeezer(t, {
    "/search/playlist": (url) => {
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

  const { forYou, genres } = await getEditorialShelf(OWNER);

  assert.deepEqual(searches.sort(), ["post-punk", "shoegaze"]);
  assert.deepEqual(forYou.map((playlist) => playlist.name), ["Shoegaze Essentials", "Dream Pop & Shoegaze"]);
  assert.ok(genres.length > 0);
});

test("flow templates keep their recipe and need history for Listening History", async () => {
  synchronizeDiscoveryCacheFromWorker({ basedOn: [] });
  const available = Object.fromEntries(
    (await listFlowTemplates(OWNER)).map((template) => [template.id, template.available]),
  );
  assert.equal(available["release-radar"], true);
  assert.equal(available["focus-listening-history"], false);
  await assert.rejects(buildFlowFromTemplate(OWNER, "focus-listening-history"), { statusCode: 400 });
  await assert.rejects(buildFlowFromTemplate(OWNER, "nope"), { statusCode: 400 });

  const radar = await buildFlowFromTemplate(OWNER, "release-radar");
  assert.equal(radar.discoverPresetId, "release-radar");
  const created = flowPlaylistConfig.createFlow({ ...radar, ownerUserId: 7 });
  assert.equal(flowPlaylistConfig.getFlow(created.id).discoverPresetId, "release-radar");

  synchronizeDiscoveryCacheFromWorker({
    basedOn: [
      { name: "Library Artist", source: "library" },
      { name: "Slowdive", source: "lastfm" },
      { name: "Ride", source: "local" },
    ],
  });
  const history = await buildFlowFromTemplate(OWNER, "focus-listening-history");
  assert.deepEqual(history.relatedArtists, ["Slowdive", "Ride"]);
  synchronizeDiscoveryCacheFromWorker({ basedOn: [] });
});

test("retired Last.fm editorial flows keep their tracks and never run again", async (t) => {
  const plan = t.mock.method(weeklyFlowWorker, "prepareFlowRunPlan", async () => ({
    primaryTracks: [{ artistName: "New Artist", trackName: "New Song" }],
    reserveTracks: [],
  }));
  const dueFlow = (id, extra = {}) => ({
    id,
    name: id,
    enabled: true,
    size: 20,
    nextRunAt: Date.now() - 60_000,
    ...extra,
  });
  dbOps.updateSettings({
    integrations: {
      lastfm: { apiKey: "test-key" },
      deemix: { enabled: true, url: "http://deemix.invalid", bitrate: 1 },
    },
    flows: [
      dueFlow("metal-mayhem", { type: "editorial", tag: "metal", discoverPresetId: "top-metal" }),
      dueFlow("discover-weekly"),
    ],
  });
  invalidateFlowPlaylistConfigCache();
  downloadTracker.addJobs([{ artistName: "Old Artist", trackName: "Old Song" }], "metal-mayhem");

  assert.deepEqual(flowPlaylistConfig.getDueForRefresh().map((flow) => flow.id), ["discover-weekly"]);

  for (const kind of ["manual-start-flow", "enable-flow-refresh", "scheduled-flow-refresh"]) {
    await processWeeklyFlowOperation({ kind, flowId: "metal-mayhem" });
  }

  assert.equal(plan.mock.callCount(), 0);
  assert.deepEqual(
    downloadTracker.getByPlaylistId("metal-mayhem").map((job) => job.trackName),
    ["Old Song"],
  );
});
