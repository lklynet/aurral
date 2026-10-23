import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerDownloads }] = await setupIsolatedBackend(
  "download-status-query",
  () => import("../../backend/routes/library/handlers/downloads.ts"),
);

const routes = createRouteHarness(registerDownloads);

afterAll(() => cleanupIsolatedState(state));

async function requestStatus(query: { albumIds: { first: string } }) {
  const response = createResponse<{ error: string }>();
  await routes.get("GET /downloads/status")({ query }, response);
  return response;
}

test("a nested albumIds query is rejected like a missing one", async () => {
  const response = await requestStatus({ albumIds: { first: "1" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "albumIds query parameter is required");
});
