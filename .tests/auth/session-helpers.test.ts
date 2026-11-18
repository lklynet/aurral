import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps }, sessionHelpers] = await setupIsolatedBackend(
  "sessions",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/session-helpers.ts"),
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

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("creates and resolves sessions with user payload metadata", (t: import("vite-plus/test").TestContext) => {
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-22T12:00:00Z").getTime());
  vi.stubEnv("SESSION_EXPIRY_HOURS", "2");
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("alice", hash, "admin");
  assert.ok(user != null);

  const session = createSession(user.id, "127.0.0.1", "node:test");
  const stored = getSessionByToken(session.token);

  assert.ok(session.token);
  assert.equal(session.expiresAt, Date.now() + 2 * 60 * 60 * 1000);
  assert.equal(stored?.expiresAt, session.expiresAt);
  assert.equal(stored?.userId, user.id);
  assert.equal(stored?.user?.username, "alice");
  assert.equal(stored?.ipAddress, "127.0.0.1");
  assert.equal(stored?.userAgent, "node:test");
});

test("deletes expired sessions when looked up or cleaned", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("bob", hash, "user");
  assert.ok(user != null);
  const lookedUp = createSession(user.id);
  const cleaned = createSession(user.id);
  const live = createSession(user.id);
  const expire = db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?");
  expire.run(Date.now() - 1000, lookedUp.token);
  expire.run(Date.now() - 1000, cleaned.token);
  const stored = () =>
    db
      .prepare<[], { token: string }>("SELECT token FROM sessions ORDER BY token")
      .all()
      .map((row) => row.token);

  assert.equal(getSessionByToken(lookedUp.token), null);
  assert.deepEqual(stored(), [cleaned.token, live.token].sort());
  assert.equal(cleanExpiredSessions(), 1);
  assert.deepEqual(stored(), [live.token]);
});

test("can delete one session or all sessions for a user", () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = userOps.createUser("carol", hash, "user");
  assert.ok(user != null);
  const first = createSession(user.id);
  const second = createSession(user.id);

  assert.equal(deleteSession(first.token), true);
  assert.equal(getSessionByToken(first.token), null);
  assert.ok(getSessionByToken(second.token));

  assert.equal(deleteSessionsByUserId(user.id), 1);
  assert.equal(getSessionByToken(second.token), null);
});

test("a used session renews at most once per touch interval, for the configured length", (t: import("vite-plus/test").TestContext) => {
  const start = new Date("2026-11-17T12:00:00Z").getTime();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const user = userOps.createUser("dana", bcrypt.hashSync("secret", 4), "user");
  assert.ok(user != null);
  const hour = 60 * 60 * 1000;
  const lookup = (at: number, token: string) => {
    clock.mockReturnValue(at);
    return getSessionByToken(token)?.expiresAt;
  };

  const month = createSession(user.id);
  assert.equal(lookup(start + 23 * hour, month.token), start + 720 * hour);
  assert.equal(lookup(start + 25 * hour, month.token), start + 745 * hour);
  assert.equal(lookup(start + 26 * hour, month.token), start + 745 * hour);

  vi.stubEnv("SESSION_EXPIRY_HOURS", "2");
  clock.mockReturnValue(start);
  const short = createSession(user.id);
  assert.equal(lookup(start + 0.1 * hour, short.token), start + 2 * hour);
  assert.equal(lookup(start + 0.25 * hour, short.token), start + 2.25 * hour);
});
