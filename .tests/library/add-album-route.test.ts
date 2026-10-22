import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerAlbums }, { libraryManager }] = await setupIsolatedBackend(
  "add-album-route",
  "backend/routes/library/handlers/albums.ts",
  "backend/services/libraryManager.ts",
);

const routes = new Map();
registerAlbums({
  post: (path, ...handlers) => routes.set(`POST ${path}`, handlers.at(-1)),
  get: () => {},
  put: () => {},
  delete: () => {},
});

afterAll(() => cleanupIsolatedState(state));

test("adding an album answers 201 once the album is in the library", async () => {
  vi.spyOn(libraryManager, "addAlbum").mockResolvedValue({
    id: "11",
    artistId: "7",
    artistName: "Route Artist",
    albumName: "Route Album",
    mbid: "72222222-2222-4222-8222-222222222222",
    foreignAlbumId: "72222222-2222-4222-8222-222222222222",
    statistics: { trackCount: 0, sizeOnDisk: 0, percentOfTracks: 0 },
  });
  const response = { statusCode: 200, body: null };
  await routes.get("POST /albums")(
    {
      body: {
        artistId: "7",
        releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
        albumName: "Route Album",
        managedBy: "aurral",
      },
      user: { id: 1, role: "admin", permissions: {} },
    },
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
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.queued, false);
});
