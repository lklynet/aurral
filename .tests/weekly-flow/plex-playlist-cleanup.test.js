import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";
import { PlexClient } from "../../backend/services/plex.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { plexConnectionStore },
  { plexPlaylistPointerStore },
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "plex-playlist-cleanup",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/plex/plexConnectionStore.js",
  "backend/services/plex/plexPlaylistPointerStore.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {
      plex: { url: "http://plex.local:32400", token: "admin-token", clientId: "admin-client" },
    },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.afterEach(() => {
  mock.restoreAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function makeManager() {
  return new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
}

test("_resolvePlexLocationKey returns 'global' for the shared/global slot (null owner)", () => {
  const manager = makeManager();
  assert.equal(manager._resolvePlexLocationKey(null), "global");
});

test("_resolvePlexLocationKey returns 'global' for an owner with no Plex link", () => {
  const manager = makeManager();
  assert.equal(manager._resolvePlexLocationKey(42), "global");
});

test("_resolvePlexLocationKey identifies a linked owner's specific account", () => {
  plexConnectionStore.saveConnection(5, {
    linkType: "managed",
    token: "t",
    clientId: "c",
    plexAccountId: 100,
  });
  const manager = makeManager();
  assert.equal(manager._resolvePlexLocationKey(5), "managed:100");
});

test("_resolveOwnerPlexTitle keeps the bare title for the shared/global slot", () => {
  const manager = makeManager();
  assert.equal(
    manager._resolveOwnerPlexTitle(null, "Discover Weekly", new Map()),
    "Discover Weekly",
  );
});

test("_resolveOwnerPlexTitle keeps the bare title for an admin who falls back to the global connection", () => {
  const admin = userOps.createUser("plex-admin", "hash", "admin");
  const manager = makeManager();
  assert.equal(
    manager._resolveOwnerPlexTitle(admin.id, "Discover Weekly", new Map()),
    "Discover Weekly",
  );
});

test("_resolveOwnerPlexTitle suffixes the title for a non-admin owner who falls back to the global connection", () => {
  const user = userOps.createUser("jody", "hash", "user");
  const manager = makeManager();
  assert.equal(
    manager._resolveOwnerPlexTitle(user.id, "Discover Weekly", new Map()),
    "Discover Weekly (jody)",
  );
});

test("_resolveOwnerPlexTitle keeps the bare title for a non-admin owner who is personally linked", () => {
  const user = userOps.createUser("jody", "hash", "user");
  plexConnectionStore.saveConnection(user.id, {
    linkType: "managed",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 100,
  });
  const manager = makeManager();
  assert.equal(
    manager._resolveOwnerPlexTitle(user.id, "Discover Weekly", new Map()),
    "Discover Weekly",
  );
});

test("_isOwnerPlexSyncBlocked is not blocked for any unlinked admin when configuredByUserId is unset (legacy)", () => {
  const admin = userOps.createUser("plex-admin", "hash", "admin");
  const manager = makeManager();
  assert.equal(manager._isOwnerPlexSyncBlocked(admin.id, new Map()), false);
});

test("_isOwnerPlexSyncBlocked is not blocked for the admin who configured the global Plex account", () => {
  const admin = userOps.createUser("plex-admin", "hash", "admin");
  dbOps.updateSettings({
    integrations: {
      plex: {
        url: "http://plex.local:32400",
        token: "admin-token",
        clientId: "admin-client",
        configuredByUserId: admin.id,
      },
    },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  const manager = makeManager();
  assert.equal(manager._isOwnerPlexSyncBlocked(admin.id, new Map()), false);
});

test("_isOwnerPlexSyncBlocked blocks an unlinked admin who is not the one who configured the global Plex account", () => {
  const admin = userOps.createUser("plex-admin", "hash", "admin");
  const otherAdmin = userOps.createUser("other-admin", "hash", "admin");
  dbOps.updateSettings({
    integrations: {
      plex: {
        url: "http://plex.local:32400",
        token: "admin-token",
        clientId: "admin-client",
        configuredByUserId: admin.id,
      },
    },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  const manager = makeManager();
  assert.equal(manager._isOwnerPlexSyncBlocked(otherAdmin.id, new Map()), true);
});

test("_isOwnerPlexSyncBlocked is not blocked for an admin who is not the configured owner but has personally linked", () => {
  const admin = userOps.createUser("plex-admin", "hash", "admin");
  const otherAdmin = userOps.createUser("other-admin", "hash", "admin");
  dbOps.updateSettings({
    integrations: {
      plex: {
        url: "http://plex.local:32400",
        token: "admin-token",
        clientId: "admin-client",
        configuredByUserId: admin.id,
      },
    },
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
  plexConnectionStore.saveConnection(otherAdmin.id, {
    linkType: "self",
    token: "other-admin-token",
    clientId: "other-admin-client",
    plexAccountId: 200,
  });
  const manager = makeManager();
  assert.equal(manager._isOwnerPlexSyncBlocked(otherAdmin.id, new Map()), false);
});

test("cleanupUserPlexPlaylists deletes every tracked playlist for that target using the owner's own linked client", async () => {
  plexConnectionStore.saveConnection(5, {
    linkType: "managed",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 100,
  });
  plexPlaylistPointerStore.setPointer("flow-1", "5", {
    location: "managed:100",
    ratingKey: 900,
    title: "Discover Weekly",
  });
  plexPlaylistPointerStore.setPointer("flow-2", "5", {
    location: "managed:100",
    ratingKey: 901,
    title: "Listening History",
  });

  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async function (ratingKey) {
    deleteCalls.push({ ratingKey, token: this.token });
    return {};
  });

  const manager = makeManager();
  await manager.cleanupUserPlexPlaylists(5);

  assert.equal(deleteCalls.length, 2);
  assert.ok(
    deleteCalls.every((c) => c.token === "owner-token"),
    "must use the owner's own token, never the admin's",
  );
  assert.deepEqual(deleteCalls.map((c) => c.ratingKey).sort(), ["900", "901"]);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "5"), null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-2", "5"), null);
});

test("cleanupUserPlexPlaylists is best-effort - one deletion failing doesn't stop the rest, and both pointers are still forgotten", async () => {
  plexConnectionStore.saveConnection(5, {
    linkType: "managed",
    token: "owner-token",
    clientId: "owner-client",
    plexAccountId: 100,
  });
  plexPlaylistPointerStore.setPointer("flow-1", "5", {
    location: "managed:100",
    ratingKey: 900,
    title: "X",
  });
  plexPlaylistPointerStore.setPointer("flow-2", "5", {
    location: "managed:100",
    ratingKey: 901,
    title: "Y",
  });

  mock.method(PlexClient.prototype, "deletePlaylist", async (ratingKey) => {
    if (ratingKey === "900") throw new Error("Plex hiccup");
    return {};
  });

  const manager = makeManager();
  await manager.cleanupUserPlexPlaylists(5);

  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "5"), null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-2", "5"), null);
});

test("cleanupUserPlexPlaylists forgets (but can't reach) a pointer for an account Aurral no longer has a token for", async () => {
  plexPlaylistPointerStore.setPointer("flow-1", "5", {
    location: "managed:100",
    ratingKey: 900,
    title: "X",
  });
  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async (ratingKey) => {
    deleteCalls.push(ratingKey);
    return {};
  });

  const manager = makeManager();
  await manager.cleanupUserPlexPlaylists(5);

  assert.equal(deleteCalls.length, 0, "no reachable client for that location");
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "5"), null, "still forgotten");
});

test("cleanupUserPlexPlaylists deletes a 'global'-located pointer via the admin client even under a specific user's target slot", async () => {
  plexPlaylistPointerStore.setPointer("flow-1", "5", {
    location: "global",
    ratingKey: 900,
    title: "Discover Weekly (jody)",
  });
  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async function (ratingKey) {
    deleteCalls.push({ ratingKey, token: this.token });
    return {};
  });

  const manager = makeManager();
  await manager.cleanupUserPlexPlaylists(5);

  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].token, "admin-token");
});

test("cleanupUserPlexPlaylists is a no-op when nothing is tracked for that target", async () => {
  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async (ratingKey) => {
    deleteCalls.push(ratingKey);
    return {};
  });
  const manager = makeManager();
  await manager.cleanupUserPlexPlaylists(999);
  assert.equal(deleteCalls.length, 0);
});

test("cleanupEntityPlexPlaylists deletes every broadcast target tracked for one entity, via each target's own client", async () => {
  plexConnectionStore.saveConnection(5, {
    linkType: "managed",
    token: "owner-5-token",
    clientId: "c5",
    plexAccountId: 100,
  });
  plexConnectionStore.saveConnection(6, {
    linkType: "self",
    token: "owner-6-token",
    clientId: "c6",
    plexAccountId: 200,
  });
  plexPlaylistPointerStore.setPointer("editorial-1", "global", {
    location: "global",
    ratingKey: 700,
    title: "Metal Mayhem",
  });
  plexPlaylistPointerStore.setPointer("editorial-1", "5", {
    location: "managed:100",
    ratingKey: 701,
    title: "Metal Mayhem",
  });
  plexPlaylistPointerStore.setPointer("editorial-1", "6", {
    location: "self:200",
    ratingKey: 702,
    title: "Metal Mayhem",
  });

  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async function (ratingKey) {
    deleteCalls.push({ ratingKey, token: this.token });
    return {};
  });

  const manager = makeManager();
  await manager.cleanupEntityPlexPlaylists("editorial-1");

  assert.equal(deleteCalls.length, 3);
  const byToken = Object.fromEntries(deleteCalls.map((c) => [c.token, c.ratingKey]));
  assert.equal(byToken["admin-token"], "700");
  assert.equal(byToken["owner-5-token"], "701");
  assert.equal(byToken["owner-6-token"], "702");
  assert.deepEqual(plexPlaylistPointerStore.getPointersForEntity("editorial-1"), []);
});

test("cleanupEntityPlexPlaylists on an entity with no pointers is a safe no-op", async () => {
  const deleteCalls = [];
  mock.method(PlexClient.prototype, "deletePlaylist", async (ratingKey) => {
    deleteCalls.push(ratingKey);
    return {};
  });
  const manager = makeManager();
  await manager.cleanupEntityPlexPlaylists("nothing-here");
  assert.equal(deleteCalls.length, 0);
});

test("cleanupEntityPlexPlaylists does not touch pointers belonging to a different entity", async () => {
  plexPlaylistPointerStore.setPointer("flow-x", "global", {
    location: "global",
    ratingKey: 800,
    title: "X",
  });
  plexPlaylistPointerStore.setPointer("flow-y", "global", {
    location: "global",
    ratingKey: 801,
    title: "Y",
  });
  mock.method(PlexClient.prototype, "deletePlaylist", async () => ({}));

  const manager = makeManager();
  await manager.cleanupEntityPlexPlaylists("flow-x");

  assert.equal(plexPlaylistPointerStore.getPointer("flow-x", "global"), null);
  assert.ok(
    plexPlaylistPointerStore.getPointer("flow-y", "global"),
    "the other entity's pointer must survive",
  );
});
