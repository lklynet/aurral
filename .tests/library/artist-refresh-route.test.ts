import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerArtists }, { libraryManager }, { lidarrClient }] =
  await setupIsolatedBackend(
    "artist-refresh-route",
    "backend/routes/library/handlers/artists.ts",
    "backend/services/libraryManager.ts",
    "backend/services/lidarrClient.ts",
  );

const routes = new Map();
registerArtists({
  post: (path, ...handlers) => routes.set(`POST ${path}`, handlers.at(-1)),
  get: () => {},
  put: () => {},
  delete: () => {},
});

afterAll(() => cleanupIsolatedState(state));

test("refreshing a monitored artist searches Lidarr by its numeric id", async () => {
  vi.spyOn(libraryManager, "getArtist").mockResolvedValue({ id: "12" });
  vi.spyOn(libraryManager, "getAlbums").mockResolvedValue([]);
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "getArtist").mockResolvedValue({ id: 12, monitored: true });
  const search = vi.spyOn(lidarrClient, "triggerArtistSearch").mockResolvedValue({});
  const response = { statusCode: 200, body: null };
  await routes.get("POST /artists/:mbid/refresh")(
    { params: { mbid: "55555555-5555-4555-8555-555555555555" } },
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
  assert.equal(response.statusCode, 200);
  assert.deepEqual(search.mock.calls, [[12]]);
});
