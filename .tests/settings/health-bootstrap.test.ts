import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }, { createSession }, { api }] =
  await setupIsolatedBackend(
    "health-bootstrap",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/config/session-helpers.ts"),
    () => import("../../backend/routes/api.ts"),
  );

const app = signedInAs(undefined).route("/", api);

async function bootstrapAsUser() {
  const user = userOps.createUser("owner", "test-password-hash", "admin");
  assert.ok(user != null);
  const { token } = createSession(Number(user.id));
  const response = await app.request("/health/bootstrap", {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json();
}

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
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
  const response = await app.request("/health");
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.matcher.available, true);
  assert.ok(payload.matcher.policyVersion);
});

test("bootstrap reports the same API contract before and after sign-in", async () => {
  dbOps.updateSettings({ onboardingComplete: true, integrations: {} });
  const response = await app.request("/health/bootstrap");
  assert.equal(response.status, 200);
  const signedOut = await response.json();
  assert.ok(Number.isSafeInteger(signedOut.api?.version));
  assert.ok(signedOut.api.version > 0);
  assert.ok(Array.isArray(signedOut.api.features));
  assert.ok(
    signedOut.api.features.every(
      (feature: unknown) => typeof feature === "string" && feature.length > 0,
    ),
  );
  assert.equal(new Set(signedOut.api.features).size, signedOut.api.features.length);
  assert.equal(signedOut.user, undefined);
  const signedIn = await bootstrapAsUser();
  assert.equal(signedIn.user.username, "owner");
  assert.deepEqual(signedIn.api, signedOut.api);
});
