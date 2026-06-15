import test from "node:test";
import assert from "node:assert/strict";
import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "./helpers/backendTestHarness.js";
import {
  defaultData,
  DEFAULT_METADATA_BASE_URL,
} from "../backend/config/constants.js";

const isolatedState = await createIsolatedStateDir("metadata-providers");
applyIsolatedBackendEnv(isolatedState);

const { dbOps } = await importFromRepo("backend/config/db-helpers.js");
const {
  __setMetadataProviderHealthStateForTests,
  getMetadataProviderHealthSnapshot,
  getCoverArtArchiveApiBaseUrls,
  getCoverArtArchiveApiBaseUrl,
  getMusicbrainzApiBaseUrls,
  getMusicbrainzApiBaseUrl,
} = await importFromRepo("backend/services/apiClients.js");

test.after(async () => {
  __setMetadataProviderHealthStateForTests("musicbrainz");
  await cleanupIsolatedState(isolatedState);
});

test("default settings use BrainzMash metadata and the official Cover Art Archive endpoint", () => {
  assert.equal(
    defaultData.settings.integrations.metadata.provider,
    "brainzmash",
  );
  assert.equal(
    defaultData.settings.integrations.metadata.baseUrl,
    DEFAULT_METADATA_BASE_URL,
  );
  assert.equal(getMusicbrainzApiBaseUrl(), DEFAULT_METADATA_BASE_URL);
  assert.equal(getCoverArtArchiveApiBaseUrl(), "https://coverartarchive.org");
});

test("backend metadata provider defaults to BrainzMash when unset", () => {
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
  assert.deepEqual(getMusicbrainzApiBaseUrls(), [DEFAULT_METADATA_BASE_URL]);
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

  assert.deepEqual(getMusicbrainzApiBaseUrls(), [
    "https://brainzmash.example.net",
  ]);
  assert.deepEqual(getCoverArtArchiveApiBaseUrls(), [
    "https://coverartarchive.org",
  ]);
});

test("provider health snapshot reports BrainzMash state", () => {
  __setMetadataProviderHealthStateForTests("musicbrainz", {
    failoverActive: true,
    consecutiveFailures: 3,
    lastFailureReason: "HTTP 403",
  });

  const snapshot = getMetadataProviderHealthSnapshot();
  assert.ok(snapshot.brainzmash);
  assert.equal(snapshot.brainzmash.configuredProvider, "brainzmash");
  assert.equal(snapshot.brainzmash.activeBaseUrl, getMusicbrainzApiBaseUrl());
  assert.equal(snapshot.brainzmash.failoverActive, false);
});
