import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";
import { createResponse, createRouteHarness } from "../library/routeHarness.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerTags }] = await setupIsolatedBackend(
  "discovery-by-tag-query",
  () => import("../../backend/routes/discovery/handlers/tags.ts"),
);
const routes = createRouteHarness(registerTags);

afterAll(() => cleanupIsolatedState(state));

test("a repeated tag query is rejected like a missing tag", async () => {
  const res = createResponse<{ error: string }>();
  await routes.get("GET /by-tag")({ query: { tag: ["rock", "jazz"] }, user: null }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Tag parameter is required");
});
