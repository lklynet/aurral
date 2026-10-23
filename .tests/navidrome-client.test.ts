import { asAppError } from "../lib/errors.ts";
import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { NavidromeClient } from "../backend/services/navidrome.ts";
import { createFakeNavidrome } from "./helpers/fakeNavidrome.ts";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (delay: number, value: unknown) =>
    new Promise<void>((resolve) => setTimeout(resolve, delay, value)),
}));

function captureRequest(url: Parameters<typeof fetch>[0], init: RequestInit) {
  assert.ok(init.body == null || init.body instanceof URLSearchParams);
  return {
    url: new URL(url instanceof Request ? url.url : url),
    init: { ...init, body: init.body ?? new URLSearchParams() },
  };
}

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

test("creates a distinct playlist without looking up matching display names", async () => {
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url instanceof Request ? url.url : url));
    return jsonResponse({
      "subsonic-response": { status: "ok", playlist: { id: "new-id", name: "Same Name" } },
    });
  };

  let playlist: {
    id: string;
    name: string;
    comment?: string;
    songCount?: number;
    entry?: { id: string; path: string } | { id: string; path: string }[];
  } | null;
  try {
    playlist = await new NavidromeClient(
      "http://navidrome.test",
      "user",
      "password",
    ).createPlaylist("Same Name", ["song-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(playlist);
  assert.equal(playlist.id, "new-id");
  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, "/rest/createPlaylist");
  assert.equal(urls[1].pathname, "/rest/updatePlaylist");
});

test("makes newly created playlists public", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(captureRequest(url, init));
    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        ...(requests.length === 1 ? { playlist: { id: "new-id" } } : {}),
      },
    });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").createPlaylist(
      "Shared",
      ["song-1"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.pathname, "/rest/updatePlaylist");
  assert.equal(requests[1].init.body.get("playlistId")!, "new-id");
  assert.equal(requests[1].init.body.get("public")!, "true");
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let firstAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => {
    firstAttempt = resolve;
  });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      firstAttempt();
      throw new TypeError("fetch failed");
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    const pinging = new NavidromeClient("http://navidrome.test", "user", "password").ping();
    await attempted;
    await vi.advanceTimersToNextTimerAsync();
    await pinging;
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
      new NavidromeClient("http://navidrome.test", "user", "password").createPlaylist("Once", [
        "song-1",
      ]),
      /fetch failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 1);
});

test("batches large playlist creation requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(captureRequest(url, init));
    return jsonResponse({
      "subsonic-response": {
        status: "ok",
        playlist: requests.length === 1 ? { id: "new-id", name: "Large" } : undefined,
      },
    });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").createPlaylist(
      "Large",
      Array.from({ length: 401 }, (_, index) => `song-${index}`),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 10);
  assert.equal(requests[0].url.pathname, "/rest/createPlaylist");
  assert.equal(requests[0].url.searchParams.getAll("songId").length, 50);
  assert.equal(requests[1].url.pathname, "/rest/updatePlaylist");
  assert.equal(requests[1].init.body.get("public")!, "true");
  assert.equal(requests[2].init.body.getAll("songIdToAdd")!.length, 50);
  assert.ok(requests.every(({ url }) => url.toString().length < 8192));
});

test("preserves Subsonic error codes for missing native IDs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      "subsonic-response": {
        status: "failed",
        error: { code: 70, message: "Playlist not found" },
      },
    });

  try {
    await assert.rejects(
      new NavidromeClient("http://navidrome.test", "user", "password").getPlaylist("missing"),
      (error) => String(asAppError(error)?.code) === "70",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replaces playlist entries without changing visibility", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(captureRequest(url, init));
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
    await new NavidromeClient("http://navidrome.test", "user", "password").updatePlaylist(
      "playlist-1",
      { name: "Renamed", songIds: ["song-1", "song-2"] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests[1].init.body.getAll("songIndexToRemove")!, ["0", "1"]);
  assert.deepEqual(requests[1].init.body.getAll("songIdToAdd")!, ["song-1", "song-2"]);
  assert.equal(requests[1].init.body.get("name")!, "Renamed");
  assert.equal(requests[1].init.body.has("public")!, false);
});

test("batches large playlist replacement requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(captureRequest(url, init));
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
    await new NavidromeClient("http://navidrome.test", "user", "password").updatePlaylist(
      "playlist-1",
      {
        name: "Large",
        songIds: Array.from({ length: 101 }, (_, index) => `song-${index}`),
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 4);
  assert.equal(requests[1].init.body.getAll("songIdToAdd")!.length, 50);
  assert.equal(requests[2].init.body.getAll("songIdToAdd")!.length, 50);
  assert.equal(requests[3].init.body.getAll("songIdToAdd")!.length, 1);
  assert.ok(requests.every(({ url }) => url.toString().length < 8192));
});

test("posts large playlist replacements without exceeding request URL limits", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).length >= 8192) throw new TypeError("fetch failed");
    requests.push(captureRequest(url, init));
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
    await new NavidromeClient("http://navidrome.test", "user", "password").updatePlaylist(
      "playlist-1",
      { name: "Large", songIds: ["song-1"] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[1].url.pathname, "/rest/updatePlaylist");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].url.search, "");
  assert.equal(requests[1].init.body.getAll("songIndexToRemove")!.length, 1_000);
});

test("preserves playlist update parameters across same-origin redirects", async () => {
  const originalFetch = globalThis.fetch;
  const requests: ReturnType<typeof captureRequest>[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(captureRequest(url, init));
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "/canonical/updatePlaylist" },
      });
    }
    return jsonResponse({ "subsonic-response": { status: "ok" } });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").request(
      "updatePlaylist",
      { playlistId: "playlist-1", songIdToAdd: ["song-1"] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[1].url.pathname, "/canonical/updatePlaylist");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.body.get("playlistId")!, "playlist-1");
  assert.deepEqual(requests[1].init.body.getAll("songIdToAdd")!, ["song-1"]);
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
      new NavidromeClient("http://navidrome.test", "user", "password").request("updatePlaylist", {
        playlistId: "playlist-1",
      }),
      /redirect request body across origins/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests, 1);
});

async function withNavidrome<Result>(
  navidrome: ReturnType<typeof createFakeNavidrome>,
  run: () => Promise<Result>,
): Promise<Result> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = navidrome.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function connectToLibraries(libraries: { id: number; name: string; path: string }[]) {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  await client.ensureAurralLibrary(
    libraries.find((library) => library.name === "Aurral Playlists")!.path,
  );
  return client;
}

test("prefers the exact indexed path when duplicate songs match", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "other",
        libraryPath: "/music",
        path: "Other/Song.flac",
        title: "Song",
        artist: "Artist",
        album: "Other",
      },
      {
        id: "match",
        libraryPath: "/music",
        path: "Artist/Album/Song.flac",
        title: "Song",
        artist: "Artist",
        album: "Album",
      },
    ],
  });

  const song = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Song", "Artist", {
      album: "Album",
      path: "/music/Artist/Album/Song.flac",
    }),
  );
  assert.ok(song != null);

  assert.ok(song);
  assert.equal(song.id, "match");
});

test("does not match a metadata variant of an unindexed track", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "variant",
        libraryPath: "/music",
        path: "Goo Goo Dolls/Greatest Hits/Slide.flac",
        title: "Slide",
        artist: "Goo Goo Dolls",
        album: "Dizzy Up the Girl",
      },
    ],
  });
  const searches: (string | URL | Request)[] = [];
  const fetchSongs = navidrome.fetch;
  navidrome.fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).pathname.startsWith("/rest/search"))
      searches.push(input);
    return fetchSongs(input, init);
  };

  const song = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Slide", "The Goo Goo Dolls", {
      album: "Dizzy Up the Girl",
      path: "/music/Goo Goo Dolls/Dizzy Up the Girl/Slide.flac",
    }),
  );

  assert.equal(song, null);
  assert.deepEqual([...searches], []);
});

test("uses an indexed path without metadata matching", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "path-match",
        libraryPath: "/data/music",
        path: "Artist/Album/track.flac",
        title: "Different tag",
        artist: "Different artist",
      },
    ],
  });

  const song = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Wanted title", "Wanted artist", {
      path: "/data/music/Artist/Album/track.flac",
    }),
  );
  assert.ok(song != null);

  assert.ok(song);
  assert.equal(song.id, "path-match");
});

test("looks up songs by path again after Navidrome comes back", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "path-match",
        libraryPath: "/data/music",
        path: "Artist/Album/track.flac",
        title: "Different tag",
        artist: "Different artist",
      },
    ],
  });
  const fetchNavidrome = navidrome.fetch;
  let down = false;
  navidrome.fetch = async (input, init) =>
    down ? new Response(null, { status: 503 }) : fetchNavidrome(input, init);
  const track = { path: "/data/music/Artist/Album/track.flac" };

  const song = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    down = true;
    await assert.rejects(client.findSong("Wanted title", "Wanted artist", track));
    down = false;
    return client.findSong("Wanted title", "Wanted artist", track);
  });
  assert.ok(song != null);

  assert.ok(song);
  assert.equal(song.id, "path-match");
});

test("picks up a song Navidrome indexed again under a new ID", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 0 });
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const indexed = { id: "first-id", libraryPath: "/data/music", path: "Artist/Album/track.flac" };
  const navidrome = createFakeNavidrome({ libraries, songs: [indexed] });
  const track = { path: "/data/music/Artist/Album/track.flac" };

  const [first, later] = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    const song = await client.findSong("Track", "Artist", track);
    indexed.id = "second-id";
    vi.advanceTimersByTime(24 * 60 * 60_000);
    return [song, await client.findSong("Track", "Artist", track)];
  });

  assert.ok(first);
  assert.equal(first.id, "first-id");
  assert.ok(later);
  assert.equal(later.id, "second-id");
});

test("looks up songs by path once Navidrome is updated to a version that supports it", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 0 });
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    serverVersion: "0.61.2 (aa84e645)",
    failSongRequest: (params) => params.has("path") && navidrome.serverVersion.startsWith("0.61"),
    songs: [
      {
        id: "path-match",
        libraryPath: "/data/music",
        path: "Artist/Album/track.flac",
        title: "Different tag",
        artist: "Different artist",
      },
    ],
  });
  const track = { path: "/data/music/Artist/Album/track.flac" };

  const [before, after] = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    const song = await client.findSong("Wanted title", "Wanted artist", track);
    navidrome.serverVersion = "0.62.0 (0f9f0a4c)";
    vi.advanceTimersByTime(24 * 60 * 60_000);
    return [song, await client.findSong("Wanted title", "Wanted artist", track)];
  });

  assert.equal(before, null);
  assert.equal(after?.id, "path-match");
});

test("matches Navidrome-relative paths under the configured library root", async () => {
  const libraries = [
    { id: 1, name: "Music Library", path: "/data/music" },
    { id: 2, name: "Aurral Playlists", path: "/data/downloads/aurral" },
  ];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "relative-match",
        libraryPath: "/data/downloads/aurral",
        path: "The Rapture/Echoes/Echoes.flac",
      },
      {
        id: "music-relative-match",
        libraryPath: "/data/music",
        path: "Black Lips/Good Bad Not Evil/Black Lips_Good Bad Not Evil_08_Bad Kids.flac",
      },
    ],
  });

  const [song, musicSong] = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    return [
      await client.findSong("Echoes", "The Rapture", {
        path: "/data/downloads/aurral/The Rapture/Echoes/Echoes.flac",
      }),
      await client.findSong("Bad Kids", "Black Lips", {
        path: "/data/music/Black Lips/Good Bad Not Evil/Black Lips_Good Bad Not Evil_08_Bad Kids.flac",
      }),
    ];
  });

  assert.ok(song);
  assert.equal(song.id, "relative-match");
  assert.ok(musicSong);
  assert.equal(musicSong.id, "music-relative-match");
});

test("matches the copy in the library that holds the track", async () => {
  const libraries = [
    { id: 1, name: "Music Library", path: "/data/music" },
    { id: 2, name: "Aurral Playlists", path: "/data/downloads/aurral" },
  ];
  const file = "Main Artist/A_B Album/01 Rock & Roll #1.flac";
  const song = (id: string, libraryPath: string, songPath: string = file) => ({
    id,
    libraryPath,
    path: songPath,
    title: "Rock & Roll #1",
    artist: "Main Artist",
    album: "A_B Album",
    mbzRecordingID: "shared-recording",
  });
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      song("wildcard-neighbor", "/data/music", "Main Artist/AxB Album/01 Rock & Roll #1.flac"),
      song("lidarr-copy", "/data/music"),
      song("aurral-copy", "/data/downloads/aurral"),
    ],
  });

  const [byRecording, byPath] = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    return Promise.all([
      client.findSong("Rock & Roll #1", "Main Artist", {
        album: "A_B Album",
        mbid: "shared-recording",
        path: `/data/downloads/aurral/${file}`,
      }),
      client.findSong("Rock & Roll #1", "Main Artist", {
        album: "A_B Album",
        path: `/data/music/${file}`,
      }),
    ]);
  });

  assert.ok(byRecording);
  assert.equal(byRecording.id, "aurral-copy");
  assert.ok(byPath);
  assert.equal(byPath.id, "lidarr-copy");
});

test("waits for and verifies a Navidrome library update", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  let libraryPath = "/data/downloads/aurral-weekly-flow";
  const calls: { method: string; requestPath: string; body: unknown }[] = [];
  client._nativeRequest = async (method, requestPath, body) => {
    calls.push({ method, requestPath, body });
    if (method === "GET") {
      return [{ id: "aurral-library", name: "Aurral Weekly Flow", path: libraryPath }];
    }
    if (method === "PUT") {
      assert.ok(
        body &&
          typeof body === "object" &&
          "path" in body &&
          typeof body.path === "string" &&
          "name" in body,
      );
      libraryPath = body.path;
      return { id: "aurral-library", name: body.name, path: body.path };
    }
    throw new Error(`Unexpected Navidrome request: ${method} ${requestPath}`);
  };

  const library = await client.ensureAurralLibrary("/data/downloads");
  assert.ok(library != null);

  assert.equal(library.id, "aurral-library");
  assert.equal(library.path, "/data/downloads");
  assert.deepEqual(
    calls.map(({ method, requestPath }) => [method, requestPath]),
    [
      ["GET", "/api/library"],
      ["PUT", "/api/library/aurral-library"],
      ["GET", "/api/library"],
    ],
  );
});

test("fails when Navidrome keeps the old library path", async () => {
  const client = new NavidromeClient("http://navidrome.test", "user", "password");
  client._nativeRequest = async (method) => {
    if (method === "GET") {
      return [
        {
          id: "aurral-library",
          name: "Aurral Playlists",
          path: "/data/downloads/aurral-weekly-flow",
        },
      ];
    }
    return { ok: true };
  };

  await assert.rejects(
    client.ensureAurralLibrary("/data/downloads"),
    /Navidrome library path verification failed/,
  );
});

test("does not match a path suffix from another library", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/library" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [{ id: "other-library", libraryPath: "/library", path: "Artist/Album/track.flac" }],
  });

  const song = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Track", "Artist", {
      path: "/other-library/Artist/Album/track.flac",
    }),
  );

  assert.equal(song, null);
});

test("uses an exact indexed recording MBID when the path differs", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: [
      {
        id: "missing-mbid-match",
        libraryPath: "/data/music",
        path: "Old Flow/track.flac",
        mbzRecordingID: "recording-mbid",
        missing: true,
      },
      {
        id: "mbid-match",
        libraryPath: "/data/music",
        path: "Artist/Album/track.flac",
        mbzRecordingID: "recording-mbid",
      },
    ],
  });

  const song = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Wanted title", "Wanted artist", {
      mbid: "recording-mbid",
      path: "/data/music/Other/track.flac",
    }),
  );
  assert.ok(song != null);

  assert.ok(song);
  assert.equal(song.id, "mbid-match");

  navidrome.songs[1].missing = true;
  const missing = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Wanted title", "Wanted artist", {
      mbid: "recording-mbid",
      path: "/data/music/Other/track.flac",
    }),
  );
  assert.equal(missing, null);
});

test("falls back to one title and artist match when the path is not indexed", async () => {
  const libraries = [{ id: 1, name: "Aurral Playlists", path: "/data/music" }];
  const navidrome = createFakeNavidrome({
    libraries,
    songs: ["Album", "Live Album"].map((album) => ({
      id: album,
      libraryPath: "/data/music",
      path: `Artist/${album}/Song.flac`,
      title: "Song",
      artist: "Artist",
      album,
    })),
  });

  const [ambiguous, byAlbum] = await withNavidrome(navidrome, async () => {
    const client = await connectToLibraries(libraries);
    return [
      await client.findSong("Song", "Artist", { path: "/downloads/Song.flac" }),
      await client.findSong("Song", "Artist", {
        album: "Live Album",
        path: "/downloads/Song.flac",
      }),
    ];
  });

  assert.equal(ambiguous, null);
  assert.ok(byAlbum);
  assert.equal(byAlbum.id, "Live Album");

  navidrome.songs[1].missing = true;
  const playable = await withNavidrome(navidrome, async () =>
    (await connectToLibraries(libraries)).findSong("Song", "Artist", {
      path: "/downloads/Song.flac",
    }),
  );
  assert.ok(playable != null);
  assert.equal(playable.id, "Album");
});

test("reuses one native login across concurrent song lookups", async () => {
  const navidrome = createFakeNavidrome({
    songs: Array.from({ length: 5 }, (_, index) => ({
      id: `song-${index}`,
      libraryPath: "/music",
      path: `song-${index}.flac`,
      mbzRecordingID: `mbid-${index}`,
    })),
  });

  const songs = await withNavidrome(navidrome, () => {
    const client = new NavidromeClient("http://navidrome.test", "user", "password");
    return Promise.all(
      Array.from({ length: 5 }, (_, index) => client.findSong("", "", { mbid: `mbid-${index}` })),
    );
  });
  assert.ok(songs != null);

  assert.deepEqual(
    songs.map((song) => {
      assert.ok(song);
      return song.id;
    }),
    ["song-0", "song-1", "song-2", "song-3", "song-4"],
  );
  assert.equal(navidrome.logins, 1);
});

test("refreshes a cached native token after a 401", async () => {
  const originalFetch = globalThis.fetch;
  let loginCount = 0;
  let requestCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const request = new URL(url instanceof Request ? url.url : url);
    if (request.pathname === "/auth/login") {
      loginCount += 1;
      return jsonResponse({ token: loginCount === 1 ? "stale-token" : "fresh-token" });
    }
    requestCount += 1;
    if (requestCount === 1) return new Response(null, { status: 401 });
    assert.equal(new Headers(options.headers).get("X-ND-Authorization"), "Bearer fresh-token");
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
    const request = new URL(url instanceof Request ? url.url : url);
    if (request.pathname === "/auth/login") return jsonResponse({ token: "native-token" });
    requestCount += 1;
    if (requestCount === 1)
      return new Response(null, {
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
    const request = new URL(url instanceof Request ? url.url : url);
    if (request.pathname === "/auth/login") {
      loginCount += 1;
      return jsonResponse({ token: loginCount === 1 ? "stale-token" : "fresh-token" });
    }
    artworkAttempts += 1;
    if (artworkAttempts === 1) return new Response(null, { status: 401 });
    assert.equal(new Headers(options.headers).get("X-ND-Authorization"), "Bearer fresh-token");
    return new Response(null, { status: 204 });
  };

  try {
    await new NavidromeClient("http://navidrome.test", "user", "password").uploadPlaylistArtwork(
      "playlist-1",
      Buffer.from("image"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(loginCount, 2);
  assert.equal(artworkAttempts, 2);
});

test("uploads playlist artwork through the native API", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: URL | RequestInfo; options: RequestInit | undefined }[] = [];
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
  assert.equal(
    new URL(requests[0].url instanceof Request ? requests[0].url.url : requests[0].url).pathname,
    "/api/playlist/playlist-1/image",
  );
  assert.equal(new Headers(requests[0].options?.headers).get("X-ND-Authorization"), "Bearer token");
  const body = requests[0].options?.body;
  assert.ok(body instanceof FormData);
  const image = body.get("image");
  assert.ok(image instanceof File);
  assert.equal(image.name, "cover.webp");
});

test("deletes playlist artwork through the native API", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: URL | RequestInfo; options: RequestInit | undefined }[] = [];
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

  assert.equal(
    new URL(requests[0].url instanceof Request ? requests[0].url.url : requests[0].url).pathname,
    "/api/playlist/playlist-1/image",
  );
  assert.equal(requests[0].options?.method, "DELETE");
  assert.equal(new Headers(requests[0].options?.headers).get("X-ND-Authorization"), "Bearer token");
});
