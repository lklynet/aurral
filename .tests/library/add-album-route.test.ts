import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [state, { api }, { libraryManager }] = await setupIsolatedBackend(
  "add-album-route",
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/libraryManager.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

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
  } as Awaited<ReturnType<typeof libraryManager.addAlbum>>);
  const response = await app.request("/library/albums", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artistId: "7",
      releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
      albumName: "Route Album",
      managedBy: "aurral",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).queued, false);
});
