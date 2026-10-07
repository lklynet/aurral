import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { hashPassword }] = await setupIsolatedBackend(
  "app-passwords",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/middleware/passwordHash.js",
);

const serverEnv = { extraEnv: { AURRAL_PUBLIC_URL: "https://music.example.test/aurral/" } };
let aurral;
let adminToken;
let userToken;
let preMigrationSession;

const api = (pathname, token, options = {}) =>
  fetch(`http://127.0.0.1:${aurral.port}/api${pathname}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  });
const login = (username, password) =>
  api("/auth/login", null, { method: "POST", body: JSON.stringify({ username, password }) });
const sessionFor = async (username, password) => (await (await login(username, password)).json()).token;
const createDevice = (token, name) => api("/auth/app-passwords", token, { method: "POST", body: JSON.stringify({ name }) });
const revokeDevice = (token, id) => api(`/auth/app-passwords/${id}`, token, { method: "DELETE" });
const subsonic = async (method, params) => {
  const query = new URLSearchParams({ v: "1.16.1", c: "device-test", f: "json", ...params });
  const response = await fetch(`http://127.0.0.1:${aurral.port}/rest/${method}.view?${query}`);
  return (await response.json())["subsonic-response"];
};
const encoded = (secret) => `enc:${Buffer.from(secret).toString("hex")}`;

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: true, integrations: {}, security: { localNetworkBypass: { enabled: false } } });
  userOps.createUser("admin", hashPassword("password123"), "admin");
  userOps.createUser("listener", hashPassword("password123"), "user", { accessFlow: true });
  userOps.createUser("other", hashPassword("password123"), "user", { accessFlow: true });
  preMigrationSession = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (user_id, token, created_at, expires_at, reauthenticated_at) VALUES (?, ?, ?, ?, ?)")
    .run(userOps.getUserByUsername("listener").id, preMigrationSession, Date.now(), Date.now() + 60_000, Date.now());
  db.exec("ALTER TABLE sessions DROP COLUMN app_password_id; DROP TABLE app_passwords");
  aurral = await startServerProcess(serverEnv);
  adminToken = await sessionFor("admin", "password123");
  userToken = await sessionFor("listener", "password123");
});

test.after(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("a new app password signs in through Subsonic and the JSON API", async () => {
  assert.equal((await api("/auth/me", preMigrationSession)).status, 200);
  const created = await createDevice(userToken, "Phone");
  assert.equal(created.status, 201);
  assert.match(created.headers.get("cache-control"), /no-store/);
  const { device, secret } = await created.json();
  assert.equal(device.name, "Phone");

  const me = await api("/auth/me", secret);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, "listener");
  const exchanged = await login("listener", secret);
  assert.equal(exchanged.status, 200);
  assert.equal((await api("/auth/me", (await exchanged.json()).token)).status, 200);
  assert.equal((await login("listener", "password123")).status, 200);

  assert.equal((await subsonic("ping", { u: "listener", p: encoded(secret) })).status, "ok");
  assert.equal((await subsonic("ping", { u: "listener", p: secret })).status, "ok");
  assert.equal((await subsonic("ping", { apiKey: secret })).status, "ok");
  assert.deepEqual((await subsonic("tokenInfo", { apiKey: secret })).tokenInfo, { username: "listener" });
  assert.equal((await subsonic("ping", { apiKey: secret, u: "listener" })).error.code, 43);
  assert.equal((await subsonic("ping", { u: "other", p: encoded(secret) })).error.code, 40);
  assert.equal((await login("other", secret)).status, 401);
  const extensions = await subsonic("getOpenSubsonicExtensions", {});
  assert.ok(extensions.openSubsonicExtensions.some((extension) => extension.name === "apiKeyAuthentication"));

  const listResponse = await api("/auth/app-passwords", userToken);
  const list = await listResponse.json();
  const listed = list.devices.find((entry) => entry.id === device.id);
  assert.equal(listed.name, "Phone");
  assert.ok(listed.createdAt);
  assert.ok(listed.lastUsedAt);
  assert.equal(list.serverUrl, "https://music.example.test/aurral");
  assert.equal(JSON.stringify(list).includes(secret), false);
  assert.notEqual(db.prepare("SELECT secret_hash FROM app_passwords WHERE id = ?").get(device.id).secret_hash, secret);

  assert.equal((await revokeDevice(userToken, device.id)).status, 200);
});

test("a revoked app password loses every kind of access on the next request", async () => {
  const { device, secret } = await (await createDevice(userToken, "Tablet")).json();
  const kept = await (await createDevice(userToken, "Laptop")).json();
  const session = await sessionFor("listener", secret);
  const streamToken = (await (await api("/health/stream-token", secret, { method: "POST" })).json()).token;
  const streamPath = `/playlists/stream/missing?st=${encodeURIComponent(streamToken)}`;
  assert.equal((await api(streamPath, null)).status, 404);
  const socket = new WebSocket(`ws://127.0.0.1:${aurral.port}/ws?token=${encodeURIComponent(session)}`);
  await new Promise((resolve, reject) => { socket.once("message", resolve); socket.once("error", reject); });
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));

  const otherToken = await sessionFor("other", "password123");
  assert.equal((await revokeDevice(otherToken, device.id)).status, 404);
  assert.equal((await api("/auth/me", secret)).status, 200);
  assert.equal((await api("/auth/app-passwords?all=true", otherToken)).status, 403);
  const all = await (await api("/auth/app-passwords?all=true", adminToken)).json();
  assert.equal(all.devices.find((entry) => entry.id === device.id).username, "listener");
  assert.equal((await revokeDevice(adminToken, device.id)).status, 200);

  assert.equal((await api("/auth/me", secret)).status, 401);
  assert.equal((await api("/auth/me", session)).status, 401);
  assert.equal((await api(streamPath, null)).status, 401);
  assert.equal(await socketClosed, 4403);
  assert.equal((await login("listener", secret)).status, 401);
  assert.equal((await subsonic("ping", { u: "listener", p: encoded(secret) })).error.code, 40);
  assert.equal((await subsonic("ping", { apiKey: secret })).error.code, 44);
  assert.equal((await api("/auth/me", kept.secret)).status, 200);
  assert.equal((await api("/auth/me", userToken)).status, 200);
  const remaining = (await (await api("/auth/app-passwords", userToken)).json()).devices.map((entry) => entry.id);
  assert.deepEqual(remaining, [kept.device.id]);
  assert.equal((await revokeDevice(userToken, kept.device.id)).status, 200);
});

test("a regular user's app password can't reach admin routes or create more credentials", async () => {
  const { device, secret } = await (await createDevice(userToken, "Desktop")).json();
  const session = await sessionFor("listener", secret);
  for (const token of [secret, session]) {
    assert.equal((await api("/settings", token)).status, 403);
    assert.equal((await api("/auth/api-key", token)).status, 403);
    assert.equal((await api("/users", token)).status, 403);
    assert.equal((await api("/auth/app-passwords?all=true", token)).status, 403);
    assert.equal((await createDevice(token, "Child")).status, 403);
  }
  const passwordChange = await api("/users/me/password", session, {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123", newPassword: "changed-password" }),
  });
  assert.equal(passwordChange.status, 401);
  assert.equal((await subsonic("getUser", { apiKey: secret, username: "listener" })).user.adminRole, false);

  const adminDevice = await (await createDevice(adminToken, "Admin app")).json();
  assert.equal((await api("/settings", adminDevice.secret)).status, 200);
  assert.equal((await revokeDevice(userToken, adminDevice.device.id)).status, 404);
  assert.equal((await revokeDevice(adminToken, adminDevice.device.id)).status, 200);
  assert.equal((await revokeDevice(userToken, device.id)).status, 200);
});

test("app passwords follow the account's current status and permissions and survive restarts", async () => {
  const { device, secret } = await (await createDevice(userToken, "Car")).json();
  await aurral.stop();
  aurral = await startServerProcess(serverEnv);
  assert.equal((await api("/auth/me", secret)).status, 200);

  const listener = userOps.getUserByUsername("listener");
  userOps.updateUser(listener.id, { permissions: { accessFlow: false } });
  assert.equal((await (await api("/auth/me", secret)).json()).user.permissions.accessFlow, false);
  userOps.updateUser(listener.id, { status: "suspended" });
  assert.equal((await api("/auth/me", secret)).status, 401);
  assert.equal((await subsonic("ping", { apiKey: secret })).error.code, 44);
  userOps.updateUser(listener.id, { status: "active", permissions: { accessFlow: true } });
  assert.equal((await revokeDevice(adminToken, device.id)).status, 200);
});

test("creation validates the device name and deleting an account removes its devices", async () => {
  assert.equal((await createDevice(null, "Anonymous")).status, 401);
  for (const name of ["", " ", "x".repeat(101)]) assert.equal((await createDevice(userToken, name)).status, 400);

  const otherToken = await sessionFor("other", "password123");
  const disposable = await (await createDevice(otherToken, "Disposable")).json();
  const exchanged = await sessionFor("other", disposable.secret);
  const other = userOps.getUserByUsername("other");
  assert.equal((await api(`/users/${other.id}`, adminToken, { method: "DELETE" })).status, 200);
  assert.equal((await api("/auth/me", disposable.secret)).status, 401);
  assert.equal((await api("/auth/me", exchanged)).status, 401);
  assert.equal(db.prepare("SELECT id FROM app_passwords WHERE id = ?").get(disposable.device.id), undefined);
});
