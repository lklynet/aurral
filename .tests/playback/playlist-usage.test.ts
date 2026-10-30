import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { JellyfinClient } from "../../backend/services/jellyfin.ts";
import { NavidromeClient } from "../../backend/services/navidrome.ts";
import { PlexClient } from "../../backend/services/plex.ts";
import { readPlaylistPages } from "../../backend/services/playback/playlistUsage.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";

type JellyfinParams = NonNullable<Parameters<JellyfinClient["request"]>[2]>["params"];

async function withNavidrome<Result>(
  navidrome: ReturnType<typeof createFakeNavidrome>,
  run: (client: NavidromeClient) => Promise<Result>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => navidrome.fetch(input, init);
  try {
    return await run(new NavidromeClient("http://navidrome.local", "admin", "password"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Jellyfin checks private playlists for every user and paginates their tracks", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  const reads: [string, JellyfinParams][] = [];
  client.request = async (_method, endpoint, { params } = {}) => {
    reads.push([endpoint, params]);
    if (endpoint === "/Users") return [{ Id: "admin" }, { Id: "listener" }];
    if (endpoint === "/Items")
      return {
        Items: params!.userId === "admin" ? [{ Id: "flow" }] : [{ Id: "saved" }],
        TotalRecordCount: 1,
      };
    assert.equal(params!.userId, "listener");
    assert.equal(params!.fields, "Path");
    return {
      Items: [
        {
          Id: `track-${params!.startIndex}`,
          Type: "Audio",
          Path: `/music/${params!.startIndex}.flac`,
        },
      ],
      TotalRecordCount: 2,
    };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["flow"])), [
    "/music/0.flac",
    "/music/1.flac",
  ]);
  assert.equal(reads.filter(([endpoint]) => endpoint === "/Items").length, 2);
  assert.ok(reads.every(([endpoint]) => !endpoint.includes("/flow/")));
});

test("Jellyfin reads static playlists for each user because library visibility can differ", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  let contents = 0;
  client.request = async (_method, endpoint) => {
    if (endpoint === "/Users") return [{ Id: "admin" }, { Id: "listener" }];
    if (endpoint === "/Items") return { Items: [{ Id: "saved" }], TotalRecordCount: 1 };
    contents += 1;
    return { Items: [{ Path: `/music/saved-${contents}.flac` }], TotalRecordCount: 1 };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(), [
    "/music/saved-1.flac",
    "/music/saved-2.flac",
  ]);
  assert.equal(contents, 2);
});

test("Jellyfin refuses incomplete listings and tracks without paths", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  client.getUsers = async () => [{ Id: "admin" }];
  client.request = async () => ({ Items: [], TotalRecordCount: 1 });
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
  client.request = async (_method, endpoint) =>
    endpoint === "/Items"
      ? { Items: [{ Id: "saved" }], TotalRecordCount: 1 }
      : { Items: [{ Id: "no-path" }], TotalRecordCount: 1 };
  await assert.rejects(client.getPlaylistTrackPaths(), /no file path/);
});

test("Navidrome protects the real file behind each playlist track", async () => {
  const navidrome = createFakeNavidrome({
    songs: [
      { id: "kept", libraryPath: "/music", path: "_flows/flow-1/Nebula/Charged/03 - Giant.mp3" },
      { id: "rotated", libraryPath: "/music", path: "_flows/flow-1/Nebula/Charged/04 - Gone.mp3" },
      { id: "archived", libraryPath: "/archive", path: "Old/Track.flac" },
    ],
    playlists: [
      { id: "flow", name: "Flow", songIds: ["kept", "rotated"] },
      { id: "keepers", name: "Keepers", songIds: ["kept", "archived"] },
    ],
  });
  assert.deepEqual(
    await withNavidrome(navidrome, (client) => client.getPlaylistTrackPaths(new Set(["flow"]))),
    ["/music/_flows/flow-1/Nebula/Charged/03 - Giant.mp3", "/archive/Old/Track.flac"],
  );
});

test("Navidrome refuses playlist contents it cannot verify", async () => {
  const navidrome = createFakeNavidrome({
    songs: [{ id: "track", libraryPath: "/music", path: "Artist/Track.flac" }],
    playlists: [{ id: "saved", name: "Saved", songIds: ["track"] }],
  });
  const serve = navidrome.fetch;
  const respondWithTracks = (tracks: unknown[], total = tracks.length) => {
    navidrome.fetch = async (input, init) =>
      String(input).endsWith("/tracks")
        ? new Response(JSON.stringify(tracks), {
            headers: { "content-type": "application/json", "x-total-count": String(total) },
          })
        : serve(input, init);
  };
  await withNavidrome(navidrome, async (client) => {
    respondWithTracks([{ libraryPath: "/music", path: "Artist/Track.flac" }], 2);
    await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
    respondWithTracks([{ libraryPath: "/music" }]);
    await assert.rejects(client.getPlaylistTrackPaths(), /no file path/);
    respondWithTracks([{ path: "Artist/Track.flac" }]);
    await assert.rejects(client.getPlaylistTrackPaths(), /no file path/);
  });
});

test("Navidrome refuses limited playlist visibility", async () => {
  const client = new NavidromeClient("http://navidrome.local", "listener", "password");
  client.request = async () => ({ user: { adminRole: false } });
  await assert.rejects(client.getPlaylistTrackPaths(), /admin account/);
});

test("Plex paginates playlists and includes all file parts in smart playlists", async () => {
  const client = new PlexClient("http://plex.local", "token", "client");
  const reads: string[] = [];
  client.request = async (endpoint, { params = {} } = {}) => {
    reads.push(endpoint);
    const offset = params["X-Plex-Container-Start"];
    if (endpoint === "/playlists")
      return {
        MediaContainer: {
          size: 1,
          totalSize: 2,
          Metadata: [offset === 0 ? { ratingKey: "flow" } : { ratingKey: "saved", smart: true }],
        },
      };
    assert.equal(endpoint, "/playlists/saved/items");
    return {
      MediaContainer: {
        size: 1,
        totalSize: 2,
        Metadata: [
          {
            ratingKey: `track-${offset}`,
            Media: [
              { Part: [{ file: `/music/${offset}.flac` }, { file: `/mirror/${offset}.flac` }] },
            ],
          },
        ],
      },
    };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["flow"])), [
    "/music/0.flac",
    "/mirror/0.flac",
    "/music/1.flac",
    "/mirror/1.flac",
  ]);
  assert.equal(reads.length, 4);
});

test("Plex refuses missing media metadata and incomplete pages", async () => {
  const client = new PlexClient("http://plex.local", "token", "client");
  client.request = async () => ({ MediaContainer: { size: 0, totalSize: 1 } });
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
  client.request = async (endpoint) => ({
    MediaContainer: {
      size: 1,
      totalSize: 1,
      Metadata: [endpoint === "/playlists" ? { ratingKey: "saved" } : { ratingKey: "track" }],
    },
  });
  await assert.rejects(client.getPlaylistTrackPaths(), /no media path/);
});

for (const Client of [JellyfinClient, NavidromeClient, PlexClient]) {
  test(`${Client.name} propagates service outages rather than reporting no references`, async () => {
    const client = new Client("http://service.local", "user", "secret");
    client.request = async () => {
      throw new Error("offline");
    };
    await assert.rejects(client.getPlaylistTrackPaths(), /offline/);
  });
}

test("usage pagination rejects repeated pages and malformed totals", async () => {
  await assert.rejects(
    readPlaylistPages(async () => ({ items: [{ id: "track" }] })),
    /did not advance/,
  );
  await assert.rejects(
    readPlaylistPages(async () => ({ items: [], total: "3" as unknown as number })),
    /Invalid/,
  );
});

test("usage pagination rejects a page that exceeds its declared total", async () => {
  await assert.rejects(
    readPlaylistPages(async () => ({
      items: [{ id: "a" }],
      total: 0,
    })),
    /exceeds its declared total/,
  );
  await assert.rejects(
    readPlaylistPages(async (start) => ({
      items: start === 0 ? [{ id: "a" }] : [{ id: "b" }, { id: "c" }],
      total: 2,
    })),
    /exceeds its declared total/,
  );
  assert.deepEqual(
    await readPlaylistPages(async () => ({
      items: [{ id: "a" }],
      total: 1,
    })),
    [{ id: "a" }],
  );
});
