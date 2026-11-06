import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { listen, signedInAs } from "../helpers/honoApp.ts";
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
  provider,
  { api },
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
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/routes/api.ts"),
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
  const server = await listen(signedInAs(() => user).route("/api", api));
  app = { url: `http://127.0.0.1:${listeningAddress(server).port}`, server };
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
    const body: { artists: SearchItem[] } = await retry.json();
    assert.deepEqual(
      body.artists.map((artist) => artist.name),
      ["Lantern"],
    );
  },
);

function seedLibraryArtist(name: string) {
  const artist = libraryStore.upsertLibraryArtist({ identityKey: `search-rank:${name}`, name });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `search-rank:${name}:album`,
    artistId: artist.id,
    title: `${name} Live`,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `search-rank:${name}:track`,
    title: "Opener",
    artistName: name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: `/tmp/search-rank/${artist.id}.flac`,
  });
}

test("library search ranks exact names first and matches terms across fields", async () => {
  seedLibraryAlbum();
  for (const name of [
    "ACDC Tribute Band",
    "The ACDC Experience",
    "AC/DC",
    "Sigur Rós",
    "U2",
    "Cure Tribute",
    "The Cure",
  ]) {
    seedLibraryArtist(name);
  }
  const search = async (q: string, limit = 1) => {
    const response = await fetch(
      `${app.url}/api/search/library?${new URLSearchParams({ q, limit: String(limit) })}`,
    );
    assert.equal(response.status, 200);
    const body: Record<"artists" | "albums" | "tracks", SearchItem[]> = await response.json();
    return body;
  };

  assert.deepEqual(
    (await search("ac dc")).artists.map((item) => item.name),
    ["AC/DC"],
  );
  assert.deepEqual(
    (await search("sigur ros")).artists.map((item) => item.name),
    ["Sigur Rós"],
  );
  assert.deepEqual(
    (await search("cure")).artists.map((item) => item.name),
    ["The Cure"],
  );
  assert.deepEqual((await search("ac", 5)).artists.map((item) => item.name).slice(0, 1), ["AC/DC"]);
  assert.deepEqual(
    (await search("lantern harbor")).tracks.map((item) => item.title),
    ["Lantern Song"],
  );
  for (const q of ["u2 opener", "u2"]) {
    assert.deepEqual(
      (await search(q, 5)).tracks.map((item) => item.artistName),
      ["U2"],
      q,
    );
  }
});

test("library search finds the user's playlists by name, then by tracklist", async () => {
  const other = requireFixture(userOps.createUser("search-routes-other", "unused", "user"));
  const track = (artistName: string, trackName: string) => ({ artistName, trackName });
  flowPlaylistConfig.createStaticPlaylist({
    name: "Saturday cleaning",
    ownerUserId: user.id,
    tracks: [
      track("Daft Punk", "One More Time"),
      track("Michael Jackson", "Billie Jean"),
      track("Michael Jackson", "Beat It"),
    ],
  });
  flowPlaylistConfig.createStaticPlaylist({
    name: "Michael Jackson essentials",
    ownerUserId: user.id,
    tracks: [track("Michael Jackson", "Thriller")],
  });
  flowPlaylistConfig.createStaticPlaylist({
    name: "Road trip",
    ownerUserId: user.id,
    tracks: [track("Daft Punk", "Digital Love")],
  });
  flowPlaylistConfig.createStaticPlaylist({
    name: "Michael Jackson deep cuts",
    ownerUserId: other.id,
    tracks: [track("Michael Jackson", "Speechless")],
  });

  const response = await fetch(`${app.url}/api/search/library?q=michael+jackson&limit=5`);
  const body: {
    playlists: { name: string; trackMatch: { title: string; count: number } | null }[];
  } = await response.json();

  assert.deepEqual(
    body.playlists.map((playlist) => [playlist.name, playlist.trackMatch]),
    [
      ["Michael Jackson essentials", null],
      ["Saturday cleaning", { title: "Billie Jean", count: 2 }],
    ],
  );
});

test("playlist search lists matching editor playlists before full user playlists", async () => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (!String(input).startsWith("https://api.deezer.com/search/playlist")) {
      return realFetch(input, init);
    }
    const playlist = (id: number, title: string, curator: string, tracks = 50) => ({
      id,
      title,
      nb_tracks: tracks,
      picture_xl: `https://cdn.test/${id}.jpg`,
      user: { name: curator },
    });
    return Promise.resolve(
      Response.json({
        data: [
          playlist(1, "Michael (Movie Soundtrack)", "Deezer Soundtracks Editor"),
          playlist(2, "100% Michael Jackson", "Deezer Artist Editor"),
          playlist(3, "michael jackson mix", "someone"),
          playlist(4, "mj", "someone", 5),
        ],
      }),
    );
  });

  const response = await fetch(`${app.url}/api/search/playlists?q=michael+jackson`);
  assert.equal(response.status, 200);
  const body: { playlists: SearchItem[] } = await response.json();
  assert.deepEqual(
    body.playlists.map((playlist) => [playlist.source, playlist.id, playlist.name]),
    [
      ["deezer", "2", "100% Michael Jackson"],
      ["deezer", "3", "michael jackson mix"],
    ],
  );
});

type DeezerSong = { title: string; artist: string; album: string; rank: number };

function stubDeezerSongs(songs: DeezerSong[]) {
  const realGet = axios.get.bind(axios);
  vi.spyOn(axios, "get").mockImplementation((url, config) => {
    if (!String(url).startsWith("https://api.deezer.com/search/track")) return realGet(url, config);
    const data = songs.map((song, index) => ({
      id: index + 1,
      title: song.title,
      rank: song.rank,
      artist: { name: song.artist },
      album: {
        id: index + 100,
        title: song.album,
        cover_medium: `https://cdn.test/${index + 1}.jpg`,
      },
    }));
    return Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: {},
      config: {},
      data: { data },
    });
  });
}

function serveCatalogAlbums(albums: { id: string; title: string; type: string; artist: string }[]) {
  metadataHandler = (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/search/album")
          ? albums.map((album) => ({
              id: album.id,
              title: album.title,
              type: album.type,
              artistid: album.artist,
              artists: [{ id: album.artist, artistname: album.artist }],
            }))
          : [],
      ),
    );
  };
}

const unifiedSearch = async (q: string) => {
  const response = await fetch(`${app.url}/api/search/unified?${new URLSearchParams({ q })}`);
  assert.equal(response.status, 200);
  const body: { status: string; top: SearchItem; artists: SearchItem[]; tracks: SearchItem[] } =
    await response.json();
  return body;
};

test("unified search folds Deezer songs into the results with their catalog album", async () => {
  stubDeezerSongs([
    { title: "As Long As You Love Me", artist: "Justin Bieber", album: "Believe", rank: 415068 },
    {
      title: "As Long As You Love Me",
      artist: "Backstreet Boys",
      album: "Backstreet's Back",
      rank: 717064,
    },
  ]);
  serveCatalogAlbums([
    {
      id: "bsb-single",
      title: "As Long as You Love Me",
      type: "Single",
      artist: "Backstreet Boys",
    },
    { id: "bsb-album", title: "Backstreet's Back", type: "Album", artist: "Backstreet Boys" },
  ]);

  const body = await unifiedSearch("as long as you love me");
  assert.equal(body.status, "ok");
  assert.deepEqual(
    [body.top.type, body.top.artistName, body.top.albumMbid],
    ["track", "Backstreet Boys", "bsb-album"],
  );
  assert.deepEqual(
    body.tracks.map((track) => [track.artistName, track.coverUrl]),
    [
      ["Justin Bieber", "https://cdn.test/1.jpg"],
      ["Backstreet Boys", "https://cdn.test/2.jpg"],
    ],
  );
});

test("unified search tops an exact album by a famous artist over an obscure exact song", async () => {
  stubDeezerSongs([
    { title: "Ok Computer", artist: "Lemaitre", album: "Ok Computer", rank: 73239 },
    { title: "Karma Police", artist: "Radiohead", album: "OK Computer", rank: 898957 },
  ]);
  serveCatalogAlbums([
    { id: "ok-computer", title: "OK Computer", type: "Album", artist: "Radiohead" },
  ]);

  const body = await unifiedSearch("ok computer");
  assert.deepEqual([body.top.type, body.top.id], ["album", "ok-computer"]);
});

test("unified search drops near-miss artists once a famous artist is the clear match", async () => {
  stubDeezerSongs([
    { title: "Thriller", artist: "Michael Jackson", album: "Thriller", rank: 927235 },
  ]);
  metadataHandler = (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/search/artist")
          ? [
              { id: "mj", artistname: "Michael Jackson" },
              { id: "mj-doctor", artistname: "Michael Jackson's Doctor" },
            ]
          : [],
      ),
    );
  };

  const body = await unifiedSearch("michael jackson");
  assert.equal(body.top.id, "mj");
  assert.deepEqual(
    body.artists.map((artist) => artist.id),
    ["mj"],
  );
});

test("unified search reports an unreachable catalog, does not cache it, and lists one artist per name", async () => {
  metadataHandler = (_request, response) => {
    response.writeHead(400);
    response.end();
  };
  const failed = await fetch(`${app.url}/api/search/unified?q=harbor+lights`);
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).status, "unavailable");

  metadataHandler = (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/search/artist")
          ? [
              { id: "harbor-lights-mbid", artistname: "Harbor Lights" },
              { id: "harbor-lights-other-mbid", artistname: "Harbor Lights" },
            ]
          : [],
      ),
    );
  };
  const recovered = await fetch(`${app.url}/api/search/unified?q=harbor+lights`);
  const body: { status: string; artists: SearchItem[] } = await recovered.json();
  assert.equal(body.status, "ok");
  assert.deepEqual(
    body.artists.map((artist) => artist.id),
    ["harbor-lights-mbid"],
  );
});

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
  await playlistOperations.processPlaylistOperation(
    v.parse(playlistOperations.playlistOperationSchema, queuedOperations[0]),
  );

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
