import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { downloadWorker },
  { playlistManager },
] = await setupIsolatedBackend(
  "flow-webhook-vars",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
);

beforeEach(() => {
  downloadTracker.clearAll();
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

test("flow completion sends display name and track library path", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Late Night",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, playlist.id);
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, path.join(process.env.WEEKLY_FLOW_FOLDER!, "track.mp3"));

  const requests: { name: string; path: string }[] = [];
  let received!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      received();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = listeningAddress(server);
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
    requestPlaylistSync: playlistManager.requestPlaylistSync,
    scheduleScanLibrary: playlistManager.scheduleScanLibrary,
  };
  playlistManager.updateConfig = () => {};
  playlistManager.requestPlaylistSync = () => null;
  playlistManager.scheduleScanLibrary = () => 0;

  try {
    await downloadWorker.checkPlaylistComplete(playlist.id);
    await firstRequest;
    assert.deepEqual(requests, [
      {
        name: "Late Night",
        path: playlistManager.downloadRoot,
      },
    ]);
    assert.doesNotMatch(requests[0].path, /_playlists/);
  } finally {
    playlistManager.updateConfig = original.updateConfig;
    playlistManager.requestPlaylistSync = original.requestPlaylistSync;
    playlistManager.scheduleScanLibrary = original.scheduleScanLibrary;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
