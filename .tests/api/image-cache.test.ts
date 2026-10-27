import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import sharp from "sharp";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

const [state, { db }, { dbOps, userOps }, { hashPassword }, { app }] = await setupIsolatedBackend(
  "image-cache",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/middleware/passwordHash.ts"),
  () => import("../../backend/app.ts"),
);

const realFetch = globalThis.fetch;
const cover = await sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } },
})
  .png()
  .toBuffer();
let server: import("node:http").Server;
let baseUrl: string;
let token: string;

function stubCoverHost(
  t: import("vite-plus/test").TestContext,
  routes: Record<string, { body: BodyInit; type: string }>,
) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    requests.push(url.href);
    const route = routes[url.href];
    if (!route) return new Response("Not Found", { status: 404 });
    return new Response(route.body, { headers: { "Content-Type": route.type } });
  });
  return requests;
}

function cacheImage(src: string, { authenticated = true }: { authenticated?: boolean } = {}) {
  return realFetch(`${baseUrl}/api/image-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ src }),
  });
}

beforeAll(async () => {
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
});

beforeEach(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: { general: { authUser: "test", authPassword: "password" } },
    security: { localNetworkBypass: { enabled: false } },
  });
  userOps.createUser("test", hashPassword("password"), "admin");
  const login = await realFetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "password" }),
  });
  token = (await login.json()).token;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await cleanupIsolatedState(state);
});

test("a signed-in user gets a same-origin copy of a cover from a host without CORS", async (t) => {
  const source = "https://imagecache.lidarr.audio/v1/caa/release/cover.jpg";
  const requests = stubCoverHost(t, { [source]: { body: cover, type: "image/png" } });

  const response = await cacheImage(source);
  assert.equal(response.status, 200);
  const { url } = await response.json();
  assert.match(url, /^\/api\/image-proxy\/[a-f0-9]{64}\.[a-z]+$/);

  const image = await realFetch(`${baseUrl}${url}`);
  assert.equal(image.status, 200);
  const { dominant } = await sharp(Buffer.from(await image.arrayBuffer())).stats();
  assert.ok(dominant.r > dominant.b, "the copy is the cover");

  assert.equal((await cacheImage(source)).status, 200);
  assert.deepEqual(requests, [source]);
});

test("caching a cover requires a signed-in user and an http image URL", async (t) => {
  const requests = stubCoverHost(t, {});

  assert.equal(
    (await cacheImage("https://images.example/cover.jpg", { authenticated: false })).status,
    401,
  );
  assert.equal((await cacheImage("file:///etc/passwd")).status, 400);
  assert.equal((await cacheImage("https://images.example/missing.jpg")).status, 404);
  assert.deepEqual(requests, ["https://images.example/missing.jpg"]);
});
