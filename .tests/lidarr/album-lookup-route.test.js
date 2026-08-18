import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../backend/config/db-sqlite.js";
import { registerMisc } from "../../backend/routes/library/handlers/misc.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { logger } from "../../backend/services/logger.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

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
  }
});
