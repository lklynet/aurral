import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterEach, afterAll, vi } from "vite-plus/test";
import express from "express";
import {
  cleanupIsolatedState,
  listeningAddress,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { authMiddleware },
  { handToHono },
  { deezerGetArtistTopTracksById, deezerGetAlbumTracks },
  { default: axios },
] = await setupIsolatedBackend(
  "deezer-preview",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/middleware/auth.ts"),
  () => import("../../backend/routes/shared/expressHandoff.ts"),
  () => import("../../backend/services/apiClients/index.ts"),
  () => import("../../lib/axiosFetch.ts"),
);

let server: import("node:http").Server;
let baseUrl: string;

const signedLink = (trackId: string, issuedAt: number) =>
  `https://cdnt-preview.dzcdn.net/${trackId}.mp3?hdnea=exp=${Math.floor(issuedAt / 1000) + 900}`;

function stubDeezer(routes: Record<string, () => unknown>) {
  const requests: string[] = [];
  vi.spyOn(axios, "get").mockImplementation(async (url) => {
    requests.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return { status: 200, statusText: "OK", headers: {}, data: route() };
  });
  return requests;
}

const requestPreview = (path: string) => fetch(`${baseUrl}${path}`, { redirect: "manual" });

beforeAll(async () => {
  const app = express();
  app.use(authMiddleware);
  app.use("/api/deezer", handToHono);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
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
    "https://api.deezer.com/track/7": () => ({ id: 7, preview: signedLink("7", Date.now()) }),
  });

  const [track] = await deezerGetArtistTopTracksById("101");
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
