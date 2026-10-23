import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { JellyfinClient } from "../../backend/services/jellyfin.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { jellyfinPlaylistPointerStore },
  { JellyfinPlaybackDestination },
  { logger },
] = await setupIsolatedBackend(
  "jellyfin-playback-destination",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/jellyfin/jellyfinPlaylistPointerStore.ts"),
  () => import("../../backend/services/playback/jellyfinPlaybackDestination.ts"),
  () => import("../../backend/services/logger.ts"),
);

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);
const userId = "jellyfin-user";

beforeEach(async () => {
  resetDatabase(db);
  await fs.rm(downloadRoot, { recursive: true, force: true });
  dbOps.updateSettings({ integrations: {} });
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

type PlaylistPayload = Parameters<JellyfinClient["createPlaylist"]>[0];
type ClientCall =
  | { operation: "create" | "update"; payload: PlaylistPayload; playlistId?: string }
  | { operation: "delete"; playlistId: string; jellyfinUserId?: string | null }
  | { operation: "request"; method: string; endpoint: string; data: unknown };

function makeClient(calls: ClientCall[], { libraries }: { libraries?: unknown } = {}) {
  return Object.assign(new JellyfinClient("http://jellyfin.local", "key", userId), {
    isConfigured: () => true,
    findUserByUsername: async (username) =>
      String(username || "")
        .trim()
        .toLowerCase() === "ambi"
        ? { Id: "jellyfin-ambi", Name: "ambi" }
        : null,
    getAudioItems: async () => [
      { Id: "jellyfin-track-1", Path: "/downloads/one.flac" },
      {
        Id: "jellyfin-track-2",
        Path: "/downloads/two.flac",
        ProviderIds: { MusicBrainzTrack: "recording-2" },
      },
    ],
    createPlaylist: async (payload) => {
      calls.push({ operation: "create", payload });
      return { Id: "playlist-1" };
    },
    updatePlaylist: async (playlistId, payload) => {
      const { onManagedItemsChange, ...recorded } = payload;
      calls.push({ operation: "update", playlistId, payload: recorded });
      await onManagedItemsChange?.(payload.itemIds);
      return { Id: playlistId, managedItemIds: payload.itemIds };
    },
    deletePlaylist: async (playlistId: string, _jellyfinUserId?: string | null) => {
      calls.push({ operation: "delete", playlistId });
    },
    request: async (method, endpoint, { data } = {}) => {
      if (endpoint === "/Library/VirtualFolders") {
        if (libraries instanceof Error) throw libraries;
        return libraries;
      }
      calls.push({ operation: "request", method, endpoint, data });
    },
  } satisfies Partial<JellyfinClient>);
}

function snapshot(
  overrides: {
    displayName?: string;
    tracks?: { path: string; title: string; artist: string; mbid?: string }[];
    ownerUserId?: number | null;
  } = {},
) {
  return {
    entityId: "flow-jellyfin",
    ownerUserId: null,
    displayName: "Discover Weekly",
    tracks: [
      { path: "/media/one.flac", title: "One", artist: "Artist" },
      {
        path: "/media/two.flac",
        title: "Two",
        artist: "Artist",
        mbid: "recording-2",
      },
    ],
    ...overrides,
  };
}

test("publishes, updates, scans, and deletes a managed playlist", async () => {
  const calls: ClientCall[] = [];
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls, {
      libraries: [{ CollectionType: "music", Locations: ["/downloads"] }],
    }),
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";
  try {
    assert.equal((await destination.publishPlaylist(snapshot())).ok, true);
    assert.deepEqual(calls[0], {
      operation: "create",
      payload: {
        name: "Discover Weekly",
        itemIds: ["jellyfin-track-1", "jellyfin-track-2"],
        userId,
      },
    });
    assert.equal(
      jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.playlistId,
      "playlist-1",
    );
    assert.deepEqual(
      jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds,
      ["jellyfin-track-1", "jellyfin-track-2"],
    );

    assert.equal(
      (await destination.publishPlaylist(snapshot({ displayName: "Fresh Weekly" }))).ok,
      true,
    );
    assert.deepEqual(calls[1], {
      operation: "update",
      playlistId: "playlist-1",
      payload: {
        name: "Fresh Weekly",
        itemIds: ["jellyfin-track-1", "jellyfin-track-2"],
        userId,
        managedItemIds: ["jellyfin-track-1", "jellyfin-track-2"],
      },
    });

    assert.equal((await destination.requestScan({ folders: ["/media/Artist/Album"] })).ok, true);
    assert.deepEqual(calls[2], {
      operation: "request",
      method: "POST",
      endpoint: "/Library/Media/Updated",
      data: { Updates: [{ Path: "/downloads/Artist/Album", UpdateType: "Modified" }] },
    });
    assert.equal((await destination.deletePlaylist({ entityId: "flow-jellyfin" })).ok, true);
    assert.deepEqual(calls[3], { operation: "delete", playlistId: "playlist-1" });
    assert.equal(jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId), null);
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

test("tells Jellyfin about changed folders in its music libraries and reports every music library when one is outside them", async () => {
  const calls: ClientCall[] = [];
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const musicLocations = ["D:\\Music\\FLAC", "\\\\nas\\music\\"];
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls, {
      libraries: [
        { Name: "FLAC", CollectionType: "music", Locations: [musicLocations[0]] },
        { Name: "Share", Locations: [musicLocations[1]] },
        { Name: "Films", CollectionType: "movies", Locations: ["/media"] },
      ],
    }),
  });
  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS =
    "jellyfin|D:\\Music|/srv/music;jellyfin|\\\\nas\\music|/srv/share;jellyfin|/media|/srv/media";
  const updated = () =>
    calls.map((call) => {
      assert.equal(call.operation, "request");
      const data = call.data;
      assert.ok(
        data && typeof data === "object" && "Updates" in data && Array.isArray(data.Updates),
      );
      return data.Updates.map((update: { Path: string }) => update.Path);
    });
  try {
    for (const libraries of [new Error("Jellyfin is restarting"), { error: "Unauthorized" }]) {
      const unreadable = new JellyfinPlaybackDestination(downloadRoot, {
        client: makeClient(calls, { libraries }),
      });
      const result = await unreadable.requestScan({ folders: ["/srv/music/flac/Artist/Album"] });
      assert.equal(result.ok, false);
      assert.equal(result.error!.retryable, true);
    }
    assert.deepEqual([...calls], []);
    assert.deepEqual(
      await destination.requestScan({
        folders: ["/srv/music/flac/Artist/Album", "/srv/share/Artist"],
      }),
      { ok: true },
    );
    assert.deepEqual(await destination.requestScan({ folders: ["/srv/media/Artist"] }), {
      ok: true,
    });
    assert.deepEqual(
      await destination.requestScan({ folders: ["/srv/share/Artist", "/srv/elsewhere/Album"] }),
      { ok: true },
    );
    assert.deepEqual(await destination.requestScan({ folders: ["/srv/elsewhere/Album"] }), {
      ok: true,
    });
    process.env.PATH_MAPPINGS += ";jellyfin|/films|/srv/films";
    assert.deepEqual(await destination.requestScan({ folders: ["/srv/elsewhere/Album"] }), {
      ok: true,
    });
    const albums = Array.from(
      { length: 21 },
      (_, index) => `/srv/music/flac/Artist/Album ${index}`,
    );
    assert.deepEqual(await destination.requestScan({ folders: albums }), { ok: true });
    assert.deepEqual(updated(), [
      ["D:\\Music\\FLAC\\Artist\\Album", "\\\\nas\\music\\Artist"],
      musicLocations,
      musicLocations,
      musicLocations,
      musicLocations,
      [musicLocations[0]],
    ]);
    assert.deepEqual(
      warn.mock.calls.map(([category, , data]) => [
        category,
        data && "folder" in data ? data.folder : undefined,
      ]),
      [
        ["jellyfin", "/srv/media/Artist"],
        ["jellyfin", "/srv/elsewhere/Album"],
        ["jellyfin", "/srv/elsewhere/Album"],
      ],
    );
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

function makeSyncingClient(initialIds: string[]) {
  const client = new JellyfinClient("http://jellyfin.local", "key", userId);
  const state = { ids: [...initialIds], deleted: false };
  client.getAudioItems = makeClient([]).getAudioItems;
  client.getPlaylistMetadata = async () => ({
    Id: "playlist-1",
    Type: "Playlist",
    Name: "Discover Weekly",
  });
  client.getPlaylistItems = async () =>
    state.ids.map((id) => ({ Id: id, PlaylistItemId: `entry-${id}` }));
  client.request = async (method, endpoint, { params } = {}) => {
    assert.equal(endpoint, "/Playlists/playlist-1/Items");
    if (method === "POST") {
      assert.ok(params);
      assert.equal(params.userId, userId);
      assert.ok(typeof params.ids === "string");
      state.ids.push(...params.ids.split(","));
    } else if (method === "DELETE") {
      assert.ok(typeof params?.entryIds === "string");
      const entryIds = params.entryIds.split(",");
      state.ids = state.ids.filter((id) => !entryIds.includes(`entry-${id}`));
    } else assert.fail(`Unexpected request: ${method}`);
  };
  client.deletePlaylist = async () => {
    state.deleted = true;
    state.ids = [];
  };
  return { client, state };
}

test("ownership survives destination recreation and an empty source preserves Jellyfin additions", async () => {
  const { client, state } = makeSyncingClient(["jellyfin-track-2", "custom"]);
  jellyfinPlaylistPointerStore.setPointer("flow-jellyfin", userId, {
    playlistId: "playlist-1",
    title: "Discover Weekly",
    serverUrl: client.url,
    jellyfinUserId: userId,
    managedItemIds: ["jellyfin-track-2"],
  });
  const source = snapshot({ tracks: [snapshot().tracks[1]] });
  let destination = new JellyfinPlaybackDestination(downloadRoot, { client });
  assert.equal((await destination.publishPlaylist(source)).ok, true);
  state.ids.push("custom-after-sync");

  // No in-memory hashes or ownership can carry over to the new instance.
  destination = new JellyfinPlaybackDestination(downloadRoot, { client });
  assert.equal((await destination.publishPlaylist(snapshot({ tracks: [] }))).ok, true);
  assert.deepEqual(state.ids, ["custom", "custom-after-sync"]);
  assert.equal(state.deleted, false);
  assert.deepEqual(
    [...jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds],
    [],
  );
  assert.equal((await destination.publishPlaylist(source)).ok, true);
  assert.deepEqual(state.ids, ["custom", "custom-after-sync", "jellyfin-track-2"]);
  assert.deepEqual(
    jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds,
    ["jellyfin-track-2"],
  );
});

test("an old pointer without ownership preserves existing tracks during sync and emptying", async () => {
  const { client, state } = makeSyncingClient(["legacy", "jellyfin-track-2", "custom"]);
  // Write the pre-upgrade representation, without managedItemIds.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "jellyfinPlaylistPointers",
    JSON.stringify({
      "flow-jellyfin": {
        [userId]: {
          playlistId: "playlist-1",
          serverUrl: client.url,
          jellyfinUserId: userId,
        },
      },
    }),
  );
  assert.deepEqual(
    [...jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds],
    [],
  );
  const destination = new JellyfinPlaybackDestination(downloadRoot, { client });
  assert.equal(
    (await destination.publishPlaylist(snapshot({ tracks: [snapshot().tracks[1]] }))).ok,
    true,
  );
  assert.equal((await destination.publishPlaylist(snapshot({ tracks: [] }))).ok, true);
  assert.deepEqual(state.ids, ["legacy", "jellyfin-track-2", "custom"]);
  assert.equal(state.deleted, false);
});

test("confirmed additions remain owned after a failed deletion and destination restart", async () => {
  const { client, state } = makeSyncingClient(["old-owned", "custom"]);
  jellyfinPlaylistPointerStore.setPointer("flow-jellyfin", userId, {
    playlistId: "playlist-1",
    title: "Discover Weekly",
    serverUrl: client.url,
    jellyfinUserId: userId,
    managedItemIds: ["old-owned"],
  });
  const request = client.request;
  let fail = true;
  client.request = async (method, ...args) => {
    if (method === "DELETE" && fail) {
      fail = false;
      throw new Error("delete failed");
    }
    return request(method, ...args);
  };
  let destination = new JellyfinPlaybackDestination(downloadRoot, { client });
  const source = snapshot({ tracks: [snapshot().tracks[1]] });
  assert.equal((await destination.publishPlaylist(source)).ok, false);
  assert.deepEqual(state.ids, ["old-owned", "custom", "jellyfin-track-2"]);
  assert.deepEqual(
    jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds,
    ["old-owned", "jellyfin-track-2"],
  );

  destination = new JellyfinPlaybackDestination(downloadRoot, { client });
  assert.equal((await destination.publishPlaylist(source)).ok, true);
  assert.deepEqual(state.ids, ["custom", "jellyfin-track-2"]);
  assert.deepEqual(
    jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId)!.managedItemIds,
    ["jellyfin-track-2"],
  );
});

test("pointer ownership is isolated by owner and malformed history grants no deletion rights", () => {
  const pointers = {
    entity: {
      first: { playlistId: "first", managedItemIds: ["one", "one"] },
      second: { playlistId: "second", managedItemIds: ["two"] },
      invalid: { playlistId: "invalid", managedItemIds: ["valid", null] },
    },
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "jellyfinPlaylistPointers",
    JSON.stringify(pointers),
  );
  const first = jellyfinPlaylistPointerStore.getPointer("entity", "first");
  assert.ok(first != null);
  assert.deepEqual(first.managedItemIds, ["one", "one"]);
  first.managedItemIds.push("not-persisted");
  assert.deepEqual(jellyfinPlaylistPointerStore.getPointer("entity", "first")!.managedItemIds, [
    "one",
    "one",
  ]);
  assert.deepEqual(jellyfinPlaylistPointerStore.getPointer("entity", "second")!.managedItemIds, [
    "two",
  ]);
  assert.deepEqual(
    [...jellyfinPlaylistPointerStore.getPointer("entity", "invalid")!.managedItemIds],
    [],
  );
});

test("an empty source without a remote pointer does not create a playlist", async () => {
  const calls: ClientCall[] = [];
  const destination = new JellyfinPlaybackDestination(downloadRoot, { client: makeClient(calls) });
  assert.equal((await destination.publishPlaylist(snapshot({ tracks: [] }))).ok, true);
  assert.deepEqual([...calls], []);
});

test("preserves repeated resolved tracks in a playlist", async () => {
  const calls: ClientCall[] = [];
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls),
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";
  try {
    assert.equal(
      (
        await destination.publishPlaylist(
          snapshot({
            tracks: [
              { path: "/media/one.flac", title: "One", artist: "Artist" },
              { path: "/media/one.flac", title: "One", artist: "Artist" },
            ],
          }),
        )
      ).ok,
      true,
    );
    assert.ok("payload" in calls[0]);
    assert.deepEqual(calls[0].payload.itemIds, ["jellyfin-track-1", "jellyfin-track-1"]);
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

test("publishes and updates as the Jellyfin user matching the Aurral username", async () => {
  const calls: ClientCall[] = [];
  const owner = userOps.createUser("ambi", "hash", "user");
  assert.ok(owner != null);
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls),
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";

  try {
    const result = await destination.publishPlaylist(snapshot({ ownerUserId: owner.id }));

    assert.equal(result.ok, true);
    assert.ok("payload" in calls[0]);
    assert.equal(calls[0].payload.userId, "jellyfin-ambi");
    assert.equal(
      jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", String(owner.id))!.jellyfinUserId,
      "jellyfin-ambi",
    );
    const updated = await destination.publishPlaylist(
      snapshot({ ownerUserId: owner.id, displayName: "Renamed owner playlist" }),
    );
    assert.equal(updated.ok, true);
    assert.equal(calls[1].operation, "update");
    assert.ok("payload" in calls[1]);
    assert.equal(calls[1].payload.userId, "jellyfin-ambi");
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

test("does not publish when no Jellyfin username matches", async () => {
  const calls: ClientCall[] = [];
  const owner = userOps.createUser("not-in-jellyfin", "hash", "user");
  assert.ok(owner != null);
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls),
  });

  const result = await destination.publishPlaylist(snapshot({ ownerUserId: owner.id }));

  assert.equal(result.ok, false);
  assert.equal(result.error!.code, "JELLYFIN_USER_NOT_FOUND");
  assert.deepEqual([...calls], []);
});

test("removes the legacy public playlist before publishing privately", async () => {
  const calls: ClientCall[] = [];
  const owner = userOps.createUser("ambi", "hash", "user");
  assert.ok(owner != null);
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls),
  });

  jellyfinPlaylistPointerStore.setPointer("flow-jellyfin", userId, {
    playlistId: "legacy-public-playlist",
    title: "Discover Weekly",
    serverUrl: "http://jellyfin.local",
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";

  try {
    const result = await destination.publishPlaylist(snapshot({ ownerUserId: owner.id }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], {
      operation: "delete",
      playlistId: "legacy-public-playlist",
    });
    assert.equal(calls[1].operation, "create");
    assert.equal(jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId), null);
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});

test("removes the legacy playlist during owner-scoped deletion", async () => {
  const calls: ClientCall[] = [];
  const owner = userOps.createUser("ambi", "hash", "user");
  assert.ok(owner != null);
  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client: makeClient(calls),
  });

  jellyfinPlaylistPointerStore.setPointer("flow-jellyfin", userId, {
    playlistId: "legacy-public-playlist",
    title: "Discover Weekly",
    serverUrl: "http://jellyfin.local",
  });

  const result = await destination.deletePlaylist({
    entityId: "flow-jellyfin",
    ownerUserId: owner.id,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    operation: "delete",
    playlistId: "legacy-public-playlist",
  });
  assert.equal(jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", userId), null);
});

test("does not reuse a playlist belonging to a different Jellyfin user", async () => {
  const calls: ClientCall[] = [];
  const owner = userOps.createUser("ambi", "hash", "user");
  assert.ok(owner != null);
  const client = makeClient(calls);

  client.deletePlaylist = async (playlistId, jellyfinUserId) => {
    calls.push({ operation: "delete", playlistId, jellyfinUserId });
  };

  const destination = new JellyfinPlaybackDestination(downloadRoot, {
    client,
  });

  jellyfinPlaylistPointerStore.setPointer("flow-jellyfin", String(owner.id), {
    playlistId: "old-user-playlist",
    title: "Discover Weekly",
    serverUrl: "http://jellyfin.local",
    jellyfinUserId: "jellyfin-old-user",
  });

  const originalMappings = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "jellyfin|/downloads|/media";

  try {
    const result = await destination.publishPlaylist(snapshot({ ownerUserId: owner.id }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], {
      operation: "delete",
      playlistId: "old-user-playlist",
      jellyfinUserId: "jellyfin-old-user",
    });
    assert.equal(calls[1].operation, "create");
    assert.ok("payload" in calls[1]);
    assert.equal(calls[1].payload.userId, "jellyfin-ambi");
    assert.equal(
      calls.some((call) => call.operation === "update"),
      false,
    );
    assert.equal(
      jellyfinPlaylistPointerStore.getPointer("flow-jellyfin", String(owner.id))!.jellyfinUserId,
      "jellyfin-ambi",
    );
  } finally {
    if (originalMappings == null) delete process.env.PATH_MAPPINGS;
    else process.env.PATH_MAPPINGS = originalMappings;
  }
});
