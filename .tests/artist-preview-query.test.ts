import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.ts";

const [state, { registerPreview }, { dbOps }, { default: axios }] = await setupIsolatedBackend(
  "artist-preview-query",
  "backend/routes/artists/handlers/preview.ts",
  "backend/db/helpers/index.ts",
  "lib/axiosFetch.ts",
);
const mbid = "58e235fc-f6ea-4614-9ed4-9855a5665ae1";
const routes = new Map();
registerPreview({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) });

afterAll(() => cleanupIsolatedState(state));

test("a repeated artistName query is ignored instead of crashing the preview route", async () => {
  dbOps.setArtistOverride(mbid, { deezerArtistId: "101" });
  vi.spyOn(axios, "get").mockResolvedValue({
    data: { data: [{ id: 7, title: "Song", preview: "https://cdn.test/song.mp3", duration: 30 }] },
  });
  let body;
  await routes.get("/:mbid/preview")(
    { params: { mbid }, query: { artistName: ["Queen", "Bowie"] } },
    {
      json(value) {
        body = value;
        return this;
      },
    },
  );
  assert.equal(body.tracks.length, 1);
});
