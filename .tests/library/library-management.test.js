import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "library-management-state",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

const store = await import("../../backend/services/libraryManagementStore.js");
const libraryStore = await import("../../backend/services/libraryMediaStore.js");
const { buildLibraryReadModel } = await import(
  "../../backend/services/libraryReadModel.js"
);
const { getLibrary, getLibraryPage } = await import(
  "../../backend/services/libraryQueryService.js"
);
const { computeLibraryRootOverlaps } = await import(
  "../../backend/services/downloadFolderConfig.js"
);

test.before(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("manager state uses library ids and round-trips through the store", () => {
  store.setLibraryManagement({
    entityKind: "album",
    entityId: 7,
    managedBy: "aurral",
    monitorMode: "all",
  });
  assert.equal(store.getManagedBy("album", 7), "aurral");
  assert.equal(store.getManagedBy("album", "7"), "aurral");
  const { updatedAt, ...entry } = store.getLibraryManagementEntry("album", 7);
  assert.deepEqual(entry, { managedBy: "aurral", monitorMode: "all" });
  assert.ok(Number.isSafeInteger(updatedAt) && updatedAt > 0);

  store.setLibraryManagement({ entityKind: "album", entityId: 7, managedBy: "lidarr" });
  const { updatedAt: _updatedAt, ...changedEntry } = store.getLibraryManagementEntry("album", 7);
  assert.deepEqual(changedEntry, { managedBy: "lidarr", monitorMode: null });

  assert.equal(store.clearLibraryManagement("album", 7), true);
  assert.equal(store.getManagedBy("album", 7), null);
});

test("manager state written by another process is visible without a restart", async () => {
  const { default: Database } = await import("better-sqlite3");
  store.setLibraryManagement({ entityKind: "album", entityId: 11, managedBy: "lidarr" });
  assert.equal(store.getManagedBy("album", 11), "lidarr");
  assert.equal(store.getManagedBy("album", 12), null);

  const otherProcess = new Database(db.name);
  try {
    const now = Date.now() + 1;
    otherProcess.prepare(
      `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
       VALUES ('album', 12, 'aurral', 'monitored', ?, ?)`,
    ).run(now, now);
    assert.equal(store.getManagedBy("album", 12), "aurral");

    otherProcess.prepare(
      "UPDATE library_management SET monitor_mode = 'unmonitored', updated_at = ? WHERE entity_id = 12",
    ).run(now + 1);
    assert.equal(store.getLibraryManagementEntry("album", 12).monitorMode, "unmonitored");

    otherProcess.prepare(
      "UPDATE library_management SET monitor_mode = 'monitored' WHERE entity_id = 12",
    ).run();
    assert.equal(store.getLibraryManagementEntry("album", 12).monitorMode, "monitored");

    otherProcess.prepare("DELETE FROM library_management WHERE entity_id = 11").run();
    assert.equal(store.getManagedBy("album", 11), null);
  } finally {
    otherProcess.close();
    store.clearLibraryManagement("album", 12);
  }
});

test("manager state rejects invalid owners, kinds, and ids", () => {
  assert.throws(
    () => store.setLibraryManagement({ entityKind: "track", entityId: 1, managedBy: "aurral" }),
    /entity kind/i,
  );
  assert.throws(
    () => store.setLibraryManagement({ entityKind: "artist", entityId: 0, managedBy: "aurral" }),
    /entity id/i,
  );
  assert.throws(
    () => store.setLibraryManagement({ entityKind: "artist", entityId: 1, managedBy: "slskd" }),
    /manager/i,
  );
});

test("read model exposes managedBy and monitorMode without inventing values", () => {
  const library = {
    artists: [
      {
        id: 11,
        identityKey: "mbid:artist-managed",
        mbid: "artist-managed",
        name: "Managed Artist",
        albumIds: [21],
        sources: ["lidarr"],
        available: true,
        metadata: { monitored: true },
      },
      {
        id: 12,
        identityKey: "mbid:artist-open",
        mbid: "artist-open",
        name: "Open Artist",
        albumIds: [22],
        sources: ["aurral"],
        available: true,
        metadata: {},
      },
    ],
    albums: [
      {
        id: 21,
        identityKey: "rg:managed",
        artistId: 11,
        title: "Managed Album",
        trackIds: [31],
        sources: ["lidarr"],
        available: true,
        metadata: {},
      },
      {
        id: 22,
        identityKey: "rg:open",
        artistId: 12,
        title: "Open Album",
        trackIds: [32],
        sources: ["aurral"],
        available: true,
        metadata: {},
      },
    ],
    tracks: [
      { id: 31, mbid: "t31", title: "One", albums: [{ albumId: 21, trackNumber: 1 }], files: [], sources: ["lidarr"], available: true },
      { id: 32, mbid: "t32", title: "Two", albums: [{ albumId: 22, trackNumber: 1 }], files: [], sources: ["aurral"], available: true },
    ],
  };

  store.setLibraryManagement({
    entityKind: "artist",
    entityId: 11,
    managedBy: "lidarr",
    monitorMode: "all",
  });

  const model = buildLibraryReadModel(library);
  const managed = model.artists.find((a) => a.id === 11);
  const open = model.artists.find((a) => a.id === 12);
  assert.equal(managed.managedBy, "lidarr");
  assert.equal(managed.monitorMode, "all");
  assert.equal(open.managedBy, null);
  assert.equal(open.monitorMode, null);
  assert.equal(model.albums.find((a) => a.id === 21).managedBy, null);
});

test("library page cache reflects ownership changes without manual invalidation", () => {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:cache-artist",
    mbid: "cache-artist",
    name: "Cache Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "rg:cache-album",
    artistId: artist.id,
    title: "Cache Album",
    albumArtist: artist.name,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "rec:cache-track",
    mbid: "cache-track",
    title: "Cache Track",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    source: "aurral",
    path: "/library/Cache Artist/Cache Album/01 Cache Track.flac",
    format: "flac",
    available: true,
  });

  store.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "aurral" });
  const before = getLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(before.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, "aurral");

  store.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "lidarr" });
  const updated = getLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(updated.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, "lidarr");

  store.clearLibraryManagement("artist", artist.id);
  const cleared = getLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(cleared.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, null);
});

test("library cache reflects ownership changed by another connection", async () => {
  const { default: Database } = await import("better-sqlite3");
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:external-cache-artist",
    mbid: "external-cache-artist",
    name: "External Cache Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "rg:external-cache-album", artistId: artist.id, title: "External Cache Album",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "rec:external-cache-track", title: "External Cache Track",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  store.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "aurral", monitorMode: "all" });
  assert.equal(getLibrary().artists.find((entry) => entry.id === artist.id).monitorMode, "all");

  const otherConnection = new Database(db.name);
  try {
    otherConnection.prepare(
      "UPDATE library_management SET monitor_mode = 'none' WHERE entity_kind = 'artist' AND entity_id = ?",
    ).run(artist.id);
    assert.equal(getLibrary().artists.find((entry) => entry.id === artist.id).monitorMode, "none");
  } finally {
    otherConnection.close();
  }
});

test("root overlap warnings cover equal and nested roots without rejecting", () => {
  assert.deepEqual(
    computeLibraryRootOverlaps({ aurralRoot: "/data/media", lidarrRoots: ["/data/other"] }),
    [],
  );
  assert.deepEqual(computeLibraryRootOverlaps({ aurralRoot: "/data/media", lidarrRoots: [null, ""] }), []);

  const equal = computeLibraryRootOverlaps({
    aurralRoot: "/data/media/",
    lidarrRoots: ["/data/media"],
  });
  assert.equal(equal.length, 1);
  assert.equal(equal[0].type, "equal");
  assert.match(equal[0].message, /rename, import, or delete/);

  const nestedLidarr = computeLibraryRootOverlaps({
    aurralRoot: "/data/media",
    lidarrRoots: ["/data/media/music"],
  });
  assert.equal(nestedLidarr.length, 1);
  assert.equal(nestedLidarr[0].type, "nested-b-in-a");

  const nestedAurral = computeLibraryRootOverlaps({
    aurralRoot: "/data/media/music",
    lidarrRoots: ["/data/media"],
  });
  assert.equal(nestedAurral.length, 1);
  assert.equal(nestedAurral[0].type, "nested-a-in-b");

  const deduped = computeLibraryRootOverlaps({
    aurralRoot: "/data/media",
    lidarrRoots: ["/data/media", "/data/media"],
  });
  assert.equal(deduped.length, 1);

  const filesystemRoot = computeLibraryRootOverlaps({
    aurralRoot: "/",
    lidarrRoots: ["/music"],
  });
  assert.equal(filesystemRoot.length, 1);
  assert.equal(filesystemRoot[0].type, "nested-b-in-a");

  const driveRoot = computeLibraryRootOverlaps({
    aurralRoot: "C:/",
    lidarrRoots: ["C:/Music"],
  });
  assert.equal(driveRoot.length, 1);
  assert.equal(driveRoot[0].type, "nested-b-in-a");

  const driveRootEqual = computeLibraryRootOverlaps({
    aurralRoot: "C:/",
    lidarrRoots: ["C:/"],
  });
  assert.equal(driveRootEqual[0].type, "equal");

  const backslashRoot = computeLibraryRootOverlaps({
    aurralRoot: "C:\\music\\aurral",
    lidarrRoots: ["C:/music"],
  });
  assert.equal(backslashRoot.length, 1);
  assert.equal(backslashRoot[0].type, "nested-a-in-b");
});
