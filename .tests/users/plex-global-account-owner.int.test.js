import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "plex-global-account-owner",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let aurral;
let adminAToken;
let adminBToken;
let adminAId;
let adminBId;

async function apiFetch(token, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${aurral.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function login(username) {
  const res = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  const adminA = userOps.createUser("admin-a", bcrypt.hashSync("password123", 4), "admin");
  const adminB = userOps.createUser("admin-b", bcrypt.hashSync("password123", 4), "admin");
  adminAId = adminA.id;
  adminBId = adminB.id;

  aurral = await startServerProcess();
  adminAToken = await login("admin-a");
  adminBToken = await login("admin-b");
});

test.after(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("connecting the global Plex account stamps configuredByUserId to the admin who connected it", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { url: "http://plex.local:32400", token: "token-a", clientId: "c-a" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminAId);

  const statusA = await apiFetch(adminAToken, "/api/users/me/plex-link/status");
  assert.equal(statusA.payload.isGlobalAccountOwner, true);

  const statusB = await apiFetch(adminBToken, "/api/users/me/plex-link/status");
  assert.equal(statusB.payload.isGlobalAccountOwner, false);
});

test("reconnecting with a different token reassigns configuredByUserId to the new admin", async () => {
  const saved = await apiFetch(adminBToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { url: "http://plex.local:32400", token: "token-b", clientId: "c-b" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);

  const statusA = await apiFetch(adminAToken, "/api/users/me/plex-link/status");
  assert.equal(statusA.payload.isGlobalAccountOwner, false);

  const statusB = await apiFetch(adminBToken, "/api/users/me/plex-link/status");
  assert.equal(statusB.payload.isGlobalAccountOwner, true);
});

test("changing an unrelated Plex field without changing the token does not reassign configuredByUserId", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: {
        plex: {
          url: "http://plex.local:32400",
          token: "token-b",
          clientId: "c-b",
          mainLibrarySectionId: "5",
        },
      },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integrations.plex.mainLibrarySectionId, "5");
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);
});

test("a partial Plex update that omits the token does not wipe the saved token or owner", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { mainLibrarySectionId: "9" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integrations.plex.mainLibrarySectionId, "9");
  assert.equal(saved.payload.integrations.plex.token, "token-b");
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);
});
