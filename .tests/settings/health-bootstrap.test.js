import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { createSession }, { default: healthRouter }] =
  await setupIsolatedBackend(
    "health-bootstrap",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/config/session-helpers.js",
    "backend/routes/health.js",
  );

const app = express();
app.use("/api/health", healthRouter);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function bootstrapAsUser() {
  const user = userOps.createUser("owner", "test-password-hash", "admin");
  const { token } = createSession(Number(user.id));
  const response = await fetch(`${baseUrl}/api/health/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json();
}

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("an install without Lidarr still reports a library root folder", async () => {
  dbOps.updateSettings({ onboardingComplete: true, integrations: {} });

  const payload = await bootstrapAsUser();

  assert.equal(payload.lidarrConfigured, false);
  assert.equal(payload.rootFolderConfigured, true);
});

test("disabling Lidarr keeps the library root folder configured", async () => {
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: { lidarr: { url: "http://127.0.0.1:9", apiKey: "key", enabled: false } },
  });

  const payload = await bootstrapAsUser();

  assert.equal(payload.lidarrConfigured, false);
  assert.equal(payload.rootFolderConfigured, true);
});

test("unauthenticated health exposes the native matcher policy version", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.matcher.available, true);
  assert.ok(payload.matcher.policyVersion);
});
