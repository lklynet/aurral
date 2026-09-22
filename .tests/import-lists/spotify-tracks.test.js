import test from "node:test";
import assert from "node:assert/strict";
import { parseSpotifyPlaylistItems } from "../../backend/services/importLists/spotifyTracks.js";

test("parseSpotifyPlaylistItems maps spotify playlist entries to aurral tracks", () => {
  const { tracks } = parseSpotifyPlaylistItems([
    {
      track: {
        type: "track",
        name: "Track One",
        artists: [{ name: "Artist A" }],
        album: { name: "Album A" },
      },
    },
    { track: null },
    {
      track: {
        type: "episode",
        name: "Skip me",
        artists: [{ name: "Podcast" }],
      },
    },
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].artistName, "Artist A");
  assert.equal(tracks[0].trackName, "Track One");
  assert.equal(tracks[0].albumName, "Album A");
});

test("parseSpotifyPlaylistItems keeps tracks when spotify fields omit type", () => {
  const { tracks } = parseSpotifyPlaylistItems([
    {
      track: {
        name: "No Type Field",
        artists: [{ name: "Artist B" }],
        album: { name: "Album B" },
      },
    },
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].trackName, "No Type Field");
});

test("parseSpotifyPlaylistItems accepts current item and legacy track wrappers", () => {
  const { tracks } = parseSpotifyPlaylistItems([
    {
      item: {
        type: "track",
        name: "Current Wrapper",
        artists: [{ name: "Artist A" }],
        album: { name: "Album A" },
      },
    },
    {
      track: {
        type: "track",
        name: "Legacy Wrapper",
        artists: [{ name: "Artist B" }],
        album: { name: "Album B" },
      },
    },
  ]);
  assert.deepEqual(tracks.map((track) => track.trackName), ["Current Wrapper", "Legacy Wrapper"]);
});

test("parseSpotifyPlaylistItems reports skipped spotify entries", () => {
  const { tracks, stats, excluded } = parseSpotifyPlaylistItems([
    { track: null },
    {
      track: {
        type: "episode",
        name: "Podcast ep",
        artists: [{ name: "Host" }],
      },
    },
    {
      track: {
        type: "track",
        name: "Real Song",
        artists: [{ name: "Band" }],
        album: { name: "Album" },
      },
    },
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.podcast, 1);
  assert.equal(stats.sourceItems, 3);
  assert.deepEqual(excluded.map(({ position, reason }) => ({ position, reason })), [
    { position: 1, reason: "unavailable" },
    { position: 2, reason: "podcast" },
  ]);
});

test("parseSpotifyPlaylistItems identifies duplicate source positions", () => {
  const { tracks, stats, excluded } = parseSpotifyPlaylistItems([
    { track: { name: "Same Song", artists: [{ name: "Artist" }], album: { name: "Album" } } },
    { track: { name: "Same Song", artists: [{ name: "Artist" }], album: { name: "Album" } } },
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(stats.duplicate, 1);
  assert.deepEqual(excluded, [{
    position: 2,
    reason: "duplicate",
    artistName: "Artist",
    trackName: "Same Song",
  }]);
});
