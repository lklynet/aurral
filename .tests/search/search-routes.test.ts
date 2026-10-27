import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import express from "express";
import {
  buildTrackPlaylistPayload,
  type SearchSuggestionTrack,
} from "../../frontend/src/utils/globalSearchUtils.ts";
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
  { handToHono },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { downloadWorker },
  playlistOperations,
  { playlistOperationQueue },
] = await setupIsolatedBackend(
  "search-routes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/routes/search.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/routes/shared/expressHandoff.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
);

let app: {
  url: string;
  server: import("node:http").Server<
    typeof import("node:http").IncomingMessage,
    typeof import("node:http").ServerResponse
  >;
};
let user: NonNullable<ReturnType<typeof userOps.createUser>>;
type SearchItem = Record<string, string>;
let metadataServer: { url: string; close: () => Promise<void> };
let metadataRequests: {
  url: string | undefined;
  response: import("node:http").ServerResponse<import("node:http").IncomingMessage> & {
    req: import("node:http").IncomingMessage;
  };
}[] = [];
let metadataHandler: import("node:http").RequestListener | null = null;

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

  user = requireFixture(
    userOps.createUser("search-routes-user", "unused", "user", { accessFlow: true }),
  );
  const expressApp = express();
  expressApp.use((req, _res, next) => {
    req.user = user;
    next();
  });
  expressApp.use("/api/playlists", handToHono);
  expressApp.use(express.json());
  expressApp.use("/api/search", searchRouter);
  await new Promise<void>((resolve) => {
    const server = expressApp.listen(0, "127.0.0.1", () => {
      app = { url: `http://127.0.0.1:${listeningAddress(server)!.port}`, server };
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
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
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
  const body: Record<"artists" | "albums" | "tracks", SearchItem[]> = await response.json();

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
    const bothRequestsArrived = new Promise<void>((resolve) => {
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
        ({ response }) => new Promise<void>((resolve) => response.on("close", resolve)),
      ),
    );
    client.abort();
    assert.equal((await abandoned).name, "AbortError");
    await upstreamClosed;

    metadataHandler = (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/search/artist")) {
        response.end(JSON.stringify([{ id: "lantern-artist-mbid", artistname: "Lantern" }]));
        return;
      }
      response.end(JSON.stringify([]));
    };
    const retry = await fetch(`${app.url}/api/search/unified?q=lantern`);
    assert.equal(retry.status, 200);
    const body: { catalog: { artists: SearchItem[] } } = await retry.json();
    assert.deepEqual(
      body.catalog.artists.map((artist) => artist.name),
      ["Lantern"],
    );
  },
);

test("adding library search results to a new static playlist keeps their MusicBrainz identity", async () => {
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => null);
  vi.spyOn(playlistManager, "scheduleScanLibrary").mockImplementation(() => 0);
  vi.spyOn(downloadWorker, "start").mockImplementation(async () => false);
  const queuedOperations: import("../../backend/services/honkerDb.ts").HonkerPayload[] = [];
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockImplementation(async (payload = {}) => {
    queuedOperations.push(payload);
    return { queued: true, operationId: queuedOperations.length };
  });
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
  for (const { track, durationMs } of [
    { track: tagged, durationMs: 214000 },
    { track: untagged, durationMs: null },
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
  const { tracks: results }: { tracks: SearchSuggestionTrack[] } = await search.json();
  const payloads = ["Beacon Light", "Beacon Reprise"].map((title) =>
    buildTrackPlaylistPayload(requireFixture(results.find((result) => result.title === title))),
  );
  const created = await fetch(`${app.url}/api/playlists/shared-playlists`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Beacon Picks", tracks: payloads }),
  });
  assert.equal(created.status, 200);
  assert.equal(queuedOperations.length, 1);
  await playlistOperations.processPlaylistOperation(queuedOperations[0]);

  const playlist = flowPlaylistConfig
    .getStaticPlaylistsForUser(user)
    .find((entry) => entry.name === "Beacon Picks");
  assert.ok(playlist != null);
  const jobs = downloadTracker.getByPlaylistType(playlist.id);
  const identity = (track: {
    trackName: string | null;
    trackMbid?: string | null;
    artistMbid?: string | null;
    albumMbid?: string | null;
    releaseYear?: string | null;
    durationMs?: number | null;
  }) =>
    [
      track.trackName,
      track.trackMbid,
      track.artistMbid,
      track.albumMbid,
      track.releaseYear,
      track.durationMs,
    ] as const;
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
  const byName = (a: ReturnType<typeof identity>, b: ReturnType<typeof identity>) =>
    String(a[0]).localeCompare(String(b[0]));
  assert.deepEqual(playlist.tracks.map(identity).sort(byName), expected);
  assert.deepEqual(jobs.map(identity).sort(byName), expected);
});
