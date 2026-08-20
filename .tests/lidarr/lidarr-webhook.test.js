import assert from "node:assert/strict";
import test from "node:test";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, history, webhook] = await setupIsolatedBackend(
  "lidarr-webhook",
  "backend/config/db-sqlite.js",
  "backend/services/aurralHistoryService.js",
  "backend/routes/lidarrWebhook.js",
);

const { upsertAurralHistory } = history;
const { handleLidarrWebhook } = webhook;

function createResponse() {
  const result = { statusCode: 200, body: undefined, ended: false };
  return {
    result,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
    end() {
      result.ended = true;
      return this;
    },
  };
}

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM aurral_history").run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("Lidarr Download webhook marks the matching request available", () => {
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

  const response = createResponse();
  handleLidarrWebhook(
    {
      body: {
        eventType: "Download",
        album: {
          id: 42,
          title: "Blue Train",
          artist: {
            artistName: "John Coltrane",
            foreignArtistId: "artist-mbid",
          },
        },
      },
    },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = db
    .prepare("SELECT status_label, metadata FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.equal(entry.status_label, "Downloaded");
  assert.equal(JSON.parse(entry.metadata).username, "alice");
});

test("Lidarr Download webhook ignores unrelated albums", () => {
  upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = createResponse();
  handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 99, title: "Other Album" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: false });
  const entry = db
    .prepare("SELECT status_label FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.equal(entry.status_label, "Searching");
});

test("Lidarr Download webhook matches a request through its album metadata", () => {
  upsertAurralHistory({
    referenceId: "artist-mbid",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = createResponse();
  handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 42, title: "Blue Train" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = db
    .prepare("SELECT status_label FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-artist-mbid");
  assert.equal(entry.status_label, "Downloaded");
});

test("Lidarr non-download events are acknowledged without changing history", () => {
  const response = createResponse();
  handleLidarrWebhook({ body: { eventType: "Test" } }, response);
  assert.equal(response.result.statusCode, 204);
  assert.equal(response.result.ended, true);
});
