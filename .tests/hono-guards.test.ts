import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterAll, beforeAll, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";
import { signedInAs } from "./helpers/honoApp.ts";
import { testUser } from "./helpers/userFixtures.ts";
import type { AppEnv } from "../backend/middleware/requestUser.ts";

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

test("permission and admin guards turn away users without access", async () => {
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

test("a link token signs in browse playlist and flow starter covers, and nothing else under Discover", async () => {
  const created = userOps.createUser("hono-guards-covers", "password-hash");
  assert.ok(created);
  const { token } = createSession(created.id);
  const app = new Hono<AppEnv>()
    .use(guards.authenticate)
    .get("/api/discover/playlists/:provider/:id/cover", (c) => c.text(String(c.var.user?.id)))
    .get("/api/discover/playlists/:provider/:id", (c) => c.text(String(c.var.user?.id)))
    .get("/api/playlists/flow-templates/:id/cover", (c) => c.text(String(c.var.user?.id)));

  const cover = await app.request(`/api/discover/playlists/mix/daily-1/cover?token=${token}`);
  assert.equal(await cover.text(), String(created.id));
  const detail = await app.request(`/api/discover/playlists/mix/daily-1?token=${token}`);
  assert.notEqual(await detail.text(), String(created.id));
  const starter = await app.request(
    `/api/playlists/flow-templates/release-radar/cover?token=${token}`,
  );
  assert.equal(await starter.text(), String(created.id));
});
