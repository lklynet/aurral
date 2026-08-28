import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import {
  assertBetterAuthCoreSchema,
  readBetterAuthSessions,
  readBetterAuthUser,
} from "../helpers/betterAuthFixtures.js";

const [isolatedState, { db }, dbHelpers, authModule] = await setupIsolatedBackend(
  "proxy-auth",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/middleware/auth.js",
);

const { dbOps } = dbHelpers;
const { issueProxySession, resolveProxyUser, resolveRequestUser } = authModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

function proxyRequest(headers = {}, remoteAddress = "127.0.0.1") {
  return {
    headers,
    socket: { remoteAddress },
    connection: { remoteAddress },
    ip: remoteAddress,
    ips: [remoteAddress],
  };
}

function resetProxyEnv() {
  process.env.AUTH_PROXY_ENABLED = "true";
  delete process.env.AUTH_PROXY_HEADER;
  delete process.env.AUTH_PROXY_TRUSTED_IPS;
  delete process.env.AUTH_PROXY_DEFAULT_ROLE;
  delete process.env.AUTH_PROXY_ADMIN_USERS;
  delete process.env.AUTH_PROXY_ROLE_HEADER;
  delete process.env.AUTH_PROXY_ADMIN_GROUPS;
}

test.beforeEach(() => {
  resetDatabase(db);
  resetProxyEnv();
  dbOps.updateSettings({ onboardingComplete: false });
  assertBetterAuthCoreSchema(db);
});

test.after(async () => {
  delete process.env.AUTH_PROXY_ENABLED;
  delete process.env.AUTH_PROXY_HEADER;
  delete process.env.AUTH_PROXY_TRUSTED_IPS;
  delete process.env.AUTH_PROXY_DEFAULT_ROLE;
  delete process.env.AUTH_PROXY_ADMIN_USERS;
  delete process.env.AUTH_PROXY_ROLE_HEADER;
  delete process.env.AUTH_PROXY_ADMIN_GROUPS;
  await cleanupIsolatedState(isolatedState);
});

test("proxy auth creates a persistent user for a new proxied identity", () => {
  const resolved = resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "Alice@example.com" }),
  );

  assert.ok(resolved);
  assert.notEqual(resolved.id, -1);
  assert.equal(resolved.username, "alice@example.com");
  assert.equal(resolved.role, "user");
  assert.equal(resolved.permissions.addArtist, true);
  assert.equal(resolved.permissions.accessFlow, false);
  assert.equal(resolved.permissions.accessSettings, false);

  const stored = readBetterAuthUser(db, resolved.id);
  assert.equal(stored?.id, resolved.id);
  assert.equal(stored?.email, "alice@example.com");
  assert.equal(stored?.name, "alice@example.com");

  const secondResolve = resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "alice@example.com" }),
  );
  assert.equal(secondResolve?.id, resolved.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "users"').get().count, 1);
});

test("proxy auth creates configured admin users as admins", () => {
  process.env.AUTH_PROXY_ADMIN_USERS = "sso-admin";

  const resolved = resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "sso-admin" }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "admin");
  assert.equal(resolved.permissions.accessSettings, true);
  assert.equal(readBetterAuthUser(db, resolved.id)?.role, "admin");
});

test("proxy auth does not create users from untrusted proxy IPs", () => {
  process.env.AUTH_PROXY_TRUSTED_IPS = "10.0.0.1";

  const resolved = resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "mallory" }, "192.168.1.10"),
  );

  assert.equal(resolved, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "users"').get().count, 0);
});

test("proxy auth grants admin via AUTH_PROXY_ADMIN_GROUPS membership", () => {
  process.env.AUTH_PROXY_ROLE_HEADER = "remote-groups";
  process.env.AUTH_PROXY_ADMIN_GROUPS = "app-arrstack-admin";

  const resolved = resolveProxyUser(
    proxyRequest({
      "x-forwarded-user": "bob",
      "remote-groups": "app-arrstack-admin,users",
    }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "admin");
  assert.equal(readBetterAuthUser(db, resolved.id)?.role, "admin");
});

test("proxy auth does not grant admin for a literal 'admin' group unless configured", () => {
  process.env.AUTH_PROXY_ROLE_HEADER = "remote-groups";

  const resolved = resolveProxyUser(
    proxyRequest({
      "x-forwarded-user": "carol",
      "remote-groups": "admin",
    }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "user");
});

test("proxy auth issues one Aurral session that outlives the identity header", async () => {
  completeOnboarding();
  const issued = await issueProxySession(proxyRequest({ "x-forwarded-user": "erin" }));

  assert.ok(issued?.token);
  const issuedUser = resolveRequestUser(proxyRequest({ "x-forwarded-user": "erin" }));
  assert.ok(issuedUser?.id);
  assert.equal(readBetterAuthSessions(db, issuedUser.id).length, 1);

  const headerlessUser = await authModule.resolveSessionUserFromToken(issued.token);
  assert.equal(headerlessUser?.username, "erin");

  assert.equal(
    await issueProxySession(
      proxyRequest({
        "x-forwarded-user": "erin",
        authorization: `Bearer ${issued.token}`,
      }),
    ),
    null,
  );
});

test("proxy auth issues no session without a trusted identity header", async () => {
  completeOnboarding();
  assert.equal(await issueProxySession(proxyRequest()), null);

  process.env.AUTH_PROXY_TRUSTED_IPS = "10.0.0.1";
  assert.equal(
    await issueProxySession(proxyRequest({ "x-forwarded-user": "mallory" }, "192.168.1.10")),
    null,
  );
});

test("proxy auth issues no session while onboarding leaves authentication off", async () => {
  assert.equal(await issueProxySession(proxyRequest({ "x-forwarded-user": "frank" })), null);

  completeOnboarding();
  assert.ok((await issueProxySession(proxyRequest({ "x-forwarded-user": "frank" })))?.token);
});

test("proxy auth re-syncs role on every request instead of only at creation", () => {
  const created = resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(created.role, "user");

  process.env.AUTH_PROXY_ADMIN_USERS = "dave";
  const promoted = resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(promoted.role, "admin");
  assert.equal(readBetterAuthUser(db, promoted.id)?.role, "admin");

  delete process.env.AUTH_PROXY_ADMIN_USERS;
  const demoted = resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(demoted.role, "user");
  assert.equal(readBetterAuthUser(db, demoted.id)?.role, "user");
});
