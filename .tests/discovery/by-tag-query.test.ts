import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { api }] = await setupIsolatedBackend(
  "discovery-by-tag-query",
  () => import("../../backend/routes/api.ts"),
);

afterAll(() => cleanupIsolatedState(state));

test("a repeated tag query is rejected like a missing tag", async () => {
  const res = await signedInAs(undefined)
    .route("/", api)
    .request("/discover/by-tag?tag=rock&tag=jazz");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Tag parameter is required");
});
