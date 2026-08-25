import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";
import {
  assertBetterAuthCoreSchema,
  readBetterAuthAccount,
  readBetterAuthUser,
  seedBetterAuthUser,
} from "../helpers/betterAuthFixtures.js";

const [isolatedState, { db }, { dbOps }, authModule] = await setupIsolatedBackend(
  "better-auth-adapters",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/middleware/auth.js",
);

const {
  getApiKey,
  getLocalNetworkBypassStatus,
  hasPermission,
  isRequestFromTrustedLocalSubnet,
  issueProxySession,
  issueStreamToken,
  resolveLocalNetworkBypassUser,
  resolveProxyUser,
  resolveRequestUser,
  resolveSessionUserFromToken,
  resolveSubsonicTokenUser,
  verifyTokenAuth,
  rotateApiKey,
} = authModule;

const password = "adapter-password";

function proxyRequest(headers = {}, remoteAddress = "127.0.0.1") {
  return {
    headers,
    query: {},
    socket: { remoteAddress },
    connection: { remoteAddress },
    ip: remoteAddress,
    ips: [remoteAddress],
  };
}

function resetAdapterEnv() {
  for (const key of [
    "AUTH_PROXY_ENABLED",
    "AUTH_PROXY_HEADER",
    "AUTH_PROXY_TRUSTED_IPS",
    "AUTH_PROXY_DEFAULT_ROLE",
    "AUTH_PROXY_ADMIN_USERS",
    "AUTH_PROXY_ROLE_HEADER",
    "AUTH_PROXY_ADMIN_GROUPS",
    "AUTH_USER",
    "AUTH_PASSWORD",
  ]) {
    delete process.env[key];
  }
}

test.beforeEach(() => {
  resetDatabase(db);
  resetAdapterEnv();
  dbOps.updateSettings({ onboardingComplete: true, integrations: {}, security: {} });
  assertBetterAuthCoreSchema(db);
});

test.after(async () => {
  resetAdapterEnv();
  await cleanupIsolatedState(isolatedState);
});

test("proxy identity provisioning is a Better Auth user with Aurral role and permission mapping", () => {
  process.env.AUTH_PROXY_ENABLED = "true";
  process.env.AUTH_PROXY_ADMIN_USERS = "sso-admin";

  const resolved = resolveProxyUser(proxyRequest({ "x-forwarded-user": "sso-admin" }));
  assert.ok(resolved);
  assert.equal(resolved.role, "admin");
  assert.equal(resolved.permissions.accessSettings, true);

  const user = readBetterAuthUser(db, resolved.id);
  assert.match(user.email, /^proxy-[a-f0-9]+@aurral\.invalid$/);
  assert.equal(user.name, "sso-admin");
  assert.equal(user.role, "admin");
  assert.equal(resolveProxyUser(proxyRequest({ "x-forwarded-user": "sso-admin" })).id, resolved.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "users"').get().count, 1);
});

test("proxy identity headers are trusted only from configured addresses and sessions survive header removal", async () => {
  process.env.AUTH_PROXY_ENABLED = "true";
  process.env.AUTH_PROXY_TRUSTED_IPS = "10.0.0.1";
  assert.equal(resolveProxyUser(proxyRequest({ "x-forwarded-user": "mallory" })), null);

  delete process.env.AUTH_PROXY_TRUSTED_IPS;
  const issued = await issueProxySession(proxyRequest({ "x-forwarded-user": "erin" }));
  assert.ok(issued?.token);
  const user = await resolveSessionUserFromToken(issued.token);
  assert.equal(user?.username, "erin");
  assert.match(readBetterAuthUser(db, user.id).email, /^proxy-[a-f0-9]+@aurral\.invalid$/);
});

test("LAN bypass resolves the sole Better Auth admin and stays ineligible for multiple users", () => {
  seedBetterAuthUser(db, {
    id: 41,
    email: "admin@example.com",
    name: "Admin",
    username: "admin",
    password: bcrypt.hashSync(password, 4),
    role: "admin",
  });
  dbOps.updateSettings({
    onboardingComplete: true,
    security: { localNetworkBypass: { enabled: true } },
  });

  const request = proxyRequest();
  assert.equal(isRequestFromTrustedLocalSubnet(request), true);
  const status = getLocalNetworkBypassStatus(request);
  assert.equal(status.active, status.eligible);
  if (status.active) assert.equal(resolveLocalNetworkBypassUser(request).id, 41);

  seedBetterAuthUser(db, {
    id: 42,
    email: "second@example.com",
    name: "Second",
    username: "second",
    password: bcrypt.hashSync(password, 4),
  });
  assert.equal(getLocalNetworkBypassStatus(request).reason, "not_single_user");
  assert.equal(resolveLocalNetworkBypassUser(request), null);
});

test("instance API keys remain a separate admin adapter and rotation invalidates the old key", () => {
  const first = getApiKey();
  assert.match(first, /^[a-f0-9]{64}$/);
  const firstUser = resolveRequestUser({ headers: { "x-api-key": first }, query: {} });
  assert.equal(firstUser.role, "admin");
  assert.equal(hasPermission(firstUser, "accessSettings"), true);

  const second = rotateApiKey();
  assert.notEqual(second, first);
  assert.equal(resolveRequestUser({ headers: { "x-api-key": first }, query: {} }), null);
  assert.equal(resolveRequestUser({ headers: { "x-api-key": second }, query: {} }).role, "admin");
});

test("Subsonic MD5 tokens use the protocol-specific shared secret", async () => {
  const credentialHash = bcrypt.hashSync(password, 4);
  seedBetterAuthUser(db, {
    id: 51,
    email: "subsonic@example.com",
    name: "Subsonic User",
    username: "subsonic",
    password: credentialHash,
  });
  const salt = "test-salt";
  process.env.AUTH_USER = "subsonic";
  process.env.AUTH_PASSWORD = password;
  const token = createHash("md5").update(`${password}${salt}`).digest("hex");

  const user = await resolveSubsonicTokenUser("subsonic", token, salt);
  assert.equal(user?.id, 51);
  assert.equal(user?.username, "subsonic");
  assert.match(readBetterAuthAccount(db, 51)[0].password, /^scrypt\$/);
});

test("media stream tokens remain short-lived Aurral adapter credentials", () => {
  seedBetterAuthUser(db, {
    id: 61,
    email: "media@example.com",
    name: "Media User",
    username: "media-user",
    password: bcrypt.hashSync(password, 4),
  });
  const user = {
    id: 61,
    username: "media-user",
    role: "user",
    permissions: { addArtist: true },
  };
  const token = issueStreamToken(user, 1000);
  const request = { query: { st: token }, headers: {} };
  assert.equal(verifyTokenAuth(request), true);
  assert.equal(request.user.id, user.id);
  assert.equal(request.user.username, user.username);

  const now = Date.now();
  const clock = mock.method(Date, "now", () => now + 2000);
  try {
    const expiredRequest = { query: { st: token }, headers: {} };
    assert.equal(verifyTokenAuth(expiredRequest), false);
  } finally {
    clock.mock.restore();
  }
});

test("Aurral permissions remain an adapter over Better Auth role fields", () => {
  assert.equal(hasPermission({ role: "admin", permissions: {} }, "deleteTrack"), true);
  assert.equal(hasPermission({ role: "user", permissions: { addArtist: true } }, "addArtist"), true);
  assert.equal(hasPermission({ role: "user", permissions: { addArtist: false } }, "addArtist"), false);
  assert.equal(hasPermission(null, "addArtist"), false);
});
