import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { listenbrainzGetReleaseGroupStats } from "../../backend/services/apiClients/listenbrainz.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";

useFakeClock();

test("a ListenBrainz failure is asked again after five minutes and never blocks the load meanwhile", async (t: import("vite-plus/test").TestContext) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const releaseGroups = [
    { id: "99999999-0000-4000-8000-000000000001", "first-release-date": null },
  ];
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return Response.json({
      code: 401,
      error: "You need to provide an Auth token for this endpoint.",
    });
  };
  const lookUp = () => listenbrainzGetReleaseGroupStats(releaseGroups, { waitMs: 1000 });
  const asked = ["/1/popularity/release-group", "/1/metadata/release_group/"];
  const unanswered = { records: new Map(), pending: false };

  assert.deepEqual(await lookUp(), unanswered);
  assert.deepEqual(await lookUp(), unanswered);
  assert.deepEqual(requests, asked);

  vi.setSystemTime(Date.now() + 301_000);
  assert.deepEqual(await lookUp(), unanswered);
  assert.deepEqual(requests, [...asked, ...asked]);
});
