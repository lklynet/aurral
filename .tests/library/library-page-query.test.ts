import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerLibraryIndex }] = await setupIsolatedBackend(
  "library-page-query",
  "backend/routes/library/handlers/libraryIndex.ts",
);

const routes = new Map();
registerLibraryIndex({
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
  post: () => {},
  put: () => {},
  delete: () => {},
});

afterAll(() => cleanupIsolatedState(state));

async function requestPage(query) {
  const response = { statusCode: 200, body: null };
  await routes.get("GET /canonical")(
    { query: { kind: "albums", pageSize: "10", ...query }, user: null },
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

test("a repeated artistId or albumId filter is rejected", async () => {
  for (const query of [{ artistId: ["1", "2"] }, { albumId: ["1", "2"] }]) {
    const response = await requestPage(query);
    assert.equal(response.statusCode, 400);
  }
});

test("single artistId and albumId filters still page the library", async () => {
  const response = await requestPage({ artistId: "1", albumId: "2" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.kind, "albums");
});
