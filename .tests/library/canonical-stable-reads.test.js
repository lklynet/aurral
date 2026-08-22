import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../backend/config/db-sqlite.js";
import {
  beginLibraryScan,
  finishLibraryScan,
  upsertLibraryArtist,
} from "../../backend/services/libraryMediaStore.js";
import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { getCanonicalArtistProjection } from "../../backend/services/libraryQueryService.js";

test("stable artist and discovery reads do not call Lidarr", async (t) => {
  const identityKey = `stable-read-test:${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey,
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "Stable Read Artist",
    metadata: { id: 9911, monitored: true },
  });
  const originalConfigured = lidarrClient.isConfigured;
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("stable reads must not call Lidarr");
  });
  t.mock.method(lidarrClient, "getAllAlbums", async () => {
    throw new Error("stable reads must not call Lidarr");
  });
  lidarrClient.isConfigured = () => true;

  try {
    const artists = await libraryManager.getAllArtists();
    const releases = await getRecentMissingReleases(10, {
      now: "2026-08-22T12:00:00Z",
    });

    assert.equal(artists.some((candidate) => candidate.providerId === "9911"), true);
    assert.deepEqual(releases, []);
    assert.equal(request.mock.callCount(), 0);
  } finally {
    lidarrClient.isConfigured = originalConfigured;
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("stable artist reads remain local when Lidarr is absent", async (t) => {
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("absent Lidarr must not be called");
  });
  t.mock.method(lidarrClient, "isConfigured", () => false);

  const artists = await libraryManager.getAllArtists();

  assert.ok(Array.isArray(artists));
  assert.equal(request.mock.callCount(), 0);
});

test("explicit artist synchronization retains its Lidarr request", async (t) => {
  const originalConfigured = lidarrClient.isConfigured;
  const request = t.mock.method(lidarrClient, "request", async () => []);
  t.mock.method(libraryManager, "backfillLidarrArtistMappings", async () => {});
  lidarrClient.isConfigured = () => true;

  try {
    await libraryManager.syncLidarrArtists({ forceRefresh: true });
    assert.deepEqual(request.mock.calls.map((call) => call.arguments[0]), ["/artist"]);
  } finally {
    lidarrClient.isConfigured = originalConfigured;
  }
});

test("a failed provider scan keeps the canonical artist and marks it stale", () => {
  const identityKey = `stale-read-test:${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey,
    mbid: "22222222-2222-4222-8222-222222222222",
    name: "Stale Read Artist",
  });
  const scanId = beginLibraryScan({ source: "lidarr" });

  try {
    finishLibraryScan(scanId, { status: "failed", error: "provider unavailable" });
    const projection = getCanonicalArtistProjection({ reference: artist.id });
    assert.equal(projection[0]?.name, "Stale Read Artist");
    assert.equal(projection[0]?.stale, true);
  } finally {
    db.prepare("DELETE FROM library_scan_runs WHERE id = ?").run(scanId);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});
