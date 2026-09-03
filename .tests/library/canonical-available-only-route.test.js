import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, libraryStore] = await setupIsolatedBackend(
  "canonical-available-only-route",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
);

const { registerCanonical } = await import(
  "../../backend/routes/library/handlers/canonical.js"
);
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

function getRoute(path) {
  const routes = new Map();
  registerCanonical({
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers.at(-1));
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers.at(-1));
    },
  });
  return routes.get(path);
}

function callCanonical(query) {
  let body;
  getRoute("GET /canonical")(
    { query },
    {
      status() {
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    },
  );
  return body;
}

function setAvailableOnly(value) {
  dbOps.updateSettings({ integrations: { lidarr: { availableOnly: value } } });
}

test.before(() => {
  resetDatabase(db);

  // Artist who owns some but not all of their discography (the issue's "Muse" case).
  const partialArtist = upsertLibraryArtist({
    identityKey: "partial-artist",
    name: "Owns Some",
  });
  const ownedAlbum = upsertLibraryAlbum({
    identityKey: "owned-album",
    artistId: partialArtist.id,
    title: "Owned Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: "owned-track",
    title: "Owned Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: ownedAlbum.id, trackId: ownedTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: ownedAlbum.id,
    source: "lidarr",
    path: "/library/Owns Some/Owned Album/01 Owned Track.flac",
    available: true,
  });

  const catalogAlbum = upsertLibraryAlbum({
    identityKey: "catalog-album",
    artistId: partialArtist.id,
    title: "Catalog Album",
  });
  const catalogTrack = upsertLibraryTrack({
    identityKey: "catalog-track",
    title: "Catalog Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: catalogAlbum.id, trackId: catalogTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: catalogTrack.id,
    albumId: catalogAlbum.id,
    source: "lidarr",
    path: "/library/Owns Some/Catalog Album/01 Catalog Track.flac",
    available: false,
  });

  // Artist who owns nothing (e.g. deleted in Lidarr but lingering) — issue #750.
  const emptyArtist = upsertLibraryArtist({
    identityKey: "empty-artist",
    name: "Owns Nothing",
  });
  const emptyAlbum = upsertLibraryAlbum({
    identityKey: "empty-album",
    artistId: emptyArtist.id,
    title: "Unowned Album",
  });
  const emptyTrack = upsertLibraryTrack({
    identityKey: "empty-track",
    title: "Unowned Track",
    artistName: emptyArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: emptyAlbum.id, trackId: emptyTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: emptyTrack.id,
    albumId: emptyAlbum.id,
    source: "lidarr",
    path: "/library/Owns Nothing/Unowned Album/01 Unowned Track.flac",
    available: false,
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("albums list hides unavailable albums when the setting is on (default)", () => {
  setAvailableOnly(true);
  const page = callCanonical({ kind: "albums", page: "1", pageSize: "50" });
  assert.deepEqual(page.items.map((album) => album.title), ["Owned Album"]);
  assert.equal(page.total, 1);
});

test("albums list shows the full catalog when the setting is off", () => {
  setAvailableOnly(false);
  const page = callCanonical({ kind: "albums", page: "1", pageSize: "50" });
  assert.deepEqual(
    page.items.map((album) => album.title).sort(),
    ["Catalog Album", "Owned Album", "Unowned Album"],
  );
  assert.equal(page.total, 3);
});

test("artists with zero available albums disappear when the setting is on (#750)", () => {
  setAvailableOnly(true);
  const page = callCanonical({ kind: "artists", page: "1", pageSize: "50" });
  assert.deepEqual(page.items.map((entry) => entry.name), ["Owns Some"]);
  assert.equal(page.total, 1);
});

test("artists with zero available albums remain when the setting is off", () => {
  setAvailableOnly(false);
  const page = callCanonical({ kind: "artists", page: "1", pageSize: "50" });
  assert.deepEqual(
    page.items.map((entry) => entry.name).sort(),
    ["Owns Nothing", "Owns Some"],
  );
  assert.equal(page.total, 2);
});

test("an explicit availableOnly query param overrides the setting", () => {
  setAvailableOnly(false);
  const filtered = callCanonical({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(filtered.items.map((album) => album.title), ["Owned Album"]);

  setAvailableOnly(true);
  const unfiltered = callCanonical({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "false",
  });
  assert.equal(unfiltered.total, 3);
});
