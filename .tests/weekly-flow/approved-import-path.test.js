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
  { registerJobs },
] = await setupIsolatedBackend(
  "approved-import-path",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/routes/weeklyFlow/handlers/jobs.js",
);

const app = express();
app.use(express.json());
const router = express.Router();
registerJobs(router);
app.use(router);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

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
    "aurral-weekly-flow",
    playlistId,
    "Artist",
    "Album",
    "Track.flac",
  );

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.path, expectedPath);
  assert.equal(downloadTracker.getJob(jobId)?.finalPath, expectedPath);
  assert.equal(await fs.readFile(expectedPath, "utf8"), "reviewed audio");
  const m3u = await fs.readFile(
    path.join(playlistManager.libraryRoot, "Reviewed.m3u"),
    "utf8",
  );
  assert.match(m3u, /Track\.flac/);
});
