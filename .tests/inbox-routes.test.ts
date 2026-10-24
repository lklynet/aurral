import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterAll, beforeAll, test } from "vite-plus/test";
import type { AppEnv, RequestUser } from "../backend/middleware/requestUser.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }, { api }] = await setupIsolatedBackend(
  "inbox-routes",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/routes/api.ts"),
);

let user: RequestUser;

const signedInAs = (current: RequestUser | undefined) =>
  new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("user", current);
      c.set("clientIp", "127.0.0.1");
      await next();
    })
    .route("/", api);

const patchJson = (body: string) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body,
});

beforeAll(() => {
  resetDatabase(db);
  const created = userOps.createUser("inbox-routes-user", "password-hash");
  assert.ok(created);
  user = { id: created.id, username: created.username, role: "user", permissions: {} };
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("inbox routes reject requests without a signed-in user", async () => {
  const app = signedInAs(undefined);

  const anonymous = await app.request("/inbox");
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

  const expired = await app.request("/inbox", { headers: { Authorization: "Bearer stale" } });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).code, "SESSION_INVALID");
});

test("inbox item updates accept loosely written actions and reject unknown ones", async () => {
  const item = dbOps.upsertInboxItem({
    userId: user.id,
    kind: "news",
    sourceKey: "https://example.com/story/1",
    title: "Story",
  });
  assert.ok(item?.id);
  const path = `/inbox/${encodeURIComponent(item.id)}`;
  const app = signedInAs(user);

  const saved = await app.request(path, patchJson(JSON.stringify({ action: " Save " })));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).item.isSaved, true);

  const unknown = await app.request(path, patchJson(JSON.stringify({ action: "archive" })));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "Invalid request");
});

test("malformed and oversized JSON bodies get client errors", async () => {
  const app = signedInAs(user);

  const malformed = await app.request("/inbox/missing", patchJson("{"));
  assert.equal(malformed.status, 400);

  const oversized = await app.request(
    "/inbox/missing",
    patchJson(JSON.stringify({ action: "x".repeat(3 * 1024 ** 2) })),
  );
  assert.equal(oversized.status, 413);
});
