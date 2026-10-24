import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";

const [isolatedState, { db }, { userOps }, { createSession }, guards] = await setupIsolatedBackend(
  "hono-guards",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/config/session-helpers.ts"),
  () => import("../backend/middleware/guards.ts"),
);

beforeAll(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

const ok = (c: { text: (body: string) => Response }) => c.text("ok");

test("permission and admin guards answer like the Express guards", async () => {
  const user = testUser(7, { permissions: { addAlbum: true } });
  const admin = testUser(1, { role: "admin" });
  const route = (current: typeof user | undefined) =>
    signedInAs(current)
      .get("/album", guards.requirePermission("addAlbum"), ok)
      .get("/artist", guards.requirePermission("deleteArtist"), ok)
      .get("/admin", guards.requireAdmin, ok);

  assert.equal((await route(user).request("/album")).status, 200);
  const denied = await route(user).request("/artist");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: "Forbidden",
    message: "Permission required: deleteArtist",
  });
  assert.equal((await route(admin).request("/artist")).status, 200);
  assert.equal((await (await route(undefined).request("/album")).json()).code, "AUTH_REQUIRED");

  assert.equal((await route(user).request("/admin")).status, 403);
  assert.equal((await route(admin).request("/admin")).status, 200);
});

test("recent-auth guard needs a fresh bearer session", async () => {
  const created = userOps.createUser("hono-guards-user", "password-hash");
  assert.ok(created);
  const user = testUser(created.id);
  const app = signedInAs(user).post("/password", guards.requireRecentAuth(), ok);

  const stale = await app.request("/password", { method: "POST" });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, "reauth_required");

  const { token } = createSession(created.id);
  const fresh = await app.request("/password", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(fresh.status, 200);
});
