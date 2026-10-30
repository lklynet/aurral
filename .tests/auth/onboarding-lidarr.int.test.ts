import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }] = await setupIsolatedBackend(
  "onboarding-lidarr-api",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

function json(
  res: http.ServerResponse<http.IncomingMessage> & { req: http.IncomingMessage },
  statusCode: number,
  payload:
    | { message: string }
    | { path: string }[]
    | { version: string; instanceName: string }
    | { id: number; name: string }[],
) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function startFakeLidarr() {
  const requests: {
    method: string | undefined;
    pathname: string;
    apiKey: string | string[] | null;
  }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    requests.push({
      method: req.method,
      pathname: url.pathname,
      apiKey: req.headers["x-api-key"] || null,
    });

    if (req.headers["x-api-key"] !== "fake-key") {
      return json(res, 401, { message: "Invalid API key" });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/rootFolder") {
      return json(res, 200, [{ path: "/music/main" }]);
    }

    if (req.method === "GET" && url.pathname === "/api/rootFolder") {
      return json(res, 200, [{ path: "/music/main" }]);
    }

    if (req.method === "GET" && url.pathname === "/api/v1/system/status") {
      return json(res, 200, { version: "1.0.0-test", instanceName: "Lidarr" });
    }

    if (req.method === "GET" && url.pathname === "/api/system/status") {
      return json(res, 200, { version: "1.0.0-test", instanceName: "Lidarr" });
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/api/v1/qualityprofile" || url.pathname === "/api/qualityprofile")
    ) {
      return json(res, 200, [{ id: 1, name: "Aurral - HQ" }]);
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/api/v1/metadataprofile" || url.pathname === "/api/metadataprofile")
    ) {
      return json(res, 200, [{ id: 2, name: "Aurral - Standard" }]);
    }

    return json(res, 404, { message: "Not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let server: Awaited<ReturnType<typeof startServerProcess>>;
let fakeLidarr: Awaited<ReturnType<typeof startFakeLidarr>>;

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: false,
  });
  fakeLidarr = await startFakeLidarr();
  server = await startServerProcess();
});

afterAll(async () => {
  await server?.stop();
  await fakeLidarr?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("POST /api/onboarding/lidarr/test uses supplied credentials before onboarding is complete", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/onboarding/lidarr/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fakeLidarr.url, apiKey: "fake-key" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload, {
    success: true,
    message: "Connection successful",
  });
  const status = fakeLidarr.requests.find(
    (request) => request.pathname === "/api/v1/system/status",
  );
  assert.equal(status?.apiKey, "fake-key");
});

test("POST /api/onboarding/lidarr/profiles uses supplied credentials before onboarding is complete", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/onboarding/lidarr/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fakeLidarr.url, apiKey: "fake-key" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload, [{ id: 1, name: "Aurral - HQ" }]);
});
