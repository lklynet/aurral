import { readArtist, readAlbum, readTrack, readFile } from "./fixtures.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { buildPlaybackQueueFromLibrary } from "../../backend/services/libraryManager.ts";

test("buildPlaybackQueueFromLibrary keeps the performer credit and uses indexed files", () => {
  const queue = buildPlaybackQueueFromLibrary({
    artists: [readArtist({ id: 1, name: "Artist" })],
    albums: [readAlbum({ id: 603, artistId: 1, title: "Album", trackIds: [7] })],
    tracks: [
      readTrack({
        id: 7,
        title: "Track",
        artistName: "Guest & Artist",
        albums: [{ albumId: 603, discNumber: 1, trackNumber: 4 }],
        files: [readFile({ albumId: 603, source: "readonly", available: true, format: "flac" })],
      }),
    ],
  });

  assert.deepEqual(queue, [
    {
      id: "lib-1-603-7",
      title: "Track",
      artist: "Guest & Artist",
      album: "Album",
      streamPath: "/library/stream/603/7",
      streamFormat: "flac",
      quality: null,
      trackNumber: 4,
    },
  ]);
});
