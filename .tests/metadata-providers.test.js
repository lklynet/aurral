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
const { clearMetadataProviderCaches, getArtistByMbid } = brainzmashProvider;

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
