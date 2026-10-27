import { signedInAs } from "../helpers/honoApp.ts";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, authModule, { default: health }] = await setupIsolatedBackend(
  "api-key-auth",
  () => import("../../backend/middleware/auth.ts"),
  () => import("../../backend/routes/health.ts"),
);

const { getApiKey, resolveRequestUser } = authModule;

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
