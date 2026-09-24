import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, dbOps }, { createSession }, auth, permissions] =
  await setupIsolatedBackend(
    "recent-auth",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/config/session-helpers.js",
    "backend/middleware/auth.js",
    "backend/middleware/requirePermission.js",
  );

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

test("recent authentication requires a valid bearer session", () => {
  const user = userOps.createUser("recent-user", bcrypt.hashSync("password123", 4));
  const session = createSession(user.id);

  assert.equal(permissions.isRecentlyAuthenticated({ headers: {} }), false);
  assert.equal(
    permissions.isRecentlyAuthenticated({
      headers: { authorization: `Bearer ${session.token}` },
    }),
    true,
  );
});

test("password and Subsonic authentication reject inactive users", () => {
  const password = "password123";
  const user = userOps.createUser(
    "inactive-user",
    bcrypt.hashSync(password, 4),
    "user",
    null,
    true,
    false,
    password,
  );
  userOps.updateUser(user.id, { status: "suspended" });

  assert.equal(auth.resolveUser("inactive-user", password), null);
  const salt = "test-salt";
  const token = crypto.createHash("md5").update(`${password}${salt}`).digest("hex");
  assert.equal(auth.resolveSubsonicTokenUser("inactive-user", token, salt), null);
});

test("Basic authentication cannot restore legacy admin access for an inactive database user", () => {
  const password = "legacy-password";
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "configured-admin", authPassword: password },
    },
  });
  const user = userOps.createUser(
    "configured-admin",
    bcrypt.hashSync(password, 4),
    "admin",
  );
  userOps.updateUser(user.id, { status: "suspended" });
  const basic = Buffer.from(`configured-admin:${password}`).toString("base64");

  assert.equal(
    auth.resolveRequestUser({ headers: { authorization: `Basic ${basic}` } }),
    null,
  );
});

test("trusted-local bypass rejects an inactive sole administrator", () => {
  const user = userOps.createUser("local-admin", bcrypt.hashSync("password123", 4), "admin");
  userOps.updateUser(user.id, { status: "disabled" });
  dbOps.updateSettings({
    onboardingComplete: true,
    security: { localNetworkBypass: { enabled: true } },
  });
  const req = {
    ip: "127.0.0.1",
    ips: [],
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    connection: { remoteAddress: "127.0.0.1" },
  };

  assert.equal(auth.resolveLocalNetworkBypassUser(req), null);
});
