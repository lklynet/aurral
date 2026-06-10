import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-artwork");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { dbOps }, { flowPlaylistConfig }, { WeeklyFlowPlaylistManager }] =
  await Promise.all([
    importFromRepo("backend/config/db-sqlite.js"),
    importFromRepo("backend/config/db-helpers.js"),
    importFromRepo("backend/services/weeklyFlowPlaylistConfig.js"),
    importFromRepo("backend/services/weeklyFlowPlaylistManager.js"),
  ]);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    weeklyFlows: [],
    sharedFlowPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("writes WebP sidecar artwork for flow and playlist smart playlists", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Late Night",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  flowPlaylistConfig.createSharedPlaylist({
    name: "Road Trip",
    tracks: [{ artistName: "A", trackName: "One" }],
  });

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensureSmartPlaylists();

  const flowName = manager._getFlowPlaylistNames("Late Night").current;
  const flowBase = manager._sanitize(flowName);
  const flowNsp = path.join(manager.libraryRoot, `${flowBase}.nsp`);
  const flowWebp = path.join(manager.libraryRoot, `${flowBase}.webp`);

  const playlistName = manager._getSharedPlaylistNames("Road Trip").current;
  const playlistBase = manager._sanitize(playlistName);
  const playlistNsp = path.join(manager.libraryRoot, `${playlistBase}.nsp`);
  const playlistWebp = path.join(manager.libraryRoot, `${playlistBase}.webp`);

  await assert.doesNotReject(() => fs.access(flowNsp));
  await assert.doesNotReject(() => fs.access(flowWebp));
  await assert.doesNotReject(() => fs.access(playlistNsp));
  await assert.doesNotReject(() => fs.access(playlistWebp));

  const flowMeta = await sharp(flowWebp).metadata();
  assert.equal(flowMeta.width, 1000);
  assert.equal(flowMeta.height, 1000);
  assert.equal(flowMeta.format, "webp");

  const playlistMeta = await sharp(playlistWebp).metadata();
  assert.equal(playlistMeta.width, 1000);
  assert.equal(playlistMeta.height, 1000);
  assert.equal(playlistMeta.format, "webp");
});

test("removes old sidecar artwork when a flow is renamed", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Old Name",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensureSmartPlaylists();

  const oldName = manager._getFlowPlaylistNames("Old Name").current;
  const oldBase = manager._sanitize(oldName);
  const oldNsp = path.join(manager.libraryRoot, `${oldBase}.nsp`);
  const oldWebp = path.join(manager.libraryRoot, `${oldBase}.webp`);
  await assert.doesNotReject(() => fs.access(oldNsp));
  await assert.doesNotReject(() => fs.access(oldWebp));

  flowPlaylistConfig.updateFlow(flow.id, { name: "New Name" });
  await manager.ensureSmartPlaylists();

  const newName = manager._getFlowPlaylistNames("New Name").current;
  const newBase = manager._sanitize(newName);
  const newNsp = path.join(manager.libraryRoot, `${newBase}.nsp`);
  const newWebp = path.join(manager.libraryRoot, `${newBase}.webp`);
  await assert.doesNotReject(() => fs.access(newNsp));
  await assert.doesNotReject(() => fs.access(newWebp));

  await assert.rejects(() => fs.access(oldNsp));
  await assert.rejects(() => fs.access(oldWebp));
});

test("does not regenerate artwork after explicit remove until generate", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "No Regen",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensureSmartPlaylists();

  const flowWebp = path.join(
    manager.libraryRoot,
    `${manager._sanitize(manager._getFlowPlaylistNames("No Regen").current)}.webp`,
  );
  await assert.doesNotReject(() => fs.access(flowWebp));

  await manager.removeArtwork(flow.id);
  await assert.rejects(() => fs.access(flowWebp));

  await manager.ensureSmartPlaylists();
  await assert.rejects(() => fs.access(flowWebp));

  await manager.generateArtwork(flow.id);
  await assert.doesNotReject(() => fs.access(flowWebp));
});

