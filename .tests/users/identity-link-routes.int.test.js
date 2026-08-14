import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, userIdentityOps, dbOps }, { createSession }] =
  await setupIsolatedBackend(
    "identity-link-routes",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/config/session-helpers.js",
  );

let server = null;

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

function ageSessionByToken(token, ageMs) {
  db.prepare("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?").run(
    Date.now() - ageMs,
    token,
  );
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  server = await startServerProcess();
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test("GET /me/identities requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/identities");
  assert.equal(response.status, 401);
});

test("GET /me/identities lists only the caller's own linked identities", async () => {
  const userA = userOps.createUser("identity-user-a", bcrypt.hashSync("password123", 4), "user");
  const userB = userOps.createUser("identity-user-b", bcrypt.hashSync("password123", 4), "user");
  userIdentityOps.link(userA.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-a",
    displayName: "a@example.com",
  });

  const tokenA = await login("identity-user-a", "password123");
  const tokenB = await login("identity-user-b", "password123");

  const { response: resA, payload: payloadA } = await apiFetch(tokenA, "/api/users/me/identities");
  assert.equal(resA.status, 200);
  assert.equal(payloadA.hasLocalPassword, true);
  assert.equal(payloadA.identities.length, 1);
  assert.equal(payloadA.identities[0].providerType, "oidc");

  const { payload: payloadB } = await apiFetch(tokenB, "/api/users/me/identities");
  assert.equal(payloadB.identities.length, 0);
});

test("reauth accepts the correct password and rejects an incorrect one", async () => {
  userOps.createUser("reauth-user", bcrypt.hashSync("password123", 4), "user");
  const token = await login("reauth-user", "password123");

  const { response: badResponse } = await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "wrong-password" }),
  });
  assert.equal(badResponse.status, 400);

  const { response: goodResponse, payload } = await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });
  assert.equal(goodResponse.status, 200);
  assert.equal(payload.success, true);
});

test("unlinking an identity requires a recent reauth and succeeds after confirming it", async () => {
  const user = userOps.createUser(
    "stale-session-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  const identity = userIdentityOps.link(user.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-stale",
  });
  const token = await login("stale-session-user", "password123");

  ageSessionByToken(token, 20 * 60 * 1000);
  const { response: staleResponse } = await apiFetch(
    token,
    `/api/users/me/identities/${identity.id}`,
    { method: "DELETE" },
  );
  assert.equal(staleResponse.status, 401);

  await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });

  const { response: freshResponse, payload } = await apiFetch(
    token,
    `/api/users/me/identities/${identity.id}`,
    { method: "DELETE" },
  );
  assert.equal(freshResponse.status, 200);
  assert.equal(payload.success, true);
  assert.equal(userIdentityOps.countForUser(user.id), 0);
});

test("unlinking a nonexistent or another user's identity 404s", async () => {
  const userA = userOps.createUser("owner-user", bcrypt.hashSync("password123", 4), "user");
  const userB = userOps.createUser("other-user", bcrypt.hashSync("password123", 4), "user");
  const identity = userIdentityOps.link(userA.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-owner",
  });
  const tokenB = await login("other-user", "password123");

  const { response } = await apiFetch(tokenB, `/api/users/me/identities/${identity.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 404);
  assert.equal(userIdentityOps.countForUser(userA.id), 1);
});

test("a successful local login records that the account has a usable local password", async () => {
  const legacy = userOps.createUser(
    "legacy-local-user",
    bcrypt.hashSync("password123", 4),
    "user",
    null,
    false,
  );
  assert.equal(userOps.getUserById(legacy.id).hasLocalPassword, false);

  await login("legacy-local-user", "password123");

  assert.equal(
    userOps.getUserById(legacy.id).hasLocalPassword,
    true,
    "logging in with a password proves one exists, which re-arms lockout and password-change checks",
  );
});

test("changing a password requires a recent auth, so a stale session cannot take the account over", async () => {
  const user = userOps.createUser(
    "stale-password-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  const token = await login("stale-password-user", "password123");

  ageSessionByToken(token, 20 * 60 * 1000);
  const { response: staleResponse } = await apiFetch(token, "/api/users/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123", newPassword: "brand-new-password" }),
  });
  assert.equal(staleResponse.status, 401);

  await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });

  const { response: freshResponse } = await apiFetch(token, "/api/users/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123", newPassword: "brand-new-password" }),
  });
  assert.equal(freshResponse.status, 200);
});

test("lockout protection blocks removing the last usable auth method", async () => {
  const passwordHash = bcrypt.hashSync("unused-random-hash", 4);
  const oidcOnlyUser = userOps.createUser("oidc-only-user", passwordHash, "user", null, false);
  const identity = userIdentityOps.link(oidcOnlyUser.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-only",
  });

  const session = createSession(oidcOnlyUser.id, "127.0.0.1", "test-agent");

  const { response } = await apiFetch(session.token, `/api/users/me/identities/${identity.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 400);
  assert.equal(userIdentityOps.countForUser(oidcOnlyUser.id), 1);
});
