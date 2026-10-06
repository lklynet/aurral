import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, libraryStore, { default: searchRouter }, provider] =
  await setupIsolatedBackend(
    "search-routes",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryMediaStore.js",
    "backend/routes/search.js",
    "backend/services/providers/brainzmashProvider.js",
  );

let app;
let metadataServer;
let metadataRequests = [];
let metadataHandler = null;

test.before(async () => {
  resetDatabase(db);
  metadataServer = await createMockHttpServer((request, response) => {
    metadataRequests.push({ url: request.url, response });
    metadataHandler?.(request, response);
  });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      metadata: {
        ...settings.integrations.metadata,
        baseUrl: metadataServer.url,
        enableNarrowFallbacks: false,
      },
    },
  });

  const expressApp = express();
  expressApp.use("/api/search", searchRouter);
  await new Promise((resolve) => {
    const server = expressApp.listen(0, "127.0.0.1", () => {
      app = { url: `http://127.0.0.1:${server.address().port}`, server };
      resolve();
    });
  });
});

test.beforeEach(() => {
  metadataRequests = [];
  metadataHandler = null;
  provider.clearMetadataProviderCaches();
});

test.after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

function seedLibraryAlbum() {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "search-routes:artist",
    mbid: "search-routes-artist-mbid",
    name: "Harbor Collective",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "search-routes:album",
    releaseGroupMbid: "search-routes-release-group",
    artistId: artist.id,
    title: "Quiet Harbor",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "search-routes:track",
    title: "Lantern Song",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: "/tmp/search-routes/lantern-song.flac",
  });
  return { artist, album, track };
}

test("library search answers from the local library without calling the metadata server", async () => {
  const { artist, album } = seedLibraryAlbum();

  const response = await fetch(`${app.url}/api/search/library?q=harbor&limit=5`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(
    body.artists.map((item) => [item.name, item.recordId]),
    [["Harbor Collective", String(artist.id)]],
  );
  assert.deepEqual(
    body.albums.map((item) => [item.title, item.recordId, item.id, item.artistName]),
    [["Quiet Harbor", String(album.id), "search-routes-release-group", "Harbor Collective"]],
  );
  assert.deepEqual(
    body.tracks.map((item) => [item.title, item.albumRecordId, item.albumMbid]),
    [["Lantern Song", String(album.id), "search-routes-release-group"]],
  );
  assert.equal(metadataRequests.length, 0);
});

test("a disconnected unified search cancels metadata requests and does not cache empty results", { timeout: 4000 }, async () => {
  const bothRequestsArrived = new Promise((resolve) => {
    metadataHandler = () => {
      if (metadataRequests.length === 2) resolve();
    };
  });
  const client = new AbortController();
  const abandoned = fetch(`${app.url}/api/search/unified?q=lantern`, {
    signal: client.signal,
  }).catch((error) => error);

  await bothRequestsArrived;
  const upstreamClosed = Promise.all(
    metadataRequests.map(
      ({ response }) => new Promise((resolve) => response.on("close", resolve)),
    ),
  );
  client.abort();
  assert.equal((await abandoned).name, "AbortError");
  await upstreamClosed;

  metadataHandler = (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/search/artist")) {
      response.end(JSON.stringify([{ id: "lantern-artist-mbid", artistname: "Lantern" }]));
      return;
    }
    response.end(JSON.stringify([]));
  };
  const retry = await fetch(`${app.url}/api/search/unified?q=lantern`);
  assert.equal(retry.status, 200);
  const body = await retry.json();
  assert.deepEqual(
    body.catalog.artists.map((artist) => artist.name),
    ["Lantern"],
  );
});
