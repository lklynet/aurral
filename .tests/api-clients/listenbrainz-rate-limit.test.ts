import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { listenbrainzRequest } from "../../backend/services/apiClients/listenbrainz.ts";

test("a ListenBrainz rate limit holds every request until the window resets, then retries", async (t: import("vite-plus/test").TestContext) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const calls: { count: string | null; at: number }[] = [];
  let rateLimitedAt: number | null = null;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push({ count: url.searchParams.get("count"), at: Date.now() });
    if (rateLimitedAt === null) {
      rateLimitedAt = Date.now();
      return json({ code: 429, error: "Too many requests" }, 429, { "x-ratelimit-reset-in": "1" });
    }
    return json(
      { payload: { artists: [{ artist_name: `count ${url.searchParams.get("count")}` }] } },
      200,
    );
  };

  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const requests = Promise.all([
    listenbrainzRequest("/1/stats/sitewide/artists", { count: 1, range: "week" }),
    listenbrainzRequest("/1/stats/sitewide/artists", { count: 2, range: "week" }),
  ]);
  await vi.runAllTimersAsync();
  const [first, second] = await requests;

  assert.equal(first.payload.artists[0].artist_name, "count 1");
  assert.equal(second.payload.artists[0].artist_name, "count 2");
  assert.deepEqual(
    calls.map((call) => call.count),
    ["1", "2", "1"],
  );
  assert.ok(rateLimitedAt !== null);
  const limitedAt = rateLimitedAt;
  assert.ok(calls.slice(1).every((call) => call.at - limitedAt >= 1000));
});
