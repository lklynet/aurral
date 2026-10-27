import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, history, { api }] = await setupIsolatedBackend(
  "lidarr-webhook",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/aurralHistoryService.ts"),
  () => import("../../backend/routes/api.ts"),
);

const { upsertAurralHistory } = history;
const handleLidarrWebhook = (body: object) =>
  signedInAs(testUser(1))
    .route("/", api)
    .request("/webhooks/lidarr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM aurral_history").run();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("Lidarr Download webhook marks the matching request available", async () => {
  upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      albumId: 42,
      albumName: "Blue Train",
      artistName: "John Coltrane",
      artistMbid: "artist-mbid",
      userId: 7,
      username: "alice",
    },
  });

  const response = await handleLidarrWebhook({
    eventType: "Download",
    album: {
      id: 42,
      title: "Blue Train",
      artist: {
        artistName: "John Coltrane",
        foreignArtistId: "artist-mbid",
      },
    },
  });

  assert.deepEqual(await response.json(), { handled: true });
  const entry = db
    .prepare<
      unknown[],
      {
        status_label: import("../../backend/db/rows.ts").AurralHistoryRow["status_label"];
        metadata: import("../../backend/db/rows.ts").AurralHistoryRow["metadata"];
      }
    >("SELECT status_label, metadata FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.ok(entry != null);
  assert.equal(entry.status_label, "Downloaded");
  assert.ok(entry != null);
  assert.ok(entry.metadata != null);
  assert.equal(JSON.parse(entry.metadata).username, "alice");
});

test("Lidarr Download webhook ignores unrelated albums", async () => {
  upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = await handleLidarrWebhook({
    eventType: "Download",
    album: { id: 99, title: "Other Album" },
  });

  assert.deepEqual(await response.json(), { handled: false });
  const entry = db
    .prepare<
      unknown[],
      { status_label: import("../../backend/db/rows.ts").AurralHistoryRow["status_label"] }
    >("SELECT status_label FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.ok(entry != null);
  assert.equal(entry.status_label, "Searching");
});

test("Lidarr Download webhook matches a request through its album metadata", async () => {
  upsertAurralHistory({
    referenceId: "artist-mbid",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = await handleLidarrWebhook({
    eventType: "Download",
    album: { id: 42, title: "Blue Train" },
  });

  assert.deepEqual(await response.json(), { handled: true });
  const entry = db
    .prepare<
      unknown[],
      {
        status_label: import("../../backend/db/rows.ts").AurralHistoryRow["status_label"];
        metadata: import("../../backend/db/rows.ts").AurralHistoryRow["metadata"];
      }
    >("SELECT status_label, metadata FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-artist-mbid");
  assert.ok(entry != null);
  assert.equal(entry.status_label, "Downloaded");
  assert.ok(entry != null);
  assert.ok(entry.metadata != null);
  const metadata = JSON.parse(entry.metadata);
  assert.equal(metadata.albumId, "42");
  assert.equal(metadata.albumName, "Blue Train");
});

test("Lidarr Download webhook reads PascalCase fields", async () => {
  upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = await handleLidarrWebhook({
    EventType: "Download",
    Album: { Id: 42, Title: "Blue Train", Artist: { ArtistName: "John Coltrane" } },
  });

  assert.deepEqual(await response.json(), { handled: true });
});

test("Lidarr non-download events are acknowledged without changing history", async () => {
  const response = await handleLidarrWebhook({ eventType: "Test", album: null, artist: [] });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});
