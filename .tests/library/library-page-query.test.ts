import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerLibraryIndex }] = await setupIsolatedBackend(
  "library-page-query",
  () => import("../../backend/routes/library/handlers/libraryIndex.ts"),
);

const routes = createRouteHarness(registerLibraryIndex);

afterAll(() => cleanupIsolatedState(state));

async function requestPage(
  query:
    | { artistId: string[]; albumId?: undefined }
    | { albumId: string[]; artistId?: undefined }
    | { artistId: string; albumId: string },
) {
  const response = createResponse<{ kind: string }>();
  await routes.get("GET /canonical")(
    { query: { kind: "albums", pageSize: "10", ...query }, user: null },
    response,
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
