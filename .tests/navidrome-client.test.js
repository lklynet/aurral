import test from "node:test";
import assert from "node:assert/strict";

import { NavidromeClient } from "../backend/services/navidrome.js";

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});

test("creates a distinct playlist without looking up matching display names", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return jsonResponse({
      "subsonic-response": { status: "ok", playlist: { id: "new-id", name: "Same Name" } },
    });
  };

  let playlist;
  try {
    playlist = await new NavidromeClient("http://navidrome.test", "user", "password")
      .createPlaylist("Same Name", ["song-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(playlist.id, "new-id");
  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, "/rest/createPlaylist");
});

test("replaces playlist entries with repeated Subsonic parameters", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    if (urls.length === 1) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          playlist: { entry: [{ id: "old-1" }, { id: "old-2" }] },
        },
      });
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .updatePlaylist("playlist-1", { name: "Renamed", songIds: ["song-1", "song-2"] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(urls[1].searchParams.getAll("songIndexToRemove"), ["0", "1"]);
  assert.deepEqual(urls[1].searchParams.getAll("songIdToAdd"), ["song-1", "song-2"]);
  assert.equal(urls[1].searchParams.get("name"), "Renamed");
});

test("prefers the exact path and metadata when duplicate songs match", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    "subsonic-response": {
      status: "ok",
      searchResult3: {
        song: [
          { id: "other", title: "Song", artist: "Artist", album: "Other", path: "Song.flac" },
          {
            id: "match",
            title: "Song",
            artist: "Artist",
            album: "Album",
            path: "Artist/Album/Song.flac",
            duration: 240,
          },
        ],
      },
    },
  });

  let song;
  try {
    song = await new NavidromeClient("http://navidrome.test", "user", "password")
      .findSong("Song", "Artist", {
        album: "Album",
        durationMs: 240000,
        path: "/music/Artist/Album/Song.flac",
      });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(song.id, "match");
});
