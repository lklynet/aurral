import { requireFixture } from "../playlists/fixtures.ts";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";

const [
  isolatedState,
  { dbOps },
  { libraryManager },
  { downloadWorker },
  { clearMetadataProviderCaches },
] = await setupIsolatedBackend(
  "bulk-album-adds",
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/providers/metadataProvider.ts"),
);

const artistMbid = "11111111-1111-4111-8111-111111111111";
const albumMbids = Array.from(
  { length: 120 },
  (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
);

useFakeClock();

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("adding more albums at once than the metadata queue holds adds every album", async () => {
  const server = await createMockHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "application/json");
    if (pathname === `/v1/artist/${artistMbid}`) {
      response.end(JSON.stringify({ id: artistMbid, name: "Bulk Artist" }));
      return;
    }
    const albumMbid = pathname.match(/^\/v1\/album\/(.+)$/)?.[1];
    if (albumMbid) {
      response.end(
        JSON.stringify({
          id: albumMbid,
          title: `Album ${albumMbid}`,
          artistId: artistMbid,
          artists: [{ id: artistMbid, name: "Bulk Artist" }],
          releases: [
            {
              id: `${albumMbid}-release`,
              status: "Official",
              tracks: [
                {
                  id: `${albumMbid}-track`,
                  recordingId: `${albumMbid}-recording`,
                  title: "Track 1",
                  trackPosition: 1,
                  mediumNumber: 1,
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
  const originalWorkerStart = downloadWorker.start;
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations?.metadata,
        baseUrl: server.url,
      },
    },
  });
  clearMetadataProviderCaches();
  downloadWorker.start = async () => {};

  try {
    const artist = await libraryManager.addArtist(artistMbid, "Bulk Artist");
    const results = await Promise.all(
      albumMbids.map((albumMbid) =>
        libraryManager.addAlbum(requireFixture(artist.id), albumMbid, albumMbid, {}),
      ),
    );

    assert.deepEqual(
      results.flatMap((result) => ("error" in result && result.error ? [result.error] : [])),
      [],
    );
  } finally {
    downloadWorker.start = originalWorkerStart;
    dbOps.updateSettings(originalSettings);
    clearMetadataProviderCaches();
    await server.close();
  }
});
