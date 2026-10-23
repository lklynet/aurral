import { captureRouteHandlers, createResponse } from "./library/routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { registerPreview }, { dbOps }, { default: axios }] = await setupIsolatedBackend(
  "artist-preview-query",
  () => import("../backend/routes/artists/handlers/preview.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../lib/axiosFetch.ts"),
);
const mbid = "58e235fc-f6ea-4614-9ed4-9855a5665ae1";
const routes = captureRouteHandlers(registerPreview, "get");

afterAll(() => cleanupIsolatedState(state));

test("a repeated artistName query is ignored instead of crashing the preview route", async () => {
  dbOps.setArtistOverride(mbid, { deezerArtistId: "101" });
  vi.spyOn(axios, "get").mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: {},
    data: { data: [{ id: 7, title: "Song", preview: "https://cdn.test/song.mp3", duration: 30 }] },
  });
  const response = createResponse<{ tracks: unknown[] }>();
  await routes.get("/:mbid/preview")(
    { params: { mbid }, query: { artistName: ["Queen", "Bowie"] } },
    response,
  );
  assert.equal(response.body.tracks.length, 1);
});
