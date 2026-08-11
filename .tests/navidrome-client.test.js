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

test("batches large playlist creation requests", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        playlist: urls.length === 1 ? { id: "new-id", name: "Large" } : undefined,
      },
    });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .createPlaylist("Large", Array.from({ length: 401 }, (_, index) => `song-${index}`));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 9);
  assert.equal(urls[0].pathname, "/rest/createPlaylist");
  assert.equal(urls[0].searchParams.getAll("songId").length, 50);
  assert.equal(urls[1].pathname, "/rest/updatePlaylist");
  assert.equal(urls[1].searchParams.getAll("songIdToAdd").length, 50);
  assert.ok(urls.every((url) => url.toString().length < 8192));
});

test("preserves Subsonic error codes for missing native IDs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    "subsonic-response": {
      status: "failed",
      error: { code: 70, message: "Playlist not found" },
    },
  });

  try {
    await assert.rejects(
      new NavidromeClient("http://navidrome.test", "user", "password")
        .getPlaylist("missing"),
      (error) => error.code === 70,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("batches large playlist replacement requests", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    if (urls.length === 1) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          playlist: { entry: [{ id: "old-1" }] },
        },
      });
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .updatePlaylist("playlist-1", {
        name: "Large",
        songIds: Array.from({ length: 101 }, (_, index) => `song-${index}`),
      });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 4);
  assert.equal(urls[1].searchParams.getAll("songIdToAdd").length, 50);
  assert.equal(urls[2].searchParams.getAll("songIdToAdd").length, 50);
  assert.equal(urls[3].searchParams.getAll("songIdToAdd").length, 1);
  assert.ok(urls.every((url) => url.toString().length < 8192));
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

test("matches metadata variants and falls back to title search", async () => {
  const originalFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    queries.push(request.searchParams.get("query"));
    const songs = queries.filter(Boolean).length === 1
      ? []
      : [{
        id: "variant",
        title: "Slide",
        artist: "Goo Goo Dolls",
        album: "Dizzy Up the Girl",
        path: "Goo Goo Dolls/Dizzy Up the Girl/Slide.flac",
      }];
    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        searchResult3: { song: songs },
      },
    });
  };

  let song;
  try {
    song = await new NavidromeClient("http://navidrome.test", "user", "password")
      .findSong("Slide", "The Goo Goo Dolls", {
        album: "Dizzy Up the Girl",
        path: "/music/Goo Goo Dolls/Dizzy Up the Girl/Slide.flac",
      });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(song.id, "variant");
  assert.deepEqual(queries.filter(Boolean), ["The Goo Goo Dolls Slide", "Slide"]);
});

test("uses an indexed path before metadata matching", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._getIndexedSongs = async () => [{
    id: "path-match",
    path: "Artist/Album/track.flac",
    title: "Different tag",
    artist: "Different artist",
  }];
  client.request = async () => {
    throw new Error("metadata search should not run");
  };

  const song = await client.findSong("Wanted title", "Wanted artist", {
    path: "/data/music/Artist/Album/track.flac",
  });

  assert.equal(song.id, "path-match");
});

test("uploads playlist artwork through the native API", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._nativeLogin = async () => "token";
  try {
    await client.uploadPlaylistArtwork(
      "playlist-1",
      Buffer.from("image"),
      "cover.webp",
      "image/webp",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/api/playlist/playlist-1/image");
  assert.equal(requests[0].options.headers["X-ND-Authorization"], "Bearer token");
  assert.equal(requests[0].options.body.get("image").name, "cover.webp");
});

test("deletes playlist artwork through the native API", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._nativeLogin = async () => "token";
  try {
    await client.deletePlaylistArtwork("playlist-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(new URL(requests[0].url).pathname, "/api/playlist/playlist-1/image");
  assert.equal(requests[0].options.method, "DELETE");
  assert.equal(requests[0].options.headers["X-ND-Authorization"], "Bearer token");
});
