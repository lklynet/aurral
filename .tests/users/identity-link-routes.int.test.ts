import { asAppError } from "../../lib/errors.ts";
import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { userOps, userIdentityOps, dbOps },
  { createSession },
  { plexConnectionStore },
] = await setupIsolatedBackend(
  "identity-link-routes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/session-helpers.ts"),
  () => import("../../backend/services/plex/plexConnectionStore.ts"),
);

let server: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};

async function login(username: string, password: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function apiFetch(token: string | null, path: string, options: RequestInit = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...Object.fromEntries(new Headers(options.headers)),
  };
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

function ageSessionByToken(token: string, ageMs: number) {
  db.prepare("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?").run(
    Date.now() - ageMs,
    token,
  );
}

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

test("GET /me/identities requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/identities");
  assert.equal(response.status, 401);
});

test("GET /me/identities lists only the caller's own linked identities", async () => {
  const userA = userOps.createUser("identity-user-a", bcrypt.hashSync("password123", 4), "user");
  assert.ok(userA != null);
  userOps.createUser("identity-user-b", bcrypt.hashSync("password123", 4), "user");
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

test("only administrators can read or rotate the instance API key", async () => {
  userOps.createUser("key-admin", bcrypt.hashSync("password123", 4), "admin");
  userOps.createUser("key-user", bcrypt.hashSync("password123", 4), "user");
  const adminToken = await login("key-admin", "password123");
  const userToken = await login("key-user", "password123");

  const { payload: before } = await apiFetch(adminToken, "/api/auth/api-key");
  assert.equal((await apiFetch(userToken, "/api/auth/api-key")).response.status, 403);
  assert.equal(
    (await apiFetch(userToken, "/api/auth/api-key/rotate", { method: "POST" })).response.status,
    403,
  );
  assert.deepEqual((await apiFetch(adminToken, "/api/auth/api-key")).payload, before);
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
  const user = userOps.createUser("stale-session-user", bcrypt.hashSync("password123", 4), "user");
  assert.ok(user != null);
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
  assert.ok(userA != null);
  userOps.createUser("other-user", bcrypt.hashSync("password123", 4), "user");
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
  assert.ok(legacy != null);
  assert.equal(userOps.getUserById(legacy.id)!.hasLocalPassword, false);

  await login("legacy-local-user", "password123");

  assert.equal(
    userOps.getUserById(legacy.id)!.hasLocalPassword,
    true,
    "logging in with a password proves one exists, which re-arms lockout and password-change checks",
  );
});

test("changing a password requires a recent auth, so a stale session cannot take the account over", async () => {
  userOps.createUser("stale-password-user", bcrypt.hashSync("password123", 4), "user");
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
  assert.ok(oidcOnlyUser != null);
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

test("removing Plex from connected accounts also clears its saved connection", async () => {
  const user = userOps.createUser("generic-plex-unlink", bcrypt.hashSync("password123", 4));
  assert.ok(user != null);
  const identity = userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "generic-plex-subject",
  });
  plexConnectionStore.saveConnection(user.id, {
    linkType: "self",
    token: "generic-plex-token",
    clientId: "generic-plex-client",
    plexAccountId: "generic-plex-subject",
  });
  const token = await login("generic-plex-unlink", "password123");

  const { response } = await apiFetch(token, `/api/users/me/identities/${identity.id}`, {
    method: "DELETE",
  });

  assert.equal(response.status, 200);
  assert.equal(userIdentityOps.getById(identity.id), null);
  assert.equal(plexConnectionStore.getConnection(user.id), null);
});

test("replacing a provider identity removes the former Plex subject", () => {
  const user = userOps.createUser("plex-replacement", bcrypt.hashSync("password123", 4));
  assert.ok(user != null);
  userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "former-subject",
  });

  userIdentityOps.replaceForUser(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "replacement-subject",
  });

  assert.equal(userIdentityOps.findByProvider("plex", "plex", "former-subject"), null);
  assert.equal(
    userIdentityOps.findByProvider("plex", "plex", "replacement-subject")?.userId,
    user.id,
  );
});

test("a conflicting Plex identity rolls back the connection and identity replacement", async () => {
  const { persistSelfPlexLink } = await import("../../backend/routes/users/plexLinkHandlers.ts");
  const owner = userOps.createUser("plex-conflict-owner", "unused", "user");
  assert.ok(owner != null);
  const contender = userOps.createUser("plex-conflict-contender", "unused", "user");
  assert.ok(contender != null);
  userIdentityOps.link(owner.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "claimed-subject",
  });
  const originalIdentity = userIdentityOps.link(contender.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "original-subject",
  });
  plexConnectionStore.saveConnection(contender.id, {
    linkType: "self",
    token: "original-token",
    clientId: "original-client",
    plexAccountId: "original-subject",
  });

  assert.throws(
    () =>
      persistSelfPlexLink(
        contender.id,
        {
          linkType: "self",
          token: "replacement-token",
          clientId: "replacement-client",
          plexAccountId: "claimed-subject",
        },
        {
          providerType: "plex",
          providerKey: "plex",
          subject: "claimed-subject",
        },
      ),
    (error) => String(asAppError(error)?.code || "").startsWith("SQLITE_CONSTRAINT"),
  );

  const connection = plexConnectionStore.getConnection(contender.id);
  assert.ok(connection != null);
  assert.equal(connection.token, "original-token");
  assert.equal(connection.clientId, "original-client");
  assert.equal(connection.plexAccountId, "original-subject");
  assert.equal(userIdentityOps.getById(originalIdentity.id)?.subject, "original-subject");
  assert.equal(userIdentityOps.findByProvider("plex", "plex", "claimed-subject")?.userId, owner.id);
});
