import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { api }] = await setupIsolatedBackend(
  "playlist-jobs-status-query",
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

afterAll(() => cleanupIsolatedState(state));

test("a repeated status filter is rejected", async () => {
  const response = await app.request("/playlists/jobs?status=done&status=failed");
  assert.equal(response.status, 400);
});

test("a single status filter lists jobs", async () => {
  const response = await app.request("/playlists/jobs?status=done");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});
