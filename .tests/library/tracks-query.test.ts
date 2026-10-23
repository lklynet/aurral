import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerTracks }] = await setupIsolatedBackend(
  "tracks-query",
  () => import("../../backend/routes/library/handlers/tracks.ts"),
);

const routes = createRouteHarness(registerTracks);

afterAll(() => cleanupIsolatedState(state));

async function requestTracks(
  query:
    | { albumId: string[]; releaseGroupMbid?: undefined }
    | { releaseGroupMbid: string[]; albumId?: undefined }
    | { albumId: string },
) {
  const response = createResponse<unknown>();
  await routes.get("GET /tracks")({ query }, response);
  return response;
}

test("a repeated albumId or releaseGroupMbid is rejected", async () => {
  for (const query of [{ albumId: ["1", "2"] }, { releaseGroupMbid: ["a", "b"] }]) {
    const response = await requestTracks(query);
    assert.equal(response.statusCode, 400);
  }
});

test("a single albumId with no matching album lists no tracks", async () => {
  const response = await requestTracks({ albumId: "999" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, []);
});
