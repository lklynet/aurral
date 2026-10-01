import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, discoveryIndex] = await setupIsolatedBackend(
  "discovery-flow-settings",
  "backend/db/helpers/index.js",
  "backend/services/discovery/index.js",
);

const { isDiscoveryPersonalizedEnabled } = discoveryIndex;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("personalized discovery is on until the Last.fm setting turns it off", () => {
  const settings = dbOps.getSettings();
  assert.equal(isDiscoveryPersonalizedEnabled(), true);

  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      lastfm: {
        ...(settings.integrations?.lastfm || {}),
        discoveryPersonalizedEnabled: false,
      },
    },
  });
  assert.equal(isDiscoveryPersonalizedEnabled(), false);
});
