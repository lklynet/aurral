import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import express from "express";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  { flowPlaylistConfig },
  { playlistManager },
  { weeklyFlowWorker },
  honkerDb,
  { registerJobs },
] = await setupIsolatedBackend(
  "approved-import-path",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/honkerDb.js",
  "backend/routes/weeklyFlow/handlers/jobs.js",
);

const app = express();
app.use(express.json());
let requestUser = { role: "admin" };
app.use((req, _res, next) => {
  req.user = requestUser;
  next();
});
const router = express.Router();
registerJobs(router);
app.use(router);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

playlistManager.navidromeDestination.client = {
  isConfigured: () => true,
  async ensureWeeklyFlowLibrary() {},
  async getPlaylists() {
    return [];
  },
  async findSong() {
    return { id: "reviewed-song" };
  },
  async createPlaylist(name) {
    return { id: name, name };
  },
  async updatePlaylist() {},
  async deletePlaylist() {},
  async scanLibrary() {},
};

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.mkdir(process.env.DOWNLOAD_FOLDER, { recursive: true });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {},
    downloadFolderPath: process.env.DOWNLOAD_FOLDER,
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("approving a reviewed download commits it inside the managed playlist library", async () => {
  const playlistId = "40ae99ad-92b0-48c6-93e7-7b39e76703ea";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Reviewed",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Album" }],
  });
  const sourcePath = path.join(isolatedState.baseDir, "review", "Track.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "reviewed audio");
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    playlistId,
  );
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", sourcePath);

  const response = await fetch(`${baseUrl}/jobs/${jobId}/approve`, { method: "POST" });
  const payload = await response.json();
  const expectedPath = path.join(
    process.env.DOWNLOAD_FOLDER,
    "Artist",
    "Album",
    "Track.flac",
  );

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.path, expectedPath);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "reviewed audio");
  await assert.rejects(fs.access(path.join(playlistManager.libraryRoot, "Reviewed.m3u")));
});

test("reports when an upgrade search is already queued for a track", async () => {
  const playlistId = "c79c1598-699a-4ab3-b8cd-4e570f001f18";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Upgrades",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Album" }],
  });
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      slskd: { enabled: true, url: "http://127.0.0.1:1", apiKey: "test-key" },
    },
  });
  const finalPath = path.join(
    process.env.DOWNLOAD_FOLDER,
    "aurral-weekly-flow",
    playlistId,
    "Artist",
    "Album",
    "Track.mp3",
  );
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "audio");
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    playlistId,
  );
  downloadTracker.setDone(jobId, finalPath, "Album");
  downloadTracker.updateQuality(jobId, { tier: "mp3-128", format: "mp3" });

  const first = await fetch(`${baseUrl}/quality-upgrades/${playlistId}/${jobId}`, {
    method: "POST",
  });
  const second = await fetch(`${baseUrl}/quality-upgrades/${playlistId}/${jobId}`, {
    method: "POST",
  });
  const payload = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, JSON.stringify(payload));
  assert.equal(payload.alreadyQueued, true);
  assert.equal(payload.queued, 0);
});

test("search all stays within the requesting user's playlist access", async () => {
  const ownedPlaylistId = "c0de1f39-226f-4ab8-8f37-09d8adf47b5a";
  const otherPlaylistId = "a2b9ae35-7fb7-474e-a0d4-8ac4bdb8d9e6";
  flowPlaylistConfig.createSharedPlaylist({
    id: ownedPlaylistId,
    name: "Owned wanted",
    ownerUserId: 7,
    tracks: [{ artistName: "Artist", trackName: "Missing", albumName: "Album" }],
  });
  flowPlaylistConfig.createSharedPlaylist({
    id: otherPlaylistId,
    name: "Other wanted",
    ownerUserId: 8,
    tracks: [{ artistName: "Artist", trackName: "Private", albumName: "Album" }],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Missing", albumName: "Album" },
    ownedPlaylistId,
  );
  const otherJobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Private", albumName: "Album" },
    otherPlaylistId,
  );
  downloadTracker.setFailed(jobId, "No source");
  downloadTracker.setFailed(otherJobId, "No source");

  const originalStart = weeklyFlowWorker.start;
  const systemTaskQueue = honkerDb.getSystemTaskQueue();
  const originalEnqueue = systemTaskQueue.enqueue;
  const enqueuedTasks = [];
  systemTaskQueue.enqueue = (payload, options) => {
    enqueuedTasks.push({ payload, options });
    return enqueuedTasks.length;
  };
  weeklyFlowWorker.start = async () => {};
  requestUser = { role: "user", id: 7 };
  try {
    const missingResponse = await fetch(`${baseUrl}/research-missing`, { method: "POST" });
    const missingPayload = await missingResponse.json();
    assert.equal(missingResponse.status, 200, JSON.stringify(missingPayload));
    assert.equal(missingPayload.requeued, 1);
    assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
    assert.equal(downloadTracker.getJob(otherJobId)?.status, "failed");

    const upgradeResponse = await fetch(`${baseUrl}/quality-upgrades`, { method: "POST" });
    const upgradePayload = await upgradeResponse.json();
    assert.equal(upgradeResponse.status, 200, JSON.stringify(upgradePayload));
    assert.equal(upgradePayload.scheduled, true);
    assert.equal(upgradePayload.playlistCount, 1);
    assert.deepEqual(enqueuedTasks, [
      {
        payload: {
          kind: "quality-upgrade-check",
          force: true,
          playlistId: ownedPlaylistId,
          limit: 500,
        },
        options: { priority: -10, runAt: null },
      },
    ]);
  } finally {
    systemTaskQueue.enqueue = originalEnqueue;
    weeklyFlowWorker.start = originalStart;
    requestUser = { role: "admin" };
  }
});
