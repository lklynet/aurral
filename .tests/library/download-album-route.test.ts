import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerDownloads }, { libraryManager }, { lidarrClient }, { dbOps }] =
  await setupIsolatedBackend(
    "download-album-route",
    "backend/routes/library/handlers/downloads.ts",
    "backend/services/libraryManager.ts",
    "backend/services/lidarrClient.ts",
    "backend/db/helpers/index.ts",
  );

const routes = new Map();
registerDownloads({
  post: (path, ...handlers) => routes.set(`POST ${path}`, handlers.at(-1)),
  get: () => {},
});

afterAll(() => cleanupIsolatedState(state));

test("searching for an album whose artist Lidarr no longer has still succeeds", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  const request = vi.spyOn(lidarrClient, "request").mockResolvedValue({});
  vi.spyOn(dbOps, "getSettings").mockReturnValue({
    integrations: { lidarr: { searchOnAdd: true } },
  });
  vi.spyOn(libraryManager, "getAlbumById").mockResolvedValue({
    id: "11",
    artistId: "7",
    albumName: "Route Album",
    artistName: "Route Artist",
    monitored: true,
  });
  vi.spyOn(libraryManager, "getArtistById").mockResolvedValue(null);
  const response = { statusCode: 200, body: null };
  await routes.get("POST /downloads/album")(
    { body: { albumId: "11" }, user: { id: 1, role: "admin", permissions: {} } },
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
  assert.equal(request.mock.calls.length, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
});
