import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "library-management-state",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

const store = await import("../../backend/services/libraryManagementStore.js");
const libraryStore = await import("../../backend/services/libraryMediaStore.js");
const { buildCanonicalLibraryReadModel } = await import(
  "../../backend/services/canonicalLibraryReadAdapter.js"
);
const { getCanonicalLibraryPage } = await import(
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

test("manager state uses canonical ids and round-trips through the store", () => {
  store.setLibraryManagement({
    entityKind: "album",
    entityId: 7,
    managedBy: "aurral",
    monitorMode: "all",
  });
  assert.equal(store.getManagedBy("album", 7), "aurral");
  assert.equal(store.getManagedBy("album", "7"), "aurral");
  assert.deepEqual(store.getLibraryManagementEntry("album", 7), {
    managedBy: "aurral",
    monitorMode: "all",
  });

  store.setLibraryManagement({ entityKind: "album", entityId: 7, managedBy: "lidarr" });
  assert.deepEqual(store.getLibraryManagementEntry("album", 7), {
    managedBy: "lidarr",
    monitorMode: null,
  });

  assert.equal(store.clearLibraryManagement("album", 7), true);
  assert.equal(store.getManagedBy("album", 7), null);
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

  const model = buildCanonicalLibraryReadModel(library);
  const managed = model.artists.find((a) => a.id === 11);
  const open = model.artists.find((a) => a.id === 12);
  assert.equal(managed.managedBy, "lidarr");
  assert.equal(managed.monitorMode, "all");
  assert.equal(open.managedBy, null);
  assert.equal(open.monitorMode, null);
  assert.equal(model.albums.find((a) => a.id === 21).managedBy, null);
});

test("canonical page cache reflects ownership changes without manual invalidation", () => {
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
  const before = getCanonicalLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(before.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, "aurral");

  store.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "lidarr" });
  const updated = getCanonicalLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(updated.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, "lidarr");

  store.clearLibraryManagement("artist", artist.id);
  const cleared = getCanonicalLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(cleared.items.find((entry) => String(entry.id) === String(artist.id))?.managedBy, null);
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

test("per-user library owner preference normalizes and defaults by connectivity", async () => {
  const userId = userOps.createUser("owner-pref", "hash").id;
  const stored = userOps.getUserById(userId);
  assert.equal(stored.defaultLibraryOwner, null);

  const updated = userOps.updateUser(userId, { defaultLibraryOwner: "AURRAL" });
  assert.equal(updated.defaultLibraryOwner, "aurral");

  const reset = userOps.updateUser(userId, { defaultLibraryOwner: "not-a-manager" });
  assert.equal(reset.defaultLibraryOwner, null);

  userOps.updateUser(userId, { defaultLibraryOwner: "lidarr" });
  const authUser = userOps.getUserAuthById(userId);
  assert.equal(authUser.defaultLibraryOwner, "lidarr");
});

test("library owner routes resolve stored preference with a connectivity fallback", async () => {
  const app = express();
  app.use(express.json());
  let currentUser = null;
  app.use((req, _res, next) => {
    req.user = currentUser;
    next();
  });
  const usersRouter = (await import("../../backend/routes/users.js")).default;
  app.use("/api/users", usersRouter);

  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...(settings.integrations || {}),
      lidarr: { ...(settings.integrations?.lidarr || {}), url: "", apiKey: "", enabled: false },
    },
  });
  const userId = userOps.createUser("owner-route", "hash").id;
  currentUser = { id: userId };

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = server.address().port;

  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const initial = await get("/api/users/me/library-owner");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.defaultLibraryOwner, "aurral");
  assert.equal(initial.body.storedDefaultLibraryOwner, null);

  const saved = await post("/api/users/me/library-owner", { defaultLibraryOwner: "aurral" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.storedDefaultLibraryOwner, "aurral");

  const invalid = await post("/api/users/me/library-owner", { defaultLibraryOwner: "slskd" });
  assert.equal(invalid.status, 400);

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});
