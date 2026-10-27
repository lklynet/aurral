import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [state, { api }] = await setupIsolatedBackend(
  "library-page-query",
  () => import("../../backend/routes/api.ts"),
);

const app = signedInAs(undefined).route("/", api);

afterAll(() => cleanupIsolatedState(state));

const requestPage = (filters: string) =>
  app.request(`/library/canonical?kind=albums&pageSize=10&${filters}`);

test("a repeated artistId or albumId filter is rejected", async () => {
  for (const filters of ["artistId=1&artistId=2", "albumId=1&albumId=2"]) {
    const response = await requestPage(filters);
    assert.equal(response.status, 400);
  }
});

test("single artistId and albumId filters still page the library", async () => {
  const response = await requestPage("artistId=1&albumId=2");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, "albums");
});
