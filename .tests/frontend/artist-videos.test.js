import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

const vite = await startFrontendServer();
const { getArtistVideos } = await vite.ssrLoadModule("/src/utils/api/endpoints/artists.js");
const tracks = Array.from({ length: 8 }, (_, index) => ({ title: `Track ${index + 1}` }));
test.after(() => vite.close());

function stubVideos(t, respond) {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const title = new URL(String(url), "http://localhost").searchParams.get("trackTitle");
    requested.push(title);
    const response = await respond(Number(title.split(" ")[1]), options);
    return new Response(JSON.stringify(response.body ?? { video: response.id ? {
      videoId: response.id, embedUrl: `https://www.youtube-nocookie.com/embed/${response.id}`,
    } : null }), { status: response.status || 200, headers: { "content-type": "application/json" } });
  });
  return requested;
}

for (const ranks of [[1, 2, 3], [1, 3, 6], [2, 5], [6], []]) {
  test(`artist videos return the first available top-six matches: ${ranks.join(",") || "none"}`, async t => {
    const requested = stubVideos(t, async rank => ({ id: ranks.includes(rank) ? `video-${rank}` : null }));
    const result = await getArtistVideos("artist", "Artist", tracks);
    assert.deepEqual(result.videos.map(video => video.trackTitle), ranks.map(rank => `Track ${rank}`));
    assert.equal(result.failed, false);
    assert.equal(requested.some(title => ["Track 7", "Track 8"].includes(title)), false);
    if (ranks.length === 3) assert.equal(requested.at(-1), `Track ${ranks.at(-1)}`);
  });
}

test("artist videos skip duplicate videos and fill the remaining slot from later tracks", async t => {
  stubVideos(t, async rank => ({ id: rank < 3 ? "same-video" : `video-${rank}` }));
  const { videos } = await getArtistVideos("artist", "Artist", tracks);
  assert.deepEqual(videos.map(video => video.videoId), ["same-video", "video-3", "video-4"]);
});

test("artist videos keep popular order when searches finish out of order", async t => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  stubVideos(t, async rank => {
    if (rank === 1) await first;
    if (rank === 3) release();
    return { id: `video-${rank}` };
  });
  const { videos } = await getArtistVideos("artist", "Artist", tracks);
  assert.deepEqual(videos.map(video => video.trackTitle), ["Track 1", "Track 2", "Track 3"]);
});

test("artist videos keep available matches when another search fails and recover on retry", async t => {
  let failed = true;
  stubVideos(t, async rank => rank === 2 && failed
    ? { status: 503, body: { error: "Search unavailable" } }
    : { id: `video-${rank}` });
  const result = await getArtistVideos("artist", "Artist", tracks);
  assert.deepEqual(result.videos.map(video => video.trackTitle), ["Track 1", "Track 3", "Track 4"]);
  assert.equal(result.failed, true);
  failed = false;
  const retry = await getArtistVideos("artist", "Artist", tracks);
  assert.deepEqual(retry.videos.map(video => video.trackTitle), ["Track 1", "Track 2", "Track 3"]);
  assert.equal(retry.failed, false);
});

test("artist video lookup stops after navigation aborts it", async t => {
  const controller = new AbortController();
  const requested = stubVideos(t, async () => {
    controller.abort();
    return { id: null };
  });
  await assert.rejects(getArtistVideos("artist", "Artist", tracks, { signal: controller.signal }),
    { name: "AbortError" });
  assert.ok(requested.length <= 3);
});
