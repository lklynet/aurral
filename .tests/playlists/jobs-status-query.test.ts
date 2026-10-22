import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerJobs }] = await setupIsolatedBackend(
  "playlist-jobs-status-query",
  "backend/routes/playlists/handlers/jobs.ts",
);

const routes = new Map();
registerJobs({
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
  post: () => {},
  put: () => {},
  patch: () => {},
  delete: () => {},
});

afterAll(() => cleanupIsolatedState(state));

async function requestJobs(query) {
  const response = { statusCode: 200, body: null };
  await routes.get("GET /jobs")(
    { query, user: null },
    {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return this;
      },
    },
  );
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
