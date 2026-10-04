import assert from "node:assert/strict";
import test from "node:test";

import { listenbrainzRequest } from "../../backend/services/apiClients/listenbrainz.js";

test("a ListenBrainz rate limit waits for the window to reset and retries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const responses = [
    new Response(JSON.stringify({ code: 429, error: "Too many requests" }), {
      status: 429,
      headers: { "content-type": "application/json", "x-ratelimit-reset-in": "0" },
    }),
    new Response(JSON.stringify({ payload: { artists: [{ artist_name: "Alvvays" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  let calls = 0;
  globalThis.fetch = async () => responses[calls++];

  const data = await listenbrainzRequest("/1/stats/sitewide/artists", { count: 1, range: "week" });

  assert.equal(data.payload.artists[0].artist_name, "Alvvays");
  assert.equal(calls, 2);
});
