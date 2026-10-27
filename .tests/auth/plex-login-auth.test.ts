import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { signedInAs } from "../helpers/honoApp.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps, userIdentityOps }, plexModule, { api }] =
  await setupIsolatedBackend(
    "plex-login-auth",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/plex.ts"),
    () => import("../../backend/routes/api.ts"),
  );

const { PlexClient } = plexModule;
const app = signedInAs(undefined).route("/", api);

async function startPlexLogin() {
  const response = await app.request("/auth/plex/login/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  return String(response.headers.get("set-cookie")).split(";", 1)[0];
}

async function completePlexLogin(headers: Record<string, string>) {
  const response = await app.request("/auth/plex/login/complete", { method: "POST", headers });
  return { response, body: await response.json() };
}

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      plex: {
        loginEnabled: true,
        url: "http://plex.example.com:32400",
        token: "configured-token",
      },
    },
  });
});

afterAll(async () => cleanupIsolatedState(isolatedState));

test("transient Plex validation failures retain the login transaction for retry", async () => {
  const user = userOps.createUser("plex-retry-user", "unused", "user");
  assert.ok(user != null);
  userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "retry-subject",
  });
  vi.spyOn(PlexClient, "generateClientId").mockImplementation(
    () => "00000000-0000-0000-0000-000000000001",
  );
  vi.spyOn(PlexClient, "generatePin").mockImplementation(async () => ({
    id: 10,
    code: "retry-code",
  }));
  vi.spyOn(PlexClient, "buildAuthUrl").mockImplementation(() => "https://plex.example/auth");
  vi.spyOn(PlexClient, "checkPin").mockImplementation(async () => "authorized-token");
  let validations = 0;
  vi.spyOn(PlexClient, "validateToken").mockImplementation(async () => {
    validations += 1;
    if (validations === 1) {
      throw Object.assign(new Error("temporary outage"), { response: { status: 503 } });
    }
    return { id: "retry-subject", username: "plex-retry-user" };
  });

  const cookie = await startPlexLogin();

  const first = await completePlexLogin({ cookie });
  assert.equal(first.response.status, 503);
  assert.equal(first.body?.retryable, true);
  assert.equal(first.response.headers.get("set-cookie"), null);

  const retry = await completePlexLogin({ cookie, "user-agent": "test-agent" });
  assert.equal(retry.response.status, 200);
  assert.ok(retry.body?.token);
  assert.equal(validations, 2);
});

test("definitive Plex validation failures consume the login transaction", async () => {
  vi.spyOn(PlexClient, "generateClientId").mockImplementation(
    () => "00000000-0000-0000-0000-000000000002",
  );
  vi.spyOn(PlexClient, "generatePin").mockImplementation(async () => ({
    id: 11,
    code: "invalid-code",
  }));
  vi.spyOn(PlexClient, "buildAuthUrl").mockImplementation(() => "https://plex.example/auth");
  vi.spyOn(PlexClient, "checkPin").mockImplementation(async () => "invalid-token");
  vi.spyOn(PlexClient, "validateToken").mockImplementation(async () => null);

  const cookie = await startPlexLogin();

  const invalid = await completePlexLogin({ cookie });
  assert.equal(invalid.response.status, 400);
  assert.match(String(invalid.response.headers.get("set-cookie")), /Max-Age=0/);

  const retry = await completePlexLogin({ cookie });
  assert.equal(retry.response.status, 400);
  assert.equal(retry.body?.error, "Plex login session expired");
});
