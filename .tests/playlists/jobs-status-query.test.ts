import { captureRoutes, mockResponse, requireFixture } from "./fixtures.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerJobs }] = await setupIsolatedBackend(
  "playlist-jobs-status-query",
  () => import("../../backend/routes/playlists/handlers/jobs.ts"),
);

const { handlers: routes, router } = captureRoutes(
  (method: string, path) => `${method.toUpperCase()} ${path}`,
);
registerJobs(router);

afterAll(() => cleanupIsolatedState(state));

async function requestJobs(query: { status: string[] | { a: string } } | { status: string }) {
  const response = mockResponse<unknown>();
  await requireFixture(routes.get("GET /jobs"))({ query, user: null }, response);
  return response;
}

test("a repeated or nested status filter is rejected", async () => {
  for (const status of [["done", "failed"], { a: "b" }]) {
    const response = await requestJobs({ status });
    assert.equal(response.statusCode, 400);
  }
});

test("a single status filter lists jobs", async () => {
  const response = await requestJobs({ status: "done" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, []);
});
