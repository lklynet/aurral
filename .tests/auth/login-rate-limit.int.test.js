import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "login-rate-limit",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let aurral;

const login = (password) =>
  fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("admin", bcrypt.hashSync("password123", 4), "admin");
  aurral = await startServerProcess();
});

test.after(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("successful sign-ins never lock out, but repeated failures do", async () => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal((await login("password123")).status, 200);
  }

  const failures = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    failures.push((await login("wrong-password")).status);
  }
  assert.deepEqual(failures, [...Array(10).fill(401), 429]);
  assert.equal((await login("password123")).status, 429);
});
