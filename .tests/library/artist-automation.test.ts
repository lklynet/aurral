import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { libraryManager },
  { downloadWorker },
  { clearMetadataProviderCaches },
] = await setupIsolatedBackend(
  "artist-automation",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/services/libraryManager.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
);

const artistMbid = "c1111111-1111-4111-8111-111111111111";
const admin = { id: 1, username: "test", role: "admin", permissions: {} };

const originalWorkerStart = downloadWorker.start;
const originalSettings = dbOps.getSettings();
const metadata = { fails: false };
const metadataServer = await createMockHttpServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (metadata.fails) {
    response.writeHead(503);
    response.end(JSON.stringify({ error: "unavailable" }));
    return;
  }
  response.end(JSON.stringify({ id: artistMbid, artistname: "Automation Artist", Albums: [] }));
});

beforeAll(() => {
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations?.metadata, baseUrl: metadataServer.url },
    },
  });
  downloadWorker.start = async () => {};
});

beforeEach(() => {
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  metadata.fails = false;
  clearMetadataProviderCaches();
});

afterAll(async () => {
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await metadataServer.close();
  await cleanupIsolatedState(isolatedState);
});

function seedArtist(monitorMode: string) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildIdentityKey("mbid", artistMbid),
    mbid: artistMbid,
    name: "Automation Artist",
  });
  managementStore.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    monitorMode,
  });
  return artist;
}

const management = (entityKind: string, id: number) => {
  const entry = managementStore.getLibraryManagementEntry(entityKind, id);
  return entry?.monitorMode;
};

test("a monitoring change that cannot load releases leaves the artist as it was", async () => {
  metadata.fails = true;
  const artist = seedArtist("none");

  const result = await libraryManager.setArtistMonitoring(artistMbid, {
    monitoring: { monitored: true },
    user: admin,
  });

  assert.equal(result.statusCode, 503);
  assert.equal(management("artist", artist.id), "none");
});

test("adding an artist through monitoring needs permission to add artists", async () => {
  const result = await libraryManager.setArtistMonitoring(artistMbid, {
    monitoring: { monitored: true },
    artistName: "Automation Artist",
    user: { id: 1, username: "test", role: "user", permissions: { changeMonitoring: true } },
  });

  assert.equal(result.statusCode, 403);
  assert.equal(
    db
      .prepare<unknown[], { n: number }>("SELECT COUNT(*) AS n FROM library_artists WHERE mbid = ?")
      .get(artistMbid)!.n,
    0,
  );
});
