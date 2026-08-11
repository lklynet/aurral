import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { flowPlaylistConfig },
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "navidrome-owner-name-prefix",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function makeManager() {
  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  manager.navidromeDestination.client = {
    isConfigured: () => true,
    async ensureWeeklyFlowLibrary() {},
    async getPlaylists() {
      return [];
    },
    async deletePlaylist() {},
    async scanLibrary() {},
  };
  return manager;
}

test("the Navidrome adapter keeps an unowned flow name bare", () => {
  const manager = makeManager();
  const names = manager.navidromeDestination.getPlaylistNames({
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "Weekend Vibes");
  assert.deepEqual(names.legacy, ["[A] Weekend Vibes", "Aurral Weekend Vibes"]);
});

test("the Navidrome adapter prefixes an owned flow and keeps legacy names", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  const manager = makeManager();
  const names = manager.navidromeDestination.getPlaylistNames({
    ownerUserId: jody.id,
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "jody - Weekend Vibes");
  assert.deepEqual(names.legacy, [
    "Weekend Vibes",
    "[A] Weekend Vibes",
    "Aurral Weekend Vibes",
  ]);
});

test("the Navidrome adapter prefixes an owned shared playlist and keeps legacy names", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "80s Anthems" });
  const manager = makeManager();
  const names = manager.navidromeDestination.getPlaylistNames({
    entityId: playlist.id,
    ownerUserId: jody.id,
    displayName: "80s Anthems",
  });
  assert.equal(names.current, "jody - 80s Anthems");
  assert.deepEqual(names.legacy, [
    "80s Anthems",
    "[AS] 80s Anthems",
    "Aurral Shared 80s Anthems",
  ]);
  flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
});

test("two different owners can use the same flow name without their .m3u files colliding", async () => {
  const gordon = userOps.createUser("gordon", "hash", "admin");
  const jody = userOps.createUser("jody", "hash", "user");
  const gordonFlow = flowPlaylistConfig.createFlow({
    name: "Weekend Vibes",
    ownerUserId: gordon.id,
  });
  flowPlaylistConfig.setEnabled(gordonFlow.id, true);
  const jodyFlow = flowPlaylistConfig.createFlow({ name: "Weekend Vibes", ownerUserId: jody.id });
  flowPlaylistConfig.setEnabled(jodyFlow.id, true);

  const manager = makeManager();
  await manager.ensurePlaylists();

  const files = await fs.readdir(manager.libraryRoot);
  const m3uFiles = files.filter((f) => f.endsWith(".m3u"));
  assert.deepEqual(
    m3uFiles.sort(),
    ["gordon - Weekend Vibes.m3u", "jody - Weekend Vibes.m3u"].sort(),
  );
});
