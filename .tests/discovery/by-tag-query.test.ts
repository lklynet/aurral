import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerTags }] = await setupIsolatedBackend(
  "discovery-by-tag-query",
  "backend/routes/discovery/handlers/tags.ts",
);
const routes = new Map();
registerTags({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) });

afterAll(() => cleanupIsolatedState(state));

test("a repeated tag query is rejected like a missing tag", async () => {
  let status = 200;
  let body;
  await routes.get("/by-tag")(
    { query: { tag: ["rock", "jazz"] }, user: null },
    {
      status(value) {
        status = value;
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    },
  );
  assert.equal(status, 400);
  assert.equal(body.error, "Tag parameter is required");
});
