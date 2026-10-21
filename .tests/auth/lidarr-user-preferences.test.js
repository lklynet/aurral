import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }] = await setupIsolatedBackend(
  "lidarr-user-preferences",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

const bcryptModule = await import("bcrypt");

const bcrypt = bcryptModule.default;

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("new users start with null Lidarr defaults on all user read paths", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("alice", hash, "user");

  assert.equal(user?.lidarrRootFolderPath, null);
  assert.equal(user?.lidarrQualityProfileId, null);

  const stored = userOps.getUserById(user.id);
  assert.equal(stored?.lidarrRootFolderPath, null);
  assert.equal(stored?.lidarrQualityProfileId, null);

  const listed = userOps.getAllUsers();
  assert.equal(listed[0]?.lidarrRootFolderPath, null);
  assert.equal(listed[0]?.lidarrQualityProfileId, null);
});

test("user updates persist Lidarr root folder and quality profile defaults", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("bob", hash, "user");

  const updated = userOps.updateUser(user.id, {
    lidarrRootFolderPath: "/music/alt",
    lidarrQualityProfileId: 9,
  });

  assert.equal(updated?.lidarrRootFolderPath, "/music/alt");
  assert.equal(updated?.lidarrQualityProfileId, 9);

  const stored = userOps.getUserById(user.id);
  assert.equal(stored?.lidarrRootFolderPath, "/music/alt");
  assert.equal(stored?.lidarrQualityProfileId, 9);
});
