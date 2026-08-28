import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, dbOps }] = await setupIsolatedBackend(
  "lidarr-preferences-api",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);
const DEFAULT_ROOT_FOLDERS = [
  { path: "/music/main" },
  { path: "/music/alt" },
];
const DEFAULT_QUALITY_PROFILES = [
  { id: 7, name: "Lossless" },
  { id: 9, name: "Compressed" },
];
const DEFAULT_TAGS = [
  { id: 3, label: "Aurral" },
  { id: 4, label: "Wishlist" },
];

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startFakeLidarr() {
  const state = {
    rootFolders: DEFAULT_ROOT_FOLDERS.map((folder) => ({ ...folder })),
    qualityProfiles: DEFAULT_QUALITY_PROFILES.map((profile) => ({ ...profile })),
    tags: DEFAULT_TAGS.map((tag) => ({ ...tag })),
    metadataProfiles: [{ id: 1, name: "Standard" }],
    artists: [],
    albums: [],
    postedArtists: [],
    updatedArtists: [],
    updatedAlbums: [],
    commands: [],
    forceUnmonitoredArtistOnPost: false,
    unmonitorAfterAlbumSearch: false,
    nextArtistId: 100,
  };

  function getById(collection, id, res, missing) {
    const item = collection.find((entry) => String(entry.id) === id);
    if (!item) return json(res, 404, missing);
    return json(res, 200, item);
  }

  async function putById(collection, updated, id, req, res, missing) {
    const payload = await readJsonBody(req);
    updated.push(payload);
    const index = collection.findIndex((entry) => String(entry.id) === id);
    if (index === -1) return json(res, 404, missing);
    collection[index] = {
      ...collection[index],
      ...payload,
      id: collection[index].id,
    };
    return json(res, 200, collection[index]);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.headers["x-api-key"] !== "fake-key") {
      return json(res, 401, { message: "Invalid API key" });
    }

    const { pathname } = url;
    if (req.method === "GET") {
      if (pathname === "/api/v1/rootFolder") return json(res, 200, state.rootFolders);
      if (pathname === "/api/v1/qualityprofile") return json(res, 200, state.qualityProfiles);
      if (pathname === "/api/v1/tag") return json(res, 200, state.tags);
      if (pathname === "/api/v1/metadataprofile") return json(res, 200, state.metadataProfiles);
      if (pathname === "/api/v1/artist") return json(res, 200, state.artists);
      if (pathname === "/api/v1/album") {
        const artistId = url.searchParams.get("artistId");
        const albums = artistId
          ? state.albums.filter((album) => String(album.artistId) === artistId)
          : state.albums;
        return json(res, 200, albums);
      }
      if (pathname.startsWith("/api/v1/artist/") && pathname !== "/api/v1/artist/") {
        return getById(state.artists, pathname.split("/").pop(), res, {
          message: "Artist not found",
        });
      }
      if (pathname.startsWith("/api/v1/album/") && pathname !== "/api/v1/album/") {
        return getById(state.albums, pathname.split("/").pop(), res, {
          message: "Album not found",
        });
      }
    }

    if (req.method === "PUT") {
      if (pathname.startsWith("/api/v1/artist/") && pathname !== "/api/v1/artist/") {
        return putById(
          state.artists,
          state.updatedArtists,
          pathname.split("/").pop(),
          req,
          res,
          { message: "Artist not found" },
        );
      }
      if (pathname.startsWith("/api/v1/album/") && pathname !== "/api/v1/album/") {
        return putById(
          state.albums,
          state.updatedAlbums,
          pathname.split("/").pop(),
          req,
          res,
          { message: "Album not found" },
        );
      }
    }

    if (req.method === "POST" && pathname === "/api/v1/artist") {
      const payload = await readJsonBody(req);
      state.postedArtists.push(payload);
      const qualityProfile =
        state.qualityProfiles.find((profile) => profile.id === payload.qualityProfileId) ||
        null;
      const artist = {
        id: state.nextArtistId++,
        artistName: payload.artistName,
        foreignArtistId: payload.foreignArtistId,
        path: `${payload.rootFolderPath}/${payload.artistName}`,
        added: new Date().toISOString(),
        monitored: state.forceUnmonitoredArtistOnPost ? false : payload.monitored,
        monitor: payload.monitor,
        monitorNewItems: payload.monitorNewItems,
        addOptions: payload.addOptions,
        qualityProfile,
        statistics: { albumCount: 0, trackCount: 0, sizeOnDisk: 0 },
      };
      state.artists.push(artist);
      return json(res, 201, artist);
    }

    if (req.method === "POST" && pathname === "/api/v1/command") {
      const payload = await readJsonBody(req);
      state.commands.push(payload);
      if (payload.name === "AlbumSearch" && state.unmonitorAfterAlbumSearch) {
        for (const albumId of payload.albumIds || []) {
          const album = state.albums.find((entry) => String(entry.id) === String(albumId));
          if (!album) continue;
          album.monitored = false;
          const artist = state.artists.find(
            (entry) => String(entry.id) === String(album.artistId),
          );
          if (artist) artist.monitored = false;
        }
      }
      return json(res, 201, { id: state.commands.length, ...payload });
    }

    return json(res, 404, { message: "Not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    reset() {
      state.rootFolders = DEFAULT_ROOT_FOLDERS.map((folder) => ({ ...folder }));
      state.qualityProfiles = DEFAULT_QUALITY_PROFILES.map((profile) => ({ ...profile }));
      state.tags = DEFAULT_TAGS.map((tag) => ({ ...tag }));
      state.metadataProfiles = [{ id: 1, name: "Standard" }];
      state.artists = [];
      state.albums = [];
      state.postedArtists = [];
      state.updatedArtists = [];
      state.updatedAlbums = [];
      state.commands = [];
      state.forceUnmonitoredArtistOnPost = false;
      state.unmonitorAfterAlbumSearch = false;
      state.nextArtistId = 100;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let server = null;
let fakeLidarr = null;
let authToken = "";
let adminUserId = null;

async function apiFetch(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${authToken}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

async function loginAsAdmin() {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 200, responseBody);
  const token = response.headers.get("set-auth-token");
  assert.ok(token);
  return token;
}

async function saveLidarrSettings({
  apiKey = "fake-key",
  rootFolderPath = "/music/main",
  qualityProfileId = 7,
  defaultMonitorOption = "none",
  searchOnAdd = false,
} = {}) {
  const { response, payload } = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      rootFolderPath,
      integrations: {
        lidarr: {
          url: fakeLidarr.url,
          apiKey,
          qualityProfileId,
          defaultMonitorOption,
          searchOnAdd,
        },
      },
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
}

async function waitForPostedArtist(mbid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = fakeLidarr.state.postedArtists.find(
      (artist) => artist.foreignArtistId === mbid,
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for fake Lidarr add for ${mbid}`);
}

async function postLibraryArtist(body, { status = 201, wait = status === 201 } = {}) {
  const { response, payload } = await apiFetch("/api/library/artists", {
    method: "POST",
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status, JSON.stringify(payload));
  const posted = wait ? await waitForPostedArtist(body.foreignArtistId) : null;
  return { response, payload, posted };
}

function assertPostedMonitor(posted, expected) {
  if (expected.monitored !== undefined) assert.equal(posted.monitored, expected.monitored);
  if (expected.monitor !== undefined) assert.equal(posted.monitor, expected.monitor);
  if (expected.monitorNewItems !== undefined) {
    assert.equal(posted.monitorNewItems, expected.monitorNewItems);
  }
  if (expected.addMonitor !== undefined) {
    assert.equal(posted.addOptions.monitor, expected.addMonitor);
  }
  if (expected.searchForMissingAlbums !== undefined) {
    assert.equal(posted.addOptions.searchForMissingAlbums, expected.searchForMissingAlbums);
  }
  if (expected.albumsToMonitor !== undefined) {
    assert.deepEqual(posted.addOptions.albumsToMonitor, expected.albumsToMonitor);
  }
}

function lidarrArtist(id, name, mbid, extra = {}) {
  return {
    id,
    artistName: name,
    foreignArtistId: mbid,
    path: `/music/main/${name}`,
    added: new Date().toISOString(),
    monitored: false,
    monitor: "none",
    monitorNewItems: "none",
    addOptions: { monitor: "none" },
    qualityProfile: DEFAULT_QUALITY_PROFILES[0],
    statistics: { albumCount: 1, trackCount: 0, sizeOnDisk: 0 },
    ...extra,
  };
}

function lidarrAlbum(id, artistId, title, mbid, extra = {}) {
  return {
    id,
    artistId,
    title,
    foreignAlbumId: mbid,
    monitored: false,
    statistics: { trackCount: 10, sizeOnDisk: 0, percentOfTracks: 0 },
    ...extra,
  };
}

function seedLidarrArtistAlbum(artist, album) {
  fakeLidarr.state.artists.push(artist);
  fakeLidarr.state.albums.push(album);
}

test.before(async () => {
  resetDatabase(db);
  fakeLidarr = await startFakeLidarr();
  dbOps.updateSettings({
    integrations: {
      lidarr: { url: fakeLidarr.url, apiKey: "fake-key", qualityProfileId: 7 },
    },
    rootFolderPath: "/music/main",
    onboardingComplete: true,
  });
  const admin = userOps.createUser(
    "admin",
    bcrypt.hashSync("password123", 4),
    "admin",
  );
  adminUserId = admin?.id || null;
  server = await startServerProcess();
  authToken = await loginAsAdmin();
});

test.beforeEach(async () => {
  fakeLidarr.reset();
  userOps.updateUser(adminUserId, {
    lidarrRootFolderPath: null,
    lidarrQualityProfileId: null,
  });
  await saveLidarrSettings();
});

test.after(async () => {
  await server?.stop();
  await fakeLidarr?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("GET /users/me/lidarr-preferences", async () => {
  const cases = [
    {
      setup: () => saveLidarrSettings({ apiKey: "", rootFolderPath: "/music/main" }),
      assert: (payload) => {
        assert.equal(payload.configured, false);
        assert.deepEqual(payload.rootFolders, []);
        assert.deepEqual(payload.qualityProfiles, []);
        assert.deepEqual(payload.fallbacks, {
          rootFolderPath: null,
          qualityProfileId: null,
          tagId: null,
        });
      },
    },
    {
      setup: () =>
        userOps.updateUser(adminUserId, {
          lidarrRootFolderPath: "/music/alt",
          lidarrQualityProfileId: 9,
        }),
      assert: (payload) => {
        assert.equal(payload.configured, true);
        assert.deepEqual(payload.rootFolders, DEFAULT_ROOT_FOLDERS);
        assert.deepEqual(payload.qualityProfiles, DEFAULT_QUALITY_PROFILES);
        assert.deepEqual(payload.tags, DEFAULT_TAGS);
        assert.deepEqual(payload.savedDefaults, {
          rootFolderPath: "/music/alt",
          qualityProfileId: 9,
          tagId: null,
        });
        assert.deepEqual(payload.fallbacks, {
          rootFolderPath: "/music/main",
          qualityProfileId: 7,
          tagId: null,
        });
      },
    },
  ];

  for (const c of cases) {
    await saveLidarrSettings();
    userOps.updateUser(adminUserId, {
      lidarrRootFolderPath: null,
      lidarrQualityProfileId: null,
    });
    await c.setup();
    const { response, payload } = await apiFetch("/api/users/me/lidarr-preferences");
    assert.equal(response.status, 200);
    c.assert(payload);
  }
});

test("PATCH /users/me/lidarr-preferences accepts valid selections and clears them with null", async () => {
  const saveResult = await apiFetch("/api/users/me/lidarr-preferences", {
    method: "PATCH",
    body: JSON.stringify({ rootFolderPath: "/music/alt", qualityProfileId: 9 }),
  });
  assert.equal(saveResult.response.status, 200);
  assert.deepEqual(saveResult.payload.savedDefaults, {
    rootFolderPath: "/music/alt",
    qualityProfileId: 9,
    tagId: null,
  });
  const stored = userOps.getUserById(adminUserId);
  assert.equal(stored?.lidarrRootFolderPath, "/music/alt");
  assert.equal(stored?.lidarrQualityProfileId, 9);

  const clearResult = await apiFetch("/api/users/me/lidarr-preferences", {
    method: "PATCH",
    body: JSON.stringify({ rootFolderPath: null, qualityProfileId: null }),
  });
  assert.equal(clearResult.response.status, 200);
  assert.deepEqual(clearResult.payload.savedDefaults, {
    rootFolderPath: null,
    qualityProfileId: null,
    tagId: null,
  });
});

test("PATCH /users/me/lidarr-preferences rejects invalid root folders and quality profiles", async () => {
  const cases = [
    [{ rootFolderPath: "/music/missing" }, 400, "rootFolderPath"],
    [{ qualityProfileId: 999 }, 400, "qualityProfileId"],
  ];
  for (const [body, status, field] of cases) {
    const { response, payload } = await apiFetch("/api/users/me/lidarr-preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    assert.equal(payload.field, field);
  }
});

test("POST /library/artists resolves root folder and quality profile precedence", async () => {
  const cases = [
    {
      setup: () =>
        userOps.updateUser(adminUserId, {
          lidarrRootFolderPath: "/music/main",
          lidarrQualityProfileId: 7,
        }),
      mbid: "11111111-1111-1111-1111-111111111111",
      body: {
        artistName: "Override Artist",
        rootFolderPath: "/music/alt",
        qualityProfileId: 9,
      },
      rootFolderPath: "/music/alt",
      qualityProfileId: 9,
    },
    {
      setup: () =>
        userOps.updateUser(adminUserId, {
          lidarrRootFolderPath: "/music/alt",
          lidarrQualityProfileId: 9,
        }),
      mbid: "22222222-2222-2222-2222-222222222222",
      body: { artistName: "Saved Default Artist" },
      rootFolderPath: "/music/alt",
      qualityProfileId: 9,
    },
    {
      mbid: "33333333-3333-3333-3333-333333333333",
      body: { artistName: "Fallback Artist" },
      rootFolderPath: "/music/main",
      qualityProfileId: 7,
    },
  ];
  for (const c of cases) {
    userOps.updateUser(adminUserId, {
      lidarrRootFolderPath: null,
      lidarrQualityProfileId: null,
    });
    c.setup?.();
    const { posted } = await postLibraryArtist({ foreignArtistId: c.mbid, ...c.body });
    assert.equal(posted.rootFolderPath, c.rootFolderPath);
    assert.equal(posted.qualityProfileId, c.qualityProfileId);
  }
});

test("POST /library/artists applies monitoring options", async () => {
  const albumMbid = "59595959-5959-5959-5959-595959595959";
  const modeCases = [
    ["none", "none", "none"],
    ["missing", "missing", "none"],
    ["latest", "latest", "none"],
    ["first", "first", "none"],
    ["existing", "existing", "none"],
    ["future", "future", "all"],
    ["all", "all", "all"],
  ];
  const cases = [
    {
      settings: { defaultMonitorOption: "none" },
      mbid: "55555555-5555-5555-5555-555555555555",
      body: { artistName: "None Monitor Artist" },
      monitor: {
        monitored: true,
        monitor: "none",
        monitorNewItems: "none",
        addMonitor: "none",
      },
    },
    {
      settings: { defaultMonitorOption: "existing", searchOnAdd: true },
      mbid: "58585858-5858-5858-5858-585858585858",
      body: { artistName: "Album Only Artist", releaseGroupMbid: albumMbid },
      monitor: {
        monitor: "none",
        addMonitor: "none",
        searchForMissingAlbums: false,
        albumsToMonitor: [albumMbid],
      },
    },
    {
      mbid: "66666666-6666-6666-6666-666666666666",
      body: { artistName: "Existing Monitor Artist", monitorOption: "existing" },
      monitor: {
        monitored: true,
        monitor: "existing",
        monitorNewItems: "none",
        addMonitor: "existing",
      },
    },
    {
      settings: { defaultMonitorOption: "existing" },
      mbid: "77777777-7777-7777-7777-777777777777",
      body: { artistName: "Default Existing Monitor Artist" },
      monitor: {
        monitored: true,
        monitor: "existing",
        monitorNewItems: "none",
        addMonitor: "existing",
      },
    },
    ...modeCases.map(([monitorOption, expectedMonitor, expectedMonitorNewItems], index) => ({
      mbid: `88888888-8888-8888-8888-${String(index + 1).padStart(12, "0")}`,
      body: { artistName: `${monitorOption} Monitor Artist`, monitorOption },
      monitor: {
        monitored: true,
        monitor: expectedMonitor,
        monitorNewItems: expectedMonitorNewItems,
        addMonitor: expectedMonitor,
      },
    })),
  ];
  for (const c of cases) {
    await saveLidarrSettings(c.settings || {});
    const { posted } = await postLibraryArtist({ foreignArtistId: c.mbid, ...c.body });
    assertPostedMonitor(posted, c.monitor);
  }
});

test("POST /library/artists repairs Lidarr artist checkbox when none add returns unmonitored", async () => {
  fakeLidarr.state.forceUnmonitoredArtistOnPost = true;
  const mbid = "56565656-5656-5656-5656-565656565656";
  const { posted } = await postLibraryArtist({
    foreignArtistId: mbid,
    artistName: "Repaired None Monitor Artist",
  });
  assert.equal(posted.monitored, true);
  assert.equal(fakeLidarr.state.updatedArtists.length >= 1, true);
  assertPostedMonitor(fakeLidarr.state.updatedArtists[0], {
    monitored: true,
    monitor: "none",
    monitorNewItems: "none",
    addMonitor: "none",
  });
});

test("PUT /library/artists/:mbid updates artist monitoring to existing albums", async () => {
  const mbid = "99999999-9999-9999-9999-999999999999";
  await postLibraryArtist({
    foreignArtistId: mbid,
    artistName: "Updated Existing Monitor Artist",
  });
  const artist = fakeLidarr.state.artists.find((entry) => entry.foreignArtistId === mbid);
  assert.ok(artist);
  fakeLidarr.state.albums.push(
    lidarrAlbum(900, artist.id, "Already Monitored", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
      monitored: true,
      statistics: { trackCount: 1, sizeOnDisk: 0, percentOfTracks: 0 },
    }),
  );
  const { response, payload } = await apiFetch(`/api/library/artists/${mbid}`, {
    method: "PUT",
    body: JSON.stringify({ monitored: true, monitorOption: "existing" }),
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assertPostedMonitor(fakeLidarr.state.updatedArtists.at(-1), {
    monitored: true,
    monitor: "existing",
    monitorNewItems: "none",
    addMonitor: "existing",
  });
  assert.equal(payload.monitorOption, "existing");
});

test("PUT /library/artists/:mbid exposes updated monitoring on the next GET", async () => {
  const mbid = "91919191-9191-9191-9191-919191919191";
  await postLibraryArtist({
    foreignArtistId: mbid,
    artistName: "Monitoring Reload Artist",
  });

  const update = await apiFetch(`/api/library/artists/${mbid}`, {
    method: "PUT",
    body: JSON.stringify({ monitored: true, monitorOption: "existing" }),
  });
  assert.equal(update.response.status, 200, JSON.stringify(update.payload));
  assert.equal(update.payload.monitorOption, "existing");

  const reload = await apiFetch(`/api/library/artists/${mbid}`);
  assert.equal(reload.response.status, 200, JSON.stringify(reload.payload));
  assert.equal(reload.payload.monitorOption, "existing");
});

test("POST /library/downloads/album checks artist and monitors only the requested album", async () => {
  const artist = lidarrArtist(700, "Pick And Choose Artist", "abababab-abab-abab-abab-abababababab");
  const album = lidarrAlbum(701, artist.id, "Selected Album", "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc");
  seedLidarrArtistAlbum(artist, album);
  const { response, payload } = await apiFetch("/api/library/downloads/album", {
    method: "POST",
    body: JSON.stringify({
      artistId: String(artist.id),
      albumId: String(album.id),
      artistMbid: artist.foreignArtistId,
      artistName: artist.artistName,
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(fakeLidarr.state.updatedArtists.length, 1);
  assertPostedMonitor(fakeLidarr.state.updatedArtists[0], {
    monitored: true,
    monitor: "none",
    monitorNewItems: "none",
  });
  assert.equal(fakeLidarr.state.updatedAlbums.length, 1);
  assert.equal(fakeLidarr.state.updatedAlbums[0].monitored, true);
  assertPostedMonitor(fakeLidarr.state.artists.find((entry) => entry.id === artist.id), {
    monitored: true,
    monitor: "none",
    monitorNewItems: "none",
  });
});

test("POST /library/downloads/album repairs monitoring after Lidarr search flips it off", async () => {
  await saveLidarrSettings({ defaultMonitorOption: "none", searchOnAdd: true });
  fakeLidarr.state.unmonitorAfterAlbumSearch = true;
  const artist = lidarrArtist(710, "Failed Search Artist", "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd", {
    monitored: true,
  });
  const album = lidarrAlbum(711, artist.id, "Hard To Find Album", "dededede-dede-dede-dede-dededededede", {
    monitored: true,
  });
  seedLidarrArtistAlbum(artist, album);
  const { response, payload } = await apiFetch("/api/library/downloads/album", {
    method: "POST",
    body: JSON.stringify({
      artistId: String(artist.id),
      albumId: String(album.id),
      artistMbid: artist.foreignArtistId,
      artistName: artist.artistName,
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(fakeLidarr.state.commands.length, 1);
  assert.equal(fakeLidarr.state.commands[0].name, "AlbumSearch");
  assertPostedMonitor(fakeLidarr.state.artists.find((entry) => entry.id === artist.id), {
    monitored: true,
    monitor: "none",
    monitorNewItems: "none",
  });
  assert.equal(fakeLidarr.state.albums.find((entry) => entry.id === album.id).monitored, true);
});

test("POST /library/artists returns 409 when saved defaults are stale", async () => {
  userOps.updateUser(adminUserId, {
    lidarrRootFolderPath: "/music/stale",
    lidarrQualityProfileId: 999,
  });
  const { payload } = await postLibraryArtist(
    {
      foreignArtistId: "44444444-4444-4444-4444-444444444444",
      artistName: "Stale Artist",
    },
    { status: 409, wait: false },
  );
  assert.equal(payload.field, "rootFolderPath");
  assert.match(payload.message, /saved Lidarr root folder/i);
  assert.equal(fakeLidarr.state.postedArtists.length, 0);
});
