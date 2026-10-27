import { createAuthRequest } from "./authFixtures.ts";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { userOps, dbOps },
  { createSession },
  auth,
  { hashPassword },
  { encryptWithKey },
  { default: subsonic },
] = await setupIsolatedBackend(
  "recent-auth",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/session-helpers.ts"),
  () => import("../../backend/middleware/auth.ts"),
  () => import("../../backend/middleware/passwordHash.ts"),
  () => import("../../backend/config/encryption.ts"),
  () => import("../../backend/routes/subsonic.ts"),
);

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

async function subsonicPing(
  params: { u: string; t: string; s: string } | { u: string; p: string },
) {
  const query = new URLSearchParams({ v: "1.16.1", c: "auth-test", f: "json", ...params });
  const response = await subsonic.request(`/rest/ping.view?${query}`);
  return (await response.json())["subsonic-response"];
}

const subsonicToken = (password: string | null | undefined, salt: string) =>
  crypto.createHash("md5").update(`${password}${salt}`).digest("hex");

function watchPasswordHashing(t: import("vite-plus/test").TestContext) {
  const scrypt = vi.spyOn(crypto, "scryptSync");
  syncBuiltinESMExports();
  t.onTestFinished(() => {
    scrypt.mockRestore();
    syncBuiltinESMExports();
  });
  return scrypt;
}

test("recent authentication requires a valid bearer session", () => {
  const user = userOps.createUser("recent-user", bcrypt.hashSync("password123", 4));
  assert.ok(user != null);
  const session = createSession(user.id);

  assert.equal(auth.isRecentlyAuthenticated(undefined), false);
  assert.equal(auth.isRecentlyAuthenticated(`Bearer ${session.token}`), true);
});

test("stream requests need sign-in once an account exists, even without a stored single password", () => {
  const anonymous = createAuthRequest({
    headers: {},
    query: {},
    ip: "203.0.113.9",
  });
  assert.equal(auth.verifyTokenAuth(createAuthRequest({ ...anonymous })), true);

  dbOps.updateSettings({ onboardingComplete: true });
  const user = userOps.createUser("stream-owner", bcrypt.hashSync("password123", 4), "admin");
  assert.ok(user != null);
  assert.equal(auth.verifyTokenAuth(createAuthRequest({ ...anonymous })), false);

  const session = createSession(user.id);
  assert.equal(
    auth.verifyTokenAuth(createAuthRequest({ ...anonymous, query: { token: session.token } })),
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
  assert.ok(user != null);
  userOps.updateUser(user.id, { status: "suspended" });

  assert.equal(auth.resolveUser("inactive-user", password), null);
  const salt = "test-salt";
  const token = crypto.createHash("md5").update(`${password}${salt}`).digest("hex");
  assert.equal(auth.resolveSubsonicTokenUser("inactive-user", token, salt), null);
});

test("Subsonic requests reuse the stored password instead of hashing it on every call", async (t) => {
  const user = userOps.createUser("listener", hashPassword("listener-password"));
  assert.ok(user != null);
  const salt = "listener-salt";
  const scrypt = watchPasswordHashing(t);

  assert.equal((await subsonicPing({ u: "listener", p: "listener-password" })).status, "ok");
  assert.equal(scrypt.mock.calls.length, 1);

  assert.equal(
    (await subsonicPing({ u: "listener", t: subsonicToken("listener-password", salt), s: salt }))
      .status,
    "ok",
  );
  assert.equal((await subsonicPing({ u: "listener", p: "listener-password" })).status, "ok");
  assert.equal(
    (
      await subsonicPing({
        u: "listener",
        p: `enc:${Buffer.from("listener-password").toString("hex")}`,
      })
    ).status,
    "ok",
  );
  assert.equal(scrypt.mock.calls.length, 1);

  assert.equal((await subsonicPing({ u: "listener", p: "listener-passwore" })).error.code, 40);
  assert.equal((await subsonicPing({ u: "listener", p: "wrong" })).error.code, 40);
  assert.equal(
    (await subsonicPing({ u: "listener", t: subsonicToken("wrong", salt), s: salt })).error.code,
    41,
  );

  userOps.updateUser(user.id, { status: "disabled" });
  assert.equal(
    (await subsonicPing({ u: "listener", t: subsonicToken("listener-password", salt), s: salt }))
      .error.code,
    41,
  );
  assert.equal((await subsonicPing({ u: "listener", p: "listener-password" })).error.code, 40);
});

test("Subsonic stops accepting a password once the account password hash changes", async () => {
  const user = userOps.createUser(
    "rotator",
    hashPassword("old-password"),
    "user",
    null,
    true,
    false,
    "old-password",
  );
  assert.ok(user != null);
  const salt = "rotator-salt";
  assert.equal(
    (await subsonicPing({ u: "rotator", t: subsonicToken("old-password", salt), s: salt })).status,
    "ok",
  );

  userOps.updateUser(user.id, { passwordHash: hashPassword("new-password") });

  assert.equal(
    (await subsonicPing({ u: "rotator", t: subsonicToken("old-password", salt), s: salt })).error
      .code,
    41,
  );
  assert.equal((await subsonicPing({ u: "rotator", p: "old-password" })).error.code, 40);
  assert.equal((await subsonicPing({ u: "rotator", p: "new-password" })).status, "ok");
  assert.equal(
    (await subsonicPing({ u: "rotator", t: subsonicToken("new-password", salt), s: salt })).status,
    "ok",
  );
});

test("Subsonic token auth checks a configured legacy password against the account password", async () => {
  const configureLegacyPassword = (authPassword: string) =>
    dbOps.updateSettings({
      onboardingComplete: true,
      integrations: { general: { authUser: "owner", authPassword } },
    });
  userOps.createUser("owner", hashPassword("current-password"), "admin");
  const salt = "owner-salt";

  configureLegacyPassword("stale-password");
  assert.equal(
    (await subsonicPing({ u: "owner", t: subsonicToken("stale-password", salt), s: salt })).error
      .code,
    41,
  );

  configureLegacyPassword("current-password");
  assert.equal(
    (await subsonicPing({ u: "owner", t: subsonicToken("current-password", salt), s: salt }))
      .status,
    "ok",
  );
});

test("Subsonic never accepts a stored password it cannot decrypt", async () => {
  const user = userOps.createUser("restored", hashPassword("restored-password"));
  assert.ok(user != null);
  const unreadable = encryptWithKey("restored-password", crypto.randomBytes(32));
  assert.ok(unreadable);
  db.prepare("UPDATE users SET subsonic_password = ? WHERE id = ?").run(unreadable, user.id);
  const salt = "restored-salt";

  assert.equal((await subsonicPing({ u: "restored", p: unreadable })).error.code, 40);
  assert.equal(
    (await subsonicPing({ u: "restored", t: subsonicToken(unreadable, salt), s: salt })).error.code,
    41,
  );
  assert.equal((await subsonicPing({ u: "restored", p: "restored-password" })).status, "ok");
  assert.equal(
    (await subsonicPing({ u: "restored", t: subsonicToken("restored-password", salt), s: salt }))
      .status,
    "ok",
  );
});

test("Basic authentication cannot restore legacy admin access for an inactive database user", () => {
  const password = "legacy-password";
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "configured-admin", authPassword: password },
    },
  });
  const user = userOps.createUser("configured-admin", bcrypt.hashSync(password, 4), "admin");
  assert.ok(user != null);
  userOps.updateUser(user.id, { status: "suspended" });
  const basic = Buffer.from(`configured-admin:${password}`).toString("base64");

  assert.equal(
    auth.resolveRequestUser(createAuthRequest({ headers: { authorization: `Basic ${basic}` } })),
    null,
  );
});

test("trusted-local bypass rejects an inactive sole administrator", () => {
  const user = userOps.createUser("local-admin", bcrypt.hashSync("password123", 4), "admin");
  assert.ok(user != null);
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

test("trusted-local bypass accepts only addresses on the server's private subnet", () => {
  userOps.createUser("lan-admin", bcrypt.hashSync("password123", 4), "admin");
  dbOps.updateSettings({
    onboardingComplete: true,
    security: { localNetworkBypass: { enabled: true } },
  });
  vi.spyOn(os, "networkInterfaces").mockImplementation(() => ({
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
    eth0: [
      {
        address: "192.168.4.115",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.4.115/24",
      },
    ],
    eth1: [
      {
        address: "192.168.4.116",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.4.116/24",
      },
    ],
  }));
  const from = (address: string) => ({
    ip: address,
    ips: [],
    headers: {},
    socket: { remoteAddress: address },
    connection: { remoteAddress: address },
  });

  assert.equal(auth.resolveLocalNetworkBypassUser(from("192.168.4.20"))?.username, "lan-admin");
  assert.equal(
    auth.resolveLocalNetworkBypassUser(from("::ffff:192.168.4.20"))?.username,
    "lan-admin",
  );
  assert.equal(auth.resolveLocalNetworkBypassUser(from("192.168.5.20")), null);
  assert.equal(auth.resolveLocalNetworkBypassUser(from("8.8.8.8")), null);
});
