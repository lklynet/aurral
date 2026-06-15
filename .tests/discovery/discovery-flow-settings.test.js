import test from "node:test";
import assert from "node:assert/strict";
import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("discovery-flow-settings");
applyIsolatedBackendEnv(isolatedState);

const { dbOps } = await importFromRepo("backend/config/db-helpers.js");
const {
  getDiscoveryRecommendationsPerRefresh,
  getDiscoveryFlowsPerRefresh,
  getMaxFocusPlaylists,
} = await importFromRepo("backend/services/discoveryService.js");
const { resolveFocusSlotBudgets } = await importFromRepo(
  "backend/services/discoverPlaylistService.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("discovery flow settings use defaults when unset", () => {
  assert.equal(getDiscoveryRecommendationsPerRefresh(), 200);
  assert.equal(getDiscoveryFlowsPerRefresh(), 9);
  assert.equal(getMaxFocusPlaylists(), 4);
});

test("discovery flow settings clamp configured values", () => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      lastfm: {
        ...(settings.integrations?.lastfm || {}),
        discoveryRecommendationsPerRefresh: 999,
        discoveryFlowsPerRefresh: 99,
      },
    },
  });
  assert.equal(getDiscoveryRecommendationsPerRefresh(), 500);
  assert.equal(getDiscoveryFlowsPerRefresh(), 32);
  assert.equal(getMaxFocusPlaylists(), 27);
});

test("resolveFocusSlotBudgets scales with max focus playlists", () => {
  assert.deepEqual(resolveFocusSlotBudgets(8), {
    maxFocus: 8,
    tag: 3,
    artist: 3,
    crossover: 2,
  });
  assert.deepEqual(resolveFocusSlotBudgets(0), {
    maxFocus: 0,
    tag: 0,
    artist: 0,
    crossover: 0,
  });
});
