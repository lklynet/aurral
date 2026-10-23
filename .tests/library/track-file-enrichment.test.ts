import { readArtist, readAlbum, readTrack, readFile } from "./fixtures.ts";
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
    artists: [readArtist({ id: 1, name: "Artist" })],
    albums: [readAlbum({ id: 603, artistId: 1, title: "Album", trackIds: [7] })],
    tracks: [
      readTrack({
        id: 7,
        title: "Track",
        artistName: "Guest & Artist",
        albums: [{ albumId: 603, discNumber: 1, trackNumber: 4 }],
        files: [readFile({ albumId: 603, source: "lidarr", available: true, format: "flac" })],
      }),
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

  assert.ok(enriched.trackFile);
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
      tracks: [{ id: 1, title: "Track", hasFile: true, trackFileId: 1 }],
    }),
    true,
  );
  assert.equal(
    albumNeedsTrackFiles({
      albumSizeOnDisk: 0,
      isAlbumComplete: false,
      tracks: [{ id: 1, title: "Track", hasFile: false }],
    }),
    false,
  );
});
