import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import sharp from "sharp";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps, userOps }, { hashPassword }, { authMiddleware },
  { default: authRouter }, { default: imageProxyRouter }] = await setupIsolatedBackend(
  "image-cache", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/middleware/passwordHash.js", "backend/middleware/auth.js",
  "backend/routes/auth.js", "backend/routes/imageProxy.js",
);

const realFetch = globalThis.fetch;
const cover = await sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } },
}).png().toBuffer();
let server;
let baseUrl;
let token;

function stubCoverHost(t, routes) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    requests.push(url.href);
    const route = routes[url.href];
    if (!route) return new Response("Not Found", { status: 404 });
    return new Response(route.body, { headers: { "Content-Type": route.type } });
  });
  return requests;
}

function cacheImage(src, { authenticated = true } = {}) {
  return realFetch(`${baseUrl}/api/image-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ src }),
  });
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/auth", authRouter);
  app.use("/api/image-proxy", imageProxyRouter);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
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

test.after(async () => {
  await new Promise((resolve) => server?.close(resolve));
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

  assert.equal((await cacheImage("https://images.example/cover.jpg", { authenticated: false })).status, 401);
  assert.equal((await cacheImage("file:///etc/passwd")).status, 400);
  assert.equal((await cacheImage("https://images.example/missing.jpg")).status, 404);
  assert.deepEqual(requests, ["https://images.example/missing.jpg"]);
});
