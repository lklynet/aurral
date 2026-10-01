import test from "node:test";
import assert from "node:assert/strict";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, managementStore, { lidarrClient }, { libraryManager }] =
  await setupIsolatedBackend(
    "lidarr-add-ownership",
    "backend/config/db-sqlite.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/services/lidarrClient.js",
    "backend/services/libraryManager.js",
  );

const artistMbid = "b1111111-1111-4111-8111-111111111111";
const albumMbid = "b2222222-2222-4222-8222-222222222201";
const lidarrArtist = {
  id: 41,
  artistName: "Owned Artist",
  foreignArtistId: artistMbid,
  monitored: true,
  monitor: "none",
};
const lidarrAlbum = {
  id: 91,
  artistId: 41,
  title: "Owned Album",
  foreignAlbumId: albumMbid,
  monitored: true,
};

const originalClient = { ...lidarrClient };

test.before(() => {
  lidarrClient.isConfigured = () => true;
  lidarrClient.request = async () => {
    throw new Error("Lidarr scan is not part of this test");
  };
  lidarrClient.addArtist = async () => lidarrArtist;
  lidarrClient.getArtist = async () => lidarrArtist;
  lidarrClient.getAlbumByMbid = async () => null;
  lidarrClient.addAlbum = async () => lidarrAlbum;
  lidarrClient.getAlbum = async () => lidarrAlbum;
});

test.beforeEach(() => {
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
});

test.after(async () => {
  Object.assign(lidarrClient, originalClient);
  await cleanupIsolatedState(isolatedState);
});

const ownerOf = (table, kind) => {
  const row = db.prepare(`SELECT id FROM ${table}`).get();
  return row ? managementStore.getLibraryManagementEntry(kind, row.id)?.managedBy ?? null : undefined;
};

test("a Lidarr artist add records Lidarr as the owner before any scan runs", async () => {
  const added = await libraryManager.addArtist(artistMbid, "Owned Artist", { managedBy: "lidarr" });
  assert.equal(added.error, undefined);
  assert.equal(ownerOf("library_artists", "artist"), "lidarr");
});

test("a Lidarr album add records Lidarr as the owner of the artist and the album", async () => {
  const added = await libraryManager.addAlbum("41", albumMbid, "Owned Album", { managedBy: "lidarr" });
  assert.equal(added.error, undefined);
  assert.equal(ownerOf("library_artists", "artist"), "lidarr");
  assert.equal(ownerOf("library_albums", "album"), "lidarr");
});

test("a Lidarr add leaves an artist Aurral already owns untouched", async () => {
  const seeded = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildIdentityKey("mbid", artistMbid),
    mbid: artistMbid,
    name: "Owned Artist",
  });
  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: seeded.id,
    managedBy: "aurral",
    monitorMode: "none",
  });

  await libraryManager.addArtist(artistMbid, "Owned Artist", { managedBy: "lidarr" });
  assert.equal(managementStore.getLibraryManagementEntry("artist", seeded.id).managedBy, "aurral");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_artists").get().n, 1);
});

test("an Aurral album add does not take over an album Lidarr just added", async () => {
  await libraryManager.addAlbum("41", albumMbid, "Owned Album", { managedBy: "lidarr" });
  const artist = db.prepare("SELECT id FROM library_artists").get();

  const result = await libraryManager.addAlbum(artist.id, albumMbid, "Owned Album", { managedBy: "aurral" });
  assert.equal(result.statusCode, 409);
  assert.equal(ownerOf("library_albums", "album"), "lidarr");
});
