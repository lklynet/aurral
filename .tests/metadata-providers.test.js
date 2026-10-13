import test from "node:test";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "./helpers/backendTestHarness.js";
import {
  defaultData,
  DEFAULT_METADATA_BASE_URL,
} from "../backend/config/constants.js";

const [isolatedState, { dbOps }, apiClients, brainzmashProvider, { getMetadataProviderBudget }, { db }] =
  await setupIsolatedBackend(
    "metadata-providers",
    "backend/db/helpers/index.js",
    "backend/services/apiClients/index.js",
    "backend/services/providers/brainzmashProvider.js",
    "backend/services/metadataProviderBudget.js",
    "backend/config/db-sqlite.js",
  );

const {
  getMetadataProviderHealthSnapshot,
  getMusicbrainzApiBaseUrl,
} = apiClients;
const {
  clearMetadataProviderCaches,
  getAlbumByMbid,
  getArtistByMbid,
  listArtistAlbums,
  searchArtists,
} = brainzmashProvider;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const OFFLINE_CHILD_ARGS = ["--import", new URL("./setup-env.js", import.meta.url).href];

test("default settings and unset backend config use BrainzMash metadata", () => {
  assert.equal(
    defaultData.settings.integrations.metadata.provider,
    "brainzmash",
  );
  assert.equal(
    defaultData.settings.integrations.metadata.baseUrl,
    DEFAULT_METADATA_BASE_URL,
  );
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

test("custom BrainzMash base URL is respected end to end", () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...(dbOps.getSettings().integrations || {}),
      metadata: {
        provider: "brainzmash",
        baseUrl: "https://brainzmash.example.net",
        userAgentSuffix: "AurralTest",
        enableNarrowFallbacks: false,
      },
    },
  });

  assert.equal(getMusicbrainzApiBaseUrl(), "https://brainzmash.example.net");
});

test("stale album metadata is served while one refresh runs in the background", async () => {
  const previousSettings = dbOps.getSettings();
  const serverResponses = ["Album v1", "Album v2"];
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const title = serverResponses[Math.min(requests, serverResponses.length - 1)];
    requests += 1;
    response.end(JSON.stringify({ id: "album-1", title }));
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
    const [stale, staleAgain] = await Promise.all([
      getAlbumByMbid("album-1"),
      getAlbumByMbid("album-1"),
    ]);
    assert.equal(stale.title, "Album v1");
    assert.equal(staleAgain.title, "Album v1");

    const refreshed = await new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer;
      const timeout = setTimeout(
        () => {
          settled = true;
          clearTimeout(pollTimer);
          reject(new Error("Timed out waiting for the stale metadata refresh"));
        },
        1000,
      );
      const poll = async () => {
        if (settled) return;
        try {
          const album = await getAlbumByMbid("album-1");
          if (settled) return;
          if (album.title === "Album v2") {
            settled = true;
            clearTimeout(timeout);
            resolve(album);
            return;
          }
          pollTimer = setTimeout(poll, 10);
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      };
      poll();
    });
    assert.equal(requests, 2);
    assert.equal(refreshed.title, "Album v2");
  } finally {
    Date.now = originalNow;
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
    const { stdout } = await promisify(execFile)(process.execPath, [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", `
      const { getAlbumByMbid } = await import("./backend/services/providers/brainzmashProvider.js");
      const album = await getAlbumByMbid("persisted-album");
      console.log(JSON.stringify({ title: album.title }));
      process.exit(0);
    `], { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 });
    assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).title, "Persisted Album");
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
    response.end(JSON.stringify({ id: request.url.split("/").at(-1), title: "Album" }));
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

    await promisify(execFile)(process.execPath, [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", `
      const day = 24 * 60 * 60 * 1000;
      const realNow = Date.now;
      let elapsed = 0;
      Date.now = () => realNow() - 40 * day + elapsed;
      const { getAlbumByMbid, searchArtists } = await import("./backend/services/providers/brainzmashProvider.js");
      await getAlbumByMbid("expiring-album");
      await searchArtists("expiring search", { limit: 10 });
      elapsed = 38 * day;
      await getAlbumByMbid("current-album");
      process.exit(0);
    `], { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 });

    const keys = db.prepare("SELECT cache_key FROM metadata_response_cache").all()
      .map((row) => row.cache_key);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /\/album\/current-album:/);
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
    response.end(JSON.stringify({
      Id: artistMbid,
      Name: "Calendar Artist",
      Albums: [{
        Id: releaseMbid,
        Title: requests === 1 ? "Cached Release" : "Current Release",
        Type: "Album",
        FirstReleaseDate: "2026-09-20",
        ReleaseStatuses: ["Official"],
      }],
    }));
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
      (error) => error.response?.status === 404,
    );
    await assert.rejects(
      () => getAlbumByMbid("missing-album"),
      (error) => error.response?.status === 404,
    );
    assert.equal(requests, 1);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a metadata 429 opens a shared cooldown for subsequent requests", async () => {
  const previousSettings = dbOps.getSettings();
  let requests = 0;
  const server = await createMockHttpServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.statusCode = 429;
      response.setHeader("retry-after", "60");
      response.end("rate limited");
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

    await assert.rejects(
      () => getArtistByMbid("rate-limited-artist"),
      (error) => error.response?.status === 429,
    );
    await assert.rejects(
      () => getArtistByMbid("another-artist"),
      (error) => error.code === "ERR_METADATA_RATE_LIMITED",
    );
    assert.equal(requests, 1);
    const providerUrl = new URL("../backend/services/providers/brainzmashProvider.js", import.meta.url).href;
    const probe = `const { getArtistByMbid } = await import(${JSON.stringify(providerUrl)});
      try { await getArtistByMbid("other-process-cooldown"); console.log(JSON.stringify({ ok: true })); }
      catch (error) { console.log(JSON.stringify({ code: error.code })); }
      process.exit(0);`;
    const { stdout } = await promisify(execFile)(process.execPath, [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", probe], {
      env: { ...process.env },
      timeout: 10000,
    });
    assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).code, "ERR_METADATA_RATE_LIMITED");
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
      (error) => error.code === "ERR_METADATA_FORBIDDEN",
    );
    const { stdout } = await promisify(execFile)(process.execPath, [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", `
      const { getArtistByMbid } = await import("./backend/services/providers/brainzmashProvider.js");
      try { await getArtistByMbid("another-process-blocked"); }
      catch (error) { console.log(JSON.stringify({ code: error.code })); }
      process.exit(0);
    `], { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 });
    assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).code, "ERR_METADATA_FORBIDDEN");
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
  let resolveRequestStarted;
  let releaseResponse;
  const requestStarted = new Promise((resolve) => {
    resolveRequestStarted = resolve;
  });
  const responseReleased = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const requestNumber = ++requests;
    resolveRequestStarted();
    responseReleased.then(() => {
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

test("provider health snapshot reports BrainzMash state", () => {
  const snapshot = getMetadataProviderHealthSnapshot();
  assert.ok(snapshot.brainzmash);
  assert.equal(snapshot.brainzmash.configuredProvider, "brainzmash");
  assert.equal(snapshot.brainzmash.activeBaseUrl, getMusicbrainzApiBaseUrl());
  assert.equal(snapshot.brainzmash.failoverActive, false);
});

test("BrainzMash rejects the saturation boundary before its deadline", async () => {
  const previousSettings = dbOps.getSettings();
  const server = await createMockHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Name: "Saturation" }));
  });
  const controller = new AbortController();
  let requests = [];
  let timeout = null;

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
    requests = Array.from({ length: 81 }, (_, index) =>
      getArtistByMbid(`saturation-${index}`, { signal: controller.signal }),
    );
    const boundary = await Promise.race([
      requests[80].then(
        () => "resolved",
        (error) => error.code || error.name,
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("late"), 50);
      }),
    ]);
    assert.equal(boundary, "EQUEUEFULL");
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    await Promise.allSettled(requests);
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("independent provider processes share request admission", async () => {
  const previous = dbOps.getSettings();
  const arrivals = [];
  const server = await createMockHttpServer((_request, response) => {
    arrivals.push(performance.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist", name: "Artist" }));
  });
  try {
    dbOps.updateSettings({ ...previous, integrations: { ...previous.integrations,
      metadata: { ...previous.integrations?.metadata, baseUrl: server.url, enableNarrowFallbacks: false } } });
    clearMetadataProviderCaches();
    const startAt = Date.now() + 1500;
    const startAtPerf = performance.now() + 1500;
    await Promise.all(["first", "second"].map((prefix) => promisify(execFile)(process.execPath,
      [...OFFLINE_CHILD_ARGS, "--input-type=module", "-e", `
        const { getArtistByMbid } = await import("./backend/services/providers/brainzmashProvider.js");
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${startAt} - Date.now())));
        for (let index = 0; index < 3; index++) await getArtistByMbid(${JSON.stringify(prefix)} + index);
        process.exit(0);
      `], { cwd: process.cwd(), env: { ...process.env }, timeout: 10000 })));
    assert.equal(arrivals.length, 6);
    assert.ok(arrivals.at(-1) - startAtPerf >= 450, "independent processes admitted a request burst");
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previous);
    await server.close();
  }
});

test("clearing caches preserves provider spacing for another process", async () => {
  const previous = dbOps.getSettings();
  const arrivals = [];
  const server = await createMockHttpServer((_request, response) => {
    arrivals.push(performance.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "artist", name: "Artist" }));
  });
  let child;
  try {
    dbOps.updateSettings({ ...previous, integrations: { ...previous.integrations,
      metadata: { ...previous.integrations?.metadata, baseUrl: server.url, enableNarrowFallbacks: false } } });
    clearMetadataProviderCaches();
    child = fork(fileURLToPath(new URL("./fixtures/metadata-provider-child.mjs", import.meta.url)), [],
      { env: { ...process.env }, execArgv: OFFLINE_CHILD_ARGS, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise((resolve) => child.once("message", resolve));
    const beforeFirstRequest = performance.now();
    await getArtistByMbid("before-cache-clear");
    clearMetadataProviderCaches();
    const done = new Promise((resolve) => child.once("message", resolve));
    child.send({ type: "request", mbid: "after-cache-clear" });
    assert.equal((await done).ok, true);
    assert.equal(arrivals.length, 2);
    assert.ok(arrivals[1] - beforeFirstRequest >= 95, "cache clearing allowed an aggregate request burst");
  } finally {
    if (child) await new Promise((resolve) => { child.once("exit", resolve); child.send({ type: "shutdown" }); });
    clearMetadataProviderCaches();
    dbOps.updateSettings(previous);
    await server.close();
  }
});
