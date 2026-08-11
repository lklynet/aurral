import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { flowPlaylistConfig }, { WeeklyFlowPlaylistManager }] =
  await setupIsolatedBackend(
    "playlist-artwork",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    playlistArtwork: { style: "aurral" },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("writes WebP sidecar artwork for flow and playlist m3u files", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Late Night",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Road Trip",
    tracks: [{ artistName: "A", trackName: "One" }],
  });

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensurePlaylists();

  const flowName = manager.getPlaylistName(flow.id);
  const flowBase = manager._sanitize(flowName);
  const flowM3u = path.join(manager.libraryRoot, `${flowBase}.m3u`);
  const flowWebp = path.join(manager.libraryRoot, `${flowBase}.webp`);

  const playlistName = manager.getPlaylistName(playlist.id);
  const playlistBase = manager._sanitize(playlistName);
  const playlistM3u = path.join(manager.libraryRoot, `${playlistBase}.m3u`);
  const playlistWebp = path.join(manager.libraryRoot, `${playlistBase}.webp`);

  await assert.doesNotReject(() => fs.access(flowM3u));
  await assert.doesNotReject(() => fs.access(flowWebp));
  await assert.doesNotReject(() => fs.access(playlistM3u));
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
  await manager.ensurePlaylists();

  const oldName = manager.getPlaylistName(flow.id);
  const oldBase = manager._sanitize(oldName);
  const oldM3u = path.join(manager.libraryRoot, `${oldBase}.m3u`);
  const oldWebp = path.join(manager.libraryRoot, `${oldBase}.webp`);
  await assert.doesNotReject(() => fs.access(oldM3u));
  await assert.doesNotReject(() => fs.access(oldWebp));

  flowPlaylistConfig.updateFlow(flow.id, { name: "New Name" });
  await manager.ensurePlaylists();

  const newName = manager.getPlaylistName(flow.id);
  const newBase = manager._sanitize(newName);
  const newM3u = path.join(manager.libraryRoot, `${newBase}.m3u`);
  const newWebp = path.join(manager.libraryRoot, `${newBase}.webp`);
  await assert.doesNotReject(() => fs.access(newM3u));
  await assert.doesNotReject(() => fs.access(newWebp));

  await assert.rejects(() => fs.access(oldM3u));
  await assert.rejects(() => fs.access(oldWebp));
});

test("writes sidecar artwork for draft flows without m3u files", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Draft Flow",
    enabled: false,
  });

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensurePlaylists();

  const playlistName = manager.getPlaylistName(flow.id);
  const base = manager._sanitize(playlistName);
  const m3u = path.join(manager.libraryRoot, `${base}.m3u`);
  const webp = path.join(manager.libraryRoot, `${base}.webp`);

  await assert.rejects(() => fs.access(m3u));
  await assert.doesNotReject(() => fs.access(webp));
});

test("keeps artwork when an enabled flow is disabled", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Toggle",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensurePlaylists();

  const base = manager._sanitize(manager.getPlaylistName(flow.id));
  const m3u = path.join(manager.libraryRoot, `${base}.m3u`);
  const webp = path.join(manager.libraryRoot, `${base}.webp`);
  await assert.doesNotReject(() => fs.access(m3u));
  await assert.doesNotReject(() => fs.access(webp));

  flowPlaylistConfig.setEnabled(flow.id, false);
  await manager.ensurePlaylists();
  await assert.rejects(() => fs.access(m3u));
  await assert.doesNotReject(() => fs.access(webp));
});

test("does not regenerate artwork after explicit remove until generate", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "No Regen",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  await manager.ensurePlaylists();

  const flowWebp = path.join(
    manager.libraryRoot,
    `${manager._sanitize(manager.getPlaylistName(flow.id))}.webp`,
  );
  await assert.doesNotReject(() => fs.access(flowWebp));

  await manager.removeArtwork(flow.id);
  await assert.rejects(() => fs.access(flowWebp));

  await manager.ensurePlaylists();
  await assert.rejects(() => fs.access(flowWebp));

  await manager.generateArtwork(flow.id);
  await assert.doesNotReject(() => fs.access(flowWebp));
});
