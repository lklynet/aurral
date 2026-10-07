import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { readFile } from "node:fs/promises";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps, userOps }, { hashPassword }, { authMiddleware },
  { default: authRouter }, { default: searchRouter }, provider] = await setupIsolatedBackend(
  "link-search", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/middleware/passwordHash.js", "backend/middleware/auth.js",
  "backend/routes/auth.js", "backend/routes/search.js",
  "backend/services/providers/brainzmashProvider.js",
);

const fixture = (name) => readFile(new URL(`../fixtures/streaming-links/${name}`, import.meta.url), "utf8");
const spotifyAlbumPage = await fixture("spotify-album-songlink.html");
const appleTrackLookup = await fixture("apple-music-track-lookup.json");

const pinkFloyd = "83d91898-7763-47d7-b03b-b92132375c47";
const darkSide = "f5093c06-23e3-404f-aeaa-40f72885ee3a";
const daftPunk = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
const discovery = "48117b90-a16e-34ca-a514-19c702df1158";
const oneMoreTime = "4b7a5d7b-9a12-4a2c-8f3e-7f0d3d4b3c11";

const artist = (id, artistname) => ({ id, artistname, genres: [], images: [] });
const albumSearchResult = (id, title, artistEntry) => ({
  id, title, type: "Album", releasedate: "2001-03-12", artistid: artistEntry.id, artists: [artistEntry], images: [],
});

const realFetch = globalThis.fetch;
let metadataServer;
let metadataRoutes = {};
let server;
let baseUrl;
let token;

function stubServices(t, routes) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    requests.push(url.href);
    const route = routes[url.href];
    if (typeof route === "function") return route();
    if (!route) return new Response("Not Found", { status: 404 });
    return new Response(route.body, { status: route.status || 200, headers: { "Content-Type": route.type } });
  });
  return requests;
}

async function resolveLink(url, { authenticated = true } = {}) {
  const query = url === undefined ? "" : `?url=${encodeURIComponent(url)}`;
  const response = await realFetch(`${baseUrl}/api/search/link${query}`, {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  metadataServer = await createMockHttpServer((request, response) => {
    const { pathname } = new URL(request.url, "http://metadata.invalid");
    const body = metadataRoutes[pathname];
    response.setHeader("Content-Type", "application/json");
    if (body === undefined) return response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
    response.end(JSON.stringify(body));
  });
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/auth", authRouter);
  app.use("/api/search", searchRouter);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  resetDatabase(db);
  provider.clearMetadataProviderCaches();
  metadataRoutes = { "/search/artist": [], "/search/album": [] };
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "test", authPassword: "password" },
      metadata: { baseUrl: metadataServer.url, enableNarrowFallbacks: false },
    },
    security: { localNetworkBypass: { enabled: false } },
  });
  userOps.createUser("test", hashPassword("password"), "admin");
  const login = await realFetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "password" }),
  });
  token = (await login.json()).token;
});

test.after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await metadataServer?.close();
  await cleanupIsolatedState(state);
});

test("a Spotify album link resolves through song.link to MusicBrainz ids and is cached by URL", async (t) => {
  const pinkFloydArtist = artist(pinkFloyd, "Pink Floyd");
  metadataRoutes = {
    "/search/artist": [pinkFloydArtist],
    "/search/album": [albumSearchResult(darkSide, "The Dark Side of the Moon", pinkFloydArtist)],
  };
  const requests = stubServices(t, {
    "https://album.link/s/4LH4d3cOWNNsVw41Gqt2kv": { body: spotifyAlbumPage, type: "text/html; charset=utf-8" },
  });
  const link = "https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv?si=7f3c2a";

  const first = await resolveLink(link);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    kind: "album",
    artist: { name: "Pink Floyd", mbid: pinkFloyd },
    album: { title: "The Dark Side of the Moon", mbid: darkSide },
    track: null,
    source: "spotify",
  });

  const second = await resolveLink(link);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(requests, ["https://album.link/s/4LH4d3cOWNNsVw41Gqt2kv"]);
});

test("Apple Music links resolve the artist, album, and recording without reusing another album's match", async (t) => {
  const daftPunkArtist = artist(daftPunk, "Daft Punk");
  metadataRoutes = {
    "/search/artist": [daftPunkArtist],
    "/search/album": [albumSearchResult(discovery, "Discovery", daftPunkArtist)],
    [`/album/${discovery}`]: {
      ...albumSearchResult(discovery, "Discovery", daftPunkArtist),
      releases: [{
        id: "d5a1d7c4-6f0b-4bd9-9f4f-0c6e7a1d2f10",
        title: "Discovery",
        status: "Official",
        tracks: [
          { id: "t1", recordingid: oneMoreTime, trackname: "One More Time", trackposition: 1, mediumnumber: 1 },
          { id: "t2", recordingid: "9a3c5b1e-0d3e-4f4a-9a5b-2c1d0e7f8a92", trackname: "Aerodynamic", trackposition: 2, mediumnumber: 1 },
        ],
      }],
    },
  };
  const requests = stubServices(t, {
    "https://itunes.apple.com/lookup?id=697195462&country=us": { body: appleTrackLookup, type: "text/javascript; charset=utf-8" },
    "https://itunes.apple.com/lookup?id=697194438&country=gb": {
      body: JSON.stringify({ resultCount: 1, results: [{ wrapperType: "collection", artistName: "Daft Punk", collectionName: "Homework" }] }),
      type: "text/javascript; charset=utf-8",
    },
    "https://itunes.apple.com/lookup?id=697194438&country=us": {
      body: JSON.stringify({ resultCount: 1, results: [{ wrapperType: "collection", artistName: "Daft Punk" }] }),
      type: "text/javascript; charset=utf-8",
    },
  });

  const { status, body } = await resolveLink("https://music.apple.com/us/album/one-more-time/697194953?i=697195462");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    kind: "track",
    artist: { name: "Daft Punk", mbid: daftPunk },
    album: { title: "Discovery", mbid: discovery },
    track: { title: "One More Time", mbid: oneMoreTime },
    source: "appleMusic",
  });

  const otherAlbum = await resolveLink("https://music.apple.com/gb/album/homework/697194438");
  assert.equal(otherAlbum.status, 200);
  assert.deepEqual(otherAlbum.body.album, { title: "Homework", mbid: null });

  const untitled = await resolveLink("https://music.apple.com/us/album/homework/697194438");
  assert.equal(untitled.status, 502);
  assert.equal(untitled.body.code, "LINK_SERVICE_UNAVAILABLE");
  assert.equal((await resolveLink("https://music.apple.com/us/album/homework/697194438")).status, 502);
  assert.deepEqual(requests, [
    "https://itunes.apple.com/lookup?id=697195462&country=us",
    "https://itunes.apple.com/lookup?id=697194438&country=gb",
    "https://itunes.apple.com/lookup?id=697194438&country=us",
    "https://itunes.apple.com/lookup?id=697194438&country=us",
  ]);
});

test("a link with no MusicBrainz match returns its names with null ids", async (t) => {
  stubServices(t, {
    "https://album.link/s/4LH4d3cOWNNsVw41Gqt2kv": { body: spotifyAlbumPage, type: "text/html; charset=utf-8" },
  });

  const { status, body } = await resolveLink("https://album.link/s/4LH4d3cOWNNsVw41Gqt2kv");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    kind: "album",
    artist: { name: "Pink Floyd", mbid: null },
    album: { title: "The Dark Side of the Moon", mbid: null },
    track: null,
    source: "songlink",
  });
});

test("unsupported links return 400 without contacting any service", async (t) => {
  const requests = stubServices(t, {});
  for (const link of [
    undefined,
    "not a link",
    "https://example.com/album/302127",
    "https://open.spotify.com.example.com/album/4LH4d3cOWNNsVw41Gqt2kv",
    "https://open.spotify.com:8443/album/4LH4d3cOWNNsVw41Gqt2kv",
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    "https://music.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "ftp://www.deezer.com/album/302127",
  ]) {
    const { status, body } = await resolveLink(link);
    assert.equal(status, 400, String(link));
    assert.equal(body.code, "LINK_UNSUPPORTED");
    assert.equal(typeof body.error, "string");
  }
  assert.deepEqual(requests, []);
});

test("an unreachable service returns 502 and is retried on the next request", async (t) => {
  let deezerState = "down";
  stubServices(t, {
    "https://api.deezer.com/artist/27": () => {
      if (deezerState === "down") throw new TypeError("fetch failed");
      if (deezerState === "cut off") {
        const body = new ReadableStream({ pull(controller) { controller.error(new TypeError("terminated")); } });
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: 27, name: "Daft Punk" }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const link = "https://www.deezer.com/en/artist/27";

  const failed = await resolveLink(link);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "LINK_SERVICE_UNAVAILABLE");

  deezerState = "cut off";
  const cutOff = await resolveLink(link);
  assert.equal(cutOff.status, 502);
  assert.equal(cutOff.body.code, "LINK_SERVICE_UNAVAILABLE");

  deezerState = "up";
  const retried = await resolveLink(link);
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, {
    kind: "artist",
    artist: { name: "Daft Punk", mbid: null },
    album: null,
    track: null,
    source: "deezer",
  });
});

test("signed-out requests return 401 without contacting any service", async (t) => {
  const requests = stubServices(t, {});
  const { status, body } = await resolveLink("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv", { authenticated: false });
  assert.equal(status, 401);
  assert.equal(typeof body.error, "string");
  assert.deepEqual(requests, []);
});
