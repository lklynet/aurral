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
  { default: axios },
  { registerArtists },
  { registerAlbums },
  { registerMonitoring },
  libraryStore,
  managementStore,
  monitoringStore,
  { downloadTracker },
  { downloadWorker },
  { lidarrClient },
  { listHonkerJobs, getHonkerQueueByName },
  { processSystemTask },
  { clearMetadataProviderCaches },
  { libraryManager },
] = await setupIsolatedBackend(
  "aurral-monitoring",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "lib/axiosFetch.js",
  "backend/routes/library/handlers/artists.js",
  "backend/routes/library/handlers/albums.js",
  "backend/routes/library/handlers/monitoring.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/aurralMonitoringStore.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
  "backend/services/lidarrClient.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
  "backend/services/providers/brainzmashProvider.js",
  "backend/services/libraryManager.js",
);

const artistMbid = "a1111111-1111-4111-8111-111111111111";
const otherArtistMbid = "a4444444-4444-4444-8444-444444444444";
const releases = {
  firstAlbum: { id: "a2222222-2222-4222-8222-222222222201", title: "First Album", type: "Album", date: "2019-01-01" },
  secondAlbum: { id: "a2222222-2222-4222-8222-222222222202", title: "Second Album", type: "Album", date: "2021-06-01" },
  latestEp: { id: "a2222222-2222-4222-8222-222222222203", title: "Latest EP", type: "EP", date: "2022-03-01" },
  single: { id: "a2222222-2222-4222-8222-222222222204", title: "A Single", type: "Single", date: "2023-01-01" },
  live: { id: "a2222222-2222-4222-8222-222222222205", title: "Live Album", type: "Album", secondary: ["Live"], date: "2022-09-01" },
  bootleg: { id: "a2222222-2222-4222-8222-222222222206", title: "Bootleg Album", type: "Album", statuses: ["Bootleg"], date: "2022-10-01" },
};
const defaultIds = [releases.firstAlbum.id, releases.secondAlbum.id, releases.latestEp.id];

const metadataState = { artistFails: false, extraReleases: [], otherReleases: [], albumGate: null, artistGate: null };
const lidarrCalls = [];

function artistPayload(mbid = artistMbid) {
  const artistReleases = mbid === artistMbid
    ? [...Object.values(releases), ...metadataState.extraReleases]
    : metadataState.otherReleases;
  return {
    id: mbid,
    artistname: mbid === artistMbid ? "Monitor Artist" : "Other Artist",
    sortname: mbid === artistMbid ? "Monitor Artist" : "Other Artist",
    Albums: artistReleases.map((release) => ({
      Id: release.id,
      Title: release.title,
      Type: release.type,
      SecondaryTypes: release.secondary || [],
      ReleaseStatuses: release.statuses || ["Official"],
      FirstReleaseDate: release.date,
    })),
  };
}

const recordingId = (release, position) =>
  `b${release.id.slice(1, 24)}${release.id.slice(-4)}000000${String(position).padStart(2, "0")}`;

function pressing(release, suffix, trackCount) {
  const source = release.sharesWith || release;
  return {
    id: `${release.id}-${suffix}`,
    status: "Official",
    tracks: Array.from({ length: trackCount }, (_, index) => index + 1).map((position) => ({
      id: `${release.id}-${suffix}-${position}`,
      recordingid: recordingId(source, position),
      trackname: `${source.title} Track ${position}`,
      trackposition: position,
      mediumnumber: 1,
      durationms: 180000,
    })),
  };
}

function albumPayload(release) {
  const owner = release.artistMbid || artistMbid;
  return {
    id: release.id,
    title: release.title,
    type: release.type,
    artistid: owner,
    artists: [{ id: owner, artistname: owner === artistMbid ? "Monitor Artist" : "Other Artist" }],
    releasedate: release.date,
    releases: release.deluxe
      ? [pressing(release, "cd", 2), pressing(release, "digital", 2), pressing(release, "deluxe", 4), pressing(release, "box", 9)]
      : [pressing(release, "release", 2)],
  };
}

const metadataServer = await createMockHttpServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === `/artist/${artistMbid}`) {
    if (metadataState.artistFails) {
      response.writeHead(503);
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    if (metadataState.artistGate) {
      metadataState.artistGate.started();
      await metadataState.artistGate.release;
    }
    response.end(JSON.stringify(artistPayload()));
    return;
  }
  if (pathname === `/artist/${otherArtistMbid}`) {
    response.end(JSON.stringify(artistPayload(otherArtistMbid)));
    return;
  }
  const release = [...Object.values(releases), ...metadataState.extraReleases, ...metadataState.otherReleases]
    .find((entry) => pathname === `/album/${entry.id}`);
  if (release) {
    if (metadataState.albumGate) {
      metadataState.albumGate.started();
      await metadataState.albumGate.release;
    }
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
registerMonitoring(router);

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
      set() {
        return this;
      },
      setHeader() {},
    },
  );
  return response;
}

function systemTasks(kind) {
  return listHonkerJobs("system-task")
    .map((job) => job.payload)
    .filter((payload) => payload?.kind === kind);
}

const queuedMonitoringTasks = () => systemTasks("aurral-monitoring-apply");

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
      .filter((job) => job.playlistType === "library" && job.managedBy === "aurral" && job.albumMbid)
      .map((job) => job.albumMbid),
  )].sort();
}

const queuedTrackTitles = () =>
  downloadTracker.getAll()
    .filter((job) => job.playlistType === "library" && !job.albumMbid)
    .map((job) => job.trackName)
    .sort();

const artistRow = (mbid = artistMbid) => db.prepare("SELECT id, metadata_json FROM library_artists WHERE mbid = ?").get(mbid);

const storedMonitoring = (mbid = artistMbid) =>
  managementStore.getLibraryManagementEntry("artist", artistRow(mbid).id)?.monitorRules ?? null;

const originalSettings = dbOps.getSettings();
const originalLidarr = {
  isConfigured: lidarrClient.isConfigured,
  request: lidarrClient.request,
  getArtist: lidarrClient.getArtist,
  getArtistByMbid: lidarrClient.getArtistByMbid,
};
const originalWorkerStart = downloadWorker.start;

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
  downloadWorker.start = async () => {};
});

test.beforeEach(() => {
  metadataState.artistFails = false;
  metadataState.extraReleases = [];
  metadataState.otherReleases = [];
  metadataState.albumGate = null;
  metadataState.artistGate = null;
  clearMetadataProviderCaches();
  clearMonitoringTasks();
  downloadTracker.clearAll();
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  db.prepare("DELETE FROM library_monitoring_exclusions").run();
  db.prepare("DELETE FROM settings WHERE key = 'monitoringDefaults'").run();
  managementStore.invalidateLibraryManagementCache();
  lidarrCalls.length = 0;
});

test.after(async () => {
  Object.assign(lidarrClient, originalLidarr);
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

async function addAurralArtist(monitorOption = "none", { mbid = artistMbid, name = "Monitor Artist" } = {}) {
  return callRoute("POST /artists", {
    body: { foreignArtistId: mbid, artistName: name, monitorOption, managedBy: "aurral" },
  });
}

const monitorWith = (monitoring, mbid = artistMbid) =>
  callRoute("PUT /artists/:mbid", { params: { mbid }, body: { monitoring } });

const customRules = (rules) => ({ monitored: true, useDefault: false, rules });

test("monitoring an Aurral artist with the default rules queues its studio albums and EPs without Lidarr", async () => {
  const added = await callRoute("POST /artists", {
    body: { foreignArtistId: artistMbid, artistName: "Monitor Artist", managedBy: "aurral", monitoring: { monitored: true } },
  });
  assert.equal(added.statusCode, 201);
  assert.equal(added.body.artist.managedBy, "aurral");
  assert.equal(added.body.artist.monitored, true);
  assert.equal(added.body.artist.useDefault, true);
  assert.deepEqual(added.body.artist.monitoring.releaseGroupIds, defaultIds);

  const tasks = await runQueuedMonitoringTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(queuedAlbumMbids(), [...defaultIds].sort());
  const groups = new Set(downloadTracker.getAll().map((job) => `${job.albumMbid}:${job.requestGroupId}`));
  assert.equal(groups.size, 3);

  const monitoredAgain = await monitorWith({ monitored: true });
  assert.equal(monitoredAgain.statusCode, 200);
  await runQueuedMonitoringTasks();
  assert.equal(downloadTracker.getAll().length, 6);
  assert.equal(lidarrCalls.length, 0);
});

test("older clients' monitor options map onto rules and Lidarr-only options are refused", async () => {
  await addAurralArtist("none");
  assert.deepEqual(queuedMonitoringTasks(), []);

  const latest = await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: "latest" } });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body.useDefault, false);
  assert.equal(latest.body.monitorOption, "latest");
  assert.deepEqual(latest.body.monitoring.releaseGroupIds, [releases.latestEp.id]);

  const future = await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: "future" } });
  assert.equal(future.body.monitored, true);
  assert.equal(future.body.rules.catalog, "none");
  assert.equal(future.body.rules.newReleases, true);
  assert.deepEqual(future.body.monitoring.releaseGroupIds, []);

  const all = await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: "all" } });
  assert.equal(all.body.useDefault, true);

  const none = await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: "none" } });
  assert.equal(none.body.monitored, false);
  assert.equal(storedMonitoring(), null);

  for (const mode of ["first", "existing", "missing"]) {
    const rejected = await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: mode } });
    assert.equal(rejected.statusCode, 400, mode);
    assert.equal(rejected.body.code, "unsupported_monitor_mode", mode);
  }
  assert.equal(lidarrCalls.length, 0);
});

test("custom rules choose release types and how much of the back catalogue to take", async () => {
  await addAurralArtist("none");

  const cases = [
    [{ types: ["album"], extraTypes: ["live"] }, [releases.firstAlbum.id, releases.secondAlbum.id, releases.live.id]],
    [{ catalog: "latest", latestCount: 2, types: ["album", "ep", "single"] }, [releases.latestEp.id, releases.single.id]],
    [{ catalog: "since", sinceYear: 2021 }, [releases.secondAlbum.id, releases.latestEp.id]],
  ];
  for (const [rules, expected] of cases) {
    const previous = storedMonitoring();
    const preview = await callRoute("POST /artists/:mbid/monitoring/preview", {
      params: { mbid: artistMbid }, body: { monitoring: customRules(rules) },
    });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(preview.body.monitoring.releaseGroupIds, expected, JSON.stringify(rules));
    assert.deepEqual(storedMonitoring(), previous);
    assert.deepEqual(queuedMonitoringTasks(), []);

    const saved = await monitorWith(customRules(rules));
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.body.monitoring.releaseGroupIds, expected, JSON.stringify(rules));
    assert.deepEqual(storedMonitoring().rules, saved.body.rules);
    clearMonitoringTasks();
  }

  const before = storedMonitoring();
  for (const rules of [{ types: [] }, { catalog: "none", newReleases: false }, { topTracks: 51 }, { types: ["boxset"] }]) {
    const rejected = await monitorWith(customRules(rules));
    assert.equal(rejected.statusCode, 400, JSON.stringify(rules));
    assert.equal(rejected.body.code, "invalid_monitor_rules", JSON.stringify(rules));
  }
  assert.deepEqual(storedMonitoring(), before);
});

test("a metadata outage reports an error and keeps the previous monitoring", async () => {
  await addAurralArtist("none");
  metadataState.artistFails = true;
  clearMetadataProviderCaches();

  const response = await monitorWith({ monitored: true });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "metadata_unavailable");
  assert.equal(storedMonitoring(), null);
  assert.deepEqual(queuedMonitoringTasks(), []);
});

test("adding an artist reports a metadata outage during monitoring", async () => {
  metadataState.artistFails = true;
  clearMetadataProviderCaches();
  const response = await addAurralArtist("all");
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "metadata_unavailable");
  assert.deepEqual(queuedMonitoringTasks(), []);
  assert.equal(storedMonitoring(), null);
  const metadata = JSON.parse(artistRow().metadata_json);
  assert.equal(metadata.monitored, false);
  assert.equal(metadata.monitorOption, "none");
});

test("the artist add service activates monitoring for an existing Aurral artist", async () => {
  await addAurralArtist("none");
  const artist = await libraryManager.addArtistWithResolvedOptions(artistMbid, "Monitor Artist", {
    managedBy: "aurral", monitoring: { monitored: true },
  });
  assert.equal(artist.monitored, true);
  assert.equal(storedMonitoring().default, true);
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), [...defaultIds].sort());
});

test("a later disable wins over an earlier artist monitoring request", async () => {
  await addAurralArtist("none");
  clearMetadataProviderCaches();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  metadataState.artistGate = { started: started.resolve, release: release.promise };

  const enable = monitorWith({ monitored: true });
  await started.promise;
  const disable = monitorWith({ monitored: false });
  release.resolve();
  try {
    await Promise.all([enable, disable]);
  } finally {
    metadataState.artistGate = null;
  }
  assert.equal(storedMonitoring(), null);
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), []);
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

  const response = await monitorWith({ monitored: true });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.monitoring.skipped, [
    { releaseGroupId: releases.secondAlbum.id, title: releases.secondAlbum.title, reason: "managed_by_lidarr" },
  ]);
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), [releases.firstAlbum.id, releases.latestEp.id].sort());
  assert.equal(lidarrCalls.length, 0);
});

test("a Lidarr album follow-up never reactivates an Aurral artist that shares its numeric id", async () => {
  const added = await addAurralArtist("none");
  const sharedId = String(added.body.artist.id);
  const stubbed = {
    isConfigured: lidarrClient.isConfigured,
    getArtist: lidarrClient.getArtist,
    getAlbum: lidarrClient.getAlbum,
  };
  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({ id: Number(sharedId), artistName: "Lidarr Artist", foreignArtistId: otherArtistMbid, monitored: true });
  lidarrClient.getAlbum = async () => ({ id: 9, artistId: Number(sharedId), title: "Lidarr Album", monitored: true });

  try {
    await libraryManager.ensureRequestedAlbumMonitoring(sharedId, "9");
    await runQueuedMonitoringTasks();
    assert.equal(storedMonitoring(), null);
    assert.deepEqual(queuedAlbumMbids(), []);

    lidarrClient.getArtist = async () => {
      throw new Error("Lidarr request failed with 503");
    };
    lidarrClient.getAlbum = lidarrClient.getArtist;
    await libraryManager.ensureRequestedAlbumMonitoring(sharedId, "9");
    await runQueuedMonitoringTasks();
    assert.equal(storedMonitoring(), null);
    assert.deepEqual(queuedAlbumMbids(), []);
  } finally {
    Object.assign(lidarrClient, stubbed);
  }
});

test("queued artist acquisition stops after monitoring is disabled or the rules change", async () => {
  await addAurralArtist("none");
  await monitorWith({ monitored: true });
  assert.ok(queuedMonitoringTasks().length > 0);
  await monitorWith({ monitored: false });
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), []);

  await monitorWith({ monitored: true });
  const [staleTask] = queuedMonitoringTasks();
  clearMonitoringTasks();
  await monitorWith(customRules({ types: ["ep"] }));
  await processSystemTask(staleTask);
  assert.deepEqual(queuedAlbumMbids(), []);
  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), [releases.latestEp.id]);
});

test("an artist disabled during metadata lookup does not acquire albums", async () => {
  await addAurralArtist("none");
  const monitoring = await monitorWith(customRules({ types: ["album"] }));
  assert.equal(monitoring.statusCode, 200);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  metadataState.albumGate = { started: started.resolve, release: release.promise };

  const task = queuedMonitoringTasks()[0];
  clearMonitoringTasks();
  const acquisition = processSystemTask(task);
  await started.promise;
  try {
    const disabled = await monitorWith({ monitored: false });
    assert.equal(disabled.statusCode, 200);
  } finally {
    release.resolve();
    await acquisition;
    metadataState.albumGate = null;
  }
  assert.deepEqual(queuedAlbumMbids(), []);
});

test("concurrent album disable and enable leaves the last choice active", async () => {
  await addAurralArtist("all");
  await runQueuedMonitoringTasks();
  const album = db.prepare("SELECT id FROM library_albums WHERE mbid = ?").get(releases.firstAlbum.id);
  const [disabled, enabled] = await Promise.all([
    callRoute("PUT /albums/aurral/:canonicalId", {
      params: { canonicalId: String(album.id) }, body: { monitored: false },
    }),
    callRoute("PUT /albums/aurral/:canonicalId", {
      params: { canonicalId: String(album.id) }, body: { monitored: true },
    }),
  ]);
  assert.equal(disabled.statusCode, 200);
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.body.monitored, true);
  assert.equal(managementStore.getLibraryManagementEntry("album", album.id).monitorMode, "monitored");
  assert.ok(downloadTracker.getAll().filter((job) => job.albumMbid === releases.firstAlbum.id).every((job) => job.status === "pending"));
});

test("an album override survives artist monitoring changes and unmonitoring keeps finished tracks", async () => {
  await addAurralArtist("none");
  await callRoute("PUT /artists/:mbid", { params: { mbid: artistMbid }, body: { monitorOption: "latest" } });
  await runQueuedMonitoringTasks();
  const albumJobs = () => downloadTracker.getAll().filter((job) => job.albumMbid === releases.latestEp.id);
  const [finishedJob, activeJob] = albumJobs();
  downloadTracker.setDone(finishedJob.id, "/aurral/Monitor Artist/Latest EP/01.flac", "Latest EP");
  const album = db.prepare("SELECT id FROM library_albums WHERE mbid = ?").get(releases.latestEp.id);

  const unmonitored = await callRoute("PUT /albums/aurral/:canonicalId", {
    params: { canonicalId: String(album.id) },
    body: { monitored: false },
  });
  assert.equal(unmonitored.statusCode, 200);
  assert.equal(unmonitored.body.monitored, false);
  assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM library_albums WHERE id = ?").get(album.id).metadata_json).monitored, false);
  assert.equal(downloadTracker.getJob(activeJob.id).status, "cancelled");
  assert.equal(downloadTracker.getJob(finishedJob.id).status, "done");

  const monitoredArtist = await monitorWith({ monitored: true });
  assert.deepEqual(monitoredArtist.body.monitoring.skipped, [
    { releaseGroupId: releases.latestEp.id, title: releases.latestEp.title, reason: "unmonitored" },
  ]);
  await runQueuedMonitoringTasks();
  assert.equal(downloadTracker.getJob(activeJob.id).status, "cancelled");
  assert.equal(albumJobs().length, 2);
  assert.equal(
    managementStore.getLibraryManagementEntry("album", album.id).monitorMode,
    "unmonitored",
  );

  const remonitored = await callRoute("PUT /albums/aurral/:canonicalId", {
    params: { canonicalId: String(album.id) },
    body: { monitored: true },
  });
  assert.equal(remonitored.statusCode, 200);
  assert.equal(remonitored.body.monitored, true);
  assert.equal(downloadTracker.getJob(activeJob.id).status, "pending");
  assert.equal(albumJobs().length, 2);

  const invalid = await callRoute("PUT /albums/aurral/:canonicalId", {
    params: { canonicalId: String(album.id) },
    body: { monitored: "yes" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(lidarrCalls.length, 0);
});

function futureDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test("daily reconciliation queues new releases once and keeps going past a failing artist", async () => {
  await addAurralArtist("all");
  await runQueuedMonitoringTasks();
  const initialJobs = downloadTracker.getAll().length;
  await callRoute("POST /artists", {
    body: {
      foreignArtistId: otherArtistMbid,
      artistName: "Other Artist",
      monitorOption: "future",
      managedBy: "aurral",
    },
  });
  assert.deepEqual(queuedMonitoringTasks(), []);

  const newRelease = {
    id: "a2222222-2222-4222-8222-222222222207",
    title: "New Album",
    type: "Album",
    date: futureDate(0),
  };
  const newSingle = { ...releases.single, id: "a2222222-2222-4222-8222-222222222208", title: "New Single" };
  const upcoming = {
    id: "a5555555-5555-4555-8555-555555555501",
    title: "Upcoming Album",
    type: "Album",
    date: futureDate(30),
    artistMbid: otherArtistMbid,
  };
  const olderRelease = { ...upcoming, id: "a5555555-5555-4555-8555-555555555502", title: "Older Album", date: "2020-01-01" };
  metadataState.extraReleases = [newRelease, newSingle];
  metadataState.otherReleases = [upcoming, olderRelease];
  clearMetadataProviderCaches();

  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.deepEqual(
    queuedAlbumMbids(),
    [...defaultIds, newRelease.id, upcoming.id].sort(),
  );
  const afterFirstRun = downloadTracker.getAll().length;
  assert.equal(afterFirstRun, initialJobs + 4);

  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.equal(downloadTracker.getAll().length, afterFirstRun);

  metadataState.artistFails = true;
  metadataState.otherReleases = [
    ...metadataState.otherReleases,
    { ...upcoming, id: "a5555555-5555-4555-8555-555555555503", title: "Another Upcoming", date: futureDate(60) },
  ];
  clearMetadataProviderCaches();
  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.ok(queuedAlbumMbids().includes("a5555555-5555-4555-8555-555555555503"));
  assert.equal(lidarrCalls.length, 0);
});

test("saving rules again keeps the cutoff for new releases while new releases stay on", async () => {
  const added = await addAurralArtist("future");
  assert.equal(added.statusCode, 201);
  const start = Date.now() - 3 * 24 * 60 * 60 * 1000;
  monitoringStore.setAurralArtistMonitoringState(artistRow().id, { ...storedMonitoring(), catalogAt: start, newSince: start });
  const newRelease = { id: "a5555555-5555-4555-8555-555555555555", title: "Recent Album", type: "Album", date: futureDate(-1) };
  metadataState.extraReleases = [newRelease];
  clearMetadataProviderCaches();

  assert.equal((await monitorWith(customRules({ catalog: "none", newReleases: true }))).statusCode, 200);
  assert.equal(storedMonitoring().newSince, start);
  assert.equal((await monitorWith(customRules({ catalog: "none", newReleases: true, types: ["album"] }))).statusCode, 200);
  assert.equal(storedMonitoring().newSince, start);
  assert.equal(JSON.parse(artistRow().metadata_json).monitorStartedAt, start);

  clearMonitoringTasks();
  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.deepEqual(queuedAlbumMbids(), [newRelease.id]);
});

test("Latest with new releases off keeps the same releases after the artist puts out another", async () => {
  await addAurralArtist("none");
  const saved = await monitorWith(customRules({ catalog: "latest", latestCount: 1, newReleases: false }));
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.monitored, true);
  assert.deepEqual(saved.body.monitoring.releaseGroupIds, [releases.latestEp.id]);
  await runQueuedMonitoringTasks();

  metadataState.extraReleases = [
    { id: "a2222222-2222-4222-8222-222222222209", title: "Newer EP", type: "EP", date: futureDate(1) },
  ];
  clearMetadataProviderCaches();
  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.deepEqual(queuedAlbumMbids(), [releases.latestEp.id]);
});

test("a release whose every song is already wanted is skipped, but studio albums never are", async () => {
  await addAurralArtist("none");
  const albumSingle = { id: "a2222222-2222-4222-8222-222222222210", title: "Album Single", type: "Single", date: "2021-05-01", sharesWith: releases.secondAlbum };
  const reissue = { id: "a2222222-2222-4222-8222-222222222211", title: "First Album Reissue", type: "Album", date: "2020-01-01", sharesWith: releases.firstAlbum };
  metadataState.extraReleases = [albumSingle, reissue];
  clearMetadataProviderCaches();

  const saved = await monitorWith(customRules({ types: ["album", "ep", "single"] }));
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.monitoring.releaseGroupIds, [
    releases.firstAlbum.id, reissue.id, releases.secondAlbum.id, releases.latestEp.id, releases.single.id,
  ]);
  assert.deepEqual(saved.body.monitoring.skipped, [
    { releaseGroupId: albumSingle.id, title: albumSingle.title, reason: "covered" },
  ]);
  await runQueuedMonitoringTasks();

  const singlesOnly = await monitorWith(customRules({ types: ["single"] }));
  assert.deepEqual(singlesOnly.body.monitoring.skipped, [
    { releaseGroupId: albumSingle.id, title: albumSingle.title, reason: "covered" },
  ]);
});

test("a deleted album stays out of monitoring until someone asks for it again", async () => {
  await addAurralArtist("none");
  await monitorWith({ monitored: true });
  await runQueuedMonitoringTasks();
  const album = db.prepare("SELECT id FROM library_albums WHERE mbid = ?").get(releases.secondAlbum.id);

  const removed = await callRoute("DELETE /albums/aurral/:canonicalId", { params: { canonicalId: String(album.id) } });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.excluded, true);
  downloadTracker.clearAll();

  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.deepEqual(queuedAlbumMbids(), []);
  const resaved = await monitorWith(customRules({ types: ["album"] }));
  assert.deepEqual(resaved.body.monitoring.skipped, [
    { releaseGroupId: releases.secondAlbum.id, title: releases.secondAlbum.title, reason: "excluded" },
  ]);

  const exclusions = await callRoute("GET /monitoring/exclusions", { query: { artistMbid } });
  assert.deepEqual(exclusions.body.map(({ kind, mbid, title }) => ({ kind, mbid, title })), [
    { kind: "album", mbid: releases.secondAlbum.id, title: releases.secondAlbum.title },
  ]);

  const requested = await callRoute("POST /albums/request", {
    body: {
      albumMbid: releases.secondAlbum.id,
      albumName: releases.secondAlbum.title,
      artistMbid,
      artistName: "Monitor Artist",
      managedBy: "aurral",
    },
  });
  assert.equal(requested.statusCode, 201, JSON.stringify(requested.body));
  assert.deepEqual((await callRoute("GET /monitoring/exclusions", { query: { artistMbid } })).body, []);
  assert.deepEqual(queuedAlbumMbids(), [releases.secondAlbum.id]);
});

test("allowing an excluded album again lets monitoring take it back", async () => {
  await addAurralArtist("none");
  await monitorWith(customRules({ types: ["album"] }));
  await runQueuedMonitoringTasks();
  const album = db.prepare("SELECT id FROM library_albums WHERE mbid = ?").get(releases.firstAlbum.id);
  await callRoute("DELETE /albums/aurral/:canonicalId", { params: { canonicalId: String(album.id) } });
  downloadTracker.clearAll();

  const [exclusion] = (await callRoute("GET /monitoring/exclusions", { query: { artistMbid } })).body;
  const allowed = await callRoute("DELETE /monitoring/exclusions/:id", { params: { id: String(exclusion.id) } });
  assert.equal(allowed.statusCode, 200);
  const missing = await callRoute("DELETE /monitoring/exclusions/:id", { params: { id: String(exclusion.id) } });
  assert.equal(missing.statusCode, 404);

  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.deepEqual(queuedAlbumMbids(), [releases.firstAlbum.id]);
});

test("changing the default rules re-applies them to the artists that use them", async () => {
  await addAurralArtist("none");
  await monitorWith({ monitored: true });
  await runQueuedMonitoringTasks();
  metadataState.otherReleases = [
    { id: "a5555555-5555-4555-8555-555555555504", title: "Other Single", type: "Single", date: "2020-01-01", artistMbid: otherArtistMbid },
  ];
  await addAurralArtist("none", { mbid: otherArtistMbid, name: "Other Artist" });
  await monitorWith(customRules({ catalog: "none", newReleases: true }), otherArtistMbid);
  clearMonitoringTasks();

  const current = await callRoute("GET /monitoring/defaults");
  assert.equal(current.body.artistCount, 1);
  assert.deepEqual(current.body.rules.types, ["album", "ep"]);

  const withSingles = { ...current.body.rules, types: ["album", "ep", "single"] };
  const preview = await callRoute("POST /monitoring/defaults/preview", { body: { rules: withSingles } });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(
    { artistCount: preview.body.artistCount, releaseCount: preview.body.releaseCount, failedArtistCount: preview.body.failedArtistCount },
    { artistCount: 1, releaseCount: 1, failedArtistCount: 0 },
  );
  assert.deepEqual(systemTasks("aurral-monitoring-reconcile"), []);

  const saved = await callRoute("PUT /monitoring/defaults", { body: { rules: withSingles } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.rules.types, ["album", "ep", "single"]);
  const [reconcile] = systemTasks("aurral-monitoring-reconcile");
  assert.ok(reconcile);
  clearMonitoringTasks();
  await processSystemTask(reconcile);
  assert.deepEqual(queuedAlbumMbids(), [...defaultIds, releases.single.id].sort());

  assert.equal((await callRoute("PUT /monitoring/defaults", { body: { rules: withSingles } })).statusCode, 200);
  assert.deepEqual(systemTasks("aurral-monitoring-reconcile"), []);

  const invalid = await callRoute("PUT /monitoring/defaults", { body: { rules: { types: [] } } });
  assert.equal(invalid.statusCode, 400);

  await callRoute("PUT /monitoring/defaults", { body: { rules: { ...withSingles, newReleases: false } } });
  const artistId = artistRow().id;
  assert.equal(managementStore.getLibraryManagementEntry("artist", artistId).monitorMode, "none");
  assert.equal(storedMonitoring().default, true);
  assert.equal(managementStore.getLibraryManagementEntry("artist", artistRow(otherArtistMbid).id).monitorMode, "future");
});

test("top tracks queue the artist's popular songs that monitored releases do not already bring", async (t) => {
  const deezerRequests = [];
  const topTracks = ["Second Album Track 1", "Hit Song", "Deleted Song", "Deep Cut"];
  const providerGet = axios.get.bind(axios);
  t.mock.method(axios, "get", async (url, options) => {
    if (!String(url).startsWith("https://api.deezer.com/")) return providerGet(url, options);
    deezerRequests.push(url);
    if (url === "https://api.deezer.com/search/artist") {
      return { data: { data: [{ id: 77, name: "Monitor Artist" }] } };
    }
    if (url === "https://api.deezer.com/artist/77/top") {
      return {
        data: {
          data: topTracks.slice(0, options.params.limit).map((title, index) => ({
            id: index + 1, title, duration: 200, rank: 1000 - index, album: { title: "Hits" },
          })),
        },
      };
    }
    throw new Error(`Unexpected Deezer request ${url}`);
  });
  await addAurralArtist("none");
  monitoringStore.addMonitoringExclusion({ kind: "track", artistMbid, artistName: "Monitor Artist", title: "Deleted Song" });

  const saved = await monitorWith(customRules({ catalog: "latest", latestCount: 1, types: ["album"], topTracks: 3 }));
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.monitoring.releaseGroupIds, [releases.secondAlbum.id]);
  assert.deepEqual(saved.body.monitoring.topTracks.map((track) => track.title), ["Hit Song"]);
  assert.deepEqual(saved.body.monitoring.skippedTracks, [
    { title: "Second Album Track 1", reason: "on_release" },
    { title: "Deleted Song", reason: "excluded" },
  ]);

  await runQueuedMonitoringTasks();
  assert.deepEqual(queuedAlbumMbids(), [releases.secondAlbum.id]);
  assert.deepEqual(queuedTrackTitles(), ["Hit Song"]);

  const jobCount = downloadTracker.getAll().length;
  await processSystemTask({ kind: "aurral-monitoring-reconcile" });
  assert.equal(downloadTracker.getAll().length, jobCount);
  assert.ok(deezerRequests.length > 0);
});

test("the expanded edition downloads the longer tracklist of an album", async () => {
  await addAurralArtist("none");
  const deluxe = { id: "a2222222-2222-4222-8222-222222222212", title: "Deluxe Album", type: "Album", date: "2024-02-02", deluxe: true };
  metadataState.extraReleases = [deluxe];
  clearMetadataProviderCaches();

  const saved = await monitorWith(customRules({ catalog: "latest", latestCount: 1, types: ["album"], edition: "expanded" }));
  assert.deepEqual(saved.body.monitoring.releaseGroupIds, [deluxe.id]);
  await runQueuedMonitoringTasks();
  const titles = downloadTracker.getAll().filter((job) => job.albumMbid === deluxe.id).map((job) => job.trackName).sort();
  assert.deepEqual(titles, [1, 2, 3, 4].map((position) => `Deluxe Album Track ${position}`));
});
