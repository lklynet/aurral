import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { default: artistVideo }, { youtubeVideoSearch }, { clearApiCaches }] =
  await setupIsolatedBackend(
    "artist-videos",
    () => import("../backend/routes/artists/handlers/video.ts"),
    () => import("../backend/services/apiClients/youtube.ts"),
    () => import("../backend/services/apiClients/clearCache.ts"),
  );
const mbid = "58e235fc-f6ea-4614-9ed4-9855a5665ae1";

async function findVideo(trackTitle = "I Wanna Get Better", artistName = "Bleachers") {
  const response = await artistVideo.request(
    `/artists/${mbid}/video?${new URLSearchParams({ artistName, trackTitle })}`,
  );
  return { status: response.status, ...(await response.json()) };
}

const video = (id: string, title: string, channel = "bleachers", live = false) => ({
  id,
  title,
  channel,
  live,
});

beforeEach(() => clearApiCaches());
afterAll(() => cleanupIsolatedState(state));

test("artist videos prefer the matching official music video over release audio", async () => {
  const search = vi
    .spyOn(youtubeVideoSearch, "search")
    .mockImplementation(async () => [
      video("audio000001", "Bleachers - I Wanna Get Better (Official Audio)"),
      video("wrong000001", "Bleachers - Don't Take the Money (Official Video)"),
      video("video000001", "Bleachers - I Wanna Get Better (Official Video)"),
    ]);
  assert.equal((await findVideo()).video?.videoId, "video000001");
  assert.equal(search.mock.calls.length, 1);
});

for (const [name, title, channel, live] of [
  ["another song", "Bleachers - I Wanna Get Better Soon (Official Video)", "bleachers", false],
  ["another artist", "Other Artist - I Wanna Get Better (Official Video)", "Other Artist", false],
  [
    "a cover on the artist's channel",
    "Other Artist - I Wanna Get Better (Cover)",
    "bleachers",
    false,
  ],
  ["a live version", "Bleachers - I Wanna Get Better (Live at Red Rocks)", "bleachers", false],
  ["a remix", "Bleachers - I Wanna Get Better (Remix)", "bleachers", false],
  ["karaoke", "Bleachers - I Wanna Get Better (Karaoke Version)", "Karaoke", false],
  ["a stream", "Bleachers - I Wanna Get Better", "bleachers", true],
] as const) {
  test(`artist videos skip ${name}`, async () => {
    vi.spyOn(youtubeVideoSearch, "search").mockImplementation(async () => [
      video("wrong000001", title, channel, live),
    ]);
    assert.equal((await findVideo()).video, null);
  });
}

test("artist videos fall back to a matching lyric upload and understand title-first and VEVO credits", async () => {
  vi.spyOn(youtubeVideoSearch, "search").mockImplementation(async () => [
    video("lyrics00001", "I Wanna Get Better - Bleachers (Lyric Video)", "BleachersVEVO"),
  ]);
  const result = await findVideo();
  assert.equal(result.video?.videoId, "lyrics00001");
  assert.equal(result.video?.embedUrl, "https://www.youtube-nocookie.com/embed/lyrics00001");
});

test("artist video matches are reused for later requests", async () => {
  const search = vi
    .spyOn(youtubeVideoSearch, "search")
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
  const search = vi.spyOn(youtubeVideoSearch, "search").mockImplementation(async () => {
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
  vi.spyOn(youtubeVideoSearch, "search").mockImplementation(async () => {
    if (failing) throw new Error("yt-dlp unavailable");
    return [video("video000001", "Bleachers - I Wanna Get Better (Official Video)")];
  });
  assert.equal((await findVideo()).status, 503);
  failing = false;
  assert.equal((await findVideo()).video?.videoId, "video000001");
});
