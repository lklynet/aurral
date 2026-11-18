import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import type { AppEnv } from "../../backend/middleware/requestUser.ts";

const [
  isolatedState,
  { db },
  { userOps, dbOps },
  { createSession, deleteSessionsByUserId, getSessionByToken },
  { hashPassword },
  { getApiKey },
  guards,
  { default: auth },
  { websocketService },
] = await setupIsolatedBackend(
  "pairing",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/session-helpers.ts"),
  () => import("../../backend/services/passwordHash.ts"),
  () => import("../../backend/services/auth.ts"),
  () => import("../../backend/middleware/guards.ts"),
  () => import("../../backend/routes/auth.ts"),
  () => import("../../backend/services/websocketService.ts"),
);

const app = new Hono<AppEnv>().use(guards.authenticate).route("/api", auth);

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: true });
});
afterAll(() => cleanupIsolatedState(isolatedState));

const createUser = (username: string) => {
  const user = userOps.createUser(username, hashPassword("password"), "admin");
  assert.ok(user);
  return user;
};

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

const pair = (code: string) =>
  app.request("/api/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

const issue = async (token: string) => {
  const issued = await app.request("/api/auth/pairing-codes", { method: "POST", ...bearer(token) });
  assert.equal(issued.status, 201);
  return ((await issued.json()) as { code: string }).code;
};

test("a code from a signed-in session pairs one device, once", async () => {
  const user = createUser("lee");
  const { token } = createSession(user.id);
  const code = await issue(token);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{10}$/);

  const redeemed = await Promise.all([pair(code), pair(code)]);
  assert.deepEqual(redeemed.map((response) => response.status).sort(), [200, 401]);
  const paired = (await redeemed.find((response) => response.ok)!.json()) as { token: string };
  assert.equal(getSessionByToken(paired.token)?.userId, user.id);
  assert.equal(getSessionByToken(paired.token)?.reauthenticatedAt, 0);

  const revoked = await issue(token);
  deleteSessionsByUserId(user.id);
  assert.equal((await pair(revoked)).status, 401);
});

test("only a signed-in session can issue a code", async () => {
  createUser("basic");
  for (const [header, value] of [
    ["Authorization", `Basic ${Buffer.from("basic:password").toString("base64")}`],
    ["X-Api-Key", getApiKey()],
  ] as const) {
    const headers = { [header]: value };
    const response = await app.request("/api/auth/pairing-codes", { method: "POST", headers });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "session_required");
  }
});

test("signing a device out ends its session and sockets, and reaches only your own", async () => {
  const user = createUser("owner");
  const other = createUser("other");
  const current = createSession(user.id, null, "Mozilla/5.0 (Macintosh) Chrome/150.0");
  const phone = createSession(user.id, null, "Mozilla/5.0 (iPhone) Safari/605.1");
  const theirs = createSession(other.id);

  const listed = (await (
    await app.request("/api/auth/sessions", bearer(current.token))
  ).json()) as {
    sessions: { id: number; userAgent: string | null; current: boolean }[];
  };
  assert.equal(listed.sessions.length, 2);
  const phoneRow = listed.sessions.find((session) => session.userAgent?.includes("iPhone"));
  assert.ok(phoneRow && !phoneRow.current);
  assert.ok(listed.sessions.some((session) => session.current));

  type Client = Parameters<typeof websocketService.clients.add>[0];
  const closed: (number | undefined)[] = [];
  websocketService.clients.add({
    id: "phone",
    user: { id: user.id } as NonNullable<Client["user"]>,
    authSource: "session",
    sessionToken: phone.token,
    connectedAt: Date.now(),
    subscriptions: new Set(["status"]),
    ws: {
      readyState: 1,
      close(code?: number) {
        closed.push(code);
      },
    } as Client["ws"],
  });

  const signOut = (id: number) =>
    app.request(`/api/auth/sessions/${id}`, { method: "DELETE", ...bearer(current.token) });
  assert.equal((await signOut(phoneRow.id)).status, 200);
  assert.deepEqual(closed, [4401]);
  assert.equal(getSessionByToken(phone.token), null);

  const theirId = getSessionByToken(theirs.token)?.id;
  assert.ok(theirId);
  assert.equal((await signOut(theirId)).status, 404);
  assert.ok(getSessionByToken(theirs.token));
});
