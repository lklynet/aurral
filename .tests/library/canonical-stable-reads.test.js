import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../backend/config/db-sqlite.js";
import {
  beginLibraryScan,
  finishLibraryScan,
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";
import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import {
  getCanonicalArtistProjection,
  getCanonicalLibraryPage,
} from "../../backend/services/libraryQueryService.js";
import {
  clearScheduledLibraryScan,
  getScheduledLibraryScanJobId,
} from "../../backend/services/libraryScanWorker.js";
import { getLibraryScanQueue } from "../../backend/services/honkerDb.js";
import { getCanonicalLidarrArtist } from "../../backend/routes/artists/handlers/details.js";
import { registerArtists } from "../../backend/routes/library/handlers/artists.js";

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

    const projectedArtist = artists.find((candidate) => candidate.providerId === "9911");
    assert.equal(projectedArtist?.id, String(artist.id));
    assert.equal(projectedArtist?.canonicalId, String(artist.id));
    assert.deepEqual(releases, []);
    assert.equal(request.mock.callCount(), 0);
  } finally {
    lidarrClient.isConfigured = originalConfigured;
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("artist monitoring mutations dedupe canonical reconciliation scans", async (t) => {
  clearScheduledLibraryScan();
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getArtistByMbid", async () => ({
    id: 9922,
    artistName: "Monitoring Artist",
    foreignArtistId: "33333333-3333-4333-8333-333333333333",
    monitored: false,
  }));
  t.mock.method(lidarrClient, "updateArtistMonitoring", async () => ({}));
  t.mock.method(lidarrClient, "getArtist", async () => ({
    id: 9922,
    artistName: "Monitoring Artist",
    foreignArtistId: "33333333-3333-4333-8333-333333333333",
    monitored: true,
    monitor: "all",
  }));

  let jobId;
  try {
    await libraryManager.updateArtist("33333333-3333-4333-8333-333333333333", {
      monitorOption: "all",
    });
    jobId = getScheduledLibraryScanJobId();
    assert.ok(jobId);
    assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(jobId).payload), {
      force: false,
      includeLidarr: true,
    });

    await libraryManager.updateArtist("33333333-3333-4333-8333-333333333333", {
      monitorOption: "all",
    });
    assert.equal(getScheduledLibraryScanJobId(), jobId);
  } finally {
    if (jobId) getLibraryScanQueue().cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("deleting a Lidarr artist clears canonical provider state", async (t) => {
  const mbid = "89898989-8989-4898-8989-898989898989";
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Deleted Provider Artist",
    metadata: {
      id: 8989,
      foreignArtistId: mbid,
      librarySource: "lidarr",
      monitored: true,
    },
  });
  clearScheduledLibraryScan();
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getArtistByMbid", async () => ({
    id: 8989,
    artistName: "Deleted Provider Artist",
    foreignArtistId: mbid,
  }));
  t.mock.method(lidarrClient, "deleteArtist", async () => true);

  try {
    assert.deepEqual(await libraryManager.deleteArtist(mbid), { success: true });
    const projection = getCanonicalArtistProjection({ reference: artist.id })[0];
    assert.equal(projection?.lidarrManaged, false);
    assert.equal(projection?.providerId, null);
    assert.equal(projection?.monitored, false);
    assert.equal(getCanonicalLidarrArtist(mbid), null);
  } finally {
    const jobId = getScheduledLibraryScanJobId();
    if (jobId) getLibraryScanQueue().cancel(jobId);
    clearScheduledLibraryScan();
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

test("legacy artist list bounds the projection before materialization", async (t) => {
  const prefix = `zzzzzzzzzz-artist-page-${process.pid}-${Date.now()}`;
  const artists = Array.from({ length: 101 }, (_, index) => upsertLibraryArtist({
    identityKey: `${prefix}:${index}`,
    name: `${prefix}-${String(index).padStart(3, "0")}`,
    sortName: `${prefix}-${String(index).padStart(3, "0")}`,
  }));
  t.mock.method(libraryManager, "getAllArtists", async () => {
    throw new Error("legacy artist list must not materialize all projection pages");
  });

  const routes = new Map();
  registerArtists({
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers.at(-1));
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers.at(-1));
    },
    put(path, ...handlers) {
      routes.set(`PUT ${path}`, handlers.at(-1));
    },
    delete(path, ...handlers) {
      routes.set(`DELETE ${path}`, handlers.at(-1));
    },
  });

  let statusCode = 200;
  let body;
  try {
    await routes.get("GET /artists")(
      { query: { limit: "1", offset: "100" } },
      {
        status(code) {
          statusCode = code;
          return this;
        },
        json(value) {
          body = value;
          return this;
        },
      },
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(body.map((artist) => artist.id), [String(artists[100].id)]);
    assert.equal(body[0].added, body[0].addedAt);
  } finally {
    db.prepare(
      `DELETE FROM library_artists WHERE id IN (${artists.map(() => "?").join(",")})`,
    ).run(...artists.map((artist) => artist.id));
  }
});

test("artist details do not expose Lidarr state for Aurral-only artists", () => {
  const mbid = "67676767-6767-4676-8676-676767676767";
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Aurral Only Artist",
    metadata: { id: 6767, foreignArtistId: mbid },
  });

  try {
    assert.equal(getCanonicalLidarrArtist(mbid), null);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("canonical artist page totals match hydrated items", () => {
  const key = `artist-page-shape:${process.pid}:${Date.now()}`;
  const emptyArtist = upsertLibraryArtist({
    identityKey: `${key}:empty`,
    name: `${key} empty`,
  });
  const populatedArtist = upsertLibraryArtist({
    identityKey: `${key}:populated`,
    name: `${key} populated`,
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: populatedArtist.id,
    title: "Hydrated Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Hydrated Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });

  try {
    const page = getCanonicalLibraryPage({ kind: "artists", query: key });
    assert.equal(page.total, 1);
    assert.deepEqual(page.items.map((artist) => artist.id), [populatedArtist.id]);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE id IN (?, ?)").run(
      emptyArtist.id,
      populatedArtist.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
  }
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
    const jobId = getScheduledLibraryScanJobId();
    if (jobId) getLibraryScanQueue().cancel(jobId);
    clearScheduledLibraryScan();
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
