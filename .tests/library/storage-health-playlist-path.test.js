import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { runStorageHealthCheck }] =
  await setupIsolatedBackend(
    "storage-health-playlist-path",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/storageHealthService.js",
  );

test.beforeEach(async () => {
  await resetDatabase(db);
  const downloadFolder = process.env.DOWNLOAD_FOLDER;
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {},
    pathMappings: [],
    downloadFolderPath: downloadFolder,
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("does not report legacy playlist job paths as storage failures", async () => {
  const result = await runStorageHealthCheck({ force: true });

  assert.equal(result.sections.some((section) => section.id === "playlists"), false);
  assert.equal(
    result.sections
      .find((section) => section.id === "downloads")
      ?.steps.some((step) => step.id === "playlist-root"),
    false,
  );
});
