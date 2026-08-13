import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalLibraryReadModel,
  findCanonicalAlbumsForArtist,
  findCanonicalArtist,
  findCanonicalTracksForAlbum,
} from "../../backend/services/canonicalLibraryReadAdapter.js";

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
      mbid: "album-1",
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

test("canonical read model maps the existing root to Library-shaped records", () => {
  const result = buildCanonicalLibraryReadModel(library);

  assert.equal(findCanonicalArtist(result.artists, "artist-1")?.artistName, "Root Artist");
  assert.deepEqual(findCanonicalAlbumsForArtist(result.albums, "artist-1").map((album) => album.id), [2]);
  assert.deepEqual(findCanonicalTracksForAlbum(result.tracks, 2).map((track) => track.trackName), [
    "Root Track",
  ]);
  assert.equal(result.albums[0].statistics.sizeOnDisk, 123);
  assert.equal(result.artists[0].statistics.sizeOnDisk, 123);
  assert.equal(result.tracks[0].path, "/music/Root Artist/Root Album/01 Root Track.flac");
});

test("canonical read model keeps flow-like records out when the index excludes them", () => {
  const result = buildCanonicalLibraryReadModel({
    artists: [],
    albums: [],
    tracks: [],
  });

  assert.deepEqual(result, { artists: [], albums: [], tracks: [] });
});
