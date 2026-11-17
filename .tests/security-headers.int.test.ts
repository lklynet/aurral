import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
  startServerProcess,
} from "./helpers/backendTestHarness.ts";

const [isolatedState] = await setupIsolatedBackend("security-headers");
let server: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};

beforeAll(async () => {
  server = await startServerProcess({ extraEnv: { CORS_ORIGIN: "https://allowed.example" } });
});

afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("CSP permits direct HTTPS artwork, generated images, and preview audio", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health/live`);
  const policy = response.headers.get("content-security-policy") || "";
  const sources = (name: string) =>
    (policy.split(";").find((directive: string) => directive.trim().startsWith(`${name} `)) || "")
      .trim()
      .split(/\s+/);

  assert.ok(sources("img-src").includes("https:"));
  assert.ok(sources("img-src").includes("blob:"));
  assert.ok(sources("media-src").includes("https:"));
});

test("CORS allows only the hosted app and configured origins on the JSON API", async () => {
  const url = `http://127.0.0.1:${server.port}/api/health/live`;
  for (const origin of ["https://allowed.example", "https://music.aurral.org"]) {
    const allowed = await fetch(url, { headers: { Origin: origin } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
    assert.match(allowed.headers.get("access-control-expose-headers") || "", /X-Aurral-Loudness/);
    assert.match(allowed.headers.get("vary") || "", /Origin/);

    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /Range/);
  }

  const blocked = await fetch(url, { headers: { Origin: "https://other.example" } });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  const page = await fetch(`http://127.0.0.1:${server.port}/`, {
    headers: { Origin: "https://music.aurral.org" },
  });
  assert.equal(page.headers.get("access-control-allow-origin"), null);
});
