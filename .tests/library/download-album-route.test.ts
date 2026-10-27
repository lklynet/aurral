import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [state, { api }, { libraryManager }, { lidarrClient }, { dbOps }] =
  await setupIsolatedBackend(
    "download-album-route",
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/libraryManager.ts"),
    () => import("../../backend/services/lidarrClient.ts"),
    () => import("../../backend/db/helpers/index.ts"),
  );

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

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
  const response = await app.request("/library/downloads/album", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumId: "11" }),
  });
  assert.equal(request.mock.calls.length, 1);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
});
