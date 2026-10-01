import test from "node:test";
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
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
);
const { flowPlaylistConfig } = playlistConfigModule;
const { getDiscoverPlaylistPreset } = await import("../../backend/config/discoverPlaylistPresets.js");
const { EDITORIAL_PLAYLIST_POOL } = await import("../../backend/config/editorialPlaylistPresets.js");
const editorialDescription = (id) => EDITORIAL_PLAYLIST_POOL.find((preset) => preset.id === id).description;

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
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

test("a flow with no discoverPresetId and no description has a null description, not an error", () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Manual Flow", size: 20 });
  assert.equal(flow.description, null);
});

test("a flow whose discoverPresetId doesn't match any known preset falls back to null rather than throwing", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Orphaned Preset Flow",
    size: 20,
    discoverPresetId: "no-such-preset-id",
  });
  assert.equal(flow.description, null);
});

test("editorial preset descriptions are found too (a separate catalog from personal presets)", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Metal Mayhem",
    size: 20,
    discoverPresetId: "top-metal",
    type: "editorial",
  });
  assert.equal(flow.description, editorialDescription("top-metal"));
});

test("shared playlists get the same fallback treatment as flows", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Heavy Rotation",
    sourceName: "Heavy Rotation",
    discoverPresetId: "top-metal",
    type: "editorial",
  });
  assert.equal(playlist.description, editorialDescription("top-metal"));
});

test("an explicit shared playlist description is kept as-is", () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "My Import",
    sourceName: "My Import",
    description: "Imported from Spotify",
  });
  assert.equal(playlist.description, "Imported from Spotify");
});
