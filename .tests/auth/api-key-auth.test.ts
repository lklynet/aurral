import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, afterAll, afterEach } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, authModule, { default: health }, { default: authRoutes }] =
  await setupIsolatedBackend(
    "api-key-auth",
    () => import("../../backend/middleware/auth.ts"),
    () => import("../../backend/routes/health.ts"),
    () => import("../../backend/routes/auth.ts"),
  );

const { getApiKey, getEnvApiKey, resolveRequestUser } = authModule;

const envApiKey = "e".repeat(64);

afterEach(() => {
  delete process.env.AURRAL_API_KEY;
});

const remoteAddress = "203.0.113.9";

const apiKeyRequest = (apiKey: string) => ({
  headers: {},
  query: { api_key: apiKey },
  ip: remoteAddress,
  ips: [remoteAddress],
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("the api_key query parameter authenticates as the API user", () => {
  const user = resolveRequestUser(apiKeyRequest(getApiKey()));

  assert.equal(user?.username, "api");
});

test("a repeated api_key query parameter is ignored instead of throwing", async () => {
  const key = getApiKey();
  const app = signedInAs(undefined).route("/", health);
  const streamToken = (query: string) =>
    app.request(`/health/stream-token?${query}`, { method: "POST" });

  assert.equal((await streamToken(`api_key=${key}`)).status, 200);
  assert.equal((await streamToken(`api_key=${key}&api_key=${key}`)).status, 401);
});

test("AURRAL_API_KEY overrides the stored API key", () => {
  const storedKey = getApiKey();
  process.env.AURRAL_API_KEY = envApiKey;

  assert.equal(getApiKey(), envApiKey);
  assert.equal(resolveRequestUser(apiKeyRequest(envApiKey))?.username, "api");
  assert.equal(resolveRequestUser(apiKeyRequest(storedKey)), null);

  delete process.env.AURRAL_API_KEY;
  assert.equal(getApiKey(), storedKey);
});

test("an AURRAL_API_KEY shorter than 32 characters throws", () => {
  process.env.AURRAL_API_KEY = "too-short";

  assert.throws(() => getEnvApiKey(), /AURRAL_API_KEY must be at least 32 characters/);
  assert.equal(resolveRequestUser(apiKeyRequest("too-short")), null);
});

test("an empty AURRAL_API_KEY is treated as unset", () => {
  process.env.AURRAL_API_KEY = "   ";

  assert.equal(getEnvApiKey(), null);
});

test("the GET API key route returns AURRAL_API_KEY", async () => {
  process.env.AURRAL_API_KEY = envApiKey;
  const app = signedInAs(testUser(1, { role: "admin" })).route("/", authRoutes);

  const current = await app.request("/auth/api-key");
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { apiKey: envApiKey, managedByEnv: true });
});

test("the rotate API key route errors when AURRAL_API_KEY is set", async () => {
  process.env.AURRAL_API_KEY = envApiKey;
  const app = signedInAs(testUser(1, { role: "admin" })).route("/", authRoutes);

  const rotate = await app.request("/auth/api-key/rotate", { method: "POST" });
  assert.equal(rotate.status, 409);
  assert.equal(getApiKey(), envApiKey);
});
