import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, managementStore, { lidarrClient }, { libraryManager }] =
  await setupIsolatedBackend(
    "aurral-lidarr-handover",
    "backend/config/db-sqlite.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/services/lidarrClient.js",
    "backend/services/libraryManager.js",
  );

const artistMbid = "e1111111-1111-4111-8111-111111111111";
const albumMbid = "e2222222-2222-4222-8222-222222222222";
const trackMbid = "e3333333-3333-4333-8333-333333333333";
const lidarrArtist = { id: 41, artistName: "Handover Artist", foreignArtistId: artistMbid, monitored: true };
const lidarrAlbum = { id: 91, artistId: 41, title: "Handover Album", foreignAlbumId: albumMbid, monitored: true };
const originalClient = { ...lidarrClient };

test.before(() => {
  lidarrClient.isConfigured = () => true;
  lidarrClient.request = async () => {
    throw new Error("Lidarr scans are not part of this test");
  };
  lidarrClient.getArtistByMbid = async () => lidarrArtist;
  lidarrClient.getArtist = async () => lidarrArtist;
  lidarrClient.getAlbumByMbid = async () => null;
  lidarrClient.addAlbum = async () => lidarrAlbum;
  lidarrClient.getAlbum = async () => lidarrAlbum;
});

test.beforeEach(() => {
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_media_files").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
});

test.after(async () => {
  Object.assign(lidarrClient, originalClient);
  await cleanupIsolatedState(isolatedState);
});

function seedAlbum({ monitored, monitorMode }) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Handover Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: "Handover Album",
    metadata: { monitored },
  });
  managementStore.setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral", monitorMode });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: "Single",
    artistName: "Handover Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: path.join(isolatedState.dataDir, "music", "Single.flac"),
  });
  return { album, track };
}

const requestFromLidarr = () =>
  libraryManager.requestAlbumFromSearch({
    albumMbid,
    albumName: "Handover Album",
    artistMbid,
    artistName: "Handover Artist",
    managedBy: "lidarr",
    user: { role: "admin" },
  });

test("downloading a single's album with Lidarr hands the album to Lidarr and stops Aurral's track monitoring", async () => {
  const { album, track } = seedAlbum({ monitored: false, monitorMode: null });

  await requestFromLidarr();

  assert.equal(managementStore.getManagedBy("album", album.id), "lidarr");
  assert.equal(db.prepare("SELECT monitored FROM library_tracks WHERE id = ?").get(track.id).monitored, 0);
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM library_albums WHERE id = ?").get(album.id).metadata_json);
  assert.equal(typeof metadata.aurralHandoverAt, "number");
});

test("an album you chose for Aurral stays Aurral's and Lidarr is not asked to add it", async () => {
  const { album } = seedAlbum({ monitored: true, monitorMode: "monitored" });
  let lidarrAdds = 0;
  lidarrClient.addAlbum = async () => {
    lidarrAdds += 1;
    return lidarrAlbum;
  };

  await assert.rejects(requestFromLidarr(), (error) => error.statusCode === 409);

  assert.equal(managementStore.getManagedBy("album", album.id), "aurral");
  assert.equal(lidarrAdds, 0);
});
