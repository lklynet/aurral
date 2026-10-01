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
  server = await startServerProcess({ extraEnv: { CORS_ORIGIN: "https://allowed.example" } });
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

test("CORS allows only configured origins on the JSON API", async () => {
  const url = `http://127.0.0.1:${server.port}/api/health/live`;
  const allowed = await fetch(url, { headers: { Origin: "https://allowed.example" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.match(allowed.headers.get("vary") || "", /Origin/);

  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: { Origin: "https://allowed.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);

  const blocked = await fetch(url, { headers: { Origin: "https://other.example" } });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
});
