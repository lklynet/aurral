import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { weeklyFlowWorker },
  { playlistManager },
] = await setupIsolatedBackend(
  "weekly-flow-webhook-vars",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

test.beforeEach(() => {
  downloadTracker.clearAll();
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

test("weekly flow completion sends display name and track library path", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Late Night",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track" },
    playlist.id,
  );
  downloadTracker.setDone(jobId, path.join(process.env.WEEKLY_FLOW_FOLDER, "track.mp3"));

  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      webhookEvents: { notifyWeeklyFlowDone: true },
      webhooks: [
        {
          url: `http://127.0.0.1:${port}/hook`,
          body: '{"name":"$flowName","path":"$flowPath"}',
          headers: [],
        },
      ],
    },
  });

  const original = {
    updateConfig: playlistManager.updateConfig,
    ensurePlaylists: playlistManager.ensurePlaylists,
    scheduleScanLibrary: playlistManager.scheduleScanLibrary,
  };
  playlistManager.updateConfig = () => {};
  playlistManager.ensurePlaylists = async () => {};
  playlistManager.scheduleScanLibrary = async () => {};

  try {
    await weeklyFlowWorker.checkPlaylistComplete(playlist.id);
    const deadline = Date.now() + 5000;
    while (requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(requests, [
      {
        name: "Late Night",
        path: path.join(playlistManager.playlistLibraryRoot, playlist.id),
      },
    ]);
    assert.doesNotMatch(requests[0].path, /_playlists/);
  } finally {
    playlistManager.updateConfig = original.updateConfig;
    playlistManager.ensurePlaylists = original.ensurePlaylists;
    playlistManager.scheduleScanLibrary = original.scheduleScanLibrary;
    await new Promise((resolve) => server.close(resolve));
  }
});
