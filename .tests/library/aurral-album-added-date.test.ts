import { requireFixture } from "../playlists/fixtures.ts";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { libraryManager },
  { downloadTracker },
  { downloadWorker },
  { lidarrClient },
  { clearMetadataProviderCaches },
] = await setupIsolatedBackend(
  "aurral-album-added-date",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
);

const artistMbid = "11111111-1111-4111-8111-111111111111";
const albumMbid = "22222222-2222-4222-8222-222222222222";
const trackMbid = "33333333-3333-4333-8333-333333333331";

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("re-adding an Aurral album keeps the date it was first added", async () => {
  const server = await createMockHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "application/json");
    if (pathname === `/artist/${artistMbid}`) {
      response.end(
        JSON.stringify({ id: artistMbid, artistname: "Aurral Artist", sortname: "Aurral Artist" }),
      );
      return;
    }
    if (pathname === `/album/${albumMbid}`) {
      response.end(
        JSON.stringify({
          id: albumMbid,
          title: "Aurral Album",
          artistid: artistMbid,
          artists: [{ id: artistMbid, artistname: "Aurral Artist" }],
          releasedate: "2026-01-02",
          releases: [
            {
              id: `${albumMbid}-release`,
              status: "Official",
              tracks: [
                {
                  id: `${trackMbid}-recording`,
                  recordingid: trackMbid,
                  trackname: "Track 1",
                  trackposition: 1,
                  mediumnumber: 1,
                  durationms: 180000,
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  const originalSettings = dbOps.getSettings();
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalWorkerStart = downloadWorker.start;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  lidarrClient.isConfigured = () => false;
  downloadWorker.start = async () => {};

  try {
    const artist = await libraryManager.addArtist(artistMbid, "Aurral Artist");
    await libraryManager.addAlbum(requireFixture(artist.id), albumMbid, "Aurral Album", {
      managedBy: "aurral",
    });

    const firstAdded = "2020-01-02T03:04:05.000Z";
    const row = db
      .prepare<unknown[], { id: number; metadata_json: string | null }>(
        "SELECT id, metadata_json FROM library_albums WHERE mbid = ?",
      )
      .get(albumMbid);
    const metadata = JSON.parse(requireFixture(requireFixture(row).metadata_json));
    db.prepare("UPDATE library_albums SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ ...metadata, added: firstAdded, trackListComplete: false }),
      requireFixture(row).id,
    );

    downloadTracker.clearAll();
    await libraryManager.addAlbum(requireFixture(artist.id), albumMbid, "Aurral Album", {
      managedBy: "aurral",
    });

    const after = db
      .prepare<unknown[], { metadata_json: string | null }>(
        "SELECT metadata_json FROM library_albums WHERE id = ?",
      )
      .get(requireFixture(row).id);
    assert.equal(JSON.parse(requireFixture(requireFixture(after).metadata_json)).added, firstAdded);
  } finally {
    downloadWorker.start = originalWorkerStart;
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.updateSettings(originalSettings);
    clearMetadataProviderCaches();
    await server.close();
  }
});
