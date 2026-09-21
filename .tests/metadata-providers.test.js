import test from "node:test";
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

const [isolatedState, { dbOps }, apiClients, brainzmashProvider] = await setupIsolatedBackend(
  "metadata-providers",
  "backend/db/helpers/index.js",
  "backend/services/apiClients/index.js",
  "backend/services/providers/brainzmashProvider.js",
);

const {
  getMetadataProviderHealthSnapshot,
  getMusicbrainzApiBaseUrl,
} = apiClients;
const {
  clearMetadataProviderCaches,
  getAlbumByMbid,
  getArtistByMbid,
  searchArtists,
} = brainzmashProvider;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

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

test("a metadata 429 opens a local cooldown for subsequent requests", async () => {
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
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(previousSettings);
    await server.close();
  }
});

test("a metadata 403 opens a local blocked cooldown for subsequent requests", async () => {
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

    await assert.rejects(
      () => getArtistByMbid("blocked-artist"),
      (error) => error.response?.status === 403,
    );
    await assert.rejects(
      () => getArtistByMbid("another-artist"),
      (error) => error.code === "ERR_METADATA_FORBIDDEN",
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
