import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps, dbOps }] = await setupIsolatedBackend(
  "theme-routes",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let server = null;

async function login(username) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function apiFetch(token, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

const putTheme = (token, theme) =>
  apiFetch(token, "/api/users/me/theme", { method: "PUT", body: JSON.stringify({ theme }) });

const createUser = (username, role = "user") =>
  userOps.createUser(username, bcrypt.hashSync("password123", 4), role);

const duskDocument = {
  version: 2,
  themeId: "custom-dusk",
  appearance: "dark",
  matchArtwork: true,
  themes: [{ id: "custom-dusk", name: "  Dusk  ", dark: { background: "#1B1D2A", text: "#eee", accent: "#C3A6FF" } }],
};

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

test("a saved theme follows its own account and no other", async () => {
  createUser("theme-owner");
  createUser("theme-other");
  const owner = await login("theme-owner");
  const other = await login("theme-other");

  const saved = await putTheme(owner, duskDocument);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));

  const ownTheme = await apiFetch(owner, "/api/users/me/theme");
  assert.deepEqual(ownTheme.payload.theme, {
    version: 2,
    themeId: "custom-dusk",
    appearance: "dark",
    matchArtwork: true,
    themes: [{ id: "custom-dusk", name: "Dusk", dark: { background: "#1b1d2a", text: "#eeeeee", accent: "#c3a6ff" } }],
  });

  const otherTheme = await apiFetch(other, "/api/users/me/theme");
  assert.equal(otherTheme.response.status, 200);
  assert.equal(otherTheme.payload.theme, null);
});

test("an invalid theme is rejected and the saved theme is kept", async () => {
  createUser("theme-invalid");
  const token = await login("theme-invalid");
  await putTheme(token, duskDocument);

  for (const theme of [
    { ...duskDocument, version: 1 },
    { ...duskDocument, themes: [{ id: "custom-x", name: "X", dark: { background: "red", accent: "#fff" } }] },
    { ...duskDocument, themes: [{ id: "custom-x", name: "X" }] },
    { ...duskDocument, themes: [duskDocument.themes[0], duskDocument.themes[0]] },
  ]) {
    const { response } = await putTheme(token, theme);
    assert.equal(response.status, 400);
  }

  const { payload } = await apiFetch(token, "/api/users/me/theme");
  assert.equal(payload.theme.themeId, "custom-dusk");
});

test("deleting a user removes their saved theme", async () => {
  createUser("theme-admin", "admin");
  const removed = createUser("theme-removed");
  await putTheme(await login("theme-removed"), duskDocument);
  assert.ok(dbOps.getUserTheme(removed.id));

  const { response } = await apiFetch(await login("theme-admin"), `/api/users/${removed.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal(dbOps.getUserTheme(removed.id), null);
});
