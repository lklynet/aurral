import test from "node:test";
import assert from "node:assert/strict";

import {
  addActiveDownload,
  finishedActiveDownloads,
  indexActiveDownloads,
  isAlbumDownloading,
  isTrackDownloading,
} from "../../frontend/src/utils/activeDownloads.js";

const recording = "11111111-2222-4333-8444-555555555555";

test("tracks match an active download by any MusicBrainz id or by artist and title", () => {
  const index = indexActiveDownloads({
    tracks: [
      { mbid: recording, artistName: "Artist", trackName: "Song" },
      { mbid: null, artistName: "Nameless", trackName: "Untagged Track" },
    ],
  });
  assert.equal(isTrackDownloading(index, { id: recording, title: "Other" }), true);
  assert.equal(isTrackDownloading(index, { trackMbid: recording }), true);
  assert.equal(isTrackDownloading(index, { artist: " nameless ", title: "UNTAGGED track" }), true);
  assert.equal(isTrackDownloading(index, { id: 42, artistName: "Artist", title: "Different" }), false);
  assert.equal(isTrackDownloading(index, { trackName: "Song" }), false);
  assert.equal(isTrackDownloading(index, null), false);
});

test("a started download shows immediately and finishing it is detected", () => {
  const started = addActiveDownload(undefined, { albumMbid: "album-1", artistMbid: "artist-1" });
  assert.equal(isAlbumDownloading(indexActiveDownloads(started), "album-1"), true);
  assert.equal(isAlbumDownloading(indexActiveDownloads(started), ""), false);

  const withTrack = addActiveDownload(started, { track: { mbid: recording } });
  assert.equal(finishedActiveDownloads(started, withTrack), false);
  assert.equal(finishedActiveDownloads(withTrack, { albums: ["album-1"], tracks: [] }), true);
  assert.equal(finishedActiveDownloads(withTrack, { tracks: [{ mbid: recording }] }), true);
  assert.equal(finishedActiveDownloads(withTrack, withTrack), false);
});
