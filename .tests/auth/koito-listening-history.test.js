import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("koito-listening-history");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { userOps }, listeningHistoryModule, bcryptModule] =
  await Promise.all([
    importFromRepo("backend/config/db-sqlite.js"),
    importFromRepo("backend/config/db-helpers.js"),
    importFromRepo("backend/services/listeningHistory.js"),
    import("bcrypt"),
  ]);

const bcrypt = bcryptModule.default;
const {
  getListenHistoryProfile,
  getListenHistoryCacheNamespace,
  hasListenHistoryProfile,
} = listeningHistoryModule;

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("koito profile uses instance url instead of username", () => {
  assert.deepEqual(
    getListenHistoryProfile({
      listenHistoryProvider: "koito",
      listenHistoryUrl: "https://koito.example.com/",
      listenHistoryUsername: "ignored",
    }),
    {
      listenHistoryProvider: "koito",
      listenHistoryUsername: null,
      listenHistoryUrl: "https://koito.example.com",
      lastfmUsername: null,
    },
  );
  assert.equal(
    hasListenHistoryProfile({
      listenHistoryProvider: "koito",
      listenHistoryUrl: "https://koito.example.com",
    }),
    true,
  );
  assert.equal(
    getListenHistoryCacheNamespace({
      listenHistoryProvider: "koito",
      listenHistoryUrl: "https://koito.example.com",
    }),
    "koito:https://koito.example.com",
  );
});

test("user updates persist koito url on profile", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("alice", hash, "user");

  const updated = userOps.updateUser(user.id, {
    listenHistoryProvider: "koito",
    listenHistoryUrl: "http://koito.local:4110/",
  });

  assert.equal(updated?.listenHistoryProvider, "koito");
  assert.equal(updated?.listenHistoryUrl, "http://koito.local:4110");
  assert.equal(updated?.listenHistoryUsername, null);

  const stored = userOps.getUserById(user.id);
  assert.equal(stored?.listenHistoryProvider, "koito");
  assert.equal(stored?.listenHistoryUrl, "http://koito.local:4110");
});
