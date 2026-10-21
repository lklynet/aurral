import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, playlistConfigModule] = await setupIsolatedBackend(
  "playlist-description-fallback",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
);
const { flowPlaylistConfig } = playlistConfigModule;
const { getDiscoverPlaylistPreset } =
  await import("../../backend/config/discoverPlaylistPresets.js");

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("an explicit flow description is kept as-is, not overridden by the preset catalog", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Custom Name",
    size: 20,
    discoverPresetId: "discover-weekly",
    description: "My own custom description",
  });
  assert.equal(flow.description, "My own custom description");
});

test("a flow adopted from a preset with no description of its own falls back to the current catalog description", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Listening History",
    size: 20,
    discoverPresetId: "focus-listening-history",
  });
  assert.equal(flow.description, getDiscoverPlaylistPreset("focus-listening-history").description);
});

test("a flow whose discoverPresetId doesn't match any known preset falls back to null rather than throwing", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Orphaned Preset Flow",
    size: 20,
    discoverPresetId: "no-such-preset-id",
  });
  assert.equal(flow.description, null);
});

test("static playlists get the same fallback treatment as flows", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Heavy Rotation",
    sourceName: "Heavy Rotation",
    discoverPresetId: "discover-weekly",
  });
  assert.equal(playlist.description, getDiscoverPlaylistPreset("discover-weekly").description);
});
