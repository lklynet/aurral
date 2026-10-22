import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerDownloads }] = await setupIsolatedBackend(
  "download-status-query",
  "backend/routes/library/handlers/downloads.ts",
);

const routes = new Map();
registerDownloads({
  post: () => {},
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
});

afterAll(() => cleanupIsolatedState(state));

async function requestStatus(query) {
  const response = { statusCode: 200, body: null };
  await routes.get("GET /downloads/status")(
    { query },
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

test("a nested albumIds query is rejected like a missing one", async () => {
  const response = await requestStatus({ albumIds: { first: "1" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "albumIds query parameter is required");
});
