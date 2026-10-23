import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerDownloads }, { libraryManager }, { lidarrClient }, { dbOps }] =
  await setupIsolatedBackend(
    "download-album-route",
    () => import("../../backend/routes/library/handlers/downloads.ts"),
    () => import("../../backend/services/libraryManager.ts"),
    () => import("../../backend/services/lidarrClient.ts"),
    () => import("../../backend/db/helpers/index.ts"),
  );

const routes = createRouteHarness(registerDownloads);

afterAll(() => cleanupIsolatedState(state));

test("searching for an album whose artist Lidarr no longer has still succeeds", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  const request = vi.spyOn(lidarrClient, "request").mockResolvedValue({});
  vi.spyOn(dbOps, "getSettings").mockReturnValue({
    ...dbOps.getSettings(),
    integrations: { lidarr: { searchOnAdd: true } },
  });
  vi.spyOn(libraryManager, "getAlbumById").mockResolvedValue({
    id: "11",
    artistId: "7",
    albumName: "Route Album",
    artistName: "Route Artist",
    monitored: true,
  } as Awaited<ReturnType<typeof libraryManager.getAlbumById>>);
  vi.spyOn(libraryManager, "getArtistById").mockResolvedValue(null);
  const response = createResponse<{ success: boolean }>();
  await routes.get("POST /downloads/album")(
    { body: { albumId: "11" }, user: { id: 1, role: "admin", permissions: {} } },
    response,
  );
  assert.equal(request.mock.calls.length, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
});
