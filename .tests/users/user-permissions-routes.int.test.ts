import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }] = await setupIsolatedBackend(
  "user-permissions-routes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

let server: Awaited<ReturnType<typeof startServerProcess>> | null = null;

function baseUrl() {
  if (!server) throw new Error("Server is not running");
  return `http://127.0.0.1:${server.port}`;
}

async function login(username: string) {
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token as string;
}

async function apiFetch(token: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return response.status;
}

const createUser = (username: string, role: string = "user") =>
  userOps.createUser(username, bcrypt.hashSync("password123", 4), role);

const flowAccessStatus = (token: string) => apiFetch(token, "/api/playlists/status");

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
  assert.ok(member != null);
  const adminToken = await login("admin");

  const patchStatus = await apiFetch(adminToken, `/api/users/${member.id}`, {
    method: "PATCH",
    body: JSON.stringify({ permissions: { accessFlow: "false" } }),
  });
  assert.equal(patchStatus, 400);
  assert.equal(userOps.getUserById(member.id)?.permissions.accessFlow, false);
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
  assert.ok(member != null);
  db.prepare("UPDATE users SET permissions = ? WHERE id = ?").run(
    JSON.stringify({ accessFlow: "false" }),
    member.id,
  );

  assert.equal(userOps.getUserById(member.id)?.permissions.accessFlow, false);
  assert.equal(await flowAccessStatus(await login("member")), 403);
});
