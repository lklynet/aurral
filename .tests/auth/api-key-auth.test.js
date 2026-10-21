import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, authModule] = await setupIsolatedBackend(
  "api-key-auth",
  "backend/config/db-sqlite.js",
  "backend/middleware/auth.js",
);

const { getApiKey, resolveRequestUser } = authModule;

function remoteRequest({ headers = {}, query = {} } = {}) {
  const remoteAddress = "203.0.113.10";
  return {
    headers,
    query,
    socket: { remoteAddress },
    connection: { remoteAddress },
    ip: remoteAddress,
    ips: [remoteAddress],
  };
}

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("an API key in the header or query authenticates as the api admin", () => {
  const key = getApiKey();

  assert.equal(
    resolveRequestUser(remoteRequest({ headers: { "x-api-key": key } }))?.username,
    "api",
  );
  assert.equal(resolveRequestUser(remoteRequest({ query: { api_key: key } }))?.username, "api");
  assert.equal(resolveRequestUser(remoteRequest({ query: { api_key: "wrong" } })), null);
});

test("a repeated api_key query parameter is ignored instead of failing the request", () => {
  const key = getApiKey();
  const repeated = { api_key: [key, key] };

  assert.equal(resolveRequestUser(remoteRequest({ query: repeated })), null);
  assert.equal(
    resolveRequestUser(remoteRequest({ headers: { "x-api-key": key }, query: repeated }))?.username,
    "api",
  );
});
