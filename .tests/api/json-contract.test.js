import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps, userOps }, { hashPassword }, { authMiddleware },
  { default: authRouter }, { default: healthRouter }, { default: discoveryRouter },
  { default: searchRouter }, { default: artistRouter }, { default: libraryRouter },
  { default: playlistRouter }, { default: requestsRouter }, libraryStore,
  { setLibraryManagement }, { reloadDiscoveryPersistedCache }, { getUserDiscoveryNamespace },
  { downloadTracker }, { downloadWorker }] = await setupIsolatedBackend(
  "json-contract", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/middleware/passwordHash.js", "backend/middleware/auth.js",
  "backend/routes/auth.js", "backend/routes/health.js", "backend/routes/discovery/index.js",
  "backend/routes/search.js", "backend/routes/artists/index.js", "backend/routes/library/index.js",
  "backend/routes/playlists/index.js", "backend/routes/requests.js", "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js", "backend/services/discovery/persistence.js",
  "backend/services/discovery/provider.js", "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWorker.js",
);

const artistMbid = "b471a869-025e-4e54-8429-566704380e36";
const albumMbid = "935aa404-893a-4ce5-9494-24c0058977e3";
const trackMbid = "df59c0af-9fd7-46b9-ae81-6db6bffce095";
const artistData = {
  id: artistMbid, artistname: "Contract Artist", genres: [], images: [],
  Albums: [{ Id: albumMbid, Title: "Contract Album", Type: "Album", ReleaseDate: "2026-01-01" }],
};
const albumData = {
  id: albumMbid, title: "Contract Album", type: "Album", releasedate: "2026-01-01",
  artists: [artistData], genres: [], images: [], releases: [],
};
let metadataServer;
let server;
let baseUrl;
let token;
let user;
let artist;
let album;

function fields(value, contract) {
  assert.ok(value && typeof value === "object");
  for (const [name, type] of Object.entries(contract)) {
    assert.ok(Object.hasOwn(value, name), `missing ${name}`);
    const actual = Array.isArray(value[name]) ? "array" : value[name] === null ? "null" : typeof value[name];
    assert.ok(type.split("|").includes(actual), `${name}: expected ${type}, got ${actual}`);
  }
}

async function call(route, { method = "GET", body, authenticated = true, status = 200 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method} ${route}`);
  return payload;
}

async function hold(trackName) {
  const stagingPath = path.join(state.baseDir, `${trackName}.flac`);
  await writeFile(stagingPath, "local review audio");
  const jobId = downloadTracker.addJob({ artistName: "Review Artist", trackName, albumName: "Review Album" }, "library");
  downloadTracker.setDownloading(jobId);
  downloadTracker.setBlocked(jobId, "Review required", stagingPath);
  return { jobId, stagingPath };
}

test.before(async () => {
  resetDatabase(db);
  metadataServer = await createMockHttpServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/search/artist")) return response.end(JSON.stringify([artistData]));
    if (request.url.startsWith("/search/album")) return response.end(JSON.stringify([albumData]));
    if (request.url === `/artist/${artistMbid}`) return response.end(JSON.stringify(artistData));
    if (request.url === `/album/${albumMbid}`) return response.end(JSON.stringify(albumData));
    response.writeHead(404).end(JSON.stringify({ error: "Unknown fixture" }));
  });
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "test", authPassword: "password" },
      metadata: { baseUrl: metadataServer.url, enableNarrowFallbacks: false },
    },
    security: { localNetworkBypass: { enabled: false } },
    playlistArtwork: { style: "aurral" },
  });
  user = userOps.createUser("test", hashPassword("password"), "admin");
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "discovery-fixture", name: "Discovery Artist", scoreTotal: 1 }],
    globalTop: [{ id: "trending-fixture", name: "Trending Artist" }],
    lastUpdated: new Date().toISOString(),
  });
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "discovery-fixture", name: "Discovery Artist", scoreTotal: 1 }],
    lastUpdated: new Date().toISOString(),
  }, getUserDiscoveryNamespace(user.id));
  reloadDiscoveryPersistedCache();
  artist = libraryStore.upsertLibraryArtist({ identityKey: "contract:artist", mbid: artistMbid, name: artistData.artistname });
  album = libraryStore.upsertLibraryAlbum({ identityKey: "contract:album", releaseGroupMbid: albumMbid, artistId: artist.id, title: albumData.title });
  const track = libraryStore.upsertLibraryTrack({ identityKey: "contract:track", mbid: trackMbid, title: "Contract Song", artistName: artist.name });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  const mediaPath = path.join(state.baseDir, "media", "Contract Song.flac");
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, "local owned audio");
  libraryStore.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: mediaPath });
  setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "aurral", monitorMode: "none" });
  setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral", monitorMode: "all" });
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  for (const [route, router] of [
    ["auth", authRouter], ["health", healthRouter], ["discover", discoveryRouter],
    ["search", searchRouter], ["artists", artistRouter], ["library", libraryRouter],
    ["playlists", playlistRouter], ["requests", requestsRouter],
  ]) app.use(`/api/${route}`, router);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await call("/api/auth/login", { method: "POST", body: { username: "test", password: "password" }, authenticated: false });
  fields(login, { token: "string", expiresAt: "number", user: "object" });
  fields(login.user, { id: "number", username: "string", role: "string", permissions: "object" });
  token = login.token;
});

test.after(async () => {
  await downloadWorker.stopAndDrain();
  await new Promise((resolve) => server?.close(resolve));
  await metadataServer?.close();
  await cleanupIsolatedState(state);
});

test("sign-in, bootstrap, and identity preserve their public response fields", async () => {
  const bootstrap = await call("/api/health/bootstrap", { authenticated: false });
  fields(bootstrap, { status: "string", authRequired: "boolean", onboardingRequired: "boolean", appVersion: "string", api: "object" });
  fields(bootstrap.api, { version: "number", features: "array" });
  for (const feature of ["discover", "flows", "activity", "review", "trackDownloads", "appPasswords"]) {
    assert.ok(bootstrap.api.features.includes(feature), `missing implemented capability ${feature}`);
  }
  const signedIn = await call("/api/health/bootstrap");
  fields(signedIn.user, { id: "number", username: "string", role: "string", permissions: "object" });
  assert.deepEqual(signedIn.api, bootstrap.api);
  const identity = await call("/api/auth/me");
  fields(identity, { user: "object", expiresAt: "number" });
  fields(identity.user, { id: "number", username: "string", role: "string", permissions: "object" });
  fields(await call("/api/auth/login", { method: "POST", body: { username: "test", password: "wrong" }, authenticated: false, status: 401 }), { error: "string" });
});

test("discovery, search, artist details, and release details preserve their public response fields", async () => {
  const discovery = await call("/api/discover?limit=10");
  fields(discovery, { recommendations: "array", recommendationCount: "number", globalTop: "array", basedOn: "array", topTags: "array", topGenres: "array", lastUpdated: "string|null", configured: "boolean", provider: "string" });
  assert.ok(discovery.recommendations.length);
  fields(discovery.recommendations[0], { id: "string|null", name: "string", type: "string", image: "string|null", tags: "array" });
  assert.ok(discovery.globalTop.length);
  fields(discovery.globalTop[0], { id: "string|null", name: "string", type: "string", image: "string|null", tags: "array" });
  const search = await call("/api/search?q=Contract&scope=artist");
  fields(search, { scope: "string", query: "string", count: "number", offset: "number", items: "array" });
  assert.equal(search.items[0].id, artistMbid);
  fields(search.items[0], { type: "string", id: "string", name: "string", image: "string|null", tags: "array", inLibrary: "boolean" });
  const albumSearch = await call("/api/search?q=Contract&scope=album");
  fields(albumSearch, { scope: "string", query: "string", count: "number", offset: "number", items: "array" });
  fields(albumSearch.items[0], { id: "string", title: "string", artistName: "string", type: "string", status: "string", inLibrary: "boolean" });
  const details = await call(`/api/artists/${artistMbid}?mode=core&artistName=Contract%20Artist`);
  fields(details, { id: "string", name: "string", tags: "array", genres: "array", "release-groups": "array", "appears-on-release-groups": "array" });
  assert.equal(details.id, artistMbid);
  assert.equal(details["release-groups"][0].id, albumMbid);
  fields(details["release-groups"][0], { id: "string", title: "string", "primary-type": "string", "secondary-types": "array", "first-release-date": "string|null" });
  const release = await call(`/api/artists/release-group/${albumMbid}`);
  fields(release, { id: "string", title: "string", "primary-type": "string", "secondary-types": "array", "first-release-date": "string|null", "artist-credit": "array", releases: "array", genres: "array", overview: "string", coverUrl: "string|null" });
  assert.equal(release.id, albumMbid);
});

test("library pages, lookups, album requests, and track requests preserve their public response fields", async () => {
  const page = await call("/api/library/canonical?kind=tracks&pageSize=10&availableOnly=true");
  fields(page, { kind: "string", page: "number", pageSize: "number", total: "number", hasMore: "boolean", items: "array", artists: "array", albums: "array", tracks: "array", genres: "array" });
  assert.ok(page.items.length);
  fields(page.items[0], { id: "number", identityKey: "string", mbid: "string|null", title: "string", artistName: "string", files: "array" });
  assert.equal(page.items[0].mbid, trackMbid);
  for (const [kind, name] of [["artists", "name"], ["albums", "title"]]) {
    const collection = await call(`/api/library/canonical?kind=${kind}&pageSize=10&availableOnly=true`);
    fields(collection, { kind: "string", page: "number", pageSize: "number", total: "number", hasMore: "boolean", items: "array", artists: "array", albums: "array", tracks: "array", genres: "array" });
    fields(collection.items[0], { id: "number", identityKey: "string", [name]: "string" });
  }
  fields(await call("/api/library/canonical?kind=genres&pageSize=10"), { kind: "string", page: "number", pageSize: "number", total: "number", hasMore: "boolean", items: "array", artists: "array", albums: "array", tracks: "array", genres: "array" });
  const lookup = await call(`/api/library/lookup/${artistMbid}`);
  fields(lookup, { exists: "boolean", artist: "object|null", albums: "array", canonical: "boolean", libraryArtistId: "string|null" });
  assert.equal(lookup.exists, true);
  const artists = await call("/api/library/lookup/batch", { method: "POST", body: { mbids: [artistMbid, "absent"] } });
  assert.deepEqual(artists, { [artistMbid]: true, absent: false });
  const albums = await call("/api/library/albums/lookup/batch", { method: "POST", body: { mbids: [albumMbid] } });
  fields(albums[albumMbid], { inLibrary: "boolean", libraryAlbumId: "string|null", libraryArtistId: "string|null", status: "string", monitored: "boolean", trackCount: "number", trackFileCount: "number", ownedTrackMbids: "array" });
  assert.deepEqual(albums[albumMbid].ownedTrackMbids, [trackMbid]);
  const requested = await call("/api/library/albums/request", { method: "POST", status: 201, body: {
    albumMbid, albumName: album.title, artistMbid, artistName: artist.name, managedBy: "aurral",
  } });
  fields(requested, { success: "boolean", artist: "object", album: "object", createdArtist: "boolean", createdAlbum: "boolean", status: "string", managedBy: "string", queued: "boolean" });
  assert.equal(requested.success, true);
  assert.equal(requested.queued, false);
  const owned = await call("/api/library/downloads/track", { method: "POST", body: { artistName: artist.name, trackName: "Contract Song", trackMbid } });
  assert.deepEqual(owned, { success: true, alreadyOwned: true, queued: false });
  const pendingId = downloadTracker.addJob({ artistName: "Pending Artist", trackName: "Pending Song" }, "library");
  const queued = await call("/api/library/downloads/track", { method: "POST", status: 202, body: { artistName: "Pending Artist", trackName: "Pending Song" } });
  fields(queued, { success: "boolean", queued: "boolean", jobId: "string", alreadyQueued: "boolean" });
  assert.equal(queued.jobId, pendingId);
});

test("flows, activity, and review preserve their public response fields and stored outcomes", async () => {
  const created = await call("/api/playlists/flows", { method: "POST", body: { name: "Contract Flow", size: 10, scheduleDays: [1], scheduleTime: "09:00", mix: { discover: 100, mix: 0, trending: 0, focus: 0 } } });
  fields(created, { success: "boolean", flow: "object" });
  fields(created.flow, { id: "string", name: "string", size: "number", enabled: "boolean", ownerUserId: "number", mix: "object" });
  const status = await call("/api/playlists/status");
  fields(status, { flows: "array", sharedPlaylists: "array", stats: "object", flowStats: "object", worker: "object", hint: "object" });
  assert.ok(status.flows.some((flow) => flow.id === created.flow.id));
  const denied = await hold("Denied Song");
  const approved = await hold("Approved Song");
  const jobs = await call("/api/playlists/jobs?status=blocked");
  assert.ok(jobs.some((job) => job.id === denied.jobId));
  fields(jobs[0], { id: "string", status: "string", artistName: "string", trackName: "string", playlistType: "string", streamFormat: "string|null" });
  const activity = await call("/api/requests?refresh=1");
  assert.ok(activity.length);
  fields(activity[0], { id: "string", kind: "string|null", status: "string", title: "string", artistName: "string|null", trackName: "string|null" });
  assert.equal((await call(`/api/playlists/jobs/${denied.jobId}/deny`, { method: "POST" })).success, true);
  assert.equal(downloadTracker.getJob(denied.jobId).status, "pending");
  assert.equal(await stat(denied.stagingPath).catch(() => null), null);
  await downloadWorker.stopAndDrain();
  const approval = await call(`/api/playlists/jobs/${approved.jobId}/approve`, { method: "POST" });
  fields(approval, { success: "boolean", path: "string" });
  assert.equal(downloadTracker.getJob(approved.jobId).status, "done");
  assert.ok((await stat(approval.path)).isFile());
  fields(await call("/api/playlists/jobs/missing/approve", { method: "POST", status: 404 }), { error: "string" });
});
