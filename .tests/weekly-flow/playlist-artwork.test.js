import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import axios from "../../lib/axiosFetch.js";
import { buildPlaylistArtworkWebpBuffer } from "../../backend/services/playlistArtwork.js";

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

function makeManager() {
  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  manager.__artworkUploads = [];
  manager.navidromeDestination.client = {
    isConfigured: () => true,
    async ensureWeeklyFlowLibrary() {},
    async getPlaylists() {
      return [];
    },
    async findSong() {
      return null;
    },
    async createPlaylist(name) {
      return { id: name, name };
    },
    async updatePlaylist() {},
    async deletePlaylist() {},
    async uploadPlaylistArtwork(id, data, filename) {
      manager.__artworkUploads.push({ id, size: data.length, filename });
    },
    async deletePlaylistArtwork(id) {
      manager.__artworkUploads.push({ id, deleted: true });
    },
    async scanLibrary() {},
  };
  return manager;
}

test("writes WebP artwork for flows and playlists without M3U files", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Late Night",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Road Trip",
    tracks: [{ artistName: "A", trackName: "One" }],
  });

  const manager = makeManager();
  await manager.ensurePlaylists();

  const flowName = manager.getPlaylistName(flow.id);
  const flowBase = manager._sanitize(flowName);
  const flowWebp = path.join(manager.libraryRoot, `${flowBase}.webp`);

  const playlistName = manager.getPlaylistName(playlist.id);
  const playlistBase = manager._sanitize(playlistName);
  const playlistWebp = path.join(manager.libraryRoot, `${playlistBase}.webp`);

  await assert.doesNotReject(() => fs.access(flowWebp));
  await assert.doesNotReject(() => fs.access(playlistWebp));
  await assert.rejects(() => fs.access(path.join(manager.libraryRoot, `${flowBase}.m3u`)));
  await assert.rejects(() => fs.access(path.join(manager.libraryRoot, `${playlistBase}.m3u`)));

  const flowMeta = await sharp(flowWebp).metadata();
  assert.equal(flowMeta.width, 1000);
  assert.equal(flowMeta.height, 1000);
  assert.equal(flowMeta.format, "webp");

  const playlistMeta = await sharp(playlistWebp).metadata();
  assert.equal(playlistMeta.width, 1000);
  assert.equal(playlistMeta.height, 1000);
  assert.equal(playlistMeta.format, "webp");
});

test("serves temporary artwork and replaces it when the photo source recovers", async (t) => {
  dbOps.updateSettings({ playlistArtwork: { style: "photo" } });
  const source = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: "#284466",
    },
  })
    .jpeg()
    .toBuffer();
  let sourceAvailable = false;
  t.mock.method(axios, "get", async () => {
    if (!sourceAvailable) throw new Error("Request failed with status code 503");
    return { data: source };
  });
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Offline Photos",
    tracks: [{ artistName: "A", trackName: "One" }],
  });
  const manager = makeManager();

  await manager.ensurePlaylists();

  assert.equal((await manager.resolveArtworkFile(playlist.id))?.extension, ".webp");

  sourceAvailable = true;
  await manager.ensurePlaylists();

  assert.equal((await manager.resolveArtworkFile(playlist.id))?.extension, ".jpg");
});

test("replaces the old generated JPEG fallback with photo artwork", async (t) => {
  dbOps.updateSettings({ playlistArtwork: { style: "photo" } });
  const source = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: "#284466",
    },
  })
    .jpeg()
    .toBuffer();
  t.mock.method(axios, "get", async () => ({ data: source }));
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Legacy Fallback",
    tracks: [{ artistName: "A", trackName: "One" }],
  });
  const manager = makeManager();
  await fs.mkdir(manager.libraryRoot, { recursive: true });
  const baseName = manager._sanitize(manager.getPlaylistName(playlist.id));
  const artworkPath = path.join(manager.libraryRoot, `${baseName}.jpg`);
  const fallback = await buildPlaylistArtworkWebpBuffer({
    playlistName: playlist.name,
    kind: "Playlist",
  });
  await fs.writeFile(
    artworkPath,
    await sharp(fallback).jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
  );

  await manager.ensurePlaylists();

  const metadata = await sharp(artworkPath).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 1200);
});

test("does not replace uploaded artwork in photo mode", async (t) => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Custom Cover",
    tracks: [{ artistName: "A", trackName: "One" }],
  });
  const manager = makeManager();
  const uploaded = await sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: "#663322",
    },
  })
    .png()
    .toBuffer();
  await manager.saveArtworkUpload(playlist.id, uploaded);
  const artworkPath = (await manager.resolveArtworkFile(playlist.id)).safePath;
  const before = await fs.readFile(artworkPath);
  dbOps.updateSettings({ playlistArtwork: { style: "photo" } });
  let photoRequests = 0;
  t.mock.method(axios, "get", async () => {
    photoRequests += 1;
    throw new Error("Unexpected photo request");
  });

  await manager.ensurePlaylists();

  assert.equal(photoRequests, 0);
  assert.deepEqual(await fs.readFile(artworkPath), before);
});

test("removes old sidecar artwork when a flow is renamed", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Old Name",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = makeManager();
  await manager.ensurePlaylists();

  const oldName = manager.getPlaylistName(flow.id);
  const oldBase = manager._sanitize(oldName);
  const oldWebp = path.join(manager.libraryRoot, `${oldBase}.webp`);
  await assert.doesNotReject(() => fs.access(oldWebp));

  flowPlaylistConfig.updateFlow(flow.id, { name: "New Name" });
  await manager.ensurePlaylists();

  const newName = manager.getPlaylistName(flow.id);
  const newBase = manager._sanitize(newName);
  const newWebp = path.join(manager.libraryRoot, `${newBase}.webp`);
  await assert.doesNotReject(() => fs.access(newWebp));

  await assert.rejects(() => fs.access(oldWebp));
});

test("writes sidecar artwork for draft flows without playlists", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Draft Flow",
    enabled: false,
  });

  const manager = makeManager();
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

  const manager = makeManager();
  await manager.ensurePlaylists();

  const base = manager._sanitize(manager.getPlaylistName(flow.id));
  const m3u = path.join(manager.libraryRoot, `${base}.m3u`);
  const webp = path.join(manager.libraryRoot, `${base}.webp`);
  await assert.rejects(() => fs.access(m3u));
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

  const manager = makeManager();
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

test("generates fallback artwork when the photo source is down", async (t) => {
  dbOps.updateSettings({ playlistArtwork: { style: "photo" } });
  t.mock.method(axios, "get", async () => {
    throw new Error("Request failed with status code 503");
  });
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Offline Generate" });
  const manager = makeManager();

  const outputPath = await manager.generateArtwork(playlist.id);

  assert.equal(path.extname(outputPath), ".webp");
  await assert.doesNotReject(() => fs.access(outputPath));
});

test("syncs artwork changes to the existing Navidrome playlist", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Artwork API" });
  const manager = makeManager();
  await manager.ensurePlaylists();
  manager.__artworkUploads.length = 0;

  await manager.generateArtwork(playlist.id);
  assert.equal(manager.__artworkUploads.length, 1);
  assert.deepEqual(manager.__artworkUploads[0], {
    id: "Artwork API",
    size: manager.__artworkUploads[0].size,
    filename: "Artwork API.webp",
  });

  await manager.removeArtwork(playlist.id);
  assert.deepEqual(manager.__artworkUploads.at(-1), { id: "Artwork API", deleted: true });
});
