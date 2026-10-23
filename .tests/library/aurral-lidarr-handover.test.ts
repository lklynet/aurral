import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "node:path";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, libraryStore, managementStore, { lidarrClient }, { libraryManager }] =
  await setupIsolatedBackend(
    "aurral-lidarr-handover",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/libraryManagementStore.ts"),
    () => import("../../backend/services/lidarrClient.ts"),
    () => import("../../backend/services/libraryManager.ts"),
  );

const artistMbid = "e1111111-1111-4111-8111-111111111111";
const albumMbid = "e2222222-2222-4222-8222-222222222222";
const trackMbid = "e3333333-3333-4333-8333-333333333333";
const lidarrArtist = {
  id: 41,
  artistName: "Handover Artist",
  foreignArtistId: artistMbid,
  monitored: true,
};
const lidarrAlbum = {
  id: 91,
  artistId: 41,
  title: "Handover Album",
  foreignAlbumId: albumMbid,
  monitored: true,
};
const originalClient = { ...lidarrClient };

beforeAll(() => {
  lidarrClient.isConfigured = () => true;
  lidarrClient.request = async () => {
    throw new Error("Lidarr scans are not part of this test");
  };
  lidarrClient.getArtistByMbid = async () => lidarrArtist;
  lidarrClient.getArtist = async () => lidarrArtist;
  lidarrClient.getAlbumByMbid = async () => undefined;
  lidarrClient.addAlbum = async () => lidarrAlbum;
  lidarrClient.getAlbum = async () => lidarrAlbum;
});

beforeEach(() => {
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_media_files").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
});

afterAll(async () => {
  Object.assign(lidarrClient, originalClient);
  await cleanupIsolatedState(isolatedState);
});

function seedAlbum({
  monitored,
  monitorMode,
}: {
  monitored: boolean;
  monitorMode: NonNullable<
    Parameters<typeof managementStore.setLibraryManagement>[0]
  >["monitorMode"];
}) {
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
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
    monitorMode,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: "Single",
    artistName: "Handover Artist",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    scanId: undefined,
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
    user: { id: 1, username: "test", role: "admin", permissions: {} },
  });

test("downloading a single's album with Lidarr hands the album to Lidarr and stops Aurral's track monitoring", async () => {
  const { album, track } = seedAlbum({ monitored: false, monitorMode: null });

  await requestFromLidarr();

  assert.equal(managementStore.getManagedBy("album", album.id), "lidarr");
  assert.equal(
    db
      .prepare<
        unknown[],
        { monitored: import("../../backend/db/rows.ts").LibraryTracksRow["monitored"] }
      >("SELECT monitored FROM library_tracks WHERE id = ?")
      .get(track.id)!.monitored,
    0,
  );
  const metadata = JSON.parse(
    db
      .prepare<
        unknown[],
        { metadata_json: import("../../backend/db/rows.ts").LibraryAlbumsRow["metadata_json"] }
      >("SELECT metadata_json FROM library_albums WHERE id = ?")
      .get(album.id)!.metadata_json!,
  );
  assert.equal(typeof metadata.aurralHandoverAt, "number");
});

test("adding an Aurral album to Lidarr directly hands it to Lidarr too", async () => {
  const { album } = seedAlbum({ monitored: true, monitorMode: "monitored" });

  const added = await libraryManager.addAlbum(
    String(lidarrArtist.id),
    albumMbid,
    "Handover Album",
    {
      managedBy: "lidarr",
      user: { id: 1, username: "test", role: "admin", permissions: {} },
    },
  );

  assert.equal(added?.error, undefined);
  assert.equal(managementStore.getManagedBy("album", album.id), "lidarr");
});

test("a Lidarr album in the Library is removed from Lidarr by its MusicBrainz ID", async () => {
  const deleted: (string | number | boolean | undefined)[][] = [];
  lidarrClient.getAlbumByMbid = async (mbid) => (mbid === albumMbid ? lidarrAlbum : undefined);
  lidarrClient.deleteAlbum = async (id, deleteFiles) => {
    deleted.push([id, deleteFiles]);
  };

  const removed = await libraryManager.deleteLidarrAlbumByMbid(albumMbid, true);
  const unknown = await libraryManager.deleteLidarrAlbumByMbid(
    "e9999999-9999-4999-8999-999999999999",
    true,
  );

  assert.equal(removed.success, true);
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(deleted, [[lidarrAlbum.id, true]]);
});
