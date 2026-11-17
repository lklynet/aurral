import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterEach, afterAll, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  listeningAddress,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

vi.mock("../../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});

const [
  state,
  { db },
  { dbOps, userOps },
  { app },
  { deezerGetArtistTopTracksById, deezerGetAlbumTracks },
  { http },
  { createSession },
] = await setupIsolatedBackend(
  "deezer-preview",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/app.ts"),
  () => import("../../backend/services/apiClients/index.ts"),
  () => import("../../lib/http.ts"),
  () => import("../../backend/config/session-helpers.ts"),
);

let server: import("node:http").Server;
let baseUrl: string;

const signedLink = (trackId: string, issuedAt: number) =>
  `https://cdnt-preview.dzcdn.net/${trackId}.mp3?hdnea=exp=${Math.floor(issuedAt / 1000) + 900}`;

function stubDeezer(routes: Record<string, () => unknown>) {
  const requests: string[] = [];
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    requests.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return { status: 200, statusText: "OK", headers: {}, data: route() };
  });
  return requests;
}

const requestPreview = (path: string) => fetch(`${baseUrl}${path}`, { redirect: "manual" });

beforeAll(async () => {
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
});

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: { general: { authUser: "test", authPassword: "password" } },
    security: { localNetworkBypass: { enabled: false } },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await cleanupIsolatedState(state);
});

test("a preview link from popular tracks still plays after Deezer's signed link expires", async () => {
  const requests = stubDeezer({
    "https://api.deezer.com/artist/101/top": () => ({
      data: [{ id: 7, title: "Song", preview: signedLink("7", Date.now()), duration: 30 }],
    }),
    "https://api.deezer.com/track/7": () => ({
      id: 7,
      title: "Song",
      preview: signedLink("7", Date.now()),
    }),
  });

  const [track] = await deezerGetArtistTopTracksById("101");
  assert.ok(track);
  assert.equal(track.preview_url, "/api/deezer/preview/7.mp3");

  const first = await requestPreview(track.preview_url);
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), signedLink("7", Date.now()));

  vi.advanceTimersByTime(20 * 60 * 1000);
  const later = await requestPreview(track.preview_url);
  assert.equal(later.status, 302);
  assert.equal(later.headers.get("location"), signedLink("7", Date.now()));
  assert.deepEqual(requests, [
    "https://api.deezer.com/artist/101/top",
    "https://api.deezer.com/track/7",
    "https://api.deezer.com/track/7",
  ]);
});

test("album tracks link only the tracks Deezer has a preview for", async () => {
  stubDeezer({
    "https://api.deezer.com/album/55/tracks": () => ({
      data: [
        { id: 8, title: "Playable", preview: signedLink("8", Date.now()) },
        { id: 9, title: "Silent", preview: "" },
      ],
    }),
  });

  const tracks = await deezerGetAlbumTracks("55");

  assert.deepEqual(
    tracks.map((track) => track.preview_url),
    ["/api/deezer/preview/8.mp3", null],
  );
});

test("a preview Deezer no longer has is a 404 and a Deezer outage is a 502", async () => {
  stubDeezer({
    "https://api.deezer.com/track/10": () => ({ error: { code: 800, message: "no data" } }),
    "https://api.deezer.com/track/11": () => ({ error: { code: 4, message: "Quota limit" } }),
  });

  assert.equal((await requestPreview("/api/deezer/preview/10.mp3")).status, 404);
  assert.equal((await requestPreview("/api/deezer/preview/11.mp3")).status, 502);
  assert.equal((await requestPreview("/api/deezer/preview/abc.mp3")).status, 404);
});

test("a downloaded preview comes from Aurral instead of redirecting to Deezer", async () => {
  const link = signedLink("12", Date.now());
  stubDeezer({
    "https://api.deezer.com/track/12": () => ({ id: 12, title: "Clip", preview: link }),
    [link]: () => Buffer.from("clip"),
  });

  const response = await requestPreview("/api/deezer/preview/12.mp3?download");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(await response.text(), "clip");
});

test("a track found by artist and title plays its Deezer preview for a signed-in user", async () => {
  const link = signedLink("13", Date.now());
  const requests = stubDeezer({
    "https://api.deezer.com/search": () => ({
      data: [
        { id: 14, title: "Night Drive", artist: { name: "Someone Else" }, preview: link },
        { id: 13, title: "Night Drive", artist: { name: "Neon Coast" }, preview: link },
      ],
    }),
    "https://api.deezer.com/track/13": () => ({ id: 13, title: "Night Drive", preview: link }),
  });
  const user = userOps.createUser("previewer", "password-hash");
  assert.ok(user);
  const path = "/api/deezer/preview?artist=Neon+Coast&track=Night+Drive";

  assert.equal((await requestPreview(path)).status, 401);
  const played = await requestPreview(`${path}&token=${createSession(user.id).token}`);

  assert.equal(played.status, 302);
  assert.equal(played.headers.get("location"), link);
  assert.deepEqual(requests, ["https://api.deezer.com/search", "https://api.deezer.com/track/13"]);
});

test("a friend's cover is looked up on Deezer by name once, and a miss isn't asked again", async () => {
  const cover = "https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg";
  const requests = stubDeezer({
    "https://api.deezer.com/search/album": () => ({
      data: [{ id: 1, title: "In Rainbows", artist: { name: "Radiohead" }, cover_xl: cover }],
    }),
    "https://api.deezer.com/search/artist": () => ({ data: [] }),
  });
  const user = userOps.createUser("friend", "password-hash");
  assert.ok(user);
  const token = createSession(user.id).token;
  const art = (query: string) =>
    requestPreview(`/api/hub-link/friends/art?${query}&token=${token}`);

  const found = await art("artist=Radiohead&album=In+Rainbows");
  assert.equal(found.status, 302);
  assert.equal(found.headers.get("location"), cover);
  assert.equal((await art("artist=Nobody+Here")).status, 404);
  assert.equal((await art("artist=nobody+here")).status, 404);
  assert.equal(
    (await art("artist=Radiohead&album=In+Rainbows&w=96")).headers.get("location"),
    cover.replace("1000x1000", "120x120"),
  );
  assert.deepEqual(requests, [
    "https://api.deezer.com/search/album",
    "https://api.deezer.com/search/artist",
  ]);
});
