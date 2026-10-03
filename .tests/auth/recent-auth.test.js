import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";

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

test("trusted-local bypass accepts only addresses on the server's private subnet", (t) => {
  userOps.createUser("lan-admin", bcrypt.hashSync("password123", 4), "admin");
  dbOps.updateSettings({
    onboardingComplete: true,
    security: { localNetworkBypass: { enabled: true } },
  });
  t.mock.method(os, "networkInterfaces", () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [{ address: "192.168.4.115", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "192.168.4.115/24" }],
    eth1: [{ address: "192.168.4.116", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "192.168.4.116/24" }],
  }));
  const from = (address) => ({
    ip: address,
    ips: [],
    headers: {},
    socket: { remoteAddress: address },
    connection: { remoteAddress: address },
  });

  assert.equal(auth.resolveLocalNetworkBypassUser(from("192.168.4.20"))?.username, "lan-admin");
  assert.equal(auth.resolveLocalNetworkBypassUser(from("::ffff:192.168.4.20"))?.username, "lan-admin");
  assert.equal(auth.resolveLocalNetworkBypassUser(from("192.168.5.20")), null);
  assert.equal(auth.resolveLocalNetworkBypassUser(from("8.8.8.8")), null);
});
