import { captureRouteHandlers, createResponse } from "../library/routeHarness.ts";
import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { registerSpotifyImport }, { spotifyConnectionStore }] = await setupIsolatedBackend(
  "spotify-oauth-complete",
  () => import("../../backend/routes/playlists/handlers/spotifyImport.ts"),
  () => import("../../backend/services/spotify/spotifyConnectionStore.ts"),
);

const routes = captureRouteHandlers(registerSpotifyImport, "post");

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupIsolatedState(state);
});

async function completeOAuth() {
  const response = createResponse<{ message: string; connected: boolean }>();
  await routes.get("/import/spotify/oauth/complete")(
    { body: { accessToken: "access", refreshToken: "refresh", expiresIn: 3600 }, user: { id: 1 } },
    response,
  );
  return response;
}

test("an unreadable saved connection is reported instead of crashing the response", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false }));
  vi.spyOn(spotifyConnectionStore, "saveConnection").mockReturnValue(null);
  const response = await completeOAuth();
  assert.equal(response.statusCode, 500);
  assert.ok(response.body != null);
  assert.equal(response.body.message, "The saved Spotify connection could not be read back");
});

test("a saved connection is returned to the client", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false }));
  vi.restoreAllMocks();
  const response = await completeOAuth();
  assert.equal(response.statusCode, 200);
  assert.ok(response.body != null);
  assert.equal(response.body.connected, true);
});
