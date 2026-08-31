import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
  startServerProcess,
} from "./helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("security-headers");
let server;

test.before(async () => {
  server = await startServerProcess();
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("CSP permits direct HTTPS artwork", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health/live`);
  const policy = response.headers.get("content-security-policy") || "";
  const imageSources = policy
    .split(";")
    .find((directive) => directive.trim().startsWith("img-src "));

  assert.ok((imageSources || "").trim().split(/\s+/).includes("https:"));
});
