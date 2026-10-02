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
  );

const routes = new Map();
const route = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers.at(-1));
registerArtists({ get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") });

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

const lidarr = { artist: null, albums: [], calls: [] };
const originalClient = { ...lidarrClient };

const lidarrAlbum = (id, foreignAlbumId, monitored) => ({
  id,
  artistId: 41,
  title: `Album ${id}`,
  foreignAlbumId,
  monitored,
  statistics: {},
});

test.before(() => {
  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtistByMbid = async () => lidarr.artist;
  lidarrClient.getArtist = async () => lidarr.artist;
  lidarrClient.getMetadataProfiles = async () => [];
  lidarrClient.resolveArtistAddConfiguration = async () => ({
    resolved: { rootFolderPath: "/music", qualityProfileId: 1 },
  });
  lidarrClient.addArtist = async (mbid, artistName, options) => {
    lidarr.calls.push(["add", options.monitorOption]);
    lidarr.artist = { id: 41, artistName, foreignArtistId: mbid, monitored: true, monitorNewItems: "none" };
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
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  Object.assign(lidarr, { artist: null, albums: [], calls: [] });
});

test.after(async () => {
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

const artistManagement = (artistId) => {
  const entry = managementStore.getLibraryManagementEntry("artist", artistId);
  return [entry?.managedBy, entry?.monitorMode];
};

test("choosing Aurral for a Lidarr artist stops Lidarr's automation and starts Aurral's", async () => {
  const artist = seedArtist("lidarr", "all");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "all" };

  const result = await libraryManager.setArtistAutomation(artistMbid, {
    manager: "aurral",
    monitorOption: "future",
    user: admin,
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(lidarr.calls, [["monitor", "none"]]);
  assert.deepEqual(artistManagement(artist.id), ["aurral", "future"]);
});

test("choosing Lidarr adds the artist and keeps Aurral's albums out of Lidarr's monitoring", async () => {
  const artist = seedArtist("aurral", "future");
  const aurralAlbum = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${aurralAlbumMbid}`,
    mbid: aurralAlbumMbid,
    releaseGroupMbid: aurralAlbumMbid,
    artistId: artist.id,
    title: "Album 1",
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: aurralAlbum.id, managedBy: "aurral" });
  lidarr.albums = [lidarrAlbum(1, aurralAlbumMbid, true), lidarrAlbum(2, otherAlbumMbid, false)];

  const result = await libraryManager.setArtistAutomation(artistMbid, {
    manager: "lidarr",
    monitorOption: "all",
    user: admin,
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(lidarr.calls, [["add", "none"], ["monitor", "all"]]);
  assert.deepEqual(artistManagement(artist.id), ["lidarr", "all"]);
  assert.deepEqual(lidarr.albums.map((album) => album.monitored), [false, true]);
});

test("the Lidarr option chosen in Aurral reads back until Lidarr changes", async () => {
  seedArtist("aurral", "none");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "none" };
  await libraryManager.setArtistAutomation(artistMbid, { manager: "lidarr", monitorOption: "future", user: admin });

  const chosen = await libraryManager.getArtist(artistMbid, { managedBy: "lidarr", forceRefresh: true });
  lidarr.artist = { ...lidarr.artist, monitorNewItems: "none" };
  const changedInLidarr = await libraryManager.getArtist(artistMbid, { managedBy: "lidarr", forceRefresh: true });

  assert.deepEqual([chosen.managedBy, chosen.monitorOption], ["lidarr", "future"]);
  assert.equal(changedInLidarr.monitorOption, "none");
});

test("turning monitoring off stops both managers", async () => {
  const artist = seedArtist("aurral", "future");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "all" };

  const result = await libraryManager.setArtistAutomation(artistMbid, { manager: null, user: admin });

  assert.equal(result.error, undefined);
  assert.deepEqual(lidarr.calls, [["monitor", "none"]]);
  assert.deepEqual(artistManagement(artist.id), ["aurral", "none"]);
});

test("a switch that would add the artist needs permission to add artists", async () => {
  const artist = seedArtist("aurral", "future");

  const result = await libraryManager.setArtistAutomation(artistMbid, {
    manager: "lidarr",
    monitorOption: "all",
    user: { role: "user", permissions: { changeMonitoring: true } },
  });

  assert.equal(result.statusCode, 403);
  assert.deepEqual(lidarr.calls, []);
  assert.deepEqual(artistManagement(artist.id), ["aurral", "future"]);
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

test("the monitoring state reports both managers and which one is active", async () => {
  seedArtist("aurral", "future");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitored: true, monitorNewItems: "none" };

  const aurralActive = await libraryManager.getArtistMonitoring(artistMbid);
  await libraryManager.setArtistAutomation(artistMbid, { manager: "lidarr", monitorOption: "all", user: admin });
  const lidarrActive = await libraryManager.getArtistMonitoring(artistMbid);

  assert.deepEqual(aurralActive, {
    aurral: { known: true, inLibrary: true, mode: "future" },
    lidarr: { available: true, inLidarr: true, monitorOption: "none", error: null },
    active: "aurral",
  });
  assert.deepEqual(
    [lidarrActive.active, lidarrActive.aurral.mode, lidarrActive.lidarr.monitorOption],
    ["lidarr", "none", "all"],
  );
});

test("removing an artist from Lidarr leaves its Aurral side alone", async () => {
  const artist = seedArtist("aurral", "none");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "none" };

  const result = await libraryManager.deleteArtist(artistMbid, false, { manager: "lidarr" });

  assert.equal(result.success, true);
  assert.deepEqual(lidarr.calls, [["delete", 41]]);
  assert.deepEqual(artistManagement(artist.id), ["aurral", "none"]);
});

test("None on one manager leaves the other manager and the artist's owner alone", async () => {
  const artist = seedArtist("aurral", "none");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "all" };

  await libraryManager.setArtistAutomation(artistMbid, { manager: "lidarr", monitorOption: "none", user: admin });
  const neverAurral = "c3333333-3333-4333-8333-333333333333";
  const untouched = await libraryManager.setArtistAutomation(neverAurral, {
    manager: "aurral",
    monitorOption: "none",
    artistName: "Never Aurral",
    user: admin,
  });

  assert.deepEqual(artistManagement(artist.id), ["aurral", "none"]);
  assert.deepEqual(lidarr.calls, [["monitor", "none"]]);
  assert.equal(untouched.error, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE mbid = ?").get(neverAurral).n, 0);
});

test("Lidarr keeps monitoring when Aurral cannot start monitoring the artist", async () => {
  const artist = seedArtist("lidarr", "all");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "all" };

  const result = await libraryManager.setArtistAutomation(artistMbid, { manager: "aurral", monitorOption: "all", user: admin });

  assert.equal(result.statusCode, 503);
  assert.deepEqual(lidarr.calls, []);
  assert.deepEqual(artistManagement(artist.id), ["lidarr", "all"]);
});

test("removing an artist with an unknown manager is refused and touches nothing", async () => {
  seedArtist("aurral", "none");
  lidarr.artist = { id: 41, artistName: "Automation Artist", foreignArtistId: artistMbid, monitorNewItems: "none" };

  for (const manager of ["aurral ", ["lidarr"], "both"]) {
    const response = await callRoute("DELETE /artists/:mbid", { params: { mbid: artistMbid }, query: { manager } });
    assert.equal(response.statusCode, 400, JSON.stringify(manager));
  }
  assert.deepEqual(lidarr.calls, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE mbid = ?").get(artistMbid).n, 1);
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
  const canonicalAlbums = await libraryManager.getAlbums(artist.id, null, { managedBy: "aurral" });
  assert.equal(canonicalAlbums[0].id, String(album.id));

  await libraryManager.applyArtistMonitoringDefaults(
    { id: "41", monitored: true, monitorOption: "all", managedBy: "lidarr" },
    canonicalAlbums,
  );

  assert.equal(canonicalAlbums.length, 1);
  assert.equal(lidarr.albums[0].monitored, false);
});

test("removing Aurral's side keeps a Lidarr artist's record", async () => {
  const artist = seedArtist("lidarr", "none");

  const result = await libraryManager.deleteArtist(artistMbid, false, { manager: "aurral" });

  assert.equal(result.success, true);
  assert.deepEqual(artistManagement(artist.id), ["lidarr", "none"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists WHERE id = ?").get(artist.id).n, 1);
});
