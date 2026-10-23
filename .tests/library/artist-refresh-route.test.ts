import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerArtists }, { libraryManager }, { lidarrClient }] =
  await setupIsolatedBackend(
    "artist-refresh-route",
    () => import("../../backend/routes/library/handlers/artists.ts"),
    () => import("../../backend/services/libraryManager.ts"),
    () => import("../../backend/services/lidarrClient.ts"),
  );

const routes = createRouteHarness(registerArtists);

afterAll(() => cleanupIsolatedState(state));

test("refreshing a monitored artist searches Lidarr by its numeric id", async () => {
  vi.spyOn(libraryManager, "getArtist").mockResolvedValue({ id: "12" } as Awaited<
    ReturnType<typeof libraryManager.getArtist>
  >);
  vi.spyOn(libraryManager, "getAlbums").mockResolvedValue([]);
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  const monitoredArtist = { id: 12, monitored: true, monitor: "all" };
  vi.spyOn(lidarrClient, "getArtistByMbid").mockResolvedValue(monitoredArtist);
  const search = vi.spyOn(lidarrClient, "triggerArtistSearch").mockResolvedValue({});
  const response = createResponse<unknown>();
  await routes.get("POST /artists/:mbid/refresh")(
    { params: { mbid: "55555555-5555-4555-8555-555555555555" } },
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(search.mock.calls, [[12]]);
});
