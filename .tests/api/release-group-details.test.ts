import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  listeningAddress,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

const missingMbid = "33333333-3333-4333-8333-333333333333";
const outageMbid = "44444444-4444-4444-8444-444444444444";

const metadataServer = await createMockHttpServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.statusCode = request.url === `/album/${outageMbid}` ? 503 : 404;
  response.end("{}");
});

const [state, { db }, { dbOps, userOps }, { hashPassword }, { app }] = await setupIsolatedBackend(
  "release-group-details",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/middleware/passwordHash.ts"),
  () => import("../../backend/app.ts"),
);

let server: import("node:http").Server;
let baseUrl: string;
let token: string;

const details = (mbid: string) =>
  fetch(`${baseUrl}/api/artists/release-group/${mbid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "test", authPassword: "password" },
      metadata: { baseUrl: metadataServer.url, enableNarrowFallbacks: false },
    },
    security: { localNetworkBypass: { enabled: false } },
  });
  userOps.createUser("test", hashPassword("password"), "admin");
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "password" }),
  });
  token = (await login.json()).token;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await metadataServer.close();
  await cleanupIsolatedState(state);
});

test("an album MusicBrainz doesn't have is a 404, and an outage is an uncached 502", async () => {
  const missing = await details(missingMbid);
  assert.equal(missing.status, 404);

  const outage = await details(outageMbid);
  assert.equal(outage.status, 502);
  assert.equal(outage.headers.get("cache-control"), "no-store");
});
