import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLibraryReadModel,
  findLibraryArtist,
  findLibraryTracksForAlbum,
} from "../../backend/services/libraryReadModel.js";
import { selectCanonicalFile } from "../../backend/services/canonicalFileSelector.js";

const library = {
  artists: [
    {
      id: 1,
      identityKey: "mbid:artist-1",
      mbid: "artist-1",
      name: "Root Artist",
      sortName: "Root Artist",
      albumIds: [2],
      sources: ["lidarr"],
      available: true,
    },
  ],
  albums: [
    {
      id: 2,
      identityKey: "release-group:album-1",
      mbid: "release-1",
      releaseGroupMbid: "album-1",
      artistId: 1,
      title: "Root Album",
      albumArtist: "Root Artist",
      releaseDate: "2026-01-01",
      trackIds: [3],
      sources: ["lidarr"],
      available: true,
    },
  ],
  tracks: [
    {
      id: 3,
      mbid: "track-1",
      title: "Root Track",
      albums: [{ albumId: 2, trackNumber: 1 }],
      files: [
        {
          id: 4,
          source: "lidarr",
          path: "/music/Root Artist/Root Album/01 Root Track.flac",
          size: 123,
          quality: { format: "FLAC" },
          available: true,
        },
      ],
      sources: ["lidarr"],
      available: true,
    },
  ],
};

test("library read model maps the existing root to Library-shaped records", () => {
  const result = buildLibraryReadModel(library);

  assert.equal(findLibraryArtist(result.artists, "artist-1")?.artistName, "Root Artist");
  assert.equal(result.albums[0].artistMbid, "artist-1");
  assert.deepEqual(findLibraryTracksForAlbum(result.tracks, 2).map((track) => track.trackName), [
    "Root Track",
  ]);
  assert.equal(result.albums[0].mbid, "release-1");
  assert.equal(result.albums[0].releaseGroupMbid, "album-1");
  assert.equal(result.artists[0].foreignArtistId, "artist-1");
  assert.equal(result.albums[0].statistics.sizeOnDisk, 123);
  assert.equal(result.artists[0].statistics.sizeOnDisk, 123);
  assert.equal(result.tracks[0].path, "/music/Root Artist/Root Album/01 Root Track.flac");
});

test("library album statistics exclude unavailable file sizes", () => {
  const result = buildLibraryReadModel({
    artists: [{ id: 11, name: "Unavailable Artist", albumIds: [12] }],
    albums: [{ id: 12, artistId: 11, title: "Unavailable Album", trackIds: [13] }],
    tracks: [{
      id: 13,
      title: "Unavailable Track",
      albums: [{ albumId: 12 }],
      files: [{ path: "/music/unavailable.flac", size: 456, available: false }],
    }],
  });

  assert.equal(result.albums[0].statistics.trackFileCount, 0);
  assert.equal(result.albums[0].statistics.sizeOnDisk, 0);
});

test("library read model preserves non-MBID provider artist identity", () => {
  const result = buildLibraryReadModel({
    artists: [
      {
        id: 4,
        identityKey: "lidarr-artist:705@deezer",
        mbid: null,
        name: "Provider Artist",
        sortName: "Provider Artist",
        metadata: {
          id: 42,
          foreignArtistId: "705@deezer",
          librarySource: "lidarr",
        },
        albumIds: [],
        sources: ["lidarr"],
        available: false,
      },
    ],
    albums: [],
    tracks: [],
  });

  assert.equal(result.artists[0].providerId, 42);
  assert.equal(result.artists[0].mbid, null);
  assert.equal(result.artists[0].foreignArtistId, "705@deezer");
});

test("library read model keeps flow-like records out when the index excludes them", () => {
  const result = buildLibraryReadModel({
    artists: [],
    albums: [],
    tracks: [],
  });

  assert.deepEqual(result, { artists: [], albums: [], tracks: [] });
});

test("library file reads prefer the album manager before Lidarr", () => {
  const file = selectCanonicalFile([
    { albumId: 2, source: "lidarr", path: "/music/lidarr.flac", available: true },
    { albumId: 2, source: "aurral", path: "/music/aurral.flac", available: true },
  ], 2, "aurral");

  assert.equal(file.path, "/music/aurral.flac");
});
