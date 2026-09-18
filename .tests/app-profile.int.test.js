import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
  startServerProcess,
} from "./helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("app-profile-diet");
let server;

test.before(async () => {
  server = await startServerProcess({
    extraEnv: { AURRAL_PROFILE: "diet" },
  });
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("Diet bootstrap advertises its reduced runtime capabilities", async () => {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/health/bootstrap`,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.profile, "diet");
  assert.equal(payload.capabilities.localLibrary, false);
  assert.equal(payload.capabilities.downloads, false);
  assert.equal(payload.capabilities.playback, false);
  assert.equal(payload.capabilities.flows, false);
  assert.equal(payload.capabilities.backgroundWorkers, false);
  assert.equal(payload.capabilities.matcher, false);
  assert.equal(payload.capabilities.fullFeatures, false);
  assert.deepEqual(payload.matcher, {
    available: false,
    checked: false,
    error: null,
  });
});

test("Diet returns an explicit capability response for Full-only API routes", async () => {
  for (const [path, capability] of [
    ["/api/library/canonical", "localLibrary"],
    ["/api/playlists/status", "flows"],
    ["/api/inbox", "fullFeatures"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), {
      error: "Capability unavailable",
      code: "capability_unavailable",
      capability,
      profile: "diet",
    });
  }
});
