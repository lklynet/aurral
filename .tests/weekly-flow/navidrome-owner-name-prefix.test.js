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
  return new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
}

test("_getFlowPlaylistNames stays bare for an unowned flow", () => {
  const manager = makeManager();
  const names = manager._getFlowPlaylistNames("Weekend Vibes", null);
  assert.equal(names.current, "Weekend Vibes");
  assert.deepEqual(names.legacy, ["[A] Weekend Vibes", "Aurral Weekend Vibes"]);
});

test("_getFlowPlaylistNames prepends the owner's username, and treats the bare name as legacy", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  const manager = makeManager();
  const names = manager._getFlowPlaylistNames("Weekend Vibes", jody.id);
  assert.equal(names.current, "jody - Weekend Vibes");
  assert.deepEqual(names.legacy, [
    "Weekend Vibes",
    "[A] Weekend Vibes",
    "Aurral Weekend Vibes",
  ]);
});

test("_getSharedPlaylistNames prepends the owner's username, and treats the bare name as legacy", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  const manager = makeManager();
  const names = manager._getSharedPlaylistNames("80s Anthems", jody.id);
  assert.equal(names.current, "jody - 80s Anthems");
  assert.deepEqual(names.legacy, [
    "80s Anthems",
    "[AS] 80s Anthems",
    "Aurral Shared 80s Anthems",
  ]);
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
