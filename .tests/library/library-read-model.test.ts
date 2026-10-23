import { readArtist, readAlbum, readTrack, readFile } from "./fixtures.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  buildLibraryReadModel,
  findLibraryArtist,
  findLibraryTracksForAlbum,
} from "../../backend/services/libraryReadModel.ts";
import { selectCanonicalFile } from "../../backend/services/canonicalFileSelector.ts";

const library = {
  artists: [
    readArtist({
      id: 1,
      identityKey: "mbid:artist-1",
      mbid: "artist-1",
      name: "Root Artist",
      sortName: "Root Artist",

      sources: ["lidarr"],
      available: true,
    }),
  ],
  albums: [
    readAlbum({
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
    }),
  ],
  tracks: [
    readTrack({
      id: 3,
      mbid: "track-1",
      title: "Root Track",
      albums: [{ albumId: 2, discNumber: 1, trackNumber: 1 }],
      files: [
        readFile({
          id: 4,
          source: "lidarr",
          path: "/music/Root Artist/Root Album/01 Root Track.flac",
          size: 123,
          quality: { format: "FLAC" },
          available: true,
        }),
      ],
      sources: ["lidarr"],
      available: true,
    }),
  ],
};

test("library read model maps the existing root to Library-shaped records", () => {
  const result = buildLibraryReadModel(library);

  assert.equal(findLibraryArtist(result.artists, "artist-1")?.artistName, "Root Artist");
  assert.equal(result.albums[0].artistMbid, "artist-1");
  assert.deepEqual(
    findLibraryTracksForAlbum(result.tracks, 2).map((track) => track.trackName),
    ["Root Track"],
  );
  assert.equal(result.albums[0].mbid, "release-1");
  assert.equal(result.albums[0].releaseGroupMbid, "album-1");
  assert.equal(result.artists[0].foreignArtistId, "artist-1");
  assert.equal(result.albums[0].statistics.sizeOnDisk, 123);
  assert.equal(result.artists[0].statistics.sizeOnDisk, 123);
  assert.equal(result.tracks[0].path, "/music/Root Artist/Root Album/01 Root Track.flac");
});

test("library album statistics exclude unavailable file sizes", () => {
  const result = buildLibraryReadModel({
    artists: [readArtist({ id: 11, name: "Unavailable Artist" })],
    albums: [readAlbum({ id: 12, artistId: 11, title: "Unavailable Album", trackIds: [13] })],
    tracks: [
      readTrack({
        id: 13,
        title: "Unavailable Track",
        albums: [{ albumId: 12, discNumber: 1, trackNumber: 1 }],
        files: [readFile({ path: "/music/unavailable.flac", size: 456, available: false })],
      }),
    ],
  });

  assert.equal(result.albums[0].statistics.trackFileCount, 0);
  assert.equal(result.albums[0].statistics.sizeOnDisk, 0);
});

test("library read model preserves non-MBID provider artist identity", () => {
  const result = buildLibraryReadModel({
    artists: [
      readArtist({
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

        sources: ["lidarr"],
        available: false,
      }),
    ],
    albums: [],
    tracks: [],
  });

  assert.equal(result.artists[0].providerId, 42);
  assert.equal(result.artists[0].mbid, null);
  assert.equal(result.artists[0].foreignArtistId, "705@deezer");
  assert.equal(
    findLibraryArtist(result.artists, "lidarr-artist:705@deezer")?.name,
    "Provider Artist",
  );
});

test("library file reads prefer the album manager before Lidarr", () => {
  const file = selectCanonicalFile(
    [
      { albumId: 2, source: "lidarr", path: "/music/lidarr.flac", available: true },
      { albumId: 2, source: "aurral", path: "/music/aurral.flac", available: true },
    ],
    2,
    "aurral",
  );

  assert.equal(file.path, "/music/aurral.flac");
});
