import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, listeningHistoryModule] =
  await setupIsolatedBackend(
    "listening-history",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/listeningHistory.js",
  );

const bcryptModule = await import("bcrypt");

const bcrypt = bcryptModule.default;
const {
  getListenHistoryProfile,
  getListenHistoryCacheNamespace,
  hasListenHistoryProfile,
  resolveListenHistorySettings,
} = listeningHistoryModule;

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("normalizes legacy and explicit listening history profiles", () => {
  assert.deepEqual(
    getListenHistoryProfile({ lastfm_username: "alice" }),
    {
      listenHistoryProvider: "lastfm",
      listenHistoryUsername: "alice",
      listenHistoryUrl: null,
      lastfmUsername: "alice",
    },
  );

  assert.deepEqual(
    getListenHistoryProfile({
      listenHistoryProvider: "listenbrainz",
      listenHistoryUsername: "  roofuskit  ",
    }),
    {
      listenHistoryProvider: "listenbrainz",
      listenHistoryUsername: "roofuskit",
      listenHistoryUrl: null,
      lastfmUsername: null,
    },
  );
});

test("builds provider-specific discovery cache namespaces", () => {
  assert.equal(
    getListenHistoryCacheNamespace({
      listenHistoryProvider: "lastfm",
      listenHistoryUsername: "alice",
    }),
    "lfm:alice",
  );

  assert.equal(
    getListenHistoryCacheNamespace({
      listenHistoryProvider: "listenbrainz",
      listenHistoryUsername: "alice",
    }),
    "lb:alice",
  );

  assert.equal(
    getListenHistoryCacheNamespace({
      listenHistoryProvider: "koito",
      listenHistoryUrl: "https://koito.example.com",
    }),
    "koito:https://koito.example.com",
  );
});

test("user updates persist listenbrainz separately from legacy lastfm field", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("alice", hash, "user");

  const updated = userOps.updateUser(user.id, {
    listenHistoryProvider: "listenbrainz",
    listenHistoryUsername: "roofuskit",
  });

  assert.equal(updated?.listenHistoryProvider, "listenbrainz");
  assert.equal(updated?.listenHistoryUsername, "roofuskit");
  assert.equal(updated?.lastfmUsername, null);

  const stored = userOps.getUserById(user.id);
  assert.equal(stored?.listenHistoryProvider, "listenbrainz");
  assert.equal(stored?.listenHistoryUsername, "roofuskit");
  assert.equal(stored?.lastfmUsername, null);
});

test("legacy lastfm_username still resolves as a lastfm profile", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("bob", hash, "user");

  db.prepare(
    "UPDATE users SET lastfm_username = ?, listen_history_provider = NULL, listen_history_username = NULL WHERE id = ?",
  ).run("legacybob", user.id);

  const stored = userOps.getUserById(user.id);
  assert.equal(stored?.listenHistoryProvider, "lastfm");
  assert.equal(stored?.listenHistoryUsername, "legacybob");
  assert.equal(stored?.lastfmUsername, "legacybob");
});

test("resolveListenHistorySettings does not use a global username", () => {
  const settings = {
    integrations: {
      lastfm: {
        username: "leefamous",
        apiKey: "test",
      },
    },
  };
  assert.deepEqual(resolveListenHistorySettings({}, settings), {
    listenHistoryProvider: "lastfm",
    listenHistoryUsername: null,
    listenHistoryUrl: null,
    lastfmUsername: null,
  });
});

test("local history is a valid profile without an external identity", () => {
  assert.deepEqual(resolveListenHistorySettings({ listenHistoryProvider: "local" }), {
    listenHistoryProvider: "local",
    listenHistoryUsername: null,
    listenHistoryUrl: null,
    lastfmUsername: null,
  });
});

test("resolveListenHistorySettings keeps explicit user profile over default", () => {
  const settings = {
    integrations: {
      lastfm: { username: "leefamous" },
    },
  };
  assert.deepEqual(
    resolveListenHistorySettings(
      {
        listenHistoryProvider: "lastfm",
        listenHistoryUsername: "otheruser",
      },
      settings,
    ),
    {
      listenHistoryProvider: "lastfm",
      listenHistoryUsername: "otheruser",
      listenHistoryUrl: null,
      lastfmUsername: "otheruser",
    },
  );
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
