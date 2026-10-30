import { requireFixture } from "./playlists/fixtures.ts";
import { asAppError } from "../lib/errors.ts";
import { test, afterAll, vi } from "vite-plus/test";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
  apiClients,
  brainzmashProvider,
  {
    acquireMetadataRequest,
    clearMetadataRequestStates,
    failMetadataRequest,
    getMetadataProviderBudget,
  },
  { db },
  { default: axios },
] = await setupIsolatedBackend(
  "metadata-providers",
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/services/apiClients/index.ts"),
  () => import("../backend/services/providers/brainzmashProvider.ts"),
  () => import("../backend/services/metadataProviderBudget.ts"),
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../lib/axiosFetch.ts"),
);

const { getMusicbrainzApiBaseUrl } = apiClients;
const {
  clearMetadataProviderCaches,
  getAlbumByMbid,
  getArtistByMbid,
  listArtistAlbums,
  searchAlbums,
  searchArtists,
} = brainzmashProvider;

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const OFFLINE_CHILD_ARGS = ["--import", new URL("./setup-env.ts", import.meta.url).href];

test("default settings and unset backend config use BrainzMash metadata", () => {
  assert.equal(defaultData.settings.integrations.metadata.provider, "brainzmash");
  assert.equal(defaultData.settings.integrations.metadata.baseUrl, DEFAULT_METADATA_BASE_URL);
  assert.equal(getMusicbrainzApiBaseUrl(), DEFAULT_METADATA_BASE_URL);

  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...(dbOps.getSettings().integrations || {}),
      metadata: {
        provider: "brainzmash",
        baseUrl: "",
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
      },
    },
  });

  assert.equal(getMusicbrainzApiBaseUrl(), DEFAULT_METADATA_BASE_URL);
});

test("entity request failures back off for one hour, six hours, then one day", () => {
  const key = "backoff:test";
  const hour = 60 * 60 * 1000;
  let now = 1_000_000;
  clearMetadataRequestStates();

  const first = acquireMetadataRequest(key, 120_000, now);
  assert.equal(first.acquired, true);
  assert.equal(failMetadataRequest(key, first.acquired ? first.token : "", now), now + hour);

  now += hour;
  const second = acquireMetadataRequest(key, 120_000, now);
  assert.equal(second.acquired, true);
  assert.equal(failMetadataRequest(key, second.acquired ? second.token : "", now), now + 6 * hour);

  now += 6 * hour;
  const third = acquireMetadataRequest(key, 120_000, now);
  assert.equal(third.acquired, true);
  assert.equal(failMetadataRequest(key, third.acquired ? third.token : "", now), now + 24 * hour);
  clearMetadataRequestStates();
});

test("an abandoned entity request enters cooldown when its lease expires", () => {
  const key = "abandoned:test";
  const now = 2_000_000;
  clearMetadataRequestStates();
  assert.equal(acquireMetadataRequest(key, 1_000, now).acquired, true);

  const recovered = acquireMetadataRequest(key, 1_000, now + 1_001);
  assert.equal(recovered.acquired, false);
  assert.equal(recovered.retryAfter, now + 1_001 + 60 * 60 * 1000);
  clearMetadataRequestStates();
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();
    const year = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await dbOps.setMetadataResponseAsync(`${server.url}/album/album-x:{}`, {
      value: { id: 7 },
      freshUntil: year,
      staleUntil: year,
    });

    await assert.rejects(
      () => getAlbumByMbid("album-x"),
      /BrainzMash sent \/album\/album-x data Aurral can't read/,
    );
    assert.equal((await getAlbumByMbid("album-x")).title, "Album");
    assert.equal(requests, 2);
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
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
      const { getAlbumByMbid } = await import("./backend/services/providers/brainzmashProvider.ts");
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
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
      const { getAlbumByMbid, searchArtists } = await import("./backend/services/providers/brainzmashProvider.ts");
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
        artistname: "Calendar Artist",
        Albums: [
          {
            Id: releaseMbid,
            Title: requests === 1 ? "Cached Release" : "Current Release",
            Type: "Album",
            ReleaseStatuses: ["Official"],
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    const first = await listArtistAlbums(artistMbid, { hydrateLimit: 0 });
    const cached = await listArtistAlbums(artistMbid, { hydrateLimit: 0 });
    const refreshed = await listArtistAlbums(artistMbid, {
      hydrateLimit: 0,
      forceRefresh: true,
    });

    assert.equal(first[0].title, "Cached Release");
    assert.equal(cached[0].title, "Cached Release");
    assert.equal(refreshed[0].title, "Current Release");
    assert.equal(requests, 2);
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
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

test("transient entity failures use a persistent cooldown instead of redownloading", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 503;
    response.end("temporarily unavailable");
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    await assert.rejects(() => getAlbumByMbid("large-album"));
    await assert.rejects(
      () => getAlbumByMbid("large-album"),
      (error) => asAppError(error)?.code === "ERR_METADATA_COOLDOWN",
    );
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("local request admission timeouts do not put entity metadata into cooldown", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "admission-artist", artistname: "Admission Artist" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();
    db.prepare(
      `INSERT INTO metadata_provider_budget(base_url, next_request_at)
       VALUES (?, ?)
       ON CONFLICT(base_url) DO UPDATE SET next_request_at = excluded.next_request_at`,
    ).run(server.url, Date.now() + 60_000);

    await assert.rejects(
      () => getArtistByMbid("admission-artist"),
      (error) => asAppError(error)?.code === "ETIMEDOUT",
    );
    assert.equal(requests, 0);
    assert.deepEqual(
      db
        .prepare<
          [string],
          { failure_count: number; retry_after: number; lease_token: string | null }
        >(
          `SELECT failure_count, retry_after, lease_token
           FROM metadata_request_state WHERE cache_key LIKE ?`,
        )
        .get("%admission-artist%"),
      { failure_count: 0, retry_after: 0, lease_token: null },
    );

    db.prepare("UPDATE metadata_provider_budget SET next_request_at = 0 WHERE base_url = ?").run(
      server.url,
    );
    assert.equal((await getArtistByMbid("admission-artist")).name, "Admission Artist");
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    assert.equal((await getAlbumByMbid("stale-album")).title, "Last Good Album");
    assert.equal(
      (await getAlbumByMbid("stale-album", { forceRefresh: true })).title,
      "Last Good Album",
    );
    assert.equal(
      (await getAlbumByMbid("stale-album", { forceRefresh: true })).title,
      "Last Good Album",
    );
    assert.equal(requests, 2);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("an album 429 makes only that album wait out its retry-after", async () => {
  const previousSettings = dbOps.getSettings();
  const requested: string[] = [];
  const server = await createMockHttpServer((request, response) => {
    requested.push(request.url || "");
    if (request.url?.startsWith("/album/repeat-album")) {
      response.statusCode = 429;
      response.setHeader("retry-after", "604800");
      response.end(JSON.stringify({ error: "album request is temporarily rate limited" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "other-album", title: "Other Album" }));
  });
  const waitsAboutAWeek = () =>
    assert.rejects(
      () => getAlbumByMbid("repeat-album"),
      (error) =>
        asAppError(error)?.code === "ERR_METADATA_COOLDOWN" &&
        error instanceof Error &&
        "retryAfterMs" in error &&
        Number(error.retryAfterMs) > 6 * 24 * 60 * 60 * 1000,
    );

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    await waitsAboutAWeek();
    await waitsAboutAWeek();
    assert.equal((await getAlbumByMbid("other-album")).title, "Other Album");
    assert.deepEqual(requested, ["/album/repeat-album", "/album/other-album"]);
    assert.equal(Number(getMetadataProviderBudget(server.url).rate_limited_until), 0);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a search 429 pauses every metadata request for at most fifteen minutes", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.statusCode = 429;
    response.setHeader("retry-after", "604800");
    response.end("rate limited");
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    await assert.rejects(
      () => searchAlbums("Rate Limited", { throwOnFailure: true }),
      (error) => asAppError(error)?.response?.status === 429,
    );
    await assert.rejects(
      () => getArtistByMbid("another-artist"),
      (error) => asAppError(error)?.code === "ERR_METADATA_RATE_LIMITED",
    );
    assert.equal(requests, 1);
    const cooldownMs =
      Number(getMetadataProviderBudget(server.url).rate_limited_until) - Date.now();
    assert.ok(cooldownMs > 14 * 60 * 1000 && cooldownMs <= 15 * 60 * 1000);
    const providerUrl = new URL(
      "../backend/services/providers/brainzmashProvider.ts",
      import.meta.url,
    ).href;
    const probe = `const { getArtistByMbid } = await import(${JSON.stringify(providerUrl)});
      try { await getArtistByMbid("other-process-cooldown"); console.log(JSON.stringify({ ok: true })); }
      catch (error) { console.log(JSON.stringify({ code: error.code })); }
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", probe],
      {
        env: { ...process.env },
        timeout: 10000,
      },
    );
    assert.equal(
      JSON.parse(requireFixture(stdout.trim().split("\n").at(-1))).code,
      "ERR_METADATA_RATE_LIMITED",
    );
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a metadata 403 opens a shared blocked cooldown for subsequent requests", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist-2", name: "Artist" }));
  });

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    const blocked = getArtistByMbid("blocked-artist").catch((error) => error);
    const queued = getArtistByMbid("queued-artist").catch((error) => error);
    assert.equal((await blocked).response?.status, 403);
    const blockedUntil = getMetadataProviderBudget(server.url).forbidden_until;
    assert.equal((await queued).code, "ERR_METADATA_FORBIDDEN");
    assert.equal(getMetadataProviderBudget(server.url).forbidden_until, blockedUntil);
    clearMetadataProviderCaches();
    await assert.rejects(
      () => getArtistByMbid("another-artist"),
      (error) => asAppError(error)?.code === "ERR_METADATA_FORBIDDEN",
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        ...OFFLINE_CHILD_ARGS,
        "--input-type=module",
        "-e",
        `
      const { getArtistByMbid } = await import("./backend/services/providers/brainzmashProvider.ts");
      try { await getArtistByMbid("another-process-blocked"); }
      catch (error) { console.log(JSON.stringify({ code: error.code })); }
      process.exit(0);
    `,
      ],
      { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 },
    );
    assert.equal(
      JSON.parse(requireFixture(stdout.trim().split("\n").at(-1))).code,
      "ERR_METADATA_FORBIDDEN",
    );
    assert.equal(requests, 1);
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
      response.end(JSON.stringify([{ id: `artist-${requestNumber}`, name: "Artist" }]));
    });
  });
  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();

    const firstRequest = searchArtists("artist", { limit: 10 });
    await requestStarted;
    const secondRequest = searchArtists("artist", { limit: 10 });
    releaseResponse();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(first.items[0].id, "artist-1");
    assert.equal(second.items[0].id, "artist-1");
    assert.equal(requests, 1);
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
    response.end("[]");
  });
  const providerGet = axios.get.bind(axios);
  vi.spyOn(axios, "get").mockImplementation(async (url, options) => {
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
          provider: "brainzmash",
          baseUrl: server.url,
          enableNarrowFallbacks: true,
        },
      },
    });
    clearMetadataProviderCaches();

    assert.deepEqual((await searchAlbums("Missing Album")).items, []);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("BrainzMash rejects the saturation boundary before its deadline", async () => {
  const previousSettings = dbOps.getSettings();
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Name: "Saturation" }));
  });
  const controller = new AbortController();
  let requests: ReturnType<typeof getArtistByMbid>[] = [];

  try {
    dbOps.updateSettings({
      ...previousSettings,
      integrations: {
        ...(previousSettings.integrations || {}),
        metadata: {
          ...(previousSettings.integrations?.metadata || {}),
          provider: "brainzmash",
          baseUrl: server.url,
        },
      },
    });
    clearMetadataProviderCaches();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    requests = Array.from({ length: 81 }, (_, index) =>
      getArtistByMbid(`saturation-${index}`, { signal: controller.signal }),
    );
    const boundary = await Promise.race([
      requests[80].then(
        () => "resolved",
        (error) => error.code || error.name,
      ),
      vi.advanceTimersByTimeAsync(7_999).then(() => "late"),
    ]);
    assert.equal(boundary, "EQUEUEFULL");
  } finally {
    vi.useRealTimers();
    controller.abort();
    await Promise.allSettled(requests);
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("independent provider processes share request admission", async () => {
  const previous = dbOps.getSettings();
  const arrivals: number[] = [];
  const server = await createMockHttpServer((_request, response) => {
    arrivals.push(performance.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist", name: "Artist" }));
  });
  let children: ChildProcess[] = [];
  try {
    dbOps.updateSettings({
      ...previous,
      integrations: {
        ...previous.integrations,
        metadata: {
          ...previous.integrations?.metadata,
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();
    children = Array.from({ length: 2 }, () =>
      fork(fileURLToPath(new URL("./fixtures/metadata-provider-child.mts", import.meta.url)), [], {
        env: { ...process.env },
        execArgv: OFFLINE_CHILD_ARGS,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    );
    await Promise.all(
      children.map((child) => new Promise<void>((resolve) => child.once("message", resolve))),
    );
    const startAtPerf = performance.now();
    await Promise.all(
      children.map(async (child, childIndex) => {
        for (let index = 0; index < 3; index++) {
          const done = new Promise<{ ok: boolean }>((resolve) => child.once("message", resolve));
          child.send({ type: "request", mbid: `child-${childIndex}-${index}` });
          assert.equal((await done).ok, true);
        }
      }),
    );
    assert.equal(arrivals.length, 6);
    assert.ok(
      arrivals.at(-1)! - startAtPerf >= 450,
      "independent processes admitted a request burst",
    );
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", resolve);
            child.send({ type: "shutdown" });
          }),
      ),
    );
    clearMetadataProviderCaches();
    dbOps.updateSettings(previous);
    await server.close();
  }
});

test("independent provider processes share one active entity request", async () => {
  const previous = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    setTimeout(() => response.end(JSON.stringify({ id: "shared-artist", name: "Artist" })), 500);
  });
  let children: ChildProcess[] = [];
  try {
    dbOps.updateSettings({
      ...previous,
      integrations: {
        ...previous.integrations,
        metadata: {
          ...previous.integrations?.metadata,
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();
    children = Array.from({ length: 2 }, () =>
      fork(fileURLToPath(new URL("./fixtures/metadata-provider-child.mts", import.meta.url)), [], {
        env: { ...process.env },
        execArgv: OFFLINE_CHILD_ARGS,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    );
    await Promise.all(
      children.map((child) => new Promise<void>((resolve) => child.once("message", resolve))),
    );
    const results = children.map(
      (child) =>
        new Promise<{ ok: boolean }>((resolve) => {
          child.once("message", resolve);
          child.send({ type: "request", mbid: "shared-artist" });
        }),
    );
    assert.ok((await Promise.all(results)).every((result) => result.ok));
    assert.equal(requests, 1);
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", resolve);
            child.send({ type: "shutdown" });
          }),
      ),
    );
    clearMetadataProviderCaches();
    dbOps.updateSettings(previous);
    await server.close();
  }
});

test("clearing caches preserves provider spacing for another process", async () => {
  const previous = dbOps.getSettings();
  const arrivals: number[] = [];
  const server = await createMockHttpServer((_request, response) => {
    arrivals.push(performance.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist", name: "Artist" }));
  });
  let child: ChildProcess | undefined;
  try {
    dbOps.updateSettings({
      ...previous,
      integrations: {
        ...previous.integrations,
        metadata: {
          ...previous.integrations?.metadata,
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    clearMetadataProviderCaches();
    child = fork(
      fileURLToPath(new URL("./fixtures/metadata-provider-child.mts", import.meta.url)),
      [],
      {
        env: { ...process.env },
        execArgv: OFFLINE_CHILD_ARGS,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const spawned = child;
    await new Promise<void>((resolve) => spawned.once("message", resolve));
    const beforeFirstRequest = performance.now();
    await getArtistByMbid("before-cache-clear");
    clearMetadataProviderCaches();
    const done = new Promise<{ ok: boolean }>((resolve) => spawned.once("message", resolve));
    spawned.send({ type: "request", mbid: "after-cache-clear" });
    assert.equal((await done).ok, true);
    assert.equal(arrivals.length, 2);
    assert.ok(
      arrivals[1] - beforeFirstRequest >= 95,
      "cache clearing allowed an aggregate request burst",
    );
  } finally {
    const running = child;
    if (running)
      await new Promise<void>((resolve) => {
        running.once("exit", resolve);
        running.send({ type: "shutdown" });
      });
    clearMetadataProviderCaches();
    dbOps.updateSettings(previous);
    await server.close();
  }
});
