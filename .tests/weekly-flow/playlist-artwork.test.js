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

test("writes PNG sidecar artwork for flow and playlist smart playlists", async () => {
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
  const flowPng = path.join(manager.libraryRoot, `${flowBase}.png`);

  const playlistName = manager._getSharedPlaylistNames("Road Trip").current;
  const playlistBase = manager._sanitize(playlistName);
  const playlistNsp = path.join(manager.libraryRoot, `${playlistBase}.nsp`);
  const playlistPng = path.join(manager.libraryRoot, `${playlistBase}.png`);

  await assert.doesNotReject(() => fs.access(flowNsp));
  await assert.doesNotReject(() => fs.access(flowPng));
  await assert.doesNotReject(() => fs.access(playlistNsp));
  await assert.doesNotReject(() => fs.access(playlistPng));

  const flowMeta = await sharp(flowPng).metadata();
  assert.equal(flowMeta.width, 1000);
  assert.equal(flowMeta.height, 1000);

  const playlistMeta = await sharp(playlistPng).metadata();
  assert.equal(playlistMeta.width, 1000);
  assert.equal(playlistMeta.height, 1000);
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
  const oldPng = path.join(manager.libraryRoot, `${oldBase}.png`);
  await assert.doesNotReject(() => fs.access(oldNsp));
  await assert.doesNotReject(() => fs.access(oldPng));

  flowPlaylistConfig.updateFlow(flow.id, { name: "New Name" });
  await manager.ensureSmartPlaylists();

  const newName = manager._getFlowPlaylistNames("New Name").current;
  const newBase = manager._sanitize(newName);
  const newNsp = path.join(manager.libraryRoot, `${newBase}.nsp`);
  const newPng = path.join(manager.libraryRoot, `${newBase}.png`);
  await assert.doesNotReject(() => fs.access(newNsp));
  await assert.doesNotReject(() => fs.access(newPng));

  await assert.rejects(() => fs.access(oldNsp));
  await assert.rejects(() => fs.access(oldPng));
});

