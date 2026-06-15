import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  cleanupIsolatedState,
  prepareIntegrationTestServer,
  ensureServerProcess,
  buildApiUrl,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("auth-api");

let server = null;
let authToken = "";

async function loginAsAdmin() {
  const response = await fetch(buildApiUrl(server.port, "/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "password123",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.token);
  return payload.token;
}

test.before(async () => {
  server = await prepareIntegrationTestServer(isolatedState, {
    admin: true,
    onboardingComplete: true,
  });
});

test.beforeEach(async () => {
  server = await ensureServerProcess(server);
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("protected API routes return AUTH_REQUIRED without a Basic Auth challenge", async () => {
  const response = await fetch(buildApiUrl(server.port, "/api/settings"));
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "AUTH_REQUIRED");
  assert.equal(payload.message, "Authentication required");
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("login, session-backed me, and logout all work together", async () => {
  authToken = await loginAsAdmin();
  const loginPayload = { token: authToken, user: { username: "admin" } };
  authToken = loginPayload.token;

  const meResponse = await fetch(buildApiUrl(server.port, "/api/auth/me"), {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });
  const mePayload = await meResponse.json();

  assert.equal(meResponse.status, 200);
  assert.equal(mePayload.user.username, "admin");
  assert.equal(mePayload.user.role, "admin");

  const logoutResponse = await fetch(
    buildApiUrl(server.port, "/api/auth/logout"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
  );
  const logoutPayload = await logoutResponse.json();

  assert.equal(logoutResponse.status, 200);
  assert.equal(logoutPayload.success, true);
});

test("invalid bearer sessions return SESSION_INVALID without triggering browser basic auth", async () => {
  const response = await fetch(buildApiUrl(server.port, "/api/settings"), {
    headers: {
      Authorization: "Bearer not-a-real-session",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "SESSION_INVALID");
  assert.match(payload.message, /Session expired or invalid/);
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("weekly flow worker settings reject concurrency above 3 and accept 3", async () => {
  const settingsToken = await loginAsAdmin();
  const rejectResponse = await fetch(
    buildApiUrl(server.port, "/api/weekly-flow/worker/settings"),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settingsToken}`,
      },
      body: JSON.stringify({ concurrency: 4 }),
    },
  );
  const rejectPayload = await rejectResponse.json();

  assert.equal(rejectResponse.status, 400);
  assert.match(rejectPayload.error, /between 1 and 3/);

  const acceptResponse = await fetch(
    buildApiUrl(server.port, "/api/weekly-flow/worker/settings"),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settingsToken}`,
      },
      body: JSON.stringify({ concurrency: 3 }),
    },
  );
  const acceptPayload = await acceptResponse.json();

  assert.equal(acceptResponse.status, 200);
  assert.equal(acceptPayload.success, true);
  assert.equal(acceptPayload.settings.concurrency, 3);
});

test("weekly flow worker settings default to concurrency 2", async () => {
  await server?.stop();
  server = await prepareIntegrationTestServer(isolatedState, {
    admin: true,
    onboardingComplete: true,
  });
  const settingsToken = await loginAsAdmin();
  const response = await fetch(
    buildApiUrl(server.port, "/api/weekly-flow/worker/settings"),
    {
      headers: {
        Authorization: `Bearer ${settingsToken}`,
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.concurrency, 2);
});
