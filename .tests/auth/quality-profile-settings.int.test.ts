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
  "quality-profile-settings-api",
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
let authToken: string;

async function saveSettings(body: { qualityProfile: { automaticUpgrades: boolean } }) {
  const response = await fetch(`http://127.0.0.1:${aurral.port}/api/settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("admin", bcrypt.hashSync("password123", 4), "admin");
  aurral = await startServerProcess();
  const response = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  authToken = (await response.json()).token;
  assert.equal(response.status, 200);
});

afterAll(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("partial quality-profile updates preserve custom ranking and cutoff", async () => {
  const profile = {
    order: ["m4a-320", "mp3-320", "flac-standard"],
    enabled: ["m4a-320", "mp3-320"],
    cutoff: "m4a-320",
    automaticUpgrades: false,
    intervalDays: 7,
  };
  const saved = await saveSettings({ qualityProfile: profile });
  const updated = await saveSettings({ qualityProfile: { automaticUpgrades: true } });

  assert.deepEqual(updated.qualityProfile.order, saved.qualityProfile.order);
  assert.deepEqual(updated.qualityProfile.enabled, saved.qualityProfile.enabled);
  assert.equal(updated.qualityProfile.cutoff, saved.qualityProfile.cutoff);
  assert.equal(updated.qualityProfile.intervalDays, 7);
  assert.equal(updated.qualityProfile.automaticUpgrades, true);
});
