import assert from "node:assert/strict";
import test from "node:test";

import { listenbrainzGetReleaseGroupListens } from "../../backend/services/apiClients/listenbrainz.js";

test("a ListenBrainz failure is asked again after five minutes instead of the hour a good answer is kept", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const releaseGroupMbids = ["99999999-0000-4000-8000-000000000001"];
  let popularityRequests = 0;
  globalThis.fetch = async () => {
    popularityRequests += 1;
    return new Response(
      JSON.stringify({ code: 401, error: "You need to provide an Auth token for this endpoint." }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  assert.deepEqual(await listenbrainzGetReleaseGroupListens(releaseGroupMbids), new Map());
  assert.deepEqual(await listenbrainzGetReleaseGroupListens(releaseGroupMbids), new Map());
  assert.equal(popularityRequests, 1);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 301_000 });
  assert.deepEqual(await listenbrainzGetReleaseGroupListens(releaseGroupMbids), new Map());
  assert.equal(popularityRequests, 2);
});
