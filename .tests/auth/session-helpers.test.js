import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("sessions");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { userOps }, sessionHelpers, bcryptModule] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/config/db-helpers.js"),
  importFromRepo("backend/config/session-helpers.js"),
  importFromRepo("backend/node_modules/bcrypt/bcrypt.js"),
]);

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
  const session = createSession(user.id);

  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(
    Date.now() - 1000,
    session.token,
  );

  assert.equal(getSessionByToken(session.token), null);
  assert.equal(cleanExpiredSessions(), 0);
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
