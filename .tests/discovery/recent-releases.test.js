import test from "node:test";
import assert from "node:assert/strict";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import { refreshLidarrReleaseMetadata } from "../../backend/services/lidarrReleaseMetadataSync.js";
import { db } from "../../backend/config/db-sqlite.js";
import { dbOps } from "../../backend/db/helpers/index.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import {
  getCanonicalAlbumsByReleaseDate,
  getCanonicalArtistProjection,
} from "../../backend/services/libraryQueryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

const artist = {
  id: 1,
  name: "Library Artist",
  foreignArtistId: "artist-mbid",
};
const providerArtist = {
  id: 2,
  artistName: "Library Artist",
  foreignArtistId: "1182@deezer",
};
const canonicalMbid = "c2f6e8d3-2e6d-4d0a-ae60-4f8c5b2d7a91";

const buildAlbum = ({ id, title, releaseDate }) => ({
  id,
  artistId: artist.id,
  foreignAlbumId: `album-${id}`,
  title,
  releaseDate,
  monitored: true,
  statistics: {
    trackCount: 10,
    trackFileCount: 0,
    percentOfTracks: 0,
    sizeOnDisk: 0,
  },
});

test("recent missing releases can exclude future releases for Release Radar", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  lidarrClient.isConfigured = () => true;

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [artist],
      albums: [
        buildAlbum({
          id: 1,
          title: "Released Album",
          releaseDate: "2026-06-11",
        }),
        buildAlbum({
          id: 2,
          title: "Future Album",
          releaseDate: "2026-08-20",
        }),
      ],
      includeFuture: false,
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Released Album"],
    );
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
  }
});

test("recent missing releases keep upcoming albums by default for the Discover rail", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  lidarrClient.isConfigured = () => true;

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [artist],
      albums: [
        buildAlbum({
          id: 1,
          title: "Released Album",
          releaseDate: "2026-06-11",
        }),
        buildAlbum({
          id: 2,
          title: "Future Album",
          releaseDate: "2026-08-20",
        }),
      ],
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Future Album", "Released Album"],
    );
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
  }
});

test("recent missing releases backfill direct Lidarr artists before mapping", async (t) => {
  const originalIsConfigured = lidarrClient.isConfigured;
  lidarrClient.isConfigured = () => true;
  t.mock.method(libraryManager, "backfillLidarrArtistMappings", async (artists) => {
    assert.equal(artists[0], providerArtist);
    dbOps.setLidarrArtistIdMap(canonicalMbid, providerArtist.foreignArtistId);
  });

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [providerArtist],
      albums: [
        {
          ...buildAlbum({
            id: 3,
            title: "Backfilled Album",
            releaseDate: "2026-06-11",
          }),
          artistId: providerArtist.id,
        },
      ],
      now: "2026-06-15T12:00:00Z",
    });

    assert.equal(releases[0].artistMbid, canonicalMbid);
    assert.equal(releases[0].foreignArtistId, providerArtist.foreignArtistId);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    dbOps.deleteLidarrArtistIdMap(canonicalMbid);
  }
});

test("Lidarr release metadata refresh reconciles additions and removals", async () => {
  const artistMbid = "71717171-7171-4717-8717-717171717171";
  const albumMbid = "81818181-8181-4818-8818-818181818181";
  let lidarrArtists = [];
  let lidarrAlbums = [];
  const client = {
    isConfigured: () => true,
    isEnabled: () => true,
    async request(endpoint, method, data, skipConfigUpdate, options) {
      assert.equal(endpoint, "/artist");
      assert.equal(method, "GET");
      assert.equal(data, null);
      assert.equal(skipConfigUpdate, false);
      assert.equal(options.forceRefresh, true);
      return lidarrArtists;
    },
    async getAllAlbums(options) {
      assert.equal(options.forceRefresh, true);
      return lidarrAlbums;
    },
  };

  try {
    assert.deepEqual(await refreshLidarrReleaseMetadata({ client }), {
      skipped: false,
      artistsSeen: 0,
      albumsSeen: 0,
      albumsSkipped: 0,
      artistsStale: 0,
      albumsStale: 0,
    });

    lidarrArtists = [{
      id: 914,
      artistName: "New Lidarr Artist",
      foreignArtistId: artistMbid,
      monitored: true,
      monitor: "future",
    }];
    lidarrAlbums = [{
      id: 915,
      artistId: 914,
      title: "New Upcoming Release",
      foreignAlbumId: albumMbid,
      releaseDate: "2026-10-02",
      monitored: true,
    }];
    const result = await refreshLidarrReleaseMetadata({ client });
    assert.deepEqual(result, {
      skipped: false,
      artistsSeen: 1,
      albumsSeen: 1,
      albumsSkipped: 0,
      artistsStale: 0,
      albumsStale: 0,
    });

    const releases = await getRecentMissingReleases(24, {
      now: "2026-09-27T12:00:00Z",
    });
    const release = releases.find((album) => album.releaseGroupMbid === albumMbid);
    assert.equal(release?.artistName, "New Lidarr Artist");
    assert.equal(release?.albumName, "New Upcoming Release");
    assert.equal(release?.managedBy, "lidarr");

    assert.deepEqual(await refreshLidarrReleaseMetadata({ client }), {
      skipped: false,
      artistsSeen: 1,
      albumsSeen: 1,
      albumsSkipped: 0,
      artistsStale: 0,
      albumsStale: 0,
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM library_albums WHERE release_group_mbid = ?")
        .get(albumMbid).total,
      1,
    );

    lidarrArtists = [];
    lidarrAlbums = [];
    assert.deepEqual(await refreshLidarrReleaseMetadata({ client }), {
      skipped: false,
      artistsSeen: 0,
      albumsSeen: 0,
      albumsSkipped: 0,
      artistsStale: 1,
      albumsStale: 1,
    });
    const releasesAfterRemoval = await getRecentMissingReleases(24, {
      now: "2026-09-27T12:00:00Z",
    });
    assert.equal(
      releasesAfterRemoval.some((album) => album.releaseGroupMbid === albumMbid),
      false,
    );
    const removedAlbum = db.prepare(
      "SELECT metadata_json FROM library_albums WHERE release_group_mbid = ?",
    ).get(albumMbid);
    assert.equal(JSON.parse(removedAlbum.metadata_json).lidarrCatalogPresent, false);

    lidarrArtists = [{
      id: 914,
      artistName: "New Lidarr Artist",
      foreignArtistId: artistMbid,
      monitored: true,
      monitor: "future",
    }];
    lidarrAlbums = [{
      id: 915,
      artistId: 914,
      title: "New Upcoming Release",
      foreignAlbumId: albumMbid,
      releaseDate: "2026-10-02",
      monitored: true,
    }];
    assert.deepEqual(await refreshLidarrReleaseMetadata({ client }), {
      skipped: false,
      artistsSeen: 1,
      albumsSeen: 1,
      albumsSkipped: 0,
      artistsStale: 0,
      albumsStale: 0,
    });
    const releasesAfterRestore = await getRecentMissingReleases(24, {
      now: "2026-09-27T12:00:00Z",
    });
    assert.equal(
      releasesAfterRestore.some((album) => album.releaseGroupMbid === albumMbid),
      true,
    );
    const restoredAlbum = db.prepare(
      "SELECT metadata_json FROM library_albums WHERE release_group_mbid = ?",
    ).get(albumMbid);
    assert.equal(JSON.parse(restoredAlbum.metadata_json).lidarrCatalogPresent, true);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM library_albums WHERE release_group_mbid = ?")
        .get(albumMbid).total,
      1,
    );
  } finally {
    const album = db.prepare(
      "SELECT id FROM library_albums WHERE release_group_mbid = ?",
    ).get(albumMbid);
    const insertedArtist = db.prepare(
      "SELECT id FROM library_artists WHERE mbid = ?",
    ).get(artistMbid);
    if (album?.id) {
      db.prepare(
        "DELETE FROM library_search_documents WHERE entity_kind = 'album' AND entity_id = ?",
      ).run(album.id);
      db.prepare(
        "DELETE FROM library_management WHERE entity_kind = 'album' AND entity_id = ?",
      ).run(album.id);
      db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    }
    if (insertedArtist?.id) {
      db.prepare(
        "DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?",
      ).run(insertedArtist.id);
      db.prepare(
        "DELETE FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
      ).run(insertedArtist.id);
      db.prepare("DELETE FROM library_artists WHERE id = ?").run(insertedArtist.id);
    }
  }
});

test("canonical recent releases exclude owned albums without loading old albums", async () => {
  const key = `recent-canonical-${process.pid}-${Date.now()}`;
  const canonicalArtist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: "45454545-4545-4454-8454-454545454545",
    name: "Canonical Release Artist",
    metadata: { id: 4545 },
  });
  const trackIds = [];
  const addAlbum = ({ suffix, title, releaseDate, available = false }) => {
    const album = upsertLibraryAlbum({
      identityKey: `${key}:album:${suffix}`,
      releaseGroupMbid: `56565656-5656-4565-8565-${String(suffix).padStart(12, "0")}`,
      artistId: canonicalArtist.id,
      title,
      releaseDate,
    });
    const track = upsertLibraryTrack({
      identityKey: `${key}:track:${suffix}`,
      title: `${title} Track`,
      artistName: "Canonical Release Artist",
    });
    trackIds.push(track.id);
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    if (available) {
      upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "lidarr",
        path: `/tmp/${key}/${suffix}.flac`,
        available: true,
      });
    }
  };

  try {
    addAlbum({ suffix: 1, title: "Missing Current", releaseDate: "2026-08-20" });
    addAlbum({ suffix: 2, title: "Owned Current", releaseDate: "2026-08-19", available: true });
    const unrelatedArtist = upsertLibraryArtist({
      identityKey: `${key}:unrelated-artist`,
      name: "Unrelated Release Artist",
    });
    const unrelatedAlbum = upsertLibraryAlbum({
      identityKey: `${key}:unrelated-album`,
      artistId: unrelatedArtist.id,
      title: "Unrelated Newer Release",
      releaseDate: "2026-08-21",
    });
    const unrelatedTrack = upsertLibraryTrack({
      identityKey: `${key}:unrelated-track`,
      title: "Unrelated Track",
      artistName: "Unrelated Release Artist",
    });
    trackIds.push(unrelatedTrack.id);
    linkLibraryAlbumTrack({ albumId: unrelatedAlbum.id, trackId: unrelatedTrack.id });
    for (let index = 0; index < 125; index += 1) {
      addAlbum({ suffix: index + 100, title: `Old Album ${index}`, releaseDate: "2000-01-01" });
    }

    const projectedArtist = getCanonicalArtistProjection({ reference: canonicalArtist.id })[0];
    const projectedAlbums = getCanonicalAlbumsByReleaseDate({
      from: "2026-08-01",
      to: "2026-08-22",
      limit: 10,
    });
    assert.equal(
      projectedAlbums.find((album) => album.title === "Missing Current")?.artistId,
      projectedArtist?.id,
    );

    const releases = await getRecentMissingReleases(10, {
      now: "2026-08-22T12:00:00Z",
    });
    const relevantReleases = releases.filter((album) =>
      [canonicalArtist.id, unrelatedArtist.id].includes(Number(album.artistId)),
    );

    assert.deepEqual(relevantReleases.map((album) => album.title), [
      "Unrelated Newer Release",
      "Missing Current",
    ]);

    const scopedReleases = await getRecentMissingReleases(1, {
      artists: [projectedArtist],
      now: "2026-08-22T12:00:00Z",
    });
    assert.deepEqual(scopedReleases.map((album) => album.title), ["Missing Current"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path LIKE ?").run(`/tmp/${key}/%`);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(canonicalArtist.id);
    if (trackIds.length) {
      db.prepare(
        `DELETE FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`,
      ).run(...trackIds);
    }
  }
});
