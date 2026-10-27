import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [state, { api }] = await setupIsolatedBackend(
  "tracks-query",
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(undefined).route("/", api);

afterAll(() => cleanupIsolatedState(state));

test("a repeated albumId or releaseGroupMbid is rejected", async () => {
  for (const query of ["albumId=1&albumId=2", "releaseGroupMbid=a&releaseGroupMbid=b"]) {
    const response = await app.request(`/library/tracks?${query}`);
    assert.equal(response.status, 400);
  }
});

test("a single albumId with no matching album lists no tracks", async () => {
  const response = await app.request("/library/tracks?albumId=999");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});
