import test from "node:test";
import assert from "node:assert/strict";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
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

    assert.deepEqual(releases.map((album) => album.title), [
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
