import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, sessionHelpers] =
  await setupIsolatedBackend(
    "sessions",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/config/session-helpers.js",
  );

const bcryptModule = await import("bcrypt");

const bcrypt = bcryptModule.default;

const {
  createSession,
  getSessionByToken,
  deleteSession,
  deleteSessionsByUserId,
  cleanExpiredSessions,
} = sessionHelpers;

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("creates and resolves sessions with user payload metadata", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("alice", hash, "admin");

  const session = createSession(user.id, "127.0.0.1", "node:test");
  const stored = getSessionByToken(session.token);

  assert.ok(session.token);
  assert.equal(typeof session.expiresAt, "number");
  assert.equal(stored?.userId, user.id);
  assert.equal(stored?.user?.username, "alice");
  assert.equal(stored?.ipAddress, "127.0.0.1");
  assert.equal(stored?.userAgent, "node:test");
});

test("deletes expired sessions when looked up or cleaned", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("bob", hash, "user");
  const lookedUp = createSession(user.id);
  const cleaned = createSession(user.id);
  const live = createSession(user.id);
  const expire = db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?");
  expire.run(Date.now() - 1000, lookedUp.token);
  expire.run(Date.now() - 1000, cleaned.token);
  const stored = () => db.prepare("SELECT token FROM sessions ORDER BY token").all().map((row) => row.token);

  assert.equal(getSessionByToken(lookedUp.token), null);
  assert.deepEqual(stored(), [cleaned.token, live.token].sort());
  assert.equal(cleanExpiredSessions(), 1);
  assert.deepEqual(stored(), [live.token]);
});

test("can delete one session or all sessions for a user", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("carol", hash, "user");
  const first = createSession(user.id);
  const second = createSession(user.id);

  assert.equal(deleteSession(first.token), true);
  assert.equal(getSessionByToken(first.token), null);
  assert.ok(getSessionByToken(second.token));

  assert.equal(deleteSessionsByUserId(user.id), 1);
  assert.equal(getSessionByToken(second.token), null);
});
