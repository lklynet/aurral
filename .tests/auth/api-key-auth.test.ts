import { createAuthRequest } from "./authFixtures.ts";
import type { Request } from "express";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, authModule] = await setupIsolatedBackend(
  "api-key-auth",
  () => import("../../backend/middleware/auth.ts"),
);

const { getApiKey, resolveRequestUser } = authModule;

const remoteAddress = "203.0.113.9";

function apiKeyRequest(query: Request["query"]) {
  return createAuthRequest({
    headers: {},
    query,
    path: "/api/artists",
    method: "GET",
    ip: remoteAddress,
    ips: [remoteAddress],
  });
}

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("the api_key query parameter authenticates as the API user", () => {
  const user = resolveRequestUser(apiKeyRequest({ api_key: getApiKey() }));

  assert.equal(user?.username, "api");
});

test("a repeated api_key query parameter is ignored instead of throwing", () => {
  const key = getApiKey();

  assert.equal(resolveRequestUser(apiKeyRequest({ api_key: [key, key] })), null);
  assert.equal(resolveRequestUser(apiKeyRequest({ api_key: { 0: key } })), null);
});
