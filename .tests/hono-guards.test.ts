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

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { createSession },
  guards,
  { default: filesystem },
  { websocketService },
] = await setupIsolatedBackend(
  "hono-guards",
  () => import("../backend/config/db-sqlite.ts"),
  () => import("../backend/db/helpers/index.ts"),
  () => import("../backend/config/session-helpers.ts"),
  () => import("../backend/middleware/guards.ts"),
  () => import("../backend/routes/filesystem.ts"),
  () => import("../backend/services/websocketService.ts"),
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

  for (const playlist of ["mix/daily-1", "community/1e35c76d"]) {
    const cover = await app.request(`/api/discover/playlists/${playlist}/cover?token=${token}`);
    assert.equal(await cover.text(), String(created.id));
  }
  const detail = await app.request(`/api/discover/playlists/mix/daily-1?token=${token}`);
  assert.notEqual(await detail.text(), String(created.id));
  const starter = await app.request(
    `/api/playlists/flow-templates/release-radar/cover?token=${token}`,
  );
  assert.equal(await starter.text(), String(created.id));
});

test("a request from another site never takes a no-auth path", async () => {
  resetDatabase(db);
  const app = new Hono<AppEnv>()
    .use(guards.authenticate)
    .route("/api", filesystem)
    .post("/api/onboarding/complete", (c) => c.text(String(c.var.user?.id)))
    .get("/api/library/artists", (c) => c.text(String(c.var.user?.id)))
    .get("/api/library/albums/:id/cover", (c) => c.text(String(c.var.user?.id)))
    .get("/api/library/stream/:id/:track", (c) => c.text(String(c.var.user?.id)));
  const from = (headers: Record<string, string>) => ({
    headers: { Host: "aurral.local:3001", ...headers },
  });
  const foreign = from({ Origin: "https://music.aurral.org" });
  const status = async (path: string, init: ReturnType<typeof from>, method = "GET") =>
    (await app.request(path, { method, ...init })).status;

  const sameSite = [
    from({}),
    from({ Origin: "http://aurral.local:3001" }),
    from({ Origin: "http://music.home", "X-Forwarded-Host": "music.home" }),
    from({ "Sec-Fetch-Site": "same-origin", Origin: "https://music.aurral.org" }),
  ];
  const socketClose = (headers: Record<string, string>) => {
    type Socket = Parameters<typeof websocketService.handleConnection>[0];
    type Upgrade = Parameters<typeof websocketService.handleConnection>[1];
    let code: number | undefined;
    const ws = {
      readyState: 1,
      on() {},
      send() {},
      close: (closeCode?: number) => (code = closeCode),
    };
    websocketService.handleConnection(
      ws as unknown as Socket,
      {
        url: "/ws",
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        socket: {},
      } as Upgrade,
    );
    websocketService.clients.clear();
    return code;
  };

  for (const init of sameSite) {
    assert.equal(await status("/api/onboarding/complete", init, "POST"), 200);
    assert.equal(await status("/api/library/albums/1/cover", init), 200);
    assert.notEqual(await status("/api/filesystem/browse", init), 403);
  }
  assert.equal(socketClose(from({}).headers), undefined);
  for (const init of [foreign, from({ "Sec-Fetch-Site": "cross-site" })]) {
    assert.equal(await status("/api/onboarding/complete", init, "POST"), 401);
    assert.equal(await status("/api/library/albums/1/cover", init), 401);
    assert.equal(await status("/api/library/stream/1/1", init), 401);
    assert.equal(await status("/api/filesystem/browse", init), 403);
    assert.equal(socketClose(init.headers), 4401);
  }

  dbOps.updateSettings({ onboardingComplete: true });
  assert.equal(await status("/api/library/artists", from({})), 200);
  assert.equal(await status("/api/library/artists", foreign), 401);
  assert.equal(await status("/api/library/albums/1/cover", foreign), 401);

  const created = userOps.createUser("hono-guards-cross-site", "password-hash");
  assert.ok(created);
  const { token } = createSession(created.id);
  const signedIn = await app.request(
    "/api/library/artists",
    from({ Origin: "https://music.aurral.org", Authorization: `Bearer ${token}` }),
  );
  assert.equal(await signedIn.text(), String(created.id));
  const cover = await app.request(`/api/library/albums/1/cover?token=${token}`, foreign);
  assert.equal(await cover.text(), String(created.id));
  assert.equal(cover.headers.get("cross-origin-resource-policy"), "cross-origin");
});
