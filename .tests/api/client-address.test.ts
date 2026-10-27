import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterAll, test } from "vite-plus/test";
import { clientAddress } from "../../backend/middleware/clientAddress.ts";
import type { AppEnv } from "../../backend/middleware/requestUser.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

const server = await listen(
  new Hono<AppEnv>()
    .use(clientAddress)
    .get("/", (c) => c.json({ ip: c.var.clientIp, protocol: c.var.protocol })),
);
const url = `http://127.0.0.1:${listeningAddress(server).port}/`;

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("by default only the nearest proxy is trusted for the client address and protocol", async () => {
  const direct = await fetch(url);
  assert.deepEqual(await direct.json(), { ip: "127.0.0.1", protocol: "http" });

  const proxied = await fetch(url, {
    headers: { "X-Forwarded-For": "198.51.100.7, 203.0.113.9", "X-Forwarded-Proto": "https" },
  });
  assert.deepEqual(await proxied.json(), { ip: "203.0.113.9", protocol: "https" });
});
