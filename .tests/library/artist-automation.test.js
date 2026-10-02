import test from "node:test";
import assert from "node:assert/strict";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, libraryStore, managementStore, { lidarrClient }, { libraryManager }] =
  await setupIsolatedBackend(
    "artist-automation",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/services/lidarrClient.js",
    "backend/services/libraryManager.js",
  );

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
    aurral: { inLibrary: true, mode: "future" },
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
