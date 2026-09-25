import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { registerArtists },
  { registerAlbums },
  libraryStore,
  managementStore,
  { downloadTracker },
  { weeklyFlowWorker },
  { lidarrClient },
  { listHonkerJobs, getHonkerQueueByName },
  { processSystemTask },
  { clearMetadataProviderCaches },
] = await setupIsolatedBackend(
  "aurral-monitoring",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/routes/library/handlers/artists.js",
  "backend/routes/library/handlers/albums.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/lidarrClient.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
  "backend/services/providers/brainzmashProvider.js",
);

const artistMbid = "a1111111-1111-4111-8111-111111111111";
const releases = {
  firstAlbum: { id: "a2222222-2222-4222-8222-222222222201", title: "First Album", type: "Album", date: "2019-01-01" },
  secondAlbum: { id: "a2222222-2222-4222-8222-222222222202", title: "Second Album", type: "Album", date: "2021-06-01" },
  latestEp: { id: "a2222222-2222-4222-8222-222222222203", title: "Latest EP", type: "EP", date: "2022-03-01" },
  single: { id: "a2222222-2222-4222-8222-222222222204", title: "A Single", type: "Single", date: "2023-01-01" },
  live: { id: "a2222222-2222-4222-8222-222222222205", title: "Live Album", type: "Album", secondary: ["Live"], date: "2022-09-01" },
  bootleg: { id: "a2222222-2222-4222-8222-222222222206", title: "Bootleg Album", type: "Album", statuses: ["Bootleg"], date: "2022-10-01" },
};
const eligibleIds = [releases.firstAlbum.id, releases.secondAlbum.id, releases.latestEp.id];

const metadataState = { artistFails: false, extraReleases: [] };
const lidarrCalls = [];

function artistPayload() {
  return {
    id: artistMbid,
    artistname: "Monitor Artist",
    sortname: "Monitor Artist",
    Albums: [...Object.values(releases), ...metadataState.extraReleases].map((release) => ({
      Id: release.id,
      Title: release.title,
      Type: release.type,
      SecondaryTypes: release.secondary || [],
      ReleaseStatuses: release.statuses || ["Official"],
      FirstReleaseDate: release.date,
    })),
  };
}

function albumPayload(release) {
  return {
    id: release.id,
    title: release.title,
    type: release.type,
    artistid: artistMbid,
    artists: [{ id: artistMbid, artistname: "Monitor Artist" }],
    releasedate: release.date,
    releases: [{
      id: `${release.id}-release`,
      status: "Official",
      tracks: [1, 2].map((position) => ({
        id: `${release.id.slice(0, -2)}${String(position).padStart(2, "0")}-track`,
        recordingid: `${release.id.slice(0, 24)}b${release.id.slice(25, -2)}${String(position).padStart(2, "0")}`,
        trackname: `${release.title} Track ${position}`,
        trackposition: position,
        mediumnumber: 1,
        durationms: 180000,
      })),
    }],
  };
}

const metadataServer = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === `/artist/${artistMbid}`) {
    if (metadataState.artistFails) {
      response.writeHead(503);
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    response.end(JSON.stringify(artistPayload()));
    return;
  }
  const release = [...Object.values(releases), ...metadataState.extraReleases]
    .find((entry) => pathname === `/album/${entry.id}`);
  if (release) {
    response.end(JSON.stringify(albumPayload(release)));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not found" }));
});

const routes = new Map();
const route = (method) => (routePath, ...handlers) => {
  routes.set(`${method} ${routePath}`, handlers.at(-1));
};
const router = { get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") };
registerArtists(router);
registerAlbums(router);

async function callRoute(key, { params = {}, body = {}, query = {} } = {}) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    { params, body, query, user: { id: 1, role: "admin", permissions: {} } },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
    },
  );
  return response;
}

function queuedMonitoringTasks() {
  return listHonkerJobs("system-task")
    .map((job) => job.payload)
    .filter((payload) => payload?.kind === "aurral-monitoring-apply");
}

function clearMonitoringTasks() {
  const queue = getHonkerQueueByName("system-task");
  for (const job of listHonkerJobs("system-task")) queue?.cancel(job.id);
}

async function runQueuedMonitoringTasks() {
  const tasks = queuedMonitoringTasks();
  clearMonitoringTasks();
  for (const payload of tasks) await processSystemTask(payload);
  return tasks;
}

function queuedAlbumMbids() {
  return [...new Set(
    downloadTracker.getAll()
      .filter((job) => job.playlistType === "library" && job.managedBy === "aurral")
      .map((job) => job.albumMbid),
  )].sort();
}

const originalSettings = dbOps.getSettings();
const originalLidarr = {
  isConfigured: lidarrClient.isConfigured,
  request: lidarrClient.request,
  getArtist: lidarrClient.getArtist,
  getArtistByMbid: lidarrClient.getArtistByMbid,
};
const originalWorkerStart = weeklyFlowWorker.start;

test.before(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: metadataServer.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  lidarrClient.isConfigured = () => false;
  for (const method of ["request", "getArtist", "getArtistByMbid"]) {
    lidarrClient[method] = async (...args) => {
      lidarrCalls.push([method, ...args]);
      throw new Error("Lidarr must not be called");
    };
  }
  weeklyFlowWorker.start = async () => {};
});

test.beforeEach(() => {
  metadataState.artistFails = false;
  metadataState.extraReleases = [];
  clearMetadataProviderCaches();
  clearMonitoringTasks();
  downloadTracker.clearAll();
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  lidarrCalls.length = 0;
});

test.after(async () => {
  Object.assign(lidarrClient, originalLidarr);
  weeklyFlowWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

async function addAurralArtist(monitorOption = "none") {
  return callRoute("POST /artists", {
    body: {
      foreignArtistId: artistMbid,
      artistName: "Monitor Artist",
      monitorOption,
      managedBy: "aurral",
    },
  });
}

test("monitoring an Aurral artist queues every eligible album without Lidarr", async () => {
  const added = await addAurralArtist("all");
  assert.equal(added.statusCode, 201);
  assert.equal(added.body.artist.managedBy, "aurral");
  assert.deepEqual([...added.body.artist.monitoring.releaseGroupIds].sort(), [...eligibleIds].sort());

  const tasks = await runQueuedMonitoringTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(queuedAlbumMbids(), [...eligibleIds].sort());
  const groups = new Set(downloadTracker.getAll().map((job) => `${job.albumMbid}:${job.requestGroupId}`));
  assert.equal(groups.size, 3);

  await runQueuedMonitoringTasks();
  const monitoredAgain = await callRoute("PUT /artists/:mbid", {
    params: { mbid: artistMbid },
    body: { monitorOption: "all" },
  });
  assert.equal(monitoredAgain.statusCode, 200);
  await runQueuedMonitoringTasks();
  assert.equal(downloadTracker.getAll().length, 6);
  assert.equal(lidarrCalls.length, 0);
});

test("Aurral monitor modes select the matching releases and reject Lidarr-only modes", async () => {
  await addAurralArtist("none");
  assert.deepEqual(queuedMonitoringTasks(), []);

  const selections = {};
  for (const mode of ["latest", "first", "future", "missing", "none"]) {
    const response = await callRoute("PUT /artists/:mbid", {
      params: { mbid: artistMbid },
      body: { monitorOption: mode },
    });
    assert.equal(response.statusCode, 200, mode);
    assert.equal(response.body.monitorOption, mode, mode);
    selections[mode] = response.body.monitoring.releaseGroupIds;
  }
  assert.deepEqual(selections.latest, [releases.latestEp.id]);
  assert.deepEqual(selections.first, [releases.firstAlbum.id]);
  assert.deepEqual(selections.future, []);
  assert.deepEqual([...selections.missing].sort(), [...eligibleIds].sort());
  assert.deepEqual(selections.none, []);

  const rejected = await callRoute("PUT /artists/:mbid", {
    params: { mbid: artistMbid },
    body: { monitorOption: "existing" },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.code, "unsupported_monitor_mode");
  assert.equal(lidarrCalls.length, 0);
});

test("a metadata outage reports an error and keeps the previous monitor mode", async () => {
  const added = await addAurralArtist("none");
  metadataState.artistFails = true;
  clearMetadataProviderCaches();

  const response = await callRoute("PUT /artists/:mbid", {
    params: { mbid: artistMbid },
    body: { monitorOption: "all" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "metadata_unavailable");
  assert.equal(
    managementStore.getLibraryManagementEntry("artist", Number(added.body.artist.id)).monitorMode,
    "none",
  );
  assert.deepEqual(queuedMonitoringTasks(), []);
});

test("artist monitoring skips albums managed by Lidarr", async () => {
  const added = await addAurralArtist("none");
  const lidarrAlbum = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${releases.secondAlbum.id}`,
    mbid: releases.secondAlbum.id,
    releaseGroupMbid: releases.secondAlbum.id,
    artistId: Number(added.body.artist.id),
    title: releases.secondAlbum.title,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "recording:a3333333-3333-4333-8333-333333333333",
    mbid: "a3333333-3333-4333-8333-333333333333",
    title: "Lidarr Track",
    artistName: "Monitor Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: lidarrAlbum.id, trackId: track.id, trackNumber: 1 });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: lidarrAlbum.id, managedBy: "lidarr" });

  const response = await callRoute("PUT /artists/:mbid", {
    params: { mbid: artistMbid },
    body: { monitorOption: "all" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.monitoring.skipped, [
    { releaseGroupId: releases.secondAlbum.id, reason: "managed_by_lidarr" },
  ]);
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), [releases.firstAlbum.id, releases.latestEp.id].sort());
  assert.equal(lidarrCalls.length, 0);
});
