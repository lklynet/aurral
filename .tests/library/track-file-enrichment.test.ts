import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  buildPlaybackQueueFromLibrary,
  buildTrackFileIndex,
  enrichLidarrTrackWithFiles,
  albumNeedsTrackFiles,
} from "../../backend/services/libraryManager.ts";

test("buildPlaybackQueueFromLibrary keeps the performer credit and uses indexed files without Lidarr reads", () => {
  const queue = buildPlaybackQueueFromLibrary({
    artists: [{ id: 1, name: "Artist" }],
    albums: [{ id: 603, artistId: 1, title: "Album", trackIds: [7] }],
    tracks: [
      {
        id: 7,
        title: "Track",
        artistName: "Guest & Artist",
        albums: [{ albumId: 603, trackNumber: 4 }],
        files: [{ albumId: 603, source: "lidarr", available: true, format: "flac" }],
      },
    ],
  });

  assert.deepEqual(queue, [
    {
      id: "lib-1-603-7",
      title: "Track",
      artist: "Guest & Artist",
      album: "Album",
      streamPath: "/library/canonical-stream/603/7",
      streamFormat: "flac",
      quality: null,
      trackNumber: 4,
    },
  ]);
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
