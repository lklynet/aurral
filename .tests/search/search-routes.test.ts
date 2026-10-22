import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import express from "express";
import { buildTrackPlaylistPayload } from "../../frontend/src/utils/globalSearchUtils.ts";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  libraryStore,
  { default: searchRouter },
  provider,
  { registerStaticPlaylists },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { downloadWorker },
  playlistOperations,
  honker,
] = await setupIsolatedBackend(
  "search-routes",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/libraryMediaStore.ts",
  "backend/routes/search.ts",
  "backend/services/providers/brainzmashProvider.ts",
  "backend/routes/playlists/handlers/staticPlaylists.ts",
  "backend/services/playlists/flowPlaylistConfig.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/playlists/playlistManager.ts",
  "backend/services/downloadJobs/downloadWorker.ts",
  "backend/services/playlists/playlistOperations.ts",
  "backend/services/honkerDb.ts",
);

let app;
let user;
let metadataServer;
let metadataRequests = [];
let metadataHandler = null;

beforeAll(async () => {
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

  user = userOps.createUser("search-routes-user", "unused");
  const playlistsRouter = express.Router();
  registerStaticPlaylists(playlistsRouter);
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use((req, _res, next) => {
    req.user = user;
    next();
  });
  expressApp.use("/api/search", searchRouter);
  expressApp.use("/api/playlists", playlistsRouter);
  await new Promise((resolve) => {
    const server = expressApp.listen(0, "127.0.0.1", () => {
      app = { url: `http://127.0.0.1:${server.address().port}`, server };
      resolve();
    });
  });
});

beforeEach(() => {
  metadataRequests = [];
  metadataHandler = null;
  provider.clearMetadataProviderCaches();
});

afterAll(async () => {
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
    body.artists.map((item) => [item.name, item.canonicalId]),
    [["Harbor Collective", String(artist.id)]],
  );
  assert.deepEqual(
    body.albums.map((item) => [item.title, item.canonicalId, item.id, item.artistName]),
    [["Quiet Harbor", String(album.id), "search-routes-release-group", "Harbor Collective"]],
  );
  assert.deepEqual(
    body.tracks.map((item) => [item.title, item.albumCanonicalId, item.albumMbid]),
    [["Lantern Song", String(album.id), "search-routes-release-group"]],
  );
  assert.equal(metadataRequests.length, 0);
});

test(
  "a disconnected unified search cancels metadata requests and does not cache empty results",
  { timeout: 4000 },
  async () => {
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
  },
);

test("adding library search results to a new static playlist keeps their MusicBrainz identity", async () => {
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(async () => {});
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => false);
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "search-routes:beacon-artist",
    mbid: "5b11f4ce-a62d-471e-81fc-a69a8278c7da",
    name: "Beacon Choir",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "search-routes:beacon-album",
    releaseGroupMbid: "1b022e01-4da6-387b-8658-8678046e4cef",
    artistId: artist.id,
    title: "Beacon Nights",
    releaseDate: "2019-04-12",
  });
  const tagged = libraryStore.upsertLibraryTrack({
    identityKey: "search-routes:beacon-tagged",
    mbid: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
    title: "Beacon Light",
    artistName: artist.name,
  });
  const untagged = libraryStore.upsertLibraryTrack({
    identityKey: "search-routes:beacon-untagged",
    title: "Beacon Reprise",
    artistName: artist.name,
  });
  for (const [track, durationMs] of [
    [tagged, 214000],
    [untagged, null],
  ]) {
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/tmp/search-routes/${track.title}.flac`,
      durationMs,
    });
  }

  const search = await fetch(`${app.url}/api/search/library?q=beacon&limit=5`);
  assert.equal(search.status, 200);
  const { tracks: results } = await search.json();
  const payloads = ["Beacon Light", "Beacon Reprise"].map((title) =>
    buildTrackPlaylistPayload(results.find((result) => result.title === title)),
  );
  const created = await fetch(`${app.url}/api/playlists/shared-playlists`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Beacon Picks", tracks: payloads }),
  });
  assert.equal(created.status, 200);
  const operation = honker.getPlaylistOperationQueue().claimOne("search-routes");
  await playlistOperations.processPlaylistOperation(operation.payload);
  operation.ack();

  const playlist = flowPlaylistConfig
    .getStaticPlaylistsForUser(user)
    .find((entry) => entry.name === "Beacon Picks");
  const jobs = downloadTracker.getByPlaylistType(playlist.id);
  const identity = (track) => [
    track.trackName,
    track.trackMbid,
    track.artistMbid,
    track.albumMbid,
    track.releaseYear,
    track.durationMs,
  ];
  const expected = [
    [
      "Beacon Light",
      "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
      "5b11f4ce-a62d-471e-81fc-a69a8278c7da",
      "1b022e01-4da6-387b-8658-8678046e4cef",
      "2019",
      214000,
    ],
    [
      "Beacon Reprise",
      null,
      "5b11f4ce-a62d-471e-81fc-a69a8278c7da",
      "1b022e01-4da6-387b-8658-8678046e4cef",
      "2019",
      null,
    ],
  ];
  const byName = (a, b) => a[0].localeCompare(b[0]);
  assert.deepEqual(playlist.tracks.map(identity).sort(byName), expected);
  assert.deepEqual(jobs.map(identity).sort(byName), expected);
});
