import { requireFixture } from "./playlists/fixtures.ts";
import { asAppError } from "../lib/errors.ts";
import { test, afterAll, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "./helpers/backendTestHarness.ts";
import { defaultData, DEFAULT_METADATA_BASE_URL } from "../backend/config/constants.ts";

const [
  isolatedState,
  { dbOps },
  metadataProvider,
  { listMetadataCalls, reserveMetadataProviderRequest },
  { db },
  { http, HttpError },
  { readAppSettings, saveAppSettings },
  { trackWork },
] = await setupIsolatedBackend(
  "metadata-providers",
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/providers/metadataProvider.ts"),
  () => import("../backend/services/metadataProviderBudget.ts"),
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../lib/http.ts"),
  () => import("../backend/services/appSettings.ts"),
  () => import("../backend/services/eventLoopWatch.ts"),
);

const {
  clearMetadataProviderCaches,
  getAlbumByMbid,
  getArtistByMbid,
  getCachedArtistByMbid,
  listArtistAlbums,
  searchAlbums,
  searchArtists,
} = metadataProvider;

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const OFFLINE_CHILD_ARGS = ["--import", new URL("./setup-env.ts", import.meta.url).href];

test("default settings and unset backend config use data.aurral.org metadata", async () => {
  assert.equal(defaultData.settings.integrations.metadata.baseUrl, "");
  assert.equal(metadataProvider.getMetadataBaseUrl(), DEFAULT_METADATA_BASE_URL);

  const saveBaseUrl = (baseUrl: string) =>
    saveAppSettings({ integrations: { metadata: { baseUrl } } });
  assert.equal((await saveBaseUrl("https://metadata.example/")).error, undefined);
  assert.equal(metadataProvider.getMetadataBaseUrl(), "https://metadata.example");
  assert.equal((await saveBaseUrl("")).error, undefined);

  assert.equal(metadataProvider.getMetadataBaseUrl(), DEFAULT_METADATA_BASE_URL);
  assert.equal(readAppSettings().integrations.metadata?.baseUrl, "");

  vi.stubEnv("METADATA_BASE_URL", "http://data.local:5003");
  assert.equal(metadataProvider.getMetadataBaseUrl(), "http://data.local:5003");
  vi.unstubAllEnvs();
});

test("stale album metadata is served while one refresh runs in the background", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  let refreshArrived!: () => void;
  const refreshRequested = new Promise<void>((resolve) => {
    refreshArrived = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    requests += 1;
    if (requests === 1) {
      response.end(JSON.stringify({ id: "album-1", title: "Album v1" }));
      return;
    }
    refreshArrived();
    void refreshReleased.then(() =>
      response.end(JSON.stringify({ id: "album-1", title: "Album v2" })),
    );
  });
  const originalNow = Date.now;
  let now = 1_000_000;

  try {
    Date.now = () => now;
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    const first = await getAlbumByMbid("album-1");
    assert.equal(first.title, "Album v1");
    assert.equal(requests, 1);

    now += 7 * 24 * 60 * 60 * 1000 + 1_000;
    const staleReads = Promise.all([getAlbumByMbid("album-1"), getAlbumByMbid("album-1")]);
    await refreshRequested;
    const [stale, staleAgain] = await staleReads;
    assert.equal(stale.title, "Album v1");
    assert.equal(staleAgain.title, "Album v1");

    const joinedRefresh = getAlbumByMbid("album-1", { forceRefresh: true });
    releaseRefresh();
    assert.equal((await joinedRefresh).title, "Album v2");
    const refreshed = await getAlbumByMbid("album-1");
    assert.equal(requests, 2);
    assert.equal(refreshed.title, "Album v2");
  } finally {
    Date.now = originalNow;
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("an incomplete BrainzMash album uses one cached MusicBrainz release browse", async () => {
  const previousSettings = dbOps.getSettings();
  const albumMbid = "3281d649-f172-4c96-8c44-7c71eb050f1d";
  const omittedReleasesAlbumMbid = "11111111-1111-4111-8111-111111111111";
  const completeAlbumMbid = "082c6aff-a7cc-36e0-a960-35a578ecd937";
  let brainzmashRequests = 0;
  let musicbrainzRequests = 0;
  const server = await createMockHttpServer((request, response) => {
    brainzmashRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === `/v1/album/${completeAlbumMbid}`
          ? {
              id: completeAlbumMbid,
              title: "Complete Album",
              releases: [{ id: "complete-release", tracks: [] }],
            }
          : request.url === `/v1/album/${omittedReleasesAlbumMbid}`
            ? {
                id: omittedReleasesAlbumMbid,
                title: "Album Without Releases",
              }
            : {
                id: albumMbid,
                title: "How to Count to Five",
                releases: [],
              },
      ),
    );
  });
  const providerGet = http.get.bind(http);
  const get = vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (!url.startsWith("https://musicbrainz.org/")) return providerGet(url, options);
    musicbrainzRequests += 1;
    assert.equal(new URL(url).pathname, "/ws/2/release");
    assert.ok(
      [albumMbid, omittedReleasesAlbumMbid].includes(
        String(options?.query?.["release-group"] || ""),
      ),
    );
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: {
        releases: [
          {
            id: "3de8a297-70aa-422e-a7d7-4251a3939e22",
            title: "How to Count to Five",
            status: "Official",
            date: "2024-03-01",
            country: "XW",
            media: [
              {
                position: 1,
                format: "Digital Media",
                "track-count": 1,
                tracks: [
                  {
                    id: "release-track-1",
                    title: "One",
                    position: 1,
                    length: 123000,
                    recording: { id: "recording-1", title: "One" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();
    const startedAt = Date.now();

    const metadataOnly = await getAlbumByMbid(albumMbid);
    const first = await getAlbumByMbid(albumMbid, { withFallbackReleases: true });
    const second = await getAlbumByMbid(albumMbid, { withFallbackReleases: true });
    const omitted = await getAlbumByMbid(omittedReleasesAlbumMbid, {
      withFallbackReleases: true,
    });
    const complete = await getAlbumByMbid(completeAlbumMbid);

    assert.deepEqual(metadataOnly.releases, []);
    assert.equal(first.releases[0]?.tracks[0]?.recordingId, "recording-1");
    assert.equal(second.releases[0]?.tracks[0]?.title, "One");
    assert.equal(omitted.releases[0]?.tracks[0]?.recordingId, "recording-1");
    assert.equal(complete.releases[0]?.id, "complete-release");
    assert.equal(brainzmashRequests, 3);
    assert.equal(musicbrainzRequests, 2);
    const stored = db
      .prepare<[string], { fresh_until: number }>(
        "SELECT fresh_until FROM metadata_response_cache WHERE cache_key = ?",
      )
      .get(`${server.url}/v1/album/${albumMbid}:{}`);
    assert.ok(stored);
    assert.ok(stored.fresh_until >= startedAt + 60 * 60 * 1000);
    assert.ok(stored.fresh_until < startedAt + 61 * 60 * 1000);
  } finally {
    get.mockRestore();
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("BrainzMash data Aurral can't read is never served, from the provider or the cache", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "album-x", title: requests === 1 ? 5 : "Album" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();
    const year = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await dbOps.setMetadataResponseAsync(`${server.url}/v1/album/album-x:{}`, {
      value: { id: 7 },
      freshUntil: year,
      staleUntil: year,
    });

    await assert.rejects(
      () => getAlbumByMbid("album-x"),
      /Metadata sent \/v1\/album\/album-x data Aurral can't read/,
    );
    assert.equal((await getAlbumByMbid("album-x")).title, "Album");
    assert.equal(requests, 2);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("cached artist lookups read only what Aurral already stored", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist-x", artistname: "Artist" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();
    assert.equal(await getCachedArtistByMbid("artist-x"), null);

    const past = Date.now() - 1000;
    const later = Date.now() + 60_000;
    await dbOps.setMetadataResponseAsync(`${server.url}/v1/artist/artist-x:{}`, {
      value: { id: "artist-x", name: "Artist", overview: "A biography." },
      freshUntil: past,
      staleUntil: later,
    });
    assert.equal((await getCachedArtistByMbid("artist-x"))?.overview, "A biography.");
    assert.equal(requests, 0);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("entity metadata is shared with other processes until the cache is cleared", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "persisted-album", title: "Persisted Album" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    assert.equal((await getAlbumByMbid("persisted-album")).title, "Persisted Album");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        ...OFFLINE_CHILD_ARGS,
        "--input-type=module",
        "-e",
        `
      const { getAlbumByMbid } = await import("./backend/services/providers/metadataProvider.ts");
      const album = await getAlbumByMbid("persisted-album");
      console.log(JSON.stringify({ title: album.title }));
      process.exit(0);
    `,
      ],
      { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 },
    );
    assert.equal(
      JSON.parse(requireFixture(stdout.trim().split("\n").at(-1))).title,
      "Persisted Album",
    );
    assert.equal(requests, 1);

    clearMetadataProviderCaches();
    await getAlbumByMbid("persisted-album");
    assert.equal(requests, 2);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("metadata past its stale window is removed from storage", async () => {
  const previousSettings = dbOps.getSettings();
  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/v1/search/artist")) {
      response.end(JSON.stringify({ artists: [] }));
      return;
    }
    response.end(
      JSON.stringify({ id: requireFixture(request.url).split("/").at(-1), title: "Album" }),
    );
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    await promisify(execFile)(
      process.execPath,
      [
        ...OFFLINE_CHILD_ARGS,
        "--input-type=module",
        "-e",
        `
      const day = 24 * 60 * 60 * 1000;
      const realNow = Date.now;
      let elapsed = 0;
      Date.now = () => realNow() - 40 * day + elapsed;
      const { getAlbumByMbid, searchArtists } = await import("./backend/services/providers/metadataProvider.ts");
      await getAlbumByMbid("expiring-album");
      await searchArtists("expiring search", { limit: 10 });
      elapsed = 38 * day;
      await getAlbumByMbid("current-album");
      process.exit(0);
    `,
      ],
      { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 },
    );

    const keys = db
      .prepare<
        unknown[],
        { cache_key: import("../backend/db/rows.ts").MetadataResponseCacheRow["cache_key"] }
      >("SELECT cache_key FROM metadata_response_cache")
      .all()
      .map((row) => row.cache_key);
    assert.equal(keys.length, 1);
    assert.match(requireFixture(keys[0]), /\/album\/current-album:/);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("artist album refreshes can bypass the long-lived metadata cache", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: artistMbid,
        name: "Calendar Artist",
        albums: [
          {
            id: releaseMbid,
            title: requests === 1 ? "Cached Release" : "Current Release",
            type: "Album",
            releaseStatuses: ["Official"],
            firstReleaseDate: "2025-05-01",
            listeners: 1000,
          },
        ],
      }),
    );
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    const first = await listArtistAlbums(artistMbid);
    const cached = await listArtistAlbums(artistMbid);
    const refreshed = await listArtistAlbums(artistMbid, {
      forceRefresh: true,
    });

    assert.equal(first[0]?.title, "Cached Release");
    assert.equal(first[0]?.firstReleaseDate, "2025-05-01");
    assert.equal(cached[0]?.title, "Cached Release");
    assert.equal(refreshed[0]?.title, "Current Release");
    assert.equal(requests, 2);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("an artist's album list comes from one artist file without per-album hydration", async () => {
  const previousSettings = dbOps.getSettings();
  const requested: string[] = [];
  const server = await createMockHttpServer((request, response) => {
    requested.push(request.url || "");
    const id = requireFixture(request.url).split("/").at(-1);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id,
        name: "List Artist",
        albums: [
          {
            id: "out",
            title: "Out",
            type: "Album",
            firstReleaseDate: "2000-01-01",
            listeners: 4000,
            cover: "https://coverartarchive.org/release/r/1-1200.jpg",
          },
          {
            id: "soon",
            title: "Soon",
            type: "Album",
            firstReleaseDate: "2999-01-01",
            listeners: 0,
          },
        ],
      }),
    );
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    const albums = await listArtistAlbums("list-artist");

    assert.deepEqual(
      albums.map((album) => [album.id, album.firstReleaseDate, album.listeners]),
      [
        ["out", "2000-01-01", 4000],
        ["soon", "2999-01-01", 0],
      ],
    );
    assert.deepEqual(requested, ["/v1/artist/list-artist"]);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("missing artist and album MBIDs fill gaps straight from MusicBrainz", async () => {
  const previousSettings = dbOps.getSettings();
  const missingArtistMbid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const missingAlbumMbid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let providerRequests = 0;
  const server = await createMockHttpServer((_request, response) => {
    providerRequests += 1;
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Not found" }));
  });
  const providerGet = http.get.bind(http);
  const mbPaths: string[] = [];
  const get = vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (!url.startsWith("https://musicbrainz.org/")) return providerGet(url, options);
    const pathname = new URL(url).pathname;
    mbPaths.push(pathname);
    if (pathname === `/ws/2/artist/${missingArtistMbid}`) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          id: missingArtistMbid,
          name: "Brand New Artist",
          "sort-name": "Brand New Artist",
          type: "Group",
          genres: [{ name: "shoegaze", count: 5 }],
          aliases: [{ name: "BNA" }],
          relations: [{ type: "deezer", url: { resource: "https://www.deezer.com/artist/123" } }],
          "release-groups": [
            {
              id: missingAlbumMbid,
              title: "Debut LP",
              "primary-type": "Album",
              "first-release-date": "2026-11-21",
            },
          ],
        },
      };
    }
    if (pathname === `/ws/2/release-group/${missingAlbumMbid}`) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          id: missingAlbumMbid,
          title: "Debut LP",
          "primary-type": "Album",
          "first-release-date": "2026-11-21",
          "artist-credit": [
            {
              name: "Brand New Artist",
              artist: { id: missingArtistMbid, name: "Brand New Artist" },
            },
          ],
        },
      };
    }
    return { status: 200, statusText: "OK", headers: {}, data: { releases: [] } };
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: { ...(previousSettings.integrations?.metadata || {}), baseUrl: server.url },
      },
    });
    clearMetadataProviderCaches();

    const artist = await getArtistByMbid(missingArtistMbid);
    assert.equal(artist.name, "Brand New Artist");
    assert.deepEqual(artist.genres, ["shoegaze"]);
    assert.equal(artist.albums[0]?.id, missingAlbumMbid);

    const album = await getAlbumByMbid(missingAlbumMbid);
    assert.equal(album.title, "Debut LP");
    assert.equal(album.artistId, missingArtistMbid);

    assert.equal((await getArtistByMbid(missingArtistMbid)).name, "Brand New Artist");
    assert.equal((await getAlbumByMbid(missingAlbumMbid)).title, "Debut LP");
    assert.equal(providerRequests, 2);
    assert.deepEqual(mbPaths, [
      `/ws/2/artist/${missingArtistMbid}`,
      `/ws/2/release-group/${missingAlbumMbid}`,
    ]);
  } finally {
    get.mockRestore();
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("each BrainzMash request sent is counted under the work that sent it", async () => {
  const previousSettings = dbOps.getSettings();
  const server = await createMockHttpServer((request, response) => {
    if (request.url?.startsWith("/v1/album/")) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "counted-artist", name: "Counted" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: { ...(previousSettings.integrations?.metadata || {}), baseUrl: server.url },
      },
    });
    clearMetadataProviderCaches();
    db.prepare("DELETE FROM metadata_calls").run();
    const started = Date.now();

    await trackWork(
      () => "GET /api/artists/:mbid",
      async () => {
        await getArtistByMbid("counted-artist");
        await getArtistByMbid("counted-artist");
      },
    );
    await trackWork(
      () => "system:7 release-refresh",
      () => getAlbumByMbid("missing-album").catch(() => null),
      () => "system release-refresh",
    );
    await getArtistByMbid("untracked-artist");

    const host = new URL(server.url).host;
    const counted = listMetadataCalls(started)
      .calls.filter((call) => call.server === host)
      .map(({ endpoint, work, status, count }) => `${endpoint} ${status} ${count} ${work}`)
      .toSorted();
    assert.deepEqual(counted, [
      "album 404 1 system release-refresh",
      "artist 200 1 GET /api/artists/:mbid",
      "artist 200 1 other",
    ]);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("missing entity metadata is negatively cached for repeated lookups", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Album not found" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    await assert.rejects(
      () => getAlbumByMbid("missing-album"),
      (error) => asAppError(error)?.response?.status === 404,
    );
    await assert.rejects(
      () => getAlbumByMbid("missing-album"),
      (error) => asAppError(error)?.response?.status === 404,
    );
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a metadata request that reaches its turn a moment early by the wall clock is admitted", () => {
  const baseUrl = "http://slots.invalid";
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    assert.equal(reserveMetadataProviderRequest(baseUrl, 100), 0);
    vi.advanceTimersByTime(99);
    assert.equal(reserveMetadataProviderRequest(baseUrl, 100), 0);
    vi.advanceTimersByTime(50);
    assert.equal(reserveMetadataProviderRequest(baseUrl, 100), 50);
  } finally {
    vi.useRealTimers();
  }
});

test("a shared rate limit waits out the turn another process booked, but not a clock that went back", async () => {
  const { default: createRateLimiter } =
    await import("../backend/services/apiClients/rateLimiter.ts");
  const service = "http://shared-pace.invalid";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const limiter = createRateLimiter(1000, { shared: service });
    const startOnce = async () => {
      let startedAt = 0;
      const request = limiter.schedule(() => {
        startedAt = Date.now();
      });
      await vi.runAllTimersAsync();
      await request;
      return startedAt;
    };
    assert.equal(reserveMetadataProviderRequest(service, 1000), 0);
    const bookedAt = Date.now();
    const startedAt = await startOnce();
    assert.ok(startedAt - bookedAt >= 998, `started ${startedAt - bookedAt}ms after the booking`);

    const beforeSkewed = Date.now();
    db.prepare("UPDATE metadata_provider_budget SET next_request_at = ? WHERE base_url = ?").run(
      beforeSkewed + 60 * 60_000,
      service,
    );
    const skewedAt = await startOnce();
    assert.ok(
      skewedAt - beforeSkewed <= 1000,
      `waited ${skewedAt - beforeSkewed}ms on a stale booking`,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("forced refreshes serve stale album metadata when the provider fails", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "stale-album", title: "Last Good Album" }));
      return;
    }
    response.statusCode = 504;
    response.end("timed out");
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    assert.equal((await getAlbumByMbid("stale-album")).title, "Last Good Album");
    assert.equal(
      (await getAlbumByMbid("stale-album", { forceRefresh: true })).title,
      "Last Good Album",
    );
    assert.equal(requests, 3);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("search metadata coalesces concurrent misses and shares fresh cache entries", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  let resolveRequestStarted!: () => void;
  let releaseResponse!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve;
  });
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const requestNumber = ++requests;
    resolveRequestStarted();
    void responseReleased.then(() => {
      response.end(
        JSON.stringify({ artists: [{ id: `artist-${requestNumber}`, name: "Artist" }] }),
      );
    });
  });
  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    const firstRequest = searchArtists("artist", { limit: 10 });
    await requestStarted;
    const secondRequest = searchArtists("artist", { limit: 10 });
    releaseResponse();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(first.items[0]?.id, "artist-1");
    assert.equal(second.items[0]?.id, "artist-1");
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("search pages come out of one full answer", async () => {
  const previousSettings = dbOps.getSettings();
  const limits: string[] = [];
  const row = (index: number) => ({
    id: `id-${index}`,
    name: `Name ${index}`,
    title: `Name ${index}`,
  });
  const rows = Array.from({ length: 30 }, (_value, index) => row(index));
  const server = await createMockHttpServer((request, response) => {
    const url = new URL(request.url || "/", "http://provider.test");
    limits.push(`${url.pathname} ${url.searchParams.get("limit")}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ artists: rows, albums: rows }));
  });
  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: { ...(previousSettings.integrations?.metadata || {}), baseUrl: server.url },
      },
    });
    clearMetadataProviderCaches();

    await trackWork(
      () => "GET /api/search",
      async () => {
        for (const search of [
          (offset: number) => searchArtists("name", { limit: 24, offset }),
          (offset: number) => searchAlbums("name", { limit: 24, offset, sort: "titleAsc" }),
        ]) {
          const first = await search(0);
          const second = await search(24);
          assert.deepEqual([first.count, first.items.length, second.items.length], [30, 24, 6]);
        }
      },
      undefined,
      { request: true },
    );
    assert.deepEqual(limits, ["/v1/search/artist 50", "/v1/search/album 50"]);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("album search shows no results when its MusicBrainz fallback is down", async () => {
  const previousSettings = dbOps.getSettings();
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ albums: [] }));
  });
  const providerGet = http.get.bind(http);
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (url.startsWith("https://musicbrainz.org/")) throw new Error("MusicBrainz unavailable");
    return providerGet(url, options);
  });
  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();

    const result = await trackWork(
      () => "GET /api/search",
      () => searchAlbums("Missing Album"),
      undefined,
      { request: true },
    );
    assert.deepEqual(result.items, []);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a rate limited search waits out Retry-After in the background and fails at once for a request", async () => {
  const sentAt: number[] = [];
  const get = vi.spyOn(http, "get").mockImplementation(async (url) => {
    sentAt.push(Date.now());
    if (sentAt.length > 2) {
      return { status: 200, statusText: "OK", headers: {}, data: { artists: [] } };
    }
    throw new HttpError(
      "Too many requests",
      { method: "GET", url },
      {
        response: {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "30" },
          data: {},
        },
      },
    );
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  try {
    clearMetadataProviderCaches();
    await assert.rejects(
      trackWork(
        () => "GET /api/search",
        () => searchArtists("typed", { throwOnFailure: true }),
        undefined,
        { request: true },
      ),
    );
    assert.equal(sentAt.length, 1);

    assert.deepEqual((await searchArtists("scanned", { throwOnFailure: true })).items, []);
    assert.equal(sentAt.length, 3);
    assert.ok(sentAt[2]! - sentAt[1]! >= 30_000, `retried after ${sentAt[2]! - sentAt[1]!}ms`);
  } finally {
    vi.useRealTimers();
    get.mockRestore();
    clearMetadataProviderCaches();
  }
});
