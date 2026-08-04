import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { PlexClient } from "../../backend/services/plex.js";

const [isolatedState, { db }, , { plexConnectionStore }, ownerClientsModule] =
  await setupIsolatedBackend(
    "plex-owner-clients",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/plex/plexConnectionStore.js",
    "backend/services/weeklyFlow/weeklyFlowPlexOwnerClients.js",
  );
const { resolvePlexClientForOwner, recoverManagedUserToken } = ownerClientsModule;

test.beforeEach(() => {
  resetDatabase(db);
});

test.afterEach(() => {
  mock.restoreAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function globalClient() {
  const client = new PlexClient("http://plex.local:32400", "admin-token", "admin-client");
  client._machineIdentifier = "global-machine-id";
  return client;
}

test("resolvePlexClientForOwner falls back to the global client when ownerUserId is null", () => {
  const global = globalClient();
  const cache = new Map();
  const resolved = resolvePlexClientForOwner(global, null, cache);
  assert.equal(resolved, global);
});

test("resolvePlexClientForOwner falls back to the global client when the owner has no link", () => {
  const global = globalClient();
  const cache = new Map();
  const resolved = resolvePlexClientForOwner(global, 123, cache);
  assert.equal(resolved, global);
});

test("resolvePlexClientForOwner builds a per-owner client with its own token/clientId, seeded with the global machineIdentifier", () => {
  plexConnectionStore.saveConnection(5, {
    linkType: "self",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 55,
  });
  const global = globalClient();
  const cache = new Map();
  const resolved = resolvePlexClientForOwner(global, 5, cache);
  assert.notEqual(resolved, global);
  assert.equal(resolved.url, global.url);
  assert.equal(resolved.token, "owner-token");
  assert.equal(resolved.clientId, "owner-client");
  assert.equal(resolved._machineIdentifier, "global-machine-id");
});

test("resolvePlexClientForOwner memoizes within the same cache Map", () => {
  plexConnectionStore.saveConnection(6, {
    linkType: "self",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 66,
  });
  const global = globalClient();
  const cache = new Map();
  const first = resolvePlexClientForOwner(global, 6, cache);
  const second = resolvePlexClientForOwner(global, 6, cache);
  assert.equal(first, second);
});

test("recoverManagedUserToken re-switches and persists a fresh token for a managed link", async () => {
  plexConnectionStore.saveConnection(7, {
    linkType: "managed",
    token: "stale-token",
    clientId: "owner-client-7",
    plexAccountId: 700,
    linkedByAdminId: 1,
  });
  mock.method(PlexClient, "switchHomeUser", async (plexUserId, adminToken, adminClientId, targetClientId) => {
    assert.equal(plexUserId, 700);
    assert.equal(adminToken, "admin-token");
    assert.equal(targetClientId, "owner-client-7");
    return "re-switched-token";
  });
  mock.method(PlexClient, "getResources", async () => ({ servers: [] }));
  const global = globalClient();
  const recovered = await recoverManagedUserToken(7, global);
  assert.ok(recovered);
  assert.equal(recovered.token, "re-switched-token");
  assert.equal(recovered.clientId, "owner-client-7");
  assert.equal(recovered._machineIdentifier, "global-machine-id");

  const stored = plexConnectionStore.getConnection(7);
  assert.equal(stored.token, "re-switched-token");
  assert.equal(stored.lastError, null);
});

test("recoverManagedUserToken records lastError and returns null when the re-switch fails", async () => {
  plexConnectionStore.saveConnection(8, {
    linkType: "managed",
    token: "stale-token",
    clientId: "owner-client-8",
    plexAccountId: 800,
    linkedByAdminId: 1,
  });
  mock.method(PlexClient, "switchHomeUser", async () => {
    throw new Error("Plex Home access revoked");
  });
  const global = globalClient();
  const recovered = await recoverManagedUserToken(8, global);
  assert.equal(recovered, null);

  const stored = plexConnectionStore.getConnection(8);
  assert.equal(stored.token, "stale-token");
  assert.match(stored.lastError.message, /Plex Home access revoked/);
});

test("recoverManagedUserToken is a no-op for self-linked (friend) accounts", async () => {
  plexConnectionStore.saveConnection(9, {
    linkType: "self",
    token: "friend-token",
    clientId: "owner-client-9",
    plexAccountId: 900,
  });
  const global = globalClient();
  const recovered = await recoverManagedUserToken(9, global);
  assert.equal(recovered, null);
  assert.equal(plexConnectionStore.getConnection(9).lastError, null);
});

test("recoverManagedUserToken is a no-op when the owner has no link at all", async () => {
  const global = globalClient();
  const recovered = await recoverManagedUserToken(999, global);
  assert.equal(recovered, null);
});
