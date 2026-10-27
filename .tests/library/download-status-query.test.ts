import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [state, { api }] = await setupIsolatedBackend(
  "download-status-query",
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(undefined).route("/", api);

afterAll(() => cleanupIsolatedState(state));

test("a nested albumIds query is rejected like a missing one", async () => {
  const response = await app.request("/library/downloads/status?albumIds[first]=1");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "albumIds query parameter is required");
});
