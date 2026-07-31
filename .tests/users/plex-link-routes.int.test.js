import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, dbOps }, { plexConnectionStore }] =
  await setupIsolatedBackend(
    "plex-link-routes",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/plex/plexConnectionStore.js",
  );

let server = null;
let adminId = null;
let userAId = null;
let userBId = null;
let adminToken = "";
let userAToken = "";
let userBToken = "";

async function login(username, password) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function apiFetch(token, path, options = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  const admin = userOps.createUser("plex-admin", bcrypt.hashSync("password123", 4), "admin");
  const userA = userOps.createUser("plex-user-a", bcrypt.hashSync("password123", 4), "user");
  const userB = userOps.createUser("plex-user-b", bcrypt.hashSync("password123", 4), "user");
  adminId = admin.id;
  userAId = userA.id;
  userBId = userB.id;

  server = await startServerProcess();
  adminToken = await login("plex-admin", "password123");
  userAToken = await login("plex-user-a", "password123");
  userBToken = await login("plex-user-b", "password123");
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("GET /me/plex-link/status requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/plex-link/status");
  assert.equal(response.status, 401);
});

test("GET /me/plex-link/status reflects only the caller's own connection", async () => {
  plexConnectionStore.saveConnection(userAId, {
    linkType: "self",
    token: "user-a-token",
    clientId: "user-a-client",
    plexAccountId: 111,
    plexUsername: "friendA",
  });

  const { response: resA, payload: payloadA } = await apiFetch(
    userAToken,
    "/api/users/me/plex-link/status",
  );
  assert.equal(resA.status, 200);
  assert.equal(payloadA.connected, true);
  assert.equal(payloadA.plexUsername, "friendA");

  const { response: resB, payload: payloadB } = await apiFetch(
    userBToken,
    "/api/users/me/plex-link/status",
  );
  assert.equal(resB.status, 200);
  assert.equal(payloadB.connected, false);
});

test("DELETE /me/plex-link only ever clears the caller's own connection, never another user's", async () => {
  plexConnectionStore.saveConnection(userAId, {
    linkType: "self",
    token: "user-a-token",
    clientId: "user-a-client",
    plexAccountId: 111,
    plexUsername: "friendA",
  });

  const { response } = await apiFetch(userBToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(response.status, 200);

  assert.equal(plexConnectionStore.getConnection(userAId)?.plexUsername, "friendA");

  const { response: responseA } = await apiFetch(userAToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(responseA.status, 200);
  assert.equal(plexConnectionStore.getConnection(userAId), null);
});

test("POST /me/plex-link/oauth/complete validates required fields before touching Plex, and ignores any userId in the body", async () => {
  const { response, payload } = await apiFetch(
    userBToken,
    "/api/users/me/plex-link/oauth/complete",
    {
      method: "POST",
      body: JSON.stringify({ userId: userAId }),
    },
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /pinId, code and clientId are required/);
  assert.equal(plexConnectionStore.getConnection(userAId), null);
  assert.equal(plexConnectionStore.getConnection(userBId), null);
});

test("admin-only Plex routes reject non-admin users with 403", async () => {
  const homeUsers = await apiFetch(userAToken, "/api/users/plex-link/home-users");
  assert.equal(homeUsers.response.status, 403);

  const managed = await apiFetch(userAToken, `/api/users/${userBId}/plex-link/managed`, {
    method: "POST",
    body: JSON.stringify({ plexUserId: 1 }),
  });
  assert.equal(managed.response.status, 403);

  const unlink = await apiFetch(userAToken, `/api/users/${userBId}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(unlink.response.status, 403);
});

test("GET /plex-link/home-users requires the global Plex connection to be configured first", async () => {
  const { response, payload } = await apiFetch(adminToken, "/api/users/plex-link/home-users");
  assert.equal(response.status, 400);
  assert.match(payload.error, /Connect the global Plex account/);
});

test("POST /:id/plex-link/managed 404s for an unknown user id", async () => {
  const { response } = await apiFetch(adminToken, "/api/users/999999/plex-link/managed", {
    method: "POST",
    body: JSON.stringify({ plexUserId: 1 }),
  });
  assert.equal(response.status, 404);
});

test("POST /:id/plex-link/managed requires the global Plex connection to be configured first", async () => {
  const { response, payload } = await apiFetch(
    adminToken,
    `/api/users/${userBId}/plex-link/managed`,
    {
      method: "POST",
      body: JSON.stringify({ plexUserId: 1 }),
    },
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /Connect the global Plex account/);
});

test("admin DELETE /:id/plex-link unlinks a managed user", async () => {
  plexConnectionStore.saveConnection(userBId, {
    linkType: "managed",
    token: "managed-token",
    clientId: "managed-client",
    plexAccountId: 222,
    linkedByAdminId: adminId,
  });
  const { response } = await apiFetch(adminToken, `/api/users/${userBId}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal(plexConnectionStore.getConnection(userBId), null);
});
