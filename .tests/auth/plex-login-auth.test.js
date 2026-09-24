import test, { mock } from "node:test";
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
const { completePlexLogin, resetPlexLoginStateForTests, startPlexLogin } = plexLogin;

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

test.beforeEach(() => {
  resetDatabase(db);
  resetPlexLoginStateForTests();
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

test.after(async () => cleanupIsolatedState(isolatedState));

test("transient Plex validation failures retain the login transaction for retry", async (t) => {
  const user = userOps.createUser("plex-retry-user", "unused", "user");
  userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "retry-subject",
  });
  t.mock.method(PlexClient, "generateClientId", () => "retry-client");
  t.mock.method(PlexClient, "generatePin", async () => ({ id: 10, code: "retry-code" }));
  t.mock.method(PlexClient, "buildAuthUrl", () => "https://plex.example/auth");
  t.mock.method(PlexClient, "checkPin", async () => "authorized-token");
  let validations = 0;
  t.mock.method(PlexClient, "validateToken", async () => {
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

test("definitive Plex validation failures consume the login transaction", async (t) => {
  t.mock.method(PlexClient, "generateClientId", () => "invalid-client");
  t.mock.method(PlexClient, "generatePin", async () => ({ id: 11, code: "invalid-code" }));
  t.mock.method(PlexClient, "buildAuthUrl", () => "https://plex.example/auth");
  t.mock.method(PlexClient, "checkPin", async () => "invalid-token");
  t.mock.method(PlexClient, "validateToken", async () => null);

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
