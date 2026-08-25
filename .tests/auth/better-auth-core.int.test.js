import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";
import {
  assertBetterAuthCoreSchema,
  readBetterAuthSessions,
  readBetterAuthUser,
  requestBetterAuth,
} from "../helpers/betterAuthFixtures.js";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "better-auth-core",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let server;

const password = "better-auth-password";

async function signUp(overrides = {}) {
  return requestBetterAuth(server, "/sign-up/email", {
    method: "POST",
    body: {
      email: "alice@example.com",
      name: "Alice Example",
      username: "alice",
      password,
      ...overrides,
    },
  });
}

async function signIn(email = "alice@example.com", secret = password) {
  return requestBetterAuth(server, "/sign-in/email", {
    method: "POST",
    body: { email, password: secret },
  });
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: false, integrations: {} });
  process.env.BETTER_AUTH_SECRET = "aurral-test-secret-for-better-auth";
  server = await startServerProcess();
});

test.after(async () => {
  await server?.stop();
  delete process.env.BETTER_AUTH_SECRET;
  await cleanupIsolatedState(isolatedState);
});

test("Better Auth core schema owns users, credentials, sessions, and username fields", async () => {
  assertBetterAuthCoreSchema(db);

  const result = await signUp();
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.ok(result.authToken);
  assert.deepEqual(
    {
      email: result.payload.user.email,
      name: result.payload.user.name,
      username: result.payload.user.username,
    },
    {
      email: "alice@example.com",
      name: "Alice Example",
      username: "alice",
    },
  );
  assert.equal(typeof result.payload.user.id, "string");

  const user = readBetterAuthUser(db, result.payload.user.id);
  assert.equal(Number.isInteger(user.id), true);
  assert.equal(user.email, "alice@example.com");
  assert.equal(user.name, "Alice Example");
  assert.equal(user.username, "alice");

  const account = db
    .prepare('SELECT * FROM "accounts" WHERE "user_id" = ?')
    .get(user.id);
  assert.equal(account.issuer, "local:credential");
  assert.equal(account.provider_id, "credential");
  assert.equal(String(account.account_id), String(user.id));
  assert.ok(account.password);

  const sessions = readBetterAuthSessions(db, user.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].user_id, user.id);
  assert.ok(sessions[0].token);
  assert.ok(new Date(sessions[0].expires_at).getTime() > Date.now());
});

test("Better Auth sign-up requires the documented email and name fields", async () => {
  const missingEmail = await signUp({ email: undefined, username: "missing-email" });
  assert.equal(missingEmail.response.ok, false);

  const missingName = await signUp({
    email: "missing-name@example.com",
    name: undefined,
    username: "missing-name",
  });
  assert.equal(missingName.response.ok, false);
});

test("Bearer sign-in, session lookup, sign-out, and expiry use Better Auth sessions", async () => {
  const created = await signUp({
    email: "sessions@example.com",
    name: "Session User",
    username: "sessions",
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  const userId = created.payload.user.id;

  const signedOut = await requestBetterAuth(server, "/sign-out", {
    method: "POST",
    token: created.authToken,
  });
  assert.equal(signedOut.response.status, 200, JSON.stringify(signedOut.payload));

  const signedIn = await signIn("sessions@example.com");
  assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.payload));
  assert.ok(signedIn.authToken);

  const current = await requestBetterAuth(server, "/get-session", {
    token: signedIn.authToken,
  });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.equal(current.payload.user.id, userId);
  assert.equal(current.payload.session.userId, userId);

  const activeSessions = readBetterAuthSessions(db, userId);
  assert.equal(activeSessions.length, 1);

  const loggedOut = await requestBetterAuth(server, "/sign-out", {
    method: "POST",
    token: signedIn.authToken,
  });
  assert.equal(loggedOut.response.status, 200, JSON.stringify(loggedOut.payload));

  const afterLogout = await requestBetterAuth(server, "/get-session", {
    token: signedIn.authToken,
  });
  assert.equal(afterLogout.response.status, 200);
  assert.equal(afterLogout.payload, null);
  assert.equal(readBetterAuthSessions(db, userId).length, 0);

  const expiryCandidate = await signUp({
    email: "expired@example.com",
    name: "Expired User",
    username: "expired",
  });
  const expiryUserId = expiryCandidate.payload.user.id;
  db.prepare('UPDATE "sessions" SET "expires_at" = ? WHERE "user_id" = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    expiryUserId,
  );

  const expired = await requestBetterAuth(server, "/get-session", {
    token: expiryCandidate.authToken,
  });
  assert.equal(expired.response.status, 200);
  assert.equal(expired.payload, null);
});

test("Better Auth bearer sessions persist across an Aurral restart", async () => {
  const created = await signUp({
    email: "restart@example.com",
    name: "Restart User",
    username: "restart",
  });
  const userId = created.payload.user.id;
  const token = created.authToken;
  await server.stop();
  server = await startServerProcess();

  const restored = await requestBetterAuth(server, "/get-session", { token });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.user.id, userId);
  assert.equal(restored.payload.session.userId, userId);
});
