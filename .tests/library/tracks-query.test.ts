import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerTracks }] = await setupIsolatedBackend(
  "tracks-query",
  "backend/routes/library/handlers/tracks.ts",
);

const routes = new Map();
registerTracks({
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
  post: () => {},
  put: () => {},
  delete: () => {},
});

afterAll(() => cleanupIsolatedState(state));

async function requestTracks(query) {
  const response = { statusCode: 200, body: null };
  await routes.get("GET /tracks")(
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
