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
  "plex-global-account-owner",
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
let adminAToken: string;
let adminBToken: string;
let adminAId: number;
let adminBId: number;

async function apiFetch(token: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${aurral.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...Object.fromEntries(new Headers(options.headers)),
    },
  });
  const text = await response.text();
  let payload: {
    integrations: {
      plex: { configuredByUserId: number; mainLibrarySectionId: string; token: string };
    };
    isGlobalAccountOwner: boolean;
  };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text}`);
  }
  return { response, payload };
}

async function login(username: string) {
  const res = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  const adminA = userOps.createUser("admin-a", bcrypt.hashSync("password123", 4), "admin");
  assert.ok(adminA != null);
  const adminB = userOps.createUser("admin-b", bcrypt.hashSync("password123", 4), "admin");
  assert.ok(adminB != null);
  adminAId = adminA.id;
  adminBId = adminB.id;

  aurral = await startServerProcess();
  adminAToken = await login("admin-a");
  adminBToken = await login("admin-b");
});

afterAll(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("connecting the global Plex account stamps configuredByUserId to the admin who connected it", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { url: "http://plex.local:32400", token: "token-a", clientId: "c-a" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminAId);

  const statusA = await apiFetch(adminAToken, "/api/users/me/plex-link/status");
  assert.ok(statusA.payload != null);
  assert.equal(statusA.payload.isGlobalAccountOwner, true);

  const statusB = await apiFetch(adminBToken, "/api/users/me/plex-link/status");
  assert.ok(statusB.payload != null);
  assert.equal(statusB.payload.isGlobalAccountOwner, false);
});

test("reconnecting with a different token reassigns configuredByUserId to the new admin", async () => {
  const saved = await apiFetch(adminBToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { url: "http://plex.local:32400", token: "token-b", clientId: "c-b" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);

  const statusA = await apiFetch(adminAToken, "/api/users/me/plex-link/status");
  assert.ok(statusA.payload != null);
  assert.equal(statusA.payload.isGlobalAccountOwner, false);

  const statusB = await apiFetch(adminBToken, "/api/users/me/plex-link/status");
  assert.ok(statusB.payload != null);
  assert.equal(statusB.payload.isGlobalAccountOwner, true);
});

test("changing an unrelated Plex field without changing the token does not reassign configuredByUserId", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: {
        plex: {
          url: "http://plex.local:32400",
          token: "token-b",
          clientId: "c-b",
          mainLibrarySectionId: "5",
        },
      },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.mainLibrarySectionId, "5");
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);
});

test("a partial Plex update that omits the token does not wipe the saved token or owner", async () => {
  const saved = await apiFetch(adminAToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: { plex: { mainLibrarySectionId: "9" } },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.mainLibrarySectionId, "9");
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.token, "token-b");
  assert.ok(saved.payload != null);
  assert.equal(saved.payload.integrations.plex.configuredByUserId, adminBId);
});
