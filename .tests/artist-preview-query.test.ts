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

const unlinkedMbid = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

function searchedDeezerArtists() {
  const searched: unknown[] = [];
  vi.spyOn(axios, "get").mockImplementation(async (url, config) => {
    if (url !== "https://api.deezer.com/search/artist") {
      throw Object.assign(new Error("Not found"), { response: { status: 404 } });
    }
    searched.push(config?.params?.q);
    return { status: 200, statusText: "OK", headers: {}, data: { data: [] } };
  });
  return searched;
}

const previewByName = (artistName: string) =>
  routes.get("/:mbid/preview")(
    { params: { mbid: unlinkedMbid }, query: { artistName } },
    createResponse(),
  );

test("the preview route searches Deezer for the name without its disambiguation", async () => {
  const searched = searchedDeezerArtists();
  await previewByName("Nirvana (US)");
  assert.deepEqual(searched, ["Nirvana"]);
});

test("a long artist name does not stall the preview route", { timeout: 1_000 }, async () => {
  const searched = searchedDeezerArtists();
  const spaced = `a${" ".repeat(100_000)}b`;
  const unclosed = "(".repeat(100_000);
  await previewByName(spaced);
  await previewByName(unclosed);
  assert.deepEqual(searched, [spaced, unclosed]);
});
