import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { PlexClient } from "../../backend/services/plex.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { plexConnectionStore },
  { plexPlaylistPointerStore },
  { flowPlaylistConfig },
  { PlexPlaybackDestination },
  { PlaylistManager },
] = await setupIsolatedBackend(
  "plex-playback-destination",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/plex/plexConnectionStore.ts"),
  () => import("../../backend/services/plex/plexPlaylistPointerStore.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playback/plexPlaybackDestination.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
);

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);

beforeEach(async () => {
  resetDatabase(db);
  await fs.rm(downloadRoot, { recursive: true, force: true });
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupIsolatedState(isolatedState));

function makeDestination(
  config: NonNullable<
    Parameters<InstanceType<typeof PlexPlaybackDestination>["updateConfig"]>[0]
  > = {},
) {
  const destination = new PlexPlaybackDestination(downloadRoot);
  destination.updateConfig({
    url: "http://plex.local:32400",
    token: "admin-token",
    clientId: "admin-client",
    ...config,
  });
  assert.ok(destination.isConfigured());
  return destination;
}

function servePlex(sections: Record<string, { ratingKey: string; files: string[] }[]>) {
  vi.spyOn(PlexClient.prototype, "ensureAurralLibrary").mockImplementation(async () => ({
    key: "7",
    type: "artist",
    title: "Aurral",
  }));
  vi.spyOn(PlexClient.prototype, "getTracks").mockImplementation(async (sectionId) =>
    (sections[sectionId] ?? []).map((track) => ({
      title: "Track",
      artist: "Artist",
      addedAt: Math.floor(Date.now() / 1000),
      ...track,
    })),
  );
  const published: {
    ratingKey?: string | number | null;
    previousTitle?: string | null;
    previousDescription?: string | null;
    title: string;
    description?: string | null;
    ratingKeys: (string | number)[] | null | undefined;
  }[] = [];
  vi.spyOn(PlexClient.prototype, "syncPlaylist").mockImplementation(async (value) => {
    published.push(value);
    return { ratingKey: "88" };
  });
  return published;
}

function snapshot(overrides: { tracks?: { path: string; title: string; artist: string }[] } = {}) {
  return {
    entityId: "flow-1",
    ownerUserId: null,
    displayName: "Discover Weekly",
    tracks: [],
    ...overrides,
  };
}

test("selects the global client for its owner and a linked client for another owner", () => {
  const owner = userOps.createUser("linked", "hash", "user");
  assert.ok(owner != null);
  plexConnectionStore.saveConnection(owner.id, {
    linkType: "self",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 55,
  });
  const destination = makeDestination();
  destination.client._machineIdentifier = "server-id";
  const cache = new Map();

  assert.equal(destination._ownerClient(null, cache), destination.client);
  const selected = destination._ownerClient(owner.id, cache);
  assert.ok(selected != null);
  assert.notEqual(selected, destination.client);
  assert.equal(selected.token, "owner-token");
  assert.equal(selected.clientId, "owner-client");
  assert.equal(selected._machineIdentifier, "server-id");
});

test("allows only the configured global owner unless another owner has a Plex link", () => {
  const configured = userOps.createUser("configured", "hash", "admin");
  assert.ok(configured != null);
  const other = userOps.createUser("other", "hash", "admin");
  assert.ok(other != null);
  const destination = makeDestination({ configuredByUserId: configured.id });

  assert.equal(destination._isOwnerBlocked(configured.id, new Map()), false);
  assert.equal(destination._isOwnerBlocked(other.id, new Map()), true);

  plexConnectionStore.saveConnection(other.id, {
    linkType: "self",
    token: "other-token",
    clientId: "other-client",
    plexAccountId: 88,
  });
  assert.equal(destination._isOwnerBlocked(other.id, new Map()), false);
});

test("recovers a managed-user token and retries with the stored client identifier", async () => {
  const owner = userOps.createUser("managed", "hash", "user");
  assert.ok(owner != null);
  plexConnectionStore.saveConnection(owner.id, {
    linkType: "managed",
    token: "stale-token",
    clientId: "managed-client",
    plexAccountId: 77,
  });
  vi.spyOn(PlexClient, "switchHomeUser").mockImplementation(
    async (_id, _token, _adminId, targetId) => {
      assert.equal(targetId, "managed-client");
      return "fresh-token";
    },
  );
  vi.spyOn(PlexClient, "getResources").mockImplementation(async () => ({ servers: [], total: 0 }));
  const destination = makeDestination();
  destination.client._machineIdentifier = "server-id";
  const seen: (string | null)[] = [];

  const result = await destination._withOwnerClient(owner.id, new Map(), async (client) => {
    seen.push(client!.token);
    if (client!.token === "stale-token") {
      const error = Object.assign(new Error("expired"), { response: { status: 401 } });

      throw error;
    }
    return "published";
  });

  assert.equal(result, "published");
  assert.deepEqual(seen, ["stale-token", "fresh-token"]);
  assert.equal(plexConnectionStore.getConnection(owner.id)!.token, "fresh-token");
});

test("resolves managed and reused Lidarr paths to private Plex rating keys", async () => {
  const destination = makeDestination({ downloadsPath: "/data", mainLibrarySectionId: "9" });
  const managedPath = path.join(
    destination.downloadRoot,
    "_flows",
    "flow-1",
    "Artist",
    "Album",
    "Managed.flac",
  );
  const canonicalPath = path.join(
    destination.playlistFilesRoot,
    "Artist",
    "Album",
    "Canonical.flac",
  );
  const reusedRoot = path.join(downloadRoot, "..", "lidarr");
  const reusedPath = path.join(reusedRoot, "Artist", "Reused.flac");
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    pathMappings: [{ source: "plex", remote: "/music", local: reusedRoot }],
  });
  dbOps.getSettings();
  const published = servePlex({
    7: [
      { ratingKey: "101", files: ["/data/_flows/flow-1/Artist/Album/Managed.flac"] },
      { ratingKey: "102", files: ["/data/Artist/Album/Canonical.flac"] },
    ],
    9: [{ ratingKey: "202", files: ["/music/Artist/Reused.flac"] }],
  });

  assert.deepEqual(
    await destination.publishPlaylist(
      snapshot({
        tracks: [
          { path: managedPath, title: "Managed", artist: "Artist" },
          { path: canonicalPath, title: "Canonical", artist: "Artist" },
          { path: reusedPath, title: "Reused", artist: "Artist" },
        ],
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    published.map(({ ratingKeys }) => ratingKeys),
    [["101", "102", "202"]],
  );
});

test("reuses a Lidarr file linked into the entity folder without a main Plex library", async () => {
  const destination = makeDestination({ downloadsPath: "/data" });
  const reusedPath = path.join(downloadRoot, "..", "lidarr", "Artist", "Track.flac");
  const linkedPath = path.join(
    destination.downloadRoot,
    "_flows",
    "flow-1",
    "Artist",
    "Album",
    "Track.flac",
  );
  await fs.mkdir(path.dirname(reusedPath), { recursive: true });
  await fs.mkdir(path.dirname(linkedPath), { recursive: true });
  await fs.writeFile(reusedPath, "track");
  await fs.symlink(reusedPath, linkedPath);
  const published = servePlex({
    7: [{ ratingKey: "303", files: ["/data/_flows/flow-1/Artist/Album/Track.flac"] }],
  });

  assert.deepEqual(
    await destination.publishPlaylist(
      snapshot({ tracks: [{ path: reusedPath, title: "Track", artist: "Artist" }] }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    published.map(({ ratingKeys }) => ratingKeys),
    [["303"]],
  );
});

test("upserts from the entity-owner pointer and stores the returned pointer privately", async () => {
  const destination = makeDestination({ downloadsPath: "/data" });
  const trackPath = path.join(
    destination.downloadRoot,
    "_flows",
    "flow-1",
    "Artist",
    "Album",
    "Track.flac",
  );
  const published = servePlex({
    7: [{ ratingKey: "101", files: ["/data/_flows/flow-1/Artist/Album/Track.flac"] }],
  });
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: "88",
    title: "Old title",
  });

  assert.deepEqual(
    await destination.publishPlaylist(
      snapshot({ tracks: [{ path: trackPath, title: "Track", artist: "Artist" }] }),
    ),
    { ok: true },
  );
  assert.equal(published[0].ratingKey, "88");
  assert.deepEqual(published[0].ratingKeys, ["101"]);
  const stored = plexPlaylistPointerStore.getPointer("flow-1", "global");
  assert.ok(stored != null);
  assert.equal(stored.ratingKey, "88");
  assert.equal(stored.title, "Discover Weekly");

  plexPlaylistPointerStore.deletePointer("flow-1", "global");
  await destination.publishPlaylist(
    snapshot({ tracks: [{ path: trackPath, title: "Track", artist: "Artist" }] }),
  );
  assert.equal(
    published.length,
    2,
    "an unchanged playlist is published again once its pointer is gone",
  );
  assert.equal(published[1].ratingKey, null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "global")!.ratingKey, "88");
});

test("deletes the pointed playlist and forgets only that entity-owner state", async () => {
  const destination = makeDestination();
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: "88",
    title: "Discover Weekly",
  });
  plexPlaylistPointerStore.setPointer("flow-2", "global", {
    location: "global",
    ratingKey: "99",
    title: "Keep",
  });
  const deleted: (string | number)[] = [];
  vi.spyOn(PlexClient.prototype, "deletePlaylist").mockImplementation(async (ratingKey) => {
    deleted.push(ratingKey);
  });

  assert.deepEqual(await destination.deletePlaylist(snapshot()), { ok: true });
  assert.deepEqual(deleted, ["88"]);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "global"), null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-2", "global")!.ratingKey, "99");
});

test("an entity delete that Plex rejects keeps the pointer so the sync job can retry it", async () => {
  const destination = makeDestination();
  plexPlaylistPointerStore.setPointer("gone", "global", {
    location: "global",
    ratingKey: "77",
    title: "Removed from Aurral",
  });
  let available = false;
  const deleted: (string | number)[] = [];
  vi.spyOn(PlexClient.prototype, "deletePlaylist").mockImplementation(async (ratingKey) => {
    if (!available)
      throw Object.assign(new Error("Plex unavailable"), { response: { status: 503 } });
    deleted.push(ratingKey);
  });

  const failed = await destination.deleteEntityPlaylists("gone");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.retryable, true);
  assert.equal(plexPlaylistPointerStore.getPointer("gone", "global")!.ratingKey, "77");

  available = true;
  assert.deepEqual(await destination.deleteEntityPlaylists("gone"), { ok: true });
  assert.deepEqual(deleted, ["77"]);
  assert.equal(plexPlaylistPointerStore.getPointer("gone", "global"), null);
});

test("forgets an unreachable pointer after Plex configuration is cleared", async () => {
  const destination = new PlexPlaybackDestination(downloadRoot);
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: "88",
    title: "Discover Weekly",
  });

  assert.deepEqual(await destination.deletePlaylist(snapshot()), { ok: true });
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "global"), null);
});

test("refreshes only changed folders inside the Aurral section", async () => {
  const destination = makeDestination({ downloadsPath: "/downloads" });
  const calls: (
    | string
    | { [x: string]: string | number | boolean | null | undefined }
    | undefined
  )[][] = [];
  let reportedLocations: string[] = [];
  vi.spyOn(PlexClient.prototype, "ensureAurralLibrary").mockImplementation(async (libraryPath) => {
    calls.push(["ensure", libraryPath]);
    return {
      key: "7",
      type: "artist",
      title: "Aurral",
      Location: reportedLocations.map((location) => ({ path: location })),
    };
  });
  vi.spyOn(PlexClient.prototype, "getTracks").mockImplementation(async () => []);
  vi.spyOn(PlexClient.prototype, "request").mockImplementation(
    async (endpoint, { params } = {}) => {
      calls.push([endpoint, params]);
    },
  );
  const album = path.join(downloadRoot, "Artist", "Album (2001)");

  assert.deepEqual(await destination.requestScan({ folders: ["/lidarr/music/Artist"] }), {
    ok: true,
  });
  assert.deepEqual([...calls], []);
  assert.deepEqual(await destination.requestScan({ folders: [album, "/lidarr/music/Artist"] }), {
    ok: true,
  });
  assert.deepEqual(calls, [
    ["ensure", "/downloads"],
    ["/library/sections/7/refresh", { path: "/downloads/Artist/Album (2001)" }],
  ]);

  calls.length = 0;
  const folders = Array.from({ length: 21 }, (_, index) =>
    path.join(downloadRoot, `Artist ${index}`),
  );
  const lidarrRootAboveDownloads = path.dirname(downloadRoot);
  assert.deepEqual(await destination.requestScan({ folders }), { ok: true });
  assert.deepEqual(await destination.requestScan({ folders: [downloadRoot] }), { ok: true });
  assert.deepEqual(await destination.requestScan({ folders: [album, lidarrRootAboveDownloads] }), {
    ok: true,
  });
  assert.deepEqual(await destination.requestScan({ folders: [lidarrRootAboveDownloads] }), {
    ok: true,
  });
  assert.deepEqual(calls, [
    ["/library/sections/7/refresh", undefined],
    ["/library/sections/7/refresh", undefined],
    ["/library/sections/7/refresh", { path: "/downloads/Artist/Album (2001)" }],
  ]);

  for (const [downloadsPath, reported, ensured, refreshed] of [
    [
      "D:/Aurral",
      ["D:\\Aurral\\_flows", "D:\\Aurral"],
      "D:/Aurral",
      "D:\\Aurral\\Artist\\Album (2001)",
    ],
    [
      "\\\\nas\\aurral\\",
      ["\\\\nas\\aurral", "\\\\nas\\aurral\\_flows"],
      "//nas/aurral",
      "\\\\nas\\aurral\\Artist\\Album (2001)",
    ],
    [
      "/downloads/",
      ["/downloads", "/downloads/_flows"],
      "/downloads",
      "/downloads/Artist/Album (2001)",
    ],
    ["D:\\Aurral", [], "D:/Aurral", "D:/Aurral/Artist/Album (2001)"],
  ] satisfies [string, string[], string, string][]) {
    calls.length = 0;
    reportedLocations = reported;
    assert.deepEqual(await makeDestination({ downloadsPath }).requestScan({ folders: [album] }), {
      ok: true,
    });
    assert.deepEqual(calls, [
      ["ensure", ensured],
      ["/library/sections/7/refresh", { path: refreshed }],
    ]);
  }
});

test("configures Plex with the download root and explicit flow location", async () => {
  const client = new PlexClient("http://plex.local:32400", "admin-token", "admin-client");
  const root = "/downloads/aurral";
  const calls: {
    requestPath: string;
    options:
      | {
          params?: { [x: string]: string | number | boolean | null | undefined };
          method?: "GET" | "POST" | "PUT" | "DELETE";
          data?: unknown;
          timeout?: number;
        }
      | undefined;
  }[] = [];
  let reads = 0;
  vi.spyOn(client, "getLibraries").mockImplementation(async () => {
    reads += 1;
    return reads === 1
      ? []
      : [
          {
            key: "7",
            type: "artist",
            title: "Aurral",
            Location: [{ path: root }],
          },
        ];
  });
  vi.spyOn(client, "request").mockImplementation(async (requestPath, options) => {
    calls.push({ requestPath, options });
    return {};
  });

  assert.equal((await client.ensureAurralLibrary(root))!.key, "7");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].requestPath,
    `/library/sections?name=Aurral&type=artist&agent=tv.plex.agents.music&scanner=Plex+Music&language=en-US&location=${encodeURIComponent(root)}&location=${encodeURIComponent(`${root}/_flows`)}`,
  );
  assert.equal(calls[0].options!.method, "POST");
});

test("a Plex library list Aurral can't read fails without creating another Aurral library", async () => {
  const client = new PlexClient("http://plex.local:32400", "admin-token", "admin-client");
  const methods: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (requestPath, options = {}) => {
    methods.push(`${options.method || "GET"} ${requestPath.split("?")[0]}`);
    return "<html><body>Sign in</body></html>";
  });

  await assert.rejects(
    client.ensureAurralLibrary("/downloads/aurral"),
    /Plex sent \/library\/sections data Aurral can't read/,
  );
  assert.deepEqual(methods, ["GET /library/sections"]);
});

test("one Plex library Aurral can't read fails the list instead of hiding the Aurral library", async () => {
  const client = new PlexClient("http://plex.local:32400", "admin-token", "admin-client");
  const methods: string[] = [];
  vi.spyOn(client, "request").mockImplementation(async (requestPath, options = {}) => {
    methods.push(`${options.method || "GET"} ${requestPath.split("?")[0]}`);
    return {
      MediaContainer: {
        size: 2,
        Directory: [
          { key: "3", type: "artist", title: "Music", Location: [{ path: "/music" }] },
          { key: 7, type: "artist", title: "Aurral", Location: [{ path: "/downloads/aurral" }] },
        ],
      },
    };
  });

  await assert.rejects(client.ensureAurralLibrary("/downloads/aurral"), /can't read/);
  assert.deepEqual(methods, ["GET /library/sections"]);
});

test("keeps Navidrome and Plex failures isolated when both destinations are configured", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Isolation" });
  const manager = new PlaylistManager(downloadRoot);
  const calls: string[] = [];
  manager.navidromeDestination.updateConfig({
    url: "http://navidrome.local",
    username: "admin",
    password: "password",
  });
  manager.navidromeDestination.ensureLibrary = async () => ({ ok: true });
  manager.navidromeDestination.publishPlaylist = async () => ({
    ok: false,
    error: { code: "unavailable", retryable: true, message: "Navidrome unavailable" },
  });
  manager.plexDestination.updateConfig({
    url: "http://plex.local",
    token: "token",
    clientId: "client",
  });
  manager.plexDestination.ensureLibrary = async () => ({ ok: true });
  manager.plexDestination.publishPlaylist = async (value) => {
    assert.ok(value);
    calls.push(String(value.entityId));
    return { ok: true };
  };

  await manager.syncPlaylists();
  assert.deepEqual(calls, [playlist.id]);

  manager.navidromeDestination.publishPlaylist = async () => ({ ok: true });
  manager.plexDestination.publishPlaylist = async () => ({
    ok: false,
    error: { code: "unavailable", retryable: true, message: "Plex unavailable" },
  });
  await assert.doesNotReject(manager.syncPlaylists());
});

test("a destination whose library cannot be verified gets no publishes while the others still do", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Blocked setup" });
  const manager = new PlaylistManager(downloadRoot);
  const published: unknown[][] = [];
  manager.navidromeDestination.updateConfig({
    url: "http://navidrome.local",
    username: "admin",
    password: "password",
  });
  manager.navidromeDestination.ensureLibrary = async () => ({
    ok: false,
    error: {
      code: "unavailable",
      retryable: true,
      message: "Navidrome library path verification failed",
    },
  });
  manager.navidromeDestination.publishPlaylist = async () => {
    published.push(["Navidrome", playlist.id]);
    return { ok: true };
  };
  manager.plexDestination.updateConfig({
    url: "http://plex.local",
    token: "token",
    clientId: "client",
  });
  manager.plexDestination.ensureLibrary = async () => ({ ok: true });
  manager.plexDestination.publishPlaylist = async (value) => {
    assert.ok(value);
    published.push(["Plex", value.entityId]);
    return { ok: true };
  };

  await manager.syncPlaylists({ entityIds: [playlist.id] });
  assert.deepEqual(published, [["Plex", playlist.id]]);
});
