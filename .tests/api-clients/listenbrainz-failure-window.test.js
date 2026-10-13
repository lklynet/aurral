import assert from "node:assert/strict";
import test from "node:test";

import {
  listenbrainzGetReleaseGroupDates,
  listenbrainzGetReleaseGroupListens,
} from "../../backend/services/apiClients/listenbrainz.js";

test("a ListenBrainz failure is asked again after five minutes instead of the hour a good answer is kept", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const releaseGroupMbids = ["99999999-0000-4000-8000-000000000001"];
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(
      JSON.stringify({ code: 401, error: "You need to provide an Auth token for this endpoint." }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const lookUp = async () => [
    await listenbrainzGetReleaseGroupListens(releaseGroupMbids),
    await listenbrainzGetReleaseGroupDates(releaseGroupMbids),
  ];
  const asked = ["/1/popularity/release-group", "/1/metadata/release_group/"];

  assert.deepEqual(await lookUp(), [new Map(), new Map()]);
  assert.deepEqual(await lookUp(), [new Map(), new Map()]);
  assert.deepEqual(requests, asked);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 301_000 });
  assert.deepEqual(await listenbrainzGetReleaseGroupListens(releaseGroupMbids), new Map());
  t.mock.timers.tick(1000);
  assert.deepEqual(await listenbrainzGetReleaseGroupDates(releaseGroupMbids), new Map());
  assert.deepEqual(requests, [...asked, ...asked]);
});
