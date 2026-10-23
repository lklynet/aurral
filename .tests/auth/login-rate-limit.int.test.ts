import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "login-rate-limit",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

let aurral: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};

const login = (password: string) =>
  fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("admin", bcrypt.hashSync("password123", 4), "admin");
  aurral = await startServerProcess();
});

afterAll(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("successful sign-ins never lock out, but repeated failures do", async () => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal((await login("password123")).status, 200);
  }

  const failures: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    failures.push((await login("wrong-password")).status);
  }
  assert.deepEqual(failures, [...Array(10).fill(401), 429]);
  assert.equal((await login("password123")).status, 429);
});
