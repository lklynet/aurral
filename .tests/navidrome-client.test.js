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

test("retries Navidrome rate limits", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").ping();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2);
});

test("retries transient Navidrome connection failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").ping();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2);
});

test("does not retry transient failures for playlist mutations", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  };

  try {
    await assert.rejects(
      new NavidromeClient("http://navidrome.test", "user", "password")
        .createPlaylist("Once", ["song-1"]),
      /fetch failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 1);
});

test("uses the fallback delay for invalid rate limit headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 429,
    headers: { "retry-after": "-1" },
  });

  try {
    await assert.rejects(
      new NavidromeClient("http://navidrome.test", "user", "password").ping(),
      /status code 429/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batches large playlist creation requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: new URL(url), init });
    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        playlist: requests.length === 1 ? { id: "new-id", name: "Large" } : undefined,
      },
    });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .createPlaylist("Large", Array.from({ length: 401 }, (_, index) => `song-${index}`));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 9);
  assert.equal(requests[0].url.pathname, "/rest/createPlaylist");
  assert.equal(requests[0].url.searchParams.getAll("songId").length, 50);
  assert.equal(requests[1].url.pathname, "/rest/updatePlaylist");
  assert.equal(requests[1].init.body.getAll("songIdToAdd").length, 50);
  assert.ok(requests.every(({ url }) => url.toString().length < 8192));
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
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: new URL(url), init });
    if (requests.length === 1) {
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

  assert.deepEqual(requests[1].init.body.getAll("songIndexToRemove"), ["0", "1"]);
  assert.deepEqual(requests[1].init.body.getAll("songIdToAdd"), ["song-1", "song-2"]);
  assert.equal(requests[1].init.body.get("name"), "Renamed");
});

test("batches large playlist replacement requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: new URL(url), init });
    if (requests.length === 1) {
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

  assert.equal(requests.length, 4);
  assert.equal(requests[1].init.body.getAll("songIdToAdd").length, 50);
  assert.equal(requests[2].init.body.getAll("songIdToAdd").length, 50);
  assert.equal(requests[3].init.body.getAll("songIdToAdd").length, 1);
  assert.ok(requests.every(({ url }) => url.toString().length < 8192));
});

test("posts large playlist replacements without exceeding request URL limits", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).length >= 8192) throw new TypeError("fetch failed");
    requests.push({ url: new URL(url), init });
    if (requests.length === 1) {
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          playlist: {
            entry: Array.from({ length: 1_000 }, (_, index) => ({ id: `old-${index}` })),
          },
        },
      });
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .updatePlaylist("playlist-1", { name: "Large", songIds: ["song-1"] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[1].url.pathname, "/rest/updatePlaylist");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].url.search, "");
  assert.equal(requests[1].init.body.getAll("songIndexToRemove").length, 1_000);
});

test("preserves playlist update parameters across same-origin redirects", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: new URL(url), init });
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "/canonical/updatePlaylist" },
      });
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .request("updatePlaylist", { playlistId: "playlist-1", songIdToAdd: ["song-1"] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[1].url.pathname, "/canonical/updatePlaylist");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.body.get("playlistId"), "playlist-1");
  assert.deepEqual(requests[1].init.body.getAll("songIdToAdd"), ["song-1"]);
});

test("rejects playlist update redirects across origins", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.test/updatePlaylist" },
    });
  };

  try {
    await assert.rejects(
      new NavidromeClient("http://navidrome.test", "user", "password")
        .request("updatePlaylist", { playlistId: "playlist-1" }),
      /redirect request body across origins/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests, 1);
});

test("prefers the exact indexed path when duplicate songs match", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._getIndexedSongs = async () => [
    { id: "other", title: "Song", artist: "Artist", album: "Other", path: "/music/Other/Song.flac" },
    {
      id: "match",
      title: "Song",
      artist: "Artist",
      album: "Album",
      path: "/music/Artist/Album/Song.flac",
      duration: 240,
    },
  ];
  const song = await client.findSong("Song", "Artist", {
    album: "Album",
    durationMs: 240000,
    path: "/music/Artist/Album/Song.flac",
  });

  assert.equal(song.id, "match");
});

test("does not match an unindexed track from metadata search", async () => {
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
    const client = new NavidromeClient("http://navidrome.test", "user", "password");
    client._getIndexedSongs = async () => [];
    song = await client
      .findSong("Slide", "The Goo Goo Dolls", {
        album: "Dizzy Up the Girl",
        path: "/music/Goo Goo Dolls/Dizzy Up the Girl/Slide.flac",
      });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(song, null);
  assert.deepEqual(queries, []);
});

test("uses an indexed path without metadata matching", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._getIndexedSongs = async () => [{
    id: "path-match",
    path: "/data/music/Artist/Album/track.flac",
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

test("matches Navidrome-relative paths under the configured library root", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._nativeRequest = async () => [
    { id: "music-library", name: "Music Library", path: "/data/music" },
    { id: "aurral-song", name: "Aurral Playlists", path: "/data/downloads/aurral" },
  ];
  await client.ensureWeeklyFlowLibrary("/data/downloads/aurral");
  client._getIndexedSongs = async () => [{
    id: "relative-match",
    path: "The Rapture/Echoes/Echoes.flac",
  }, {
    id: "music-relative-match",
    path: "Black Lips/Good Bad Not Evil/Black Lips_Good Bad Not Evil_08_Bad Kids.flac",
  }];

  const song = await client.findSong("Echoes", "The Rapture", {
    path: "/data/downloads/aurral/The Rapture/Echoes/Echoes.flac",
  });

  assert.equal(song.id, "relative-match");
  const musicSong = await client.findSong("Bad Kids", "Black Lips", {
    path: "/data/music/Black Lips/Good Bad Not Evil/Black Lips_Good Bad Not Evil_08_Bad Kids.flac",
  });

  assert.equal(musicSong.id, "music-relative-match");
});

test("waits for and verifies a Navidrome library update", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  let libraryPath = "/data/downloads/aurral-weekly-flow";
  const calls = [];
  client._nativeRequest = async (method, requestPath, body) => {
    calls.push({ method, requestPath, body });
    if (method === "GET") {
      return [{ id: "aurral-library", name: "Aurral Weekly Flow", path: libraryPath }];
    }
    if (method === "PUT") {
      libraryPath = body.path;
      return { id: "aurral-library", name: body.name, path: body.path };
    }
    throw new Error(`Unexpected Navidrome request: ${method} ${requestPath}`);
  };

  const library = await client.ensureWeeklyFlowLibrary("/data/downloads");

  assert.equal(library.id, "aurral-library");
  assert.equal(library.path, "/data/downloads");
  assert.deepEqual(calls.map(({ method, requestPath }) => [method, requestPath]), [
    ["GET", "/api/library"],
    ["PUT", "/api/library/aurral-library"],
    ["GET", "/api/library"],
  ]);
});

test("fails when Navidrome keeps the old library path", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._nativeRequest = async (method) => {
    if (method === "GET") {
      return [{ id: "aurral-library", name: "Aurral Playlists", path: "/data/downloads/aurral-weekly-flow" }];
    }
    return { ok: true };
  };

  await assert.rejects(
    client.ensureWeeklyFlowLibrary("/data/downloads"),
    /Navidrome library path verification failed/,
  );
});

test("prefers an exact absolute path over an earlier relative match", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._libraryPaths = ["/data/music"];
  client._getIndexedSongs = async () => [{
    id: "relative-match",
    path: "Artist/Album/track.flac",
  }, {
    id: "exact-match",
    path: "/data/music/Artist/Album/track.flac",
  }];

  const song = await client.findSong("Track", "Artist", {
    path: "/data/music/Artist/Album/track.flac",
  });

  assert.equal(song.id, "exact-match");
});

test("does not match a path suffix from another library", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._getIndexedSongs = async () => [{
    id: "other-library",
    path: "/library/Artist/Album/track.flac",
  }];

  const song = await client.findSong("Track", "Artist", {
    path: "/other-library/Artist/Album/track.flac",
  });

  assert.equal(song, null);
});

test("uses an exact indexed recording MBID when the path differs", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._getIndexedSongs = async () => [{
    id: "mbid-match",
    musicBrainzId: "recording-mbid",
    path: "Artist/Album/track.flac",
  }];
  client.request = async () => {
    throw new Error("metadata search should not run");
  };

  const song = await client.findSong("Wanted title", "Wanted artist", {
    mbid: "recording-mbid",
    path: "/data/music/Other/track.flac",
  });

  assert.equal(song.id, "mbid-match");
});

test("loads the complete indexed song list in pages", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  const requests = [];
  client._nativeRequest = async (_method, requestPath) => {
    requests.push(requestPath);
    const start = Number(new URL(`http://navidrome.test${requestPath}`).searchParams.get("_start"));
    if (start === 0) return Array.from({ length: 1_000 }, (_, index) => ({ id: `song-${index}` }));
    if (start === 1_000) return [{ id: "song-after-first-page" }];
    return [];
  };

  const songs = await client._getIndexedSongs();

  assert.equal(songs.length, 1_001);
  assert.equal(songs.at(-1).id, "song-after-first-page");
  assert.deepEqual(requests, [
    "/api/song?_start=0&_end=1000",
    "/api/song?_start=1000&_end=2000",
  ]);
});

test("reuses one native login while paging the song index", async () => {
  const originalFetch = globalThis.fetch;
  let loginCount = 0;
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    if (request.pathname === "/auth/login") {
      loginCount += 1;
      return jsonResponse({ token: "native-token" });
    }
    const start = Number(request.searchParams.get("_start"));
    return jsonResponse(start < 5_000
      ? Array.from({ length: 1_000 }, (_, index) => ({ id: `song-${start + index}` }))
      : [{ id: "last-song" }]);
  };

  let songs;
  try {
    songs = await new NavidromeClient("http://navidrome.test", "user", "password")
      ._getIndexedSongs();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(songs.length, 5_001);
  assert.equal(loginCount, 1);
});

test("refreshes a cached native token after a 401", async () => {
  const originalFetch = globalThis.fetch;
  let loginCount = 0;
  let requestCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const request = new URL(url);
    if (request.pathname === "/auth/login") {
      loginCount += 1;
      return jsonResponse({ token: loginCount === 1 ? "stale-token" : "fresh-token" });
    }
    requestCount += 1;
    if (requestCount === 1) return new Response(null, { status: 401 });
    assert.equal(options.headers["X-ND-Authorization"], "Bearer fresh-token");
    return jsonResponse({ ok: true });
  };

  try {
    const client = new NavidromeClient("http://navidrome.test", "user", "password");
    assert.deepEqual(await client._nativeRequest("GET", "/api/library"), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(loginCount, 2);
  assert.equal(requestCount, 2);
});

test("retries native Navidrome requests after a 429", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    if (request.pathname === "/auth/login") return jsonResponse({ token: "native-token" });
    requestCount += 1;
    if (requestCount === 1) return new Response(null, {
      status: 429,
      headers: { "retry-after": "0" },
    });
    return jsonResponse({ ok: true });
  };

  try {
    const client = new NavidromeClient("http://navidrome.test", "user", "password");
    assert.deepEqual(await client._nativeRequest("GET", "/api/library"), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestCount, 2);
});

test("refreshes a cached native token after a 401 during artwork upload", async () => {
  const originalFetch = globalThis.fetch;
  let loginCount = 0;
  let artworkAttempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const request = new URL(url);
    if (request.pathname === "/auth/login") {
      loginCount += 1;
      return jsonResponse({ token: loginCount === 1 ? "stale-token" : "fresh-token" });
    }
    artworkAttempts += 1;
    if (artworkAttempts === 1) return new Response(null, { status: 401 });
    assert.equal(options.headers["X-ND-Authorization"], "Bearer fresh-token");
    return new Response(null, { status: 204 });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password")
      .uploadPlaylistArtwork("playlist-1", Buffer.from("image"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(loginCount, 2);
  assert.equal(artworkAttempts, 2);
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
