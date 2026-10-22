import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { runStorageHealthAction } from "../../frontend/src/pages/Settings/utils/runStorageHealthAction.ts";

test("storage health does not run against old settings when saving changes fails", async () => {
  let checksRun = 0;
  const outcome = await runStorageHealthAction({
    hasUnsavedChanges: true,
    saveSettings: async () => false,
    refreshStorageHealth: async () => {
      checksRun += 1;
      return { ok: true };
    },
  });

  assert.equal(checksRun, 0);
  assert.equal(outcome.saved, false);
  assert.equal(outcome.result, null);
});

test("storage health runs after settings save successfully", async () => {
  let checksRun = 0;
  const outcome = await runStorageHealthAction({
    hasUnsavedChanges: true,
    saveSettings: async () => true,
    refreshStorageHealth: async () => {
      checksRun += 1;
      return { ok: true };
    },
  });

  assert.equal(checksRun, 1);
  assert.equal(outcome.saved, true);
  assert.deepEqual(outcome.result, { ok: true });
});
