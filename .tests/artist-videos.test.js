import assert from "node:assert/strict";
import test from "node:test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.js";

const [state, { registerVideo }, { ytdlpClient }, { clearApiCaches }] =
  await setupIsolatedBackend("artist-videos", "backend/routes/artists/handlers/video.js",
    "backend/services/ytdlpClient.js", "backend/services/apiClients/clearCache.js");
const mbid = "58e235fc-f6ea-4614-9ed4-9855a5665ae1";
const routes = new Map();
registerVideo({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) });

async function findVideo(trackTitle = "I Wanna Get Better", artistName = "Bleachers") {
  let body;
  let status = 200;
  await routes.get("/:mbid/video")({ params: { mbid }, query: { artistName, trackTitle } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  return { status, ...body };
}

const video = (id, title, channel = "bleachers", extra = {}) =>
  ({ id, title, channel, durationSec: 293, ...extra });

test.beforeEach(() => clearApiCaches());
test.after(() => cleanupIsolatedState(state));

test("artist videos prefer the matching official music video over release audio and allow its longer cut", async t => {
  const search = t.mock.method(ytdlpClient, "search", async () => [
    video("audio000001", "Bleachers - I Wanna Get Better (Official Audio)", "bleachers", { durationSec: 207 }),
    video("wrong000001", "Bleachers - Don't Take the Money (Official Video)"),
    video("video000001", "Bleachers - I Wanna Get Better (Official Video)"),
  ]);
  assert.equal((await findVideo()).video?.videoId, "video000001");
  assert.equal(search.mock.callCount(), 1);
});

for (const [name, title, channel, extra] of [
  ["another song", "Bleachers - I Wanna Get Better Soon (Official Video)", "bleachers", {}],
  ["another artist", "Other Artist - I Wanna Get Better (Official Video)", "Other Artist", {}],
  ["a cover on the artist's channel", "Other Artist - I Wanna Get Better (Cover)", "bleachers", {}],
  ["a live version", "Bleachers - I Wanna Get Better (Live at Red Rocks)", "bleachers", {}],
  ["a remix", "Bleachers - I Wanna Get Better (Remix)", "bleachers", {}],
  ["karaoke", "Bleachers - I Wanna Get Better (Karaoke Version)", "Karaoke", {}],
  ["an upcoming stream", "Bleachers - I Wanna Get Better", "bleachers", { liveStatus: "is_upcoming" }],
]) {
  test(`artist videos skip ${name}`, async t => {
    t.mock.method(ytdlpClient, "search", async () => [video("wrong000001", title, channel, extra)]);
    assert.equal((await findVideo()).video, null);
  });
}

test("artist videos fall back to a matching lyric upload and understand title-first and VEVO credits", async t => {
  t.mock.method(ytdlpClient, "search", async () => [
    video("lyrics00001", "I Wanna Get Better - Bleachers (Lyric Video)", "BleachersVEVO"),
  ]);
  const result = await findVideo();
  assert.equal(result.video?.videoId, "lyrics00001");
  assert.equal(result.video?.embedUrl, "https://www.youtube-nocookie.com/embed/lyrics00001");
});

test("artist video matches are reused for later requests", async t => {
  const search = t.mock.method(ytdlpClient, "search", async () => [
    video("video000001", "Bleachers - I Wanna Get Better (Official Video)"),
  ]);
  const first = await findVideo();
  assert.deepEqual(await findVideo(), first);
  assert.equal(search.mock.callCount(), 1);
});

test("simultaneous artist video requests share the same search", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const search = t.mock.method(ytdlpClient, "search", async () => {
    await pending;
    return [video("video000001", "Bleachers - I Wanna Get Better (Official Video)")];
  });
  const first = findVideo();
  const second = findVideo();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].video?.videoId, "video000001");
  assert.deepEqual(results[1], results[0]);
  assert.equal(search.mock.callCount(), 1);
});

test("artist video search failures remain errors and can recover on retry", async t => {
  let failing = true;
  t.mock.method(ytdlpClient, "search", async () => {
    if (failing) throw new Error("yt-dlp unavailable");
    return [video("video000001", "Bleachers - I Wanna Get Better (Official Video)")];
  });
  assert.equal((await findVideo()).status, 503);
  failing = false;
  assert.equal((await findVideo()).video?.videoId, "video000001");
});
