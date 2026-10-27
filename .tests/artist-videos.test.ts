import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { default: artistVideo }, { ytdlpClient }, { clearApiCaches }] =
  await setupIsolatedBackend(
    "artist-videos",
    () => import("../backend/routes/artists/handlers/video.ts"),
    () => import("../backend/services/ytdlpClient.ts"),
    () => import("../backend/services/apiClients/clearCache.ts"),
  );
const mbid = "58e235fc-f6ea-4614-9ed4-9855a5665ae1";

async function findVideo(trackTitle = "I Wanna Get Better", artistName = "Bleachers") {
  const response = await artistVideo.request(
    `/artists/${mbid}/video?${new URLSearchParams({ artistName, trackTitle })}`,
  );
  return { status: response.status, ...(await response.json()) };
}

const video = (
  id: string,
  title: string,
  channel: string = "bleachers",
  extra: { durationSec?: number; liveStatus?: string } = {},
) => ({
  id,
  title,
  channel,
  durationSec: 293,
  liveStatus: "not_live",
  url: `https://www.youtube.com/watch?v=${id}`,
  ...extra,
});

beforeEach(() => clearApiCaches());
afterAll(() => cleanupIsolatedState(state));

test("artist videos prefer the matching official music video over release audio and allow its longer cut", async () => {
  const search = vi.spyOn(ytdlpClient, "search").mockImplementation(async () => [
    video("audio000001", "Bleachers - I Wanna Get Better (Official Audio)", "bleachers", {
      durationSec: 207,
    }),
    video("wrong000001", "Bleachers - Don't Take the Money (Official Video)"),
    video("video000001", "Bleachers - I Wanna Get Better (Official Video)"),
  ]);
  assert.equal((await findVideo()).video?.videoId, "video000001");
  assert.equal(search.mock.calls.length, 1);
});

for (const [name, title, channel, extra] of [
  ["another song", "Bleachers - I Wanna Get Better Soon (Official Video)", "bleachers", {}],
  ["another artist", "Other Artist - I Wanna Get Better (Official Video)", "Other Artist", {}],
  ["a cover on the artist's channel", "Other Artist - I Wanna Get Better (Cover)", "bleachers", {}],
  ["a live version", "Bleachers - I Wanna Get Better (Live at Red Rocks)", "bleachers", {}],
  ["a remix", "Bleachers - I Wanna Get Better (Remix)", "bleachers", {}],
  ["karaoke", "Bleachers - I Wanna Get Better (Karaoke Version)", "Karaoke", {}],
  [
    "an upcoming stream",
    "Bleachers - I Wanna Get Better",
    "bleachers",
    { liveStatus: "is_upcoming" },
  ],
] as const) {
  test(`artist videos skip ${name}`, async () => {
    vi.spyOn(ytdlpClient, "search").mockImplementation(async () => [
      video("wrong000001", title, channel, extra),
    ]);
    assert.equal((await findVideo()).video, null);
  });
}

test("artist videos fall back to a matching lyric upload and understand title-first and VEVO credits", async () => {
  vi.spyOn(ytdlpClient, "search").mockImplementation(async () => [
    video("lyrics00001", "I Wanna Get Better - Bleachers (Lyric Video)", "BleachersVEVO"),
  ]);
  const result = await findVideo();
  assert.equal(result.video?.videoId, "lyrics00001");
  assert.equal(result.video?.embedUrl, "https://www.youtube-nocookie.com/embed/lyrics00001");
});

test("artist video matches are reused for later requests", async () => {
  const search = vi
    .spyOn(ytdlpClient, "search")
    .mockImplementation(async () => [
      video("video000001", "Bleachers - I Wanna Get Better (Official Video)"),
    ]);
  const first = await findVideo();
  assert.deepEqual(await findVideo(), first);
  assert.equal(search.mock.calls.length, 1);
});

test("simultaneous artist video requests share the same search", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const search = vi.spyOn(ytdlpClient, "search").mockImplementation(async () => {
    await pending;
    return [video("video000001", "Bleachers - I Wanna Get Better (Official Video)")];
  });
  const first = findVideo();
  const second = findVideo();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].video?.videoId, "video000001");
  assert.deepEqual(results[1], results[0]);
  assert.equal(search.mock.calls.length, 1);
});

test("artist video search failures remain errors and can recover on retry", async () => {
  let failing = true;
  vi.spyOn(ytdlpClient, "search").mockImplementation(async () => {
    if (failing) throw new Error("yt-dlp unavailable");
    return [video("video000001", "Bleachers - I Wanna Get Better (Official Video)")];
  });
  assert.equal((await findVideo()).status, 503);
  failing = false;
  assert.equal((await findVideo()).video?.videoId, "video000001");
});
