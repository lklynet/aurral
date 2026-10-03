import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
  startServerProcess,
} from "./helpers/backendTestHarness.js";

const [isolatedState, { dbOps }] = await setupIsolatedBackend(
  "deprecated-usage-server",
  "backend/db/helpers/index.js",
);
let server;

test.before(async () => {
  server = await startServerProcess();
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("the old /api/weekly-flow prefix still redirects and records its use", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/weekly-flow/status?limit=1`, {
    redirect: "manual",
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/api/playlists/status?limit=1");
  dbOps.invalidateSettingsCache();
  assert.ok(dbOps.getJSONSetting("deprecatedUsage")?.["weekly-flow-api"]?.lastSeenAt > 0);
});
