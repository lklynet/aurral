import { requireFixture } from "../playlists/fixtures.ts";
type AlbumLookup = {
  inLibrary?: boolean;
  status?: string;
  ownedTrackMbids?: string[];
  trackListComplete?: boolean;
  trackCount?: number;
  trackFileCount?: number;
  percentOfTracks?: number;
  managedBy?: string;
};
type ArtistLookup = {
  error?: string;
  exists?: boolean;
  albums?: unknown[];
  artist?: { managedBy?: string; foreignArtistId?: string };
};
import { signedInAs } from "../helpers/honoApp.ts";
import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { db } from "../../backend/config/db-sqlite.ts";
import { openArtistStream } from "../helpers/artistStream.ts";
import { api } from "../../backend/routes/api.ts";
import { libraryManager } from "../../backend/services/libraryManager.ts";
import { lidarrClient } from "../../backend/services/lidarrClient.ts";
import { logger } from "../../backend/services/logger.ts";
import { invalidateLibraryQueryCache } from "../../backend/services/libraryQueryService.ts";
import {
  clearLibraryManagement,
  setLibraryManagement,
} from "../../backend/services/libraryManagementStore.ts";
import {
  linkLibraryAlbumTrack,
  storeLibraryAlbumTrackList,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.ts";

const app = signedInAs(undefined).route("/", api);

const lookupArtist = async (mbid: string) => {
  const body: ArtistLookup = await (await app.request(`/library/lookup/${mbid}`)).json();
  return body;
};

const lookupBatch = async <Body>(path: string, mbids: string[]) => {
  const response = await app.request(`/library${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mbids }),
  });
  const body: Body = await response.json();
  return { statusCode: response.status, body };
};

const lookupAlbums = (mbids: string[]) =>
  lookupBatch<Record<string, AlbumLookup>>("/albums/lookup/batch", mbids);

test("artist batch lookup rejects oversized batches", async () => {
  const { statusCode, body } = await lookupBatch<ArtistLookup>(
    "/lookup/batch",
    Array.from({ length: 101 }, (_, index) => `artist-${index}`),
  );

  assert.equal(statusCode, 400);
  assert.equal(body?.error, "mbids must contain at most 100 unique values");
});

test("artist lookup follows fresh Lidarr artist and album membership while the library index catches up", async () => {
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
  invalidateLibraryQueryCache();

  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  let artistRemoved = false;
  vi.spyOn(lidarrClient, "getArtistByMbid").mockImplementation(async (_mbid, options) => {
    assert.equal(_mbid, mbid);
    assert.deepEqual(options, { forceRefresh: true });
    return artistRemoved
      ? null
      : { id: 41, foreignArtistId: mbid, artistName: "Stale Artist", monitored: true };
  });
  vi.spyOn(lidarrClient, "request").mockImplementation(
    async (path, method, data, skip, options) => {
      assert.equal(path, "/album?artistId=41");
      assert.deepEqual([method, data, skip, options], ["GET", null, false, { forceRefresh: true }]);
      return [];
    },
  );

  try {
    const found = await lookupArtist(mbid);
    assert.equal(found?.exists, true);
    assert.deepEqual(found?.albums, []);

    artistRemoved = true;
    assert.equal((await lookupArtist(mbid))?.exists, false);

    const stream = openArtistStream(mbid, { artistName: "Stale Artist" });
    const library = await stream.waitFor(({ event }) => event === "library");
    stream.close();
    assert.equal(library.data.exists, false);
  } finally {
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});

test("artist lookup does not restore an Aurral-only artist after a Lidarr error", async () => {
  const mbid = "88888888-8888-4888-8888-888888888888";
  const key = `artist-lookup-aurral-only-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid,
    name: "Aurral-only Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: artist.id,
    title: "Aurral-only Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Aurral-only Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  invalidateLibraryQueryCache();

  let lookupCount = 0;
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getArtistByMbid").mockImplementation(async () => {
    lookupCount += 1;
    if (lookupCount === 1) return null;
    throw new Error("Lidarr connection refused");
  });

  try {
    assert.equal((await lookupArtist(mbid))?.exists, false);

    assert.equal((await lookupArtist(mbid))?.exists, false);
  } finally {
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});

test("artist lookup reports an Aurral-owned artist even when Lidarr does not have it", async () => {
  const mbid = "99999999-9999-4999-8999-999999999999";
  const artist = upsertLibraryArtist({
    identityKey: `artist-lookup-aurral-owned-${process.pid}-${Date.now()}`,
    mbid,
    name: "Aurral-owned Artist",
  });
  setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    managedBy: "aurral",
    monitorMode: "none",
  });
  invalidateLibraryQueryCache();

  let lidarrLookups = 0;
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getArtistByMbid").mockImplementation(async () => {
    lidarrLookups += 1;
    return null;
  });

  try {
    const body = await lookupArtist(mbid);
    assert.equal(body?.exists, true);
    assert.equal(body?.artist?.managedBy, "aurral");
    assert.equal(lidarrLookups, 0);
  } finally {
    clearLibraryManagement("artist", artist.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});

test("artist lookup sees a fresh Lidarr add before the library index catches up", async () => {
  const mbid = "66666666-6666-4666-8666-666666666666";

  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getArtistByMbid").mockImplementation(async (_mbid, options) => {
    assert.equal(_mbid, mbid);
    assert.deepEqual(options, { forceRefresh: true });
    return {
      id: 42,
      foreignArtistId: mbid,
      artistName: "Fresh Artist",
      monitored: true,
    };
  });
  vi.spyOn(lidarrClient, "request").mockImplementation(async () => []);

  const body = await lookupArtist(mbid);
  assert.equal(body?.exists, true);
  assert.equal(body?.artist?.foreignArtistId, mbid);
});

test("album batch lookup bypasses stale cache and unrelated broken albums", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumMbidIndex = lidarrClient.getAlbumMbidIndex;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetTracks = libraryManager.getTracks;
  const originalWarn = logger.warn;
  let lookupOptions: Parameters<typeof lidarrClient.getAlbumByMbid>[1];
  let warning: { category: string; message: string; data: unknown } | undefined;
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
  libraryManager.getTracks = async () => [
    libraryManager.mapLidarrTrack(
      { id: 1, foreignRecordingId: "owned-track", path: "/music/owned-track.flac" },
      { id: 42, foreignAlbumId: "target-album" },
    ),
  ];
  logger.warn = (category, message, data) => {
    warning = { category, message, data };
  };

  try {
    const { statusCode, body } = await lookupAlbums(["target-album", "broken-album"]);

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

    const oversized = await lookupAlbums(
      Array.from({ length: 101 }, (_, index) => `album-${index}`),
    );

    assert.equal(oversized.statusCode, 400);
    assert.equal(oversized.body?.error, "mbids must contain at most 100 unique values");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumMbidIndex = originalGetAlbumMbidIndex;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.getTracks = originalGetTracks;
    logger.warn = originalWarn;
  }
});

test("library album lookup counts the tracks of the release a scanned album lists", async () => {
  const key = `album-lookup-listed-${process.pid}-${Date.now()}`;
  const artist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "Listed Lookup Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: "55555555-5555-4555-8555-555555555555",
    artistId: artist.id,
    title: "Listed Lookup Album",
  });
  const albumMbid = requireFixture(album.mbid);
  const recordings = [
    "66666666-6666-4666-8666-666666666661",
    "66666666-6666-4666-8666-666666666662",
  ];
  const owned = upsertLibraryTrack({
    identityKey: `recording:${recordings[0]}`,
    mbid: recordings[0],
    title: "Owned",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: owned.id, trackNumber: 1 });
  setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  upsertLibraryMediaFile({
    trackId: owned.id,
    albumId: album.id,
    source: "aurral",
    path: `/tmp/${key}/owned.flac`,
  });
  storeLibraryAlbumTrackList(album.id, {
    release: {
      id: albumMbid,
      tracks: recordings.map((recordingId, index) => ({
        id: recordingId,
        oldRecordingIds: [],
        durationMs: null,
        mediumNumber: 1,
        artistId: null,
        trackNumber: index + 1,
        recordingId,
        title: ["Owned", "Missing"][index],
        trackPosition: index + 1,
      })),
    },
  });
  invalidateLibraryQueryCache();

  try {
    const { body } = await lookupAlbums([albumMbid]);
    assert.ok(body != null);
    const { status, trackListComplete, trackCount, trackFileCount, percentOfTracks } =
      body[albumMbid];
    assert.deepEqual(
      { status, trackListComplete, trackCount, trackFileCount, percentOfTracks },
      {
        status: "partial",
        trackListComplete: true,
        trackCount: 2,
        trackFileCount: 1,
        percentOfTracks: 50,
      },
    );
  } finally {
    db.prepare("DELETE FROM library_management WHERE entity_kind = 'album' AND entity_id = ?").run(
      album.id,
    );
    db.prepare("DELETE FROM library_media_files WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare(`DELETE FROM library_tracks WHERE mbid IN (?, ?)`).run(...recordings);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("library album lookup reports partial ownership, its manager, and the complete track count", async () => {
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
  const albumMbid = requireFixture(album.mbid);
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
  setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  const ownedPath = `/tmp/${key}/owned.flac`;
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });

  try {
    const { body } = await lookupAlbums([albumMbid]);
    assert.equal(body?.[albumMbid]?.status, "partial");
    assert.equal(body?.[albumMbid]?.trackListComplete, false);
    assert.equal("percentOfTracks" in body[albumMbid], false);
    assert.equal(body[albumMbid].trackCount, 1);
    linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
    upsertLibraryAlbum({
      identityKey: `${key}:album`,
      mbid: albumMbid,
      artistId: artist.id,
      title: "Partial Lookup Album",
      metadata: { trackListComplete: true },
    });
    invalidateLibraryQueryCache();
    const completed = await lookupAlbums([albumMbid]);
    const result = completed.body?.[albumMbid];
    assert.equal(completed.statusCode, 200);
    assert.equal(result?.status, "partial");
    assert.equal(result?.trackCount, 2);
    assert.equal(result?.trackFileCount, 1);
    assert.equal(result?.percentOfTracks, 50);
    assert.deepEqual(result?.ownedTrackMbids, [ownedTrack.mbid]);
    assert.equal(result?.managedBy, "aurral");
    assert.equal(result?.trackListComplete, true);
    upsertLibraryMediaFile({
      trackId: missingTrack.id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/${key}/missing.flac`,
    });
    invalidateLibraryQueryCache();
    const owned = (await lookupAlbums([albumMbid])).body;
    assert.equal(owned[albumMbid].status, "available");
    assert.equal(owned[albumMbid].percentOfTracks, 100);
    assert.equal(owned[albumMbid].trackListComplete, true);
  } finally {
    db.prepare("DELETE FROM library_management WHERE entity_kind = 'album' AND entity_id = ?").run(
      album.id,
    );
    db.prepare("DELETE FROM library_media_files WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(ownedTrack.id, missingTrack.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("album lookup follows fresh Lidarr removal but keeps Aurral's albums", async () => {
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
  const albumMbid = requireFixture(album.mbid);
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Stale Album Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  invalidateLibraryQueryCache();

  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getAlbumsByMbidsSettled").mockImplementation(async (mbids, options) => {
    assert.deepEqual(mbids, [albumMbid]);
    assert.deepEqual(options, { forceRefresh: true });
    return [{ status: "fulfilled", value: undefined }];
  });
  try {
    assert.deepEqual((await lookupAlbums([albumMbid])).body, {});

    setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
    invalidateLibraryQueryCache();
    const { body } = await lookupAlbums([albumMbid]);
    assert.equal(body[albumMbid]?.managedBy, "aurral");
  } finally {
    clearLibraryManagement("album", album.id);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});

test("library album lookup includes owned tracks after the first track page", async () => {
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
  const albumMbid = requireFixture(album.mbid);
  const trackIds: number[] = [];
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

  try {
    const { body } = await lookupAlbums([albumMbid]);
    const result = body?.[albumMbid];
    assert.equal(result?.trackCount, 101);
    assert.equal(result?.trackFileCount, 1);
    assert.deepEqual(result?.ownedTrackMbids, [ownedTrack.mbid]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(ownedPath);
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ?").run(album.id);
    db.prepare(`DELETE FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`).run(
      ...trackIds,
    );
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});
