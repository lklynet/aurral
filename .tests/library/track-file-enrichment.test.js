import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlaybackQueueFromCanonicalLibrary,
  buildPlaybackQueueFromLidarrData,
  buildTrackFileIndex,
  enrichLidarrTrackWithFiles,
  albumNeedsTrackFiles,
} from "../../backend/services/libraryManager.js";

test("buildPlaybackQueueFromCanonicalLibrary uses indexed files without Lidarr reads", () => {
  const queue = buildPlaybackQueueFromCanonicalLibrary({
    artists: [{ id: 1, name: "Artist" }],
    albums: [{ id: 2, artistId: 1, title: "Album", trackIds: [3] }],
    tracks: [{
      id: 3,
      title: "Track",
      artistName: "Artist",
      albums: [{ albumId: 2, trackNumber: 4 }],
      files: [{ albumId: 2, source: "lidarr", available: true, format: "flac" }],
    }],
  });

  assert.deepEqual(queue, [{
    id: "lib-1-2-3",
    title: "Track",
    artist: "Artist",
    album: "Album",
    streamPath: "/library/file-stream/2/3",
    streamFormat: "flac",
    quality: null,
    trackNumber: 4,
  }]);
});

test("buildTrackFileIndex maps trackFileId and trackIds", () => {
  const index = buildTrackFileIndex([
    {
      id: 10915,
      path: "/data/music/Artist/Album/track.mp3",
      trackIds: [42],
    },
  ]);

  assert.equal(index.get(10915)?.path, "/data/music/Artist/Album/track.mp3");
  assert.equal(index.get("track:42")?.path, "/data/music/Artist/Album/track.mp3");
});

test("enrichLidarrTrackWithFiles attaches trackFile from trackFileId", () => {
  const index = buildTrackFileIndex([
    {
      id: 10915,
      path: "/data/music/Actual Water/Call 4 Fun/track.mp3",
      size: 123,
    },
  ]);

  const enriched = enrichLidarrTrackWithFiles(
    {
      id: 7,
      title: "Take the Stairs",
      hasFile: true,
      trackFileId: 10915,
      path: null,
      trackFile: null,
    },
    index,
  );

  assert.equal(enriched.trackFile.path, "/data/music/Actual Water/Call 4 Fun/track.mp3");
});

test("buildPlaybackQueueFromLidarrData joins tracks to track files by trackFileId", () => {
  const queue = buildPlaybackQueueFromLidarrData({
    artists: [{ id: 100, artistName: "Artist" }],
    rawAlbums: [{ id: 603, artistId: 100, title: "Album" }],
    rawTracks: [
      {
        id: 7,
        albumId: 603,
        title: "Track",
        trackNumber: 1,
        hasFile: true,
        trackFileId: 10915,
      },
    ],
    rawTrackFiles: [
      {
        id: 10915,
        albumId: 603,
        artistId: 100,
        path: "/data/music/Artist/Album/track.mp3",
      },
    ],
  });

  assert.equal(queue.length, 1);
  assert.equal(queue[0].title, "Track");
  assert.equal(queue[0].artist, "Artist");
  assert.equal(queue[0].album, "Album");
  assert.equal(queue[0].streamPath, "/library/file-stream/603/7");
});

test("albumNeedsTrackFiles returns true when album has files on disk", () => {
  assert.equal(
    albumNeedsTrackFiles({
      albumSizeOnDisk: 1,
      isAlbumComplete: false,
      tracks: [],
    }),
    true,
  );
  assert.equal(
    albumNeedsTrackFiles({
      albumSizeOnDisk: 0,
      isAlbumComplete: false,
      tracks: [{ hasFile: true, trackFileId: 1 }],
    }),
    true,
  );
  assert.equal(
    albumNeedsTrackFiles({
      albumSizeOnDisk: 0,
      isAlbumComplete: false,
      tracks: [{ hasFile: false }],
    }),
    false,
  );
});
