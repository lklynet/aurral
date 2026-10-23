import { createAuthRequest, createAuthResponse } from "./authFixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps, userIdentityOps }, plexModule, plexLogin] =
  await setupIsolatedBackend(
    "plex-login-auth",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/plex.ts"),
    () => import("../../backend/services/plexLoginAuth.ts"),
  );

const { PlexClient } = plexModule;
const { completePlexLogin, startPlexLogin } = plexLogin;

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

  const startResponse = createAuthResponse();
  await startPlexLogin(createAuthRequest({ body: {}, headers: {}, secure: false }), startResponse);
  const cookie = String(startResponse.headers["Set-Cookie"]).split(";", 1)[0];

  const firstResponse = createAuthResponse();
  await completePlexLogin(
    createAuthRequest({ headers: { cookie }, ip: "127.0.0.1" }),
    firstResponse,
  );
  assert.equal(firstResponse.statusCode, 503);
  assert.equal(firstResponse.body?.retryable, true);
  assert.equal(firstResponse.headers["Set-Cookie"], undefined);

  const retryResponse = createAuthResponse();
  await completePlexLogin(
    createAuthRequest({ headers: { cookie, "user-agent": "test-agent" }, ip: "127.0.0.1" }),
    retryResponse,
  );
  assert.equal(retryResponse.statusCode, 200);
  assert.ok(retryResponse.body?.token);
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

  const startResponse = createAuthResponse();
  await startPlexLogin(createAuthRequest({ body: {}, headers: {}, secure: false }), startResponse);
  const cookie = String(startResponse.headers["Set-Cookie"]).split(";", 1)[0];

  const invalidResponse = createAuthResponse();
  await completePlexLogin(createAuthRequest({ headers: { cookie } }), invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(String(invalidResponse.headers["Set-Cookie"]), /Max-Age=0/);

  const retryResponse = createAuthResponse();
  await completePlexLogin(createAuthRequest({ headers: { cookie } }), retryResponse);
  assert.equal(retryResponse.statusCode, 400);
  assert.equal(retryResponse.body?.error, "Plex login session expired");
});
