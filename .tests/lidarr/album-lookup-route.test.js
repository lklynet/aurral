import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../backend/config/db-sqlite.js";
import { registerStream as registerArtistStream } from "../../backend/routes/artists/handlers/stream.js";
import { registerMisc } from "../../backend/routes/library/handlers/misc.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { logger } from "../../backend/services/logger.js";
import { invalidateCanonicalLibraryCache } from "../../backend/services/libraryQueryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

test("artist batch lookup rejects oversized batches", async () => {
  const routes = new Map();
  registerMisc({
    get() {},
    post(routePath, handler) {
      routes.set(routePath, handler);
    },
  });
  let statusCode = 200;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  await routes.get("/lookup/batch")(
    { body: { mbids: Array.from({ length: 101 }, (_, index) => `artist-${index}`) } },
    response,
  );

  assert.equal(statusCode, 400);
  assert.equal(body?.error, "mbids must contain at most 100 unique values");
});

test("artist lookup follows fresh Lidarr artist and album membership while the canonical index catches up", async (t) => {
  const mbid = "55555555-5555-4555-8555-555555555555";
  const artist = upsertLibraryArtist({
    identityKey: `artist-lookup-stale-${process.pid}-${Date.now()}`,
    mbid,
    name: "Stale Artist",
    metadata: { id: 41, foreignArtistId: mbid, monitored: true },
  });
  const album = upsertLibraryAlbum({
    identityKey: `artist-lookup-stale-album-${process.pid}-${Date.now()}`,
    mbid: "77777777-7777-4777-8777-777777777777",
    artistId: artist.id,
    title: "Stale Artist Album",
    metadata: { id: 43, artistId: 41, monitored: true },
  });
  const track = upsertLibraryTrack({
    identityKey: `artist-lookup-stale-track-${process.pid}-${Date.now()}`,
    title: "Stale Artist Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  invalidateCanonicalLibraryCache();
  const routes = new Map();
  registerMisc({
    get(path, handler) {
      routes.set(path, handler);
    },
    post() {},
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  let artistRemoved = false;
  t.mock.method(lidarrClient, "getArtistByMbid", async (_mbid, options) => {
    assert.equal(_mbid, mbid);
    assert.deepEqual(options, { forceRefresh: true });
    return artistRemoved
      ? null
      : { id: 41, foreignArtistId: mbid, artistName: "Stale Artist", monitored: true };
  });
  t.mock.method(lidarrClient, "request", async (path, method, data, skip, options) => {
    assert.equal(path, "/album?artistId=41");
    assert.deepEqual([method, data, skip, options], ["GET", null, false, { forceRefresh: true }]);
    return [];
  });
  let body;

  try {
    await routes.get("/lookup/:mbid")(
      { params: { mbid } },
      { json(value) { body = value; return this; } },
    );
    assert.equal(body?.exists, true);
    assert.deepEqual(body?.albums, []);

    artistRemoved = true;
    await routes.get("/lookup/:mbid")(
      { params: { mbid } },
      { json(value) { body = value; return this; } },
    );
    assert.equal(body?.exists, false);

    const streamRoutes = new Map();
    registerArtistStream({
      get(path, ...handlers) {
        streamRoutes.set(path, handlers.at(-1));
      },
    });
    const writes = [];
    let closeStream = () => {};
    await streamRoutes.get("/:mbid/stream")(
      {
        params: { mbid },
        query: { artistName: "Stale Artist" },
        headers: {},
        socket: { destroyed: false },
        on(event, handler) {
          if (event === "close") closeStream = handler;
        },
      },
      {
        setHeader() {},
        status() { return this; },
        json() { return this; },
        write(value) { writes.push(value); },
        flush() {},
        end() {},
      },
    );
    const deadline = Date.now() + 1000;
    let libraryEventIndex = writes.indexOf("event: library\n");
    while (libraryEventIndex === -1 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      libraryEventIndex = writes.indexOf("event: library\n");
    }
    assert.notEqual(libraryEventIndex, -1);
    assert.equal(JSON.parse(writes[libraryEventIndex + 1].slice(6)).exists, false);
    closeStream();
  } finally {
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateCanonicalLibraryCache();
  }
});

test("artist lookup sees a fresh Lidarr add before the canonical index catches up", async (t) => {
  const mbid = "66666666-6666-4666-8666-666666666666";
  const routes = new Map();
  registerMisc({
    get(path, handler) {
      routes.set(path, handler);
    },
    post() {},
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getArtistByMbid", async (_mbid, options) => {
    assert.equal(_mbid, mbid);
    assert.deepEqual(options, { forceRefresh: true });
    return {
      id: 42,
      foreignArtistId: mbid,
      artistName: "Fresh Artist",
      monitored: true,
    };
  });
  t.mock.method(lidarrClient, "request", async () => []);
  let body;

  await routes.get("/lookup/:mbid")(
    { params: { mbid } },
    { json(value) { body = value; return this; } },
  );
  assert.equal(body?.exists, true);
  assert.equal(body?.artist?.foreignArtistId, mbid);
});

test("album batch lookup bypasses stale cache and unrelated broken albums", async () => {
  const routes = new Map();
  registerMisc({
    get() {},
    post(path, handler) {
      routes.set(path, handler);
    },
  });

  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumMbidIndex = lidarrClient.getAlbumMbidIndex;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetTracks = libraryManager.getTracks;
  const originalWarn = logger.warn;
  let lookupOptions;
  let warning;
  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumMbidIndex = async () => {
    throw new Error("Sequence contains more than one element");
  };
  lidarrClient.getAlbumByMbid = async (mbid, options) => {
    lookupOptions = options;
    if (mbid === "broken-album") {
      throw new Error("Lidarr lookup failed");
    }
    return mbid === "target-album"
      ? {
          id: 42,
          artistId: 7,
          foreignAlbumId: "target-album",
          title: "To Be Still",
          monitored: true,
          statistics: {
            percentOfTracks: 0,
            sizeOnDisk: 0,
            trackCount: 11,
            trackFileCount: 0,
          },
        }
      : undefined;
  };
  libraryManager.getTracks = async () => [{ mbid: "owned-track", hasFile: true }];
  logger.warn = (category, message, data) => {
    warning = { category, message, data };
  };

  let statusCode = 200;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  try {
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: ["target-album", "broken-album"] } },
      response,
    );

    assert.equal(statusCode, 200);
    assert.equal(body?.["target-album"]?.inLibrary, true);
    assert.equal(body?.["target-album"]?.status, "monitored");
    assert.deepEqual(body?.["target-album"]?.ownedTrackMbids, ["owned-track"]);
    assert.equal(lookupOptions?.forceRefresh, true);
    assert.deepEqual(warning, {
      category: "library",
      message: "Lidarr album lookup failed",
      data: {
        foreignAlbumId: "broken-album",
        message: "Lidarr lookup failed",
      },
    });

    statusCode = 200;
    body = undefined;
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: Array.from({ length: 101 }, (_, index) => `album-${index}`) } },
      response,
    );

    assert.equal(statusCode, 400);
    assert.equal(body?.error, "mbids must contain at most 100 unique values");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumMbidIndex = originalGetAlbumMbidIndex;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.getTracks = originalGetTracks;
    logger.warn = originalWarn;
  }
});

test("canonical album lookup reports partial ownership and the complete track count", async () => {
  const key = `album-lookup-partial-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "Partial Lookup Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: "22222222-2222-4222-8222-222222222222",
    artistId: artist.id,
    title: "Partial Lookup Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: "33333333-3333-4333-8333-333333333333",
    title: "Owned Track",
    artistName: artist.name,
  });
  const missingTrack = upsertLibraryTrack({
    identityKey: `${key}:missing-track`,
    mbid: "44444444-4444-4444-8444-444444444444",
    title: "Missing Track",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });

  const routes = new Map();
  registerMisc({
    get() {},
    post(path, handler) {
      routes.set(path, handler);
    },
  });
  let statusCode = 200;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  try {
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: [album.mbid] } },
      response,
    );
    const result = body?.[album.mbid];
    assert.equal(statusCode, 200);
    assert.equal(result?.status, "partial");
    assert.equal(result?.trackCount, 2);
    assert.equal(result?.trackFileCount, 1);
    assert.equal(result?.percentOfTracks, 50);
    assert.deepEqual(result?.ownedTrackMbids, [ownedTrack.mbid]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(ownedPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(ownedTrack.id, missingTrack.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("album lookup follows fresh Lidarr removal while the canonical index catches up", async (t) => {
  const key = `album-lookup-stale-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "Stale Album Artist",
    metadata: { id: 51, monitored: true },
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}-album`,
    artistId: artist.id,
    title: "Stale Album",
    metadata: { id: 52, artistId: 51, monitored: true },
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Stale Album Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  invalidateCanonicalLibraryCache();
  const routes = new Map();
  registerMisc({
    get() {},
    post(path, handler) {
      routes.set(path, handler);
    },
  });
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "getAlbumsByMbidsSettled", async (mbids, options) => {
    assert.deepEqual(mbids, [album.mbid]);
    assert.deepEqual(options, { forceRefresh: true });
    return [{ status: "fulfilled", value: undefined }];
  });
  let body;

  try {
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: [album.mbid] } },
      { json(value) { body = value; return this; } },
    );
    assert.deepEqual(body, {});
  } finally {
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateCanonicalLibraryCache();
  }
});

test("canonical album lookup includes owned tracks after the first track page", async () => {
  const key = `album-lookup-pagination-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "Paginated Lookup Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}-album`,
    artistId: artist.id,
    title: "Paginated Lookup Album",
  });
  const trackIds = [];
  const ownedTrack = upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: `${key}-owned`,
    title: "Track 101",
    artistName: artist.name,
  });
  for (let index = 1; index <= 100; index += 1) {
    const track = upsertLibraryTrack({
      identityKey: `${key}:track-${index}`,
      mbid: `${key}-track-${index}`,
      title: `Track ${String(index).padStart(3, "0")}`,
      artistName: artist.name,
    });
    trackIds.push(track.id);
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index });
  }
  trackIds.push(ownedTrack.id);
  linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 101 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });

  const routes = new Map();
  registerMisc({
    get() {},
    post(path, handler) {
      routes.set(path, handler);
    },
  });
  let body;
  const response = {
    status() {
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  try {
    await routes.get("/albums/lookup/batch")(
      { body: { mbids: [album.mbid] } },
      response,
    );
    const result = body?.[album.mbid];
    assert.equal(result?.trackCount, 101);
    assert.equal(result?.trackFileCount, 1);
    assert.deepEqual(result?.ownedTrackMbids, [ownedTrack.mbid]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(ownedPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare(`DELETE FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`).run(...trackIds);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateCanonicalLibraryCache();
  }
});
