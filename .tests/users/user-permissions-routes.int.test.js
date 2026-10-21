import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, dbOps }] = await setupIsolatedBackend(
  "user-permissions-routes",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let server = null;

async function login(username) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function apiFetch(token, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return response.status;
}

const createUser = (username, role = "user") =>
  userOps.createUser(username, bcrypt.hashSync("password123", 4), role);

const flowAccessStatus = (token) => apiFetch(token, "/api/playlists/no-such-route");

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  server = await startServerProcess();
});

afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test("admins cannot store permission values other than true or false", async () => {
  createUser("admin", "admin");
  const member = createUser("member");
  const adminToken = await login("admin");

  const patchStatus = await apiFetch(adminToken, `/api/users/${member.id}`, {
    method: "PATCH",
    body: JSON.stringify({ permissions: { accessFlow: "false" } }),
  });
  assert.equal(patchStatus, 400);
  assert.equal(userOps.getUserById(member.id).permissions.accessFlow, false);
  assert.equal(await flowAccessStatus(await login("member")), 403);

  const createStatus = await apiFetch(adminToken, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: "newcomer",
      password: "password123",
      permissions: { accessFlow: "yes" },
    }),
  });
  assert.equal(createStatus, 400);
  assert.equal(userOps.getUserByUsername("newcomer"), null);

  const grantStatus = await apiFetch(adminToken, `/api/users/${member.id}`, {
    method: "PATCH",
    body: JSON.stringify({ permissions: { accessFlow: true } }),
  });
  assert.equal(grantStatus, 200);
  assert.notEqual(await flowAccessStatus(await login("member")), 403);
});

test("a permission already stored as a string does not grant access", async () => {
  const member = createUser("member");
  db.prepare("UPDATE users SET permissions = ? WHERE id = ?").run(
    JSON.stringify({ accessFlow: "false" }),
    member.id,
  );

  assert.equal(userOps.getUserById(member.id).permissions.accessFlow, false);
  assert.equal(await flowAccessStatus(await login("member")), 403);
});
