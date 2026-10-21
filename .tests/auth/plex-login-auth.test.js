import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps, userIdentityOps }, plexModule, plexLogin] =
  await setupIsolatedBackend(
    "plex-login-auth",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/plex.js",
    "backend/services/plexLoginAuth.js",
  );

const { PlexClient } = plexModule;
const { completePlexLogin, startPlexLogin } = plexLogin;

const createResponse = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  append(name, value) {
    this.headers[name] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

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
  userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "retry-subject",
  });
  vi.spyOn(PlexClient, "generateClientId").mockImplementation(() => "retry-client");
  vi.spyOn(PlexClient, "generatePin").mockImplementation(async () => ({ id: 10, code: "retry-code" }));
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

  const startResponse = createResponse();
  await startPlexLogin({ body: {}, headers: {}, secure: false }, startResponse);
  const cookie = String(startResponse.headers["Set-Cookie"]).split(";", 1)[0];

  const firstResponse = createResponse();
  await completePlexLogin({ headers: { cookie }, ip: "127.0.0.1" }, firstResponse);
  assert.equal(firstResponse.statusCode, 503);
  assert.equal(firstResponse.body.retryable, true);
  assert.equal(firstResponse.headers["Set-Cookie"], undefined);

  const retryResponse = createResponse();
  await completePlexLogin(
    { headers: { cookie, "user-agent": "test-agent" }, ip: "127.0.0.1" },
    retryResponse,
  );
  assert.equal(retryResponse.statusCode, 200);
  assert.ok(retryResponse.body.token);
  assert.equal(validations, 2);
});

test("definitive Plex validation failures consume the login transaction", async () => {
  vi.spyOn(PlexClient, "generateClientId").mockImplementation(() => "invalid-client");
  vi.spyOn(PlexClient, "generatePin").mockImplementation(async () => ({ id: 11, code: "invalid-code" }));
  vi.spyOn(PlexClient, "buildAuthUrl").mockImplementation(() => "https://plex.example/auth");
  vi.spyOn(PlexClient, "checkPin").mockImplementation(async () => "invalid-token");
  vi.spyOn(PlexClient, "validateToken").mockImplementation(async () => null);

  const startResponse = createResponse();
  await startPlexLogin({ body: {}, headers: {}, secure: false }, startResponse);
  const cookie = String(startResponse.headers["Set-Cookie"]).split(";", 1)[0];

  const invalidResponse = createResponse();
  await completePlexLogin({ headers: { cookie } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(String(invalidResponse.headers["Set-Cookie"]), /Max-Age=0/);

  const retryResponse = createResponse();
  await completePlexLogin({ headers: { cookie } }, retryResponse);
  assert.equal(retryResponse.statusCode, 400);
  assert.equal(retryResponse.body.error, "Plex login session expired");
});
