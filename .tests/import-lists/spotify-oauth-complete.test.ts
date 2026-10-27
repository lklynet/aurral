import assert from "node:assert/strict";
import { test, afterAll, vi } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { api }, { spotifyConnectionStore }] = await setupIsolatedBackend(
  "spotify-oauth-complete",
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/spotify/spotifyConnectionStore.ts"),
);

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanupIsolatedState(state);
});

async function completeOAuth() {
  const response = await app.request("/playlists/import/spotify/oauth/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 }),
  });
  return { status: response.status, body: await response.json() };
}

test("an unreadable saved connection is reported instead of crashing the response", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false }));
  vi.spyOn(spotifyConnectionStore, "saveConnection").mockReturnValue(null);
  const response = await completeOAuth();
  assert.equal(response.status, 500);
  assert.equal(response.body.message, "The saved Spotify connection could not be read back");
});

test("a saved connection is returned to the client", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false }));
  vi.restoreAllMocks();
  const response = await completeOAuth();
  assert.equal(response.status, 200);
  assert.equal(response.body.connected, true);
});
