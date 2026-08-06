import test from "node:test";
import assert from "node:assert/strict";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import { dbOps } from "../../backend/db/helpers/index.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";
import { libraryManager } from "../../backend/services/libraryManager.js";

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
