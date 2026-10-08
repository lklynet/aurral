import test from "node:test";
import assert from "node:assert/strict";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { lidarrClient },
  { libraryManager },
  { registerArtists },
  { registerAlbums },
  { downloadWorker },
] =
  await setupIsolatedBackend(
    "artist-automation",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/services/lidarrClient.js",
    "backend/services/libraryManager.js",
    "backend/routes/library/handlers/artists.js",
    "backend/routes/library/handlers/albums.js",
    "backend/services/downloadJobs/downloadWorker.js",
  );

const routes = new Map();
const route = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers.at(-1));
for (const register of [registerArtists, registerAlbums]) {
  register({ get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") });
}

async function callRoute(key, { params = {}, query = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: null };
  await routes.get(key)(
    { params, query, body, user: { role: "admin" } },
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

const artistMbid = "c1111111-1111-4111-8111-111111111111";
const aurralAlbumMbid = "c2222222-2222-4222-8222-222222222201";
const otherAlbumMbid = "c2222222-2222-4222-8222-222222222202";
const admin = { role: "admin" };

const lidarr = { configured: true, artist: null, albums: [], calls: [] };
const originalClient = { ...lidarrClient };

const lidarrAlbum = (id, foreignAlbumId, monitored) => ({
  id,
  artistId: 41,
  title: `Album ${id}`,
  foreignAlbumId,
  monitored,
  statistics: {},
});

const originalWorkerStart = downloadWorker.start;

test.before(() => {
  downloadWorker.start = async () => {};
  lidarrClient.isConfigured = () => lidarr.configured;
  lidarrClient.getArtistByMbid = async () => lidarr.artist;
  lidarrClient.getArtist = async () => lidarr.artist;
  lidarrClient.getMetadataProfiles = async () => [];
  lidarrClient.resolveArtistAddConfiguration = async () => ({
    resolved: { rootFolderPath: "/music", qualityProfileId: 1 },
  });
  lidarrClient.addArtist = async (mbid, artistName, options) => {
    lidarr.calls.push(["add", options.monitorOption]);
    const followsNewAlbums = options.monitorOption === "all" || options.monitorOption === "future";
    lidarr.artist = {
      id: 41,
      artistName,
      foreignArtistId: mbid,
      monitored: options.monitorOption !== "none",
      monitorNewItems: followsNewAlbums ? "all" : "none",
    };
    return lidarr.artist;
  };
  lidarrClient.updateArtistMonitoring = async (_id, option) => {
    lidarr.calls.push(["monitor", option]);
    lidarr.artist = {
      ...lidarr.artist,
      monitored: true,
      monitorNewItems: option === "all" || option === "future" ? "all" : "none",
    };
  };
  lidarrClient.request = async (path) => {
    if (path.startsWith("/album?artistId=")) return lidarr.albums;
    throw new Error("Lidarr scans are not part of this test");
  };
  lidarrClient.deleteArtist = async (id) => {
    lidarr.calls.push(["delete", id]);
    lidarr.artist = null;
  };
  lidarrClient.getAlbum = async (id) => lidarr.albums.find((album) => album.id === Number(id));
  lidarrClient.monitorAlbum = async (id, monitored) => {
    lidarr.albums.find((album) => album.id === Number(id)).monitored = monitored;
  };
});

test.beforeEach(() => {
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  Object.assign(lidarr, { configured: true, artist: null, albums: [], calls: [] });
});

test.after(async () => {
  downloadWorker.start = originalWorkerStart;
  Object.assign(lidarrClient, originalClient);
  await cleanupIsolatedState(isolatedState);
});

function seedArtist(managedBy, monitorMode) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildIdentityKey("mbid", artistMbid),
    mbid: artistMbid,
    name: "Automation Artist",
  });
  managementStore.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy, monitorMode });
  return artist;
}

function seedAurralAlbum(artistId) {
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${aurralAlbumMbid}`,
    mbid: aurralAlbumMbid,
    releaseGroupMbid: aurralAlbumMbid,
    artistId,
    title: "Album 1",
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral", monitorMode: "monitored" });
  const track = libraryStore.upsertLibraryTrack({ identityKey: "track:automation", title: "Track", artistName: "Automation Artist" });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  return { album, track };
}

const management = (entityKind, id) => {
  const entry = managementStore.getLibraryManagementEntry(entityKind, id);
  return [entry?.managedBy, entry?.monitorMode];
};

const lidarrArtist = (overrides = {}) => ({
  id: 41,
  artistName: "Automation Artist",
  foreignArtistId: artistMbid,
  monitored: true,
  monitorNewItems: "none",
  ...overrides,
});

test("with Lidarr connected, monitoring a Lidarr artist lets Lidarr take its Aurral albums", async () => {
  const artist = seedArtist("lidarr", "none");
  const { album, track } = seedAurralAlbum(artist.id);
  lidarr.artist = lidarrArtist({ monitored: false });
  lidarr.albums = [lidarrAlbum(1, aurralAlbumMbid, false), lidarrAlbum(2, otherAlbumMbid, false)];

  const result = await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "all", user: admin });

  assert.equal(result.error, undefined);
  assert.deepEqual(lidarr.calls, [["monitor", "all"]]);
  assert.deepEqual(management("artist", artist.id), ["lidarr", "all"]);
  assert.deepEqual(lidarr.albums.map((entry) => entry.monitored), [true, true]);
  assert.equal(management("album", album.id)[0], "lidarr");
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(track.id).monitored, 0);
});

test("an album stays Aurral's when Lidarr fails to monitor it", async () => {
  const artist = seedArtist("lidarr", "none");
  const { album, track } = seedAurralAlbum(artist.id);
  lidarr.artist = lidarrArtist({ monitored: false });
  lidarr.albums = [lidarrAlbum(1, aurralAlbumMbid, false)];
  const monitorAlbum = lidarrClient.monitorAlbum;
  lidarrClient.monitorAlbum = async () => {
    throw new Error("Lidarr rejected the album");
  };
  try {
    await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "all", user: admin });
  } finally {
    lidarrClient.monitorAlbum = monitorAlbum;
  }

  assert.equal(management("album", album.id)[0], "aurral");
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(track.id).monitored, 1);
});

test("with Lidarr connected, new artists go to Lidarr and Aurral keeps managing its own", async () => {
  const artist = seedArtist("aurral", "none");
  const { album } = seedAurralAlbum(artist.id);
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral", monitorMode: "unmonitored" });

  const add = await callRoute("POST /artists", {
    body: { foreignArtistId: artistMbid, artistName: "Automation Artist", managedBy: "aurral", monitorOption: "all" },
  });
  const future = await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "future", user: admin });
  const futureState = management("artist", artist.id);
  const none = await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "none", user: admin });
  const monitorAlbum = await libraryManager.setAurralAlbumMonitoring(album.id, { monitored: true });
  const request = (albumMbid) => libraryManager.requestAlbumFromSearch({
    albumMbid,
    albumName: "Album",
    artistMbid,
    artistName: "Automation Artist",
    managedBy: "aurral",
    user: admin,
  }).catch((error) => error);
  const retried = await request(aurralAlbumMbid);
  const newAlbum = await request(otherAlbumMbid);

  assert.notEqual(retried.statusCode, 409, retried.message);
  assert.equal(newAlbum.statusCode, 409);
  assert.equal(add.statusCode, 409);
  assert.equal(future.error, undefined);
  assert.deepEqual(futureState, ["aurral", "future"]);
  assert.equal(none.error, undefined);
  assert.deepEqual(management("artist", artist.id), ["aurral", "none"]);
  assert.notEqual(monitorAlbum.statusCode, 409);
  assert.deepEqual(management("album", album.id), ["aurral", "monitored"]);
  assert.deepEqual(lidarr.calls, []);
});

test("without Lidarr, Aurral monitors the artist and Lidarr is never asked", async () => {
  lidarr.configured = false;
  const neverAdded = "c3333333-3333-4333-8333-333333333333";

  const result = await libraryManager.setArtistMonitoring(artistMbid, {
    monitorOption: "future",
    artistName: "Automation Artist",
    user: admin,
  });
  const untouched = await libraryManager.setArtistMonitoring(neverAdded, {
    monitorOption: "none",
    artistName: "Never Added",
    user: admin,
  });
  const lidarrAdd = await callRoute("POST /artists", {
    body: { foreignArtistId: neverAdded, artistName: "Never Added", managedBy: "lidarr" },
  });

  assert.equal(result.error, undefined);
  const artistId = db.prepare("SELECT id FROM library_artists WHERE mbid = ?").get(artistMbid).id;
  assert.deepEqual(management("artist", artistId), ["aurral", "future"]);
  assert.equal(untouched.error, undefined);
  assert.equal(lidarrAdd.statusCode, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE mbid = ?").get(neverAdded).n, 0);
  assert.deepEqual(lidarr.calls, []);
});

test("an Aurral monitoring change that cannot load releases leaves the artist as it was", async () => {
  lidarr.configured = false;
  const artist = seedArtist("aurral", "none");

  const result = await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "all", user: admin });

  assert.equal(result.statusCode, 503);
  assert.deepEqual(management("artist", artist.id), ["aurral", "none"]);
});

test("the Lidarr option chosen in Aurral reads back until Lidarr changes", async () => {
  seedArtist("lidarr", "none");
  lidarr.artist = lidarrArtist();
  await libraryManager.setArtistMonitoring(artistMbid, { monitorOption: "future", user: admin });

  const chosen = await libraryManager.getArtist(artistMbid, { managedBy: "lidarr", forceRefresh: true });
  lidarr.artist = { ...lidarr.artist, monitorNewItems: "none" };
  const changedInLidarr = await libraryManager.getArtist(artistMbid, { managedBy: "lidarr", forceRefresh: true });

  assert.deepEqual([chosen.managedBy, chosen.monitorOption], ["lidarr", "future"]);
  assert.equal(changedInLidarr.monitorOption, "none");
});

test("the Lidarr option reads back for an artist Lidarr knows by another provider's ID", async () => {
  const addArtist = lidarrClient.addArtist;
  lidarrClient.addArtist = async (mbid, artistName, options) => {
    const added = await addArtist(mbid, artistName, options);
    lidarr.artist = { ...added, foreignArtistId: "1098@deezer" };
    return lidarr.artist;
  };
  try {
    await libraryManager.setArtistMonitoring(artistMbid, {
      monitorOption: "future",
      artistName: "Automation Artist",
      user: admin,
    });
  } finally {
    lidarrClient.addArtist = addArtist;
  }

  const state = await libraryManager.getArtistMonitoring(artistMbid);

  assert.deepEqual([state.added, state.monitorOption], [true, "future"]);
});

test("adding an artist through monitoring needs permission to add artists", async () => {
  const result = await libraryManager.setArtistMonitoring(artistMbid, {
    monitorOption: "all",
    artistName: "Automation Artist",
    user: { role: "user", permissions: { changeMonitoring: true } },
  });

  assert.equal(result.statusCode, 403);
  assert.deepEqual(lidarr.calls, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE mbid = ?").get(artistMbid).n, 0);
});

test("adding to Lidarr without monitoring overrides the default monitor option", async () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: { ...settings.integrations, lidarr: { ...settings.integrations?.lidarr, defaultMonitorOption: "all" } },
  });
  try {
    const chosen = await libraryManager.resolveArtistAddOptions({ managedBy: "lidarr", monitorOption: "none", user: admin });
    const defaulted = await libraryManager.resolveArtistAddOptions({ managedBy: "lidarr", user: admin });

    assert.deepEqual([chosen.monitorOption, defaulted.monitorOption], ["none", "all"]);
  } finally {
    dbOps.updateSettings(settings);
  }
});

test("the monitoring state reports only the manager in charge", async () => {
  const artist = seedArtist("lidarr", "none");

  const notInLidarr = await libraryManager.getArtistMonitoring(artistMbid);
  lidarr.artist = lidarrArtist({ monitorNewItems: "all" });
  const inLidarr = await libraryManager.getArtistMonitoring(artistMbid);
  managementStore.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "aurral", monitorMode: "future" });
  const aurral = await libraryManager.getArtistMonitoring(artistMbid);

  assert.deepEqual(notInLidarr, { manager: "lidarr", added: false, monitorOption: "none", inAurral: false, error: null });
  assert.deepEqual(inLidarr, { manager: "lidarr", added: true, monitorOption: null, inAurral: false, error: null });
  assert.deepEqual(aurral, { manager: "aurral", added: true, monitorOption: "future", inAurral: true, error: null });
});

test("deleting an artist removes it from Lidarr and Aurral together", async () => {
  const artist = seedArtist("aurral", "none");
  const { album } = seedAurralAlbum(artist.id);
  lidarr.artist = lidarrArtist();

  const response = await callRoute("DELETE /artists/:mbid", { params: { mbid: artistMbid } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(lidarr.calls, [["delete", 41]]);
  assert.equal(management("album", album.id)[0], undefined);
});

test("naming a manager removes only that side", async () => {
  const artist = seedArtist("aurral", "none");
  const { album } = seedAurralAlbum(artist.id);
  lidarr.artist = lidarrArtist();

  const fromLidarr = await callRoute("DELETE /artists/:mbid", { params: { mbid: artistMbid }, query: { manager: "lidarr" } });

  assert.equal(fromLidarr.statusCode, 200);
  assert.equal(management("album", album.id)[0], "aurral");
});

test("deleting an artist touches nothing when Lidarr cannot be reached", async () => {
  const artist = seedArtist("aurral", "none");
  const { album } = seedAurralAlbum(artist.id);
  const getArtistByMbid = lidarrClient.getArtistByMbid;
  lidarrClient.getArtistByMbid = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  try {
    const response = await callRoute("DELETE /artists/:mbid", { params: { mbid: artistMbid } });
    assert.equal(response.statusCode, 503);
  } finally {
    lidarrClient.getArtistByMbid = getArtistByMbid;
  }
  assert.equal(management("album", album.id)[0], "aurral");
});

test("removing from Lidarr while it is not connected is refused", async () => {
  lidarr.configured = false;
  seedArtist("lidarr", "none");

  const response = await callRoute("DELETE /artists/:mbid", { params: { mbid: artistMbid }, query: { manager: "lidarr" } });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(lidarr.calls, []);
});

test("a Lidarr artist's albums add Aurral's albums by MBID, never by number", async () => {
  const aurralArtist = seedArtist("aurral", "none");
  seedAurralAlbum(aurralArtist.id);
  lidarr.albums = [{ ...lidarrAlbum(7, otherAlbumMbid, true), artistId: aurralArtist.id }];
  const albumsOf = async (foreignArtistId) => {
    lidarr.artist = lidarrArtist({ id: aurralArtist.id, foreignArtistId });
    const response = await callRoute("GET /albums", { query: { artistId: String(aurralArtist.id), managedBy: "lidarr" } });
    return response.body.map((album) => album.mbid);
  };

  assert.deepEqual(await albumsOf("c4444444-4444-4444-8444-444444444444"), [otherAlbumMbid]);
  assert.deepEqual(await albumsOf(artistMbid), [otherAlbumMbid, aurralAlbumMbid]);
});

test("without Lidarr, removing an artist keeps the record Lidarr left behind", async () => {
  lidarr.configured = false;
  const artist = seedArtist("lidarr", "none");

  const result = await libraryManager.deleteArtist(artistMbid, false);

  assert.equal(result.success, true);
  assert.deepEqual(management("artist", artist.id), ["lidarr", "none"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE id = ?").get(artist.id).n, 1);
});

test("Lidarr monitoring defaults leave Lidarr alone when given Aurral's own album records", async () => {
  const artist = seedArtist("aurral", "none");
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${aurralAlbumMbid}`,
    mbid: aurralAlbumMbid,
    releaseGroupMbid: aurralAlbumMbid,
    artistId: artist.id,
    title: "Album 1",
  });
  const track = libraryStore.upsertLibraryTrack({ identityKey: "track:automation-fallback", title: "Track", artistName: "Automation Artist" });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  lidarr.albums = [lidarrAlbum(album.id, otherAlbumMbid, false)];
  const libraryAlbums = await libraryManager.getAlbums(artist.id, null, { managedBy: "aurral" });
  assert.equal(libraryAlbums[0].id, String(album.id));

  await libraryManager.applyArtistMonitoringDefaults(
    { id: "41", monitored: true, monitorOption: "all", managedBy: "lidarr" },
    libraryAlbums,
  );

  assert.equal(libraryAlbums.length, 1);
  assert.equal(lidarr.albums[0].monitored, false);
});
