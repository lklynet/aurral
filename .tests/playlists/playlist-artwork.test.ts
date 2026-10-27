import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { PlaylistManager },
  artworkState,
  imageSource,
  imageProxy,
  { downloadTracker },
] = await setupIsolatedBackend(
  "playlist-artwork",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlistArtworkState.ts"),
  () => import("../../backend/services/releaseGroupCoverService.ts"),
  () => import("../../backend/services/imageProxyService.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
);

beforeEach(() => {
  vi.spyOn(imageSource, "fetchDeezerArtistImageUrl").mockResolvedValue(null);
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
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

function makeManager() {
  const manager = Object.assign(new PlaylistManager(process.env.WEEKLY_FLOW_FOLDER), {
    __artworkUploads: [] as { id: string; size?: number; filename?: string; deleted?: boolean }[],
  });
  const client = {
    isConfigured: () => true,
    async ensureAurralLibrary() {},
    async getPlaylists() {
      return [];
    },
    async findSong() {
      return null;
    },
    async createPlaylist(name: string) {
      return { id: name, name };
    },
    async updatePlaylist() {},
    async deletePlaylist() {},
    async uploadPlaylistArtwork(id: string, data: Buffer, filename: string) {
      manager.__artworkUploads.push({ id, size: data.length, filename });
    },
    async deletePlaylistArtwork(id: string) {
      manager.__artworkUploads.push({ id, deleted: true });
    },
    async scanLibrary() {},
  };
  manager.navidromeDestination.client = client as unknown as NonNullable<
    typeof manager.navidromeDestination.client
  >;
  return manager;
}

test("writes WebP artwork for flows and playlists without M3U files", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Late Night",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Road Trip",
    tracks: [{ artistName: "A", trackName: "One" }],
  });

  const manager = makeManager();
  await manager.syncPlaylists();

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

test("imports original covers, refreshes them on sync, and preserves user replacements", async () => {
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#284466" },
  })
    .png()
    .toBuffer();
  const remote = vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: await sharp(source).metadata(),
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Imported",
    importSource: {
      provider: "deezer-playlist",
      externalId: "123",
      artworkUrl: "https://images.example.test/one.png",
    },
  });
  const manager = makeManager();
  await manager.syncPlaylists();
  assert.equal(artworkState.getPlaylistArtworkState(playlist.id)?.mode, "original");
  assert.equal(remote.mock.calls.length, 1);
  await manager.syncPlaylists();
  assert.equal(remote.mock.calls.length, 1);
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    importSource: { ...playlist.importSource, artworkUrl: "https://images.example.test/two.png" },
  });
  await manager.syncPlaylists();
  assert.equal(remote.mock.calls.length, 2);
  assert.equal(
    artworkState.getPlaylistArtworkState(playlist.id)?.sourceUrl,
    "https://images.example.test/two.png",
  );
  await manager.generateArtwork(playlist.id, "simple");
  const artwork = (await manager.resolveArtworkFile(playlist.id))!;
  const generated = await fs.readFile(artwork.safePath);
  await manager.syncPlaylists();
  assert.deepEqual(await fs.readFile(artwork.safePath), generated);
  assert.equal(remote.mock.calls.length, 2);
  await manager.restoreOriginalArtwork(playlist.id);
  assert.equal(remote.mock.calls.length, 3);
  assert.equal(artworkState.getPlaylistArtworkState(playlist.id)?.mode, "original");
  await manager.saveArtworkUpload(playlist.id, source);
  const uploaded = await fs.readFile(artwork.safePath);
  await manager.syncPlaylists();
  assert.deepEqual(await fs.readFile(artwork.safePath), uploaded);
  assert.equal(remote.mock.calls.length, 3);
});

test("an unavailable source preserves the current original cover and restore can be retried", async () => {
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#284466" },
  })
    .png()
    .toBuffer();
  const remote = vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: await sharp(source).metadata(),
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Source unavailable",
    importSource: {
      provider: "youtube-music-playlist",
      externalId: "PLabcdefghij_123",
      artworkUrl: "https://images.example.test/cover.png",
    },
  });
  const manager = makeManager();
  await manager.syncPlaylists();
  const artwork = (await manager.resolveArtworkFile(playlist.id))!;
  const before = await fs.readFile(artwork.safePath);
  remote.mockRejectedValue(new Error("offline"));
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    importSource: {
      ...playlist.importSource,
      artworkUrl: "https://images.example.test/changed.png",
    },
  });
  await manager.syncPlaylists();
  assert.deepEqual(await fs.readFile(artwork.safePath), before);
  await assert.rejects(manager.restoreOriginalArtwork(playlist.id), /offline/);
  assert.deepEqual(await fs.readFile(artwork.safePath), before);
});

test("removes old sidecar artwork when a flow is renamed", async () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Old Name",
    enabled: false,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = makeManager();
  await manager.syncPlaylists();

  const oldName = manager.getPlaylistName(flow.id);
  const oldBase = manager._sanitize(oldName);
  const oldWebp = path.join(manager.libraryRoot, `${oldBase}.webp`);
  await assert.doesNotReject(() => fs.access(oldWebp));

  flowPlaylistConfig.updateFlow(flow.id, { name: "New Name" });
  await manager.syncPlaylists();

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
  await manager.syncPlaylists();

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
  await manager.syncPlaylists();

  const base = manager._sanitize(manager.getPlaylistName(flow.id));
  const m3u = path.join(manager.libraryRoot, `${base}.m3u`);
  const webp = path.join(manager.libraryRoot, `${base}.webp`);
  await assert.rejects(() => fs.access(m3u));
  await assert.doesNotReject(() => fs.access(webp));

  flowPlaylistConfig.setEnabled(flow.id, false);
  await manager.syncPlaylists();
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
  await manager.syncPlaylists();

  const flowWebp = path.join(
    manager.libraryRoot,
    `${manager._sanitize(manager.getPlaylistName(flow.id))}.webp`,
  );
  await assert.doesNotReject(() => fs.access(flowWebp));

  await manager.removeArtwork(flow.id);
  await assert.rejects(() => fs.access(flowWebp));

  await manager.syncPlaylists();
  await assert.rejects(() => fs.access(flowWebp));

  await manager.generateArtwork(flow.id);
  await assert.doesNotReject(() => fs.access(flowWebp));
});

test("generates a simple fallback when a playlist has no artists", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Offline Generate" });
  const manager = makeManager();

  const outputPath = await manager.generateArtwork(playlist.id);

  assert.equal(path.extname(outputPath), ".webp");
  await assert.doesNotReject(() => fs.access(outputPath));
});

test("syncs artwork changes to the existing Navidrome playlist", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Artwork API" });
  const manager = makeManager();
  await manager.syncPlaylists();
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

test("automatic cover changes reach the existing Navidrome playlist", async () => {
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#284466" },
  })
    .png()
    .toBuffer();
  vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: await sharp(source).metadata(),
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Imported cover",
    importSource: {
      provider: "deezer-playlist",
      externalId: "123",
      artworkUrl: "https://images.example.test/one.png",
    },
  });
  const manager = makeManager();
  await manager.syncPlaylists();
  manager.__artworkUploads.length = 0;
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    importSource: { ...playlist.importSource, artworkUrl: "https://images.example.test/two.png" },
  });

  await manager.syncPlaylists();

  assert.deepEqual(
    manager.__artworkUploads.map((upload) => upload.filename),
    ["Imported cover.webp"],
  );
});

test("renaming an imported playlist preserves its uploaded cover", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Before rename",
    importSource: {
      provider: "deezer-playlist",
      externalId: "123",
      artworkUrl: "https://images.example.test/original.jpg",
    },
  });
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#a23871" },
  })
    .png()
    .toBuffer();
  const manager = makeManager();
  await manager.saveArtworkUpload(playlist.id, source);
  const oldFile = (await manager.resolveArtworkFile(playlist.id))!;
  const before = await fs.readFile(oldFile.safePath);
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "After rename" });
  await manager.syncPlaylists();
  const newFile = (await manager.resolveArtworkFile(playlist.id))!;
  assert.notEqual(newFile.safePath, oldFile.safePath);
  assert.deepEqual(await fs.readFile(newFile.safePath), before);
  await assert.rejects(fs.access(oldFile.safePath));
  assert.equal(artworkState.getPlaylistArtworkState(playlist.id)?.mode, "upload");
});

test("renaming onto another playlist's file name keeps that playlist's cover", async () => {
  const cover = (background: string) =>
    sharp({ create: { width: 48, height: 48, channels: 3, background } })
      .png()
      .toBuffer();
  const manager = makeManager();
  const existing = flowPlaylistConfig.createStaticPlaylist({ name: "Mix_2026" });
  await manager.saveArtworkUpload(existing.id, await cover("#a23871"));
  const existingFile = (await manager.resolveArtworkFile(existing.id))!;
  const before = await fs.readFile(existingFile.safePath);
  const renamed = flowPlaylistConfig.createStaticPlaylist({ name: "Mix one" });
  await manager.saveArtworkUpload(renamed.id, await cover("#284466"));
  flowPlaylistConfig.updateStaticPlaylist(renamed.id, { name: "Mix:2026" });

  await manager.syncPlaylists();

  assert.deepEqual(await fs.readFile(existingFile.safePath), before);
});

test("an empty flow gains an artist cover after its tracklist is generated", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "New flow", enabled: false });
  const manager = makeManager();
  await manager.ensurePlaylistArtwork(flow.id);
  assert.ok(artworkState.getPlaylistArtworkState(flow.id)?.fallbackSignature);
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#284466" },
  })
    .png()
    .toBuffer();
  vi.mocked(imageSource.fetchDeezerArtistImageUrl).mockResolvedValue(
    "https://images.example.test/artist.jpg",
  );
  vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: await sharp(source).metadata(),
  });
  downloadTracker.addJob({ artistName: "Flow artist", trackName: "Track" }, flow.id);
  await manager.ensurePlaylistArtwork(flow.id);
  assert.equal(artworkState.getPlaylistArtworkState(flow.id)?.artistKey, "flow artist");
  assert.equal(artworkState.getPlaylistArtworkState(flow.id)?.fallbackSignature, null);
});

async function useArtistPhotos() {
  const source = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "#284466" },
  })
    .png()
    .toBuffer();
  vi.mocked(imageSource.fetchDeezerArtistImageUrl).mockImplementation(
    async ({ artistName } = {}) => `https://images.example.test/${artistName}.jpg`,
  );
  return vi.spyOn(imageProxy, "fetchRemoteImage").mockResolvedValue({
    buffer: source,
    contentType: "image/png",
    metadata: await sharp(source).metadata(),
  });
}

test("each flow run refreshes its generated cover once, even with the same artists", async () => {
  const source = await useArtistPhotos();
  const flow = flowPlaylistConfig.createFlow({ name: "Rotating flow", enabled: false });
  const manager = makeManager();
  const tracks = [
    { artistName: "First", trackName: "One" },
    { artistName: "Second", trackName: "Two" },
  ];
  downloadTracker.addJobs(tracks, flow.id);
  flowPlaylistConfig.markLastRunAt(flow.id, 1000);
  await manager.ensurePlaylistArtwork(flow.id);
  const before = artworkState.getPlaylistArtworkState(flow.id)!;
  downloadTracker.clearByPlaylistId(flow.id);
  downloadTracker.addJobs(tracks, flow.id);
  flowPlaylistConfig.markLastRunAt(flow.id, 1000);
  await manager.ensurePlaylistArtwork(flow.id);
  const refreshed = artworkState.getPlaylistArtworkState(flow.id)!;
  assert.notEqual(refreshed.artistKey, before.artistKey);
  assert.notEqual(refreshed.template, before.template);
  assert.equal(refreshed.flowRunAt, 1001);
  assert.ok(refreshed.revision! > before.revision!);
  const requests = source.mock.calls.length;
  await manager.ensurePlaylistArtwork(flow.id);
  assert.deepEqual(artworkState.getPlaylistArtworkState(flow.id), refreshed);
  assert.equal(source.mock.calls.length, requests);
  downloadTracker.clearByPlaylistId(flow.id);
  downloadTracker.addJob({ artistName: "New artist", trackName: "New track" }, flow.id);
  flowPlaylistConfig.markLastRunAt(flow.id, 3000);
  await manager.ensurePlaylistArtwork(flow.id);
  assert.equal(artworkState.getPlaylistArtworkState(flow.id)?.artistKey, "new artist");
});

for (const choice of ["simple", "upload", "removed"] as const) {
  test(`flow refresh preserves an explicit ${choice} cover choice`, async () => {
    const source = await useArtistPhotos();
    const flow = flowPlaylistConfig.createFlow({ name: `Preserve ${choice}`, enabled: false });
    downloadTracker.addJob({ artistName: "First", trackName: "One" }, flow.id);
    flowPlaylistConfig.markLastRunAt(flow.id, 1000);
    const manager = makeManager();
    await manager.ensurePlaylistArtwork(flow.id);
    if (choice === "simple") await manager.generateArtwork(flow.id, "simple");
    else if (choice === "removed") await manager.removeArtwork(flow.id);
    else
      await manager.saveArtworkUpload(
        flow.id,
        await sharp({ create: { width: 48, height: 48, channels: 3, background: "#ff0000" } })
          .png()
          .toBuffer(),
      );
    const state = artworkState.getPlaylistArtworkState(flow.id);
    const cover = await manager.resolveArtworkFile(flow.id);
    const bytes = cover ? await fs.readFile(cover.safePath) : null;
    const requests = source.mock.calls.length;
    downloadTracker.clearByPlaylistId(flow.id);
    downloadTracker.addJob({ artistName: "Second", trackName: "Two" }, flow.id);
    flowPlaylistConfig.markLastRunAt(flow.id, 2000);
    await manager.ensurePlaylistArtwork(flow.id);
    assert.deepEqual(artworkState.getPlaylistArtworkState(flow.id), state);
    const currentCover = await manager.resolveArtworkFile(flow.id);
    assert.deepEqual(currentCover ? await fs.readFile(currentCover.safePath) : null, bytes);
    assert.equal(source.mock.calls.length, requests);
  });
}

test("a failed tracklist commit does not advance the flow run time", async () => {
  const { downloadWorker, DownloadWorker } =
    await import("../../backend/services/downloadJobs/downloadWorker.ts");
  assert.ok(downloadWorker instanceof DownloadWorker);
  const flow = flowPlaylistConfig.createFlow({ name: "Failed commit", enabled: false });
  flowPlaylistConfig.markLastRunAt(flow.id, 1000);
  vi.spyOn(downloadTracker, "addJobs").mockImplementation(() => {
    throw new Error("write failed");
  });
  await assert.rejects(
    downloadWorker.seedFlowRunWithTracks(flow.id, flow, [
      { artistName: "Artist", trackName: "Track" },
    ]),
    /write failed/,
  );
  assert.equal(flowPlaylistConfig.getFlow(flow.id)?.lastRunAt, 1000);
});
