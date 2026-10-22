import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, libraryStore, { setLibraryManagement }] =
  await setupIsolatedBackend(
    "canonical-available-only-route",
    "backend/config/db-sqlite.ts",
    "backend/db/helpers/index.ts",
    "backend/services/libraryMediaStore.ts",
    "backend/services/libraryManagementStore.ts",
  );

const { registerLibraryIndex } =
  await import("../../backend/routes/library/handlers/libraryIndex.ts");
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

function getRoute(path) {
  const routes = new Map();
  registerLibraryIndex({
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers.at(-1));
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers.at(-1));
    },
  });
  return routes.get(path);
}

function callLibraryPage(query) {
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

beforeAll(() => {
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

  const fetchingArtist = upsertLibraryArtist({ identityKey: "fetching-artist", name: "Fetching" });
  for (const [title, monitored] of [
    ["Requested Album", true],
    ["Unmonitored Album", false],
  ]) {
    const album = upsertLibraryAlbum({
      identityKey: `aurral-${title}`,
      artistId: fetchingArtist.id,
      title,
      metadata: { librarySource: "aurral", trackListComplete: true, monitored },
    });
    const track = upsertLibraryTrack({
      identityKey: `aurral-${title}-track`,
      title: `${title} Track`,
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    setLibraryManagement({
      entityKind: "album",
      entityId: album.id,
      managedBy: "aurral",
      monitorMode: monitored ? "monitored" : "unmonitored",
    });
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const titles = (page) => page.items.map((entry) => entry.title || entry.name).sort();

test("the Library lists what can be played and what Aurral is fetching, with or without Lidarr", () => {
  for (const lidarr of [
    { url: "http://lidarr:8686", apiKey: "test-key", availableOnly: false },
    {},
  ]) {
    dbOps.updateSettings({ integrations: { lidarr } });
    const albums = callLibraryPage({ kind: "albums", page: "1", pageSize: "50" });
    assert.deepEqual(titles(albums), ["Owned Album", "Requested Album"]);
    assert.equal(albums.total, 2);
    const artists = callLibraryPage({ kind: "artists", page: "1", pageSize: "50" });
    assert.deepEqual(titles(artists), ["Fetching", "Owns Some"]);
    assert.deepEqual(
      artists.items.map((artist) => artist.albumCount),
      [1, 1],
    );
    const ownsSome = artists.items.find((artist) => artist.name === "Owns Some");
    assert.deepEqual(
      titles(
        callLibraryPage({
          kind: "albums",
          page: "1",
          pageSize: "50",
          artistId: String(ownsSome.id),
        }),
      ),
      ["Owned Album"],
    );
  }
});

test("a source filter lists and counts only albums and artists with playable files from that source", () => {
  for (const kind of ["albums", "artists"]) {
    const page = callLibraryPage({ kind, page: "1", pageSize: "50", source: "lidarr" });
    assert.deepEqual(titles(page), [kind === "albums" ? "Owned Album" : "Owns Some"]);
    assert.equal(page.total, 1);
  }
});

test("an explicit availableOnly query param overrides the Library's rule", () => {
  const playable = callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(titles(playable), ["Owned Album"]);
  const everything = callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "false",
  });
  assert.equal(everything.total, 5);
});
