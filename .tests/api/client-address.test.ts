import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterAll, test } from "vite-plus/test";
import { clientAddress } from "../../backend/middleware/clientAddress.ts";
import type { AppEnv } from "../../backend/middleware/requestUser.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

const app = new Hono<AppEnv>()
  .use(clientAddress)
  .get("/", (c) => c.json({ ip: c.var.clientIp, protocol: c.var.protocol }));
const server = await listen(app);
const url = `http://127.0.0.1:${listeningAddress(server).port}/`;

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const fromPeer = async (remoteAddress: string, headers: Record<string, string>) => {
  const response = await app.request("/", { headers }, {
    incoming: { socket: { remoteAddress }, headers },
  } as unknown as AppEnv["Bindings"]);
  const body: unknown = await response.json();
  return body;
};

test("by default only proxies on loopback or private addresses are trusted for the client address and protocol", async () => {
  const direct = await fetch(url);
  assert.deepEqual(await direct.json(), { ip: "127.0.0.1", protocol: "http" });

  const proxied = await fetch(url, {
    headers: { "X-Forwarded-For": "198.51.100.7, 203.0.113.9", "X-Forwarded-Proto": "https" },
  });
  assert.deepEqual(await proxied.json(), { ip: "203.0.113.9", protocol: "https" });

  const forwarded = { "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" };
  assert.deepEqual(await fromPeer("203.0.113.9", forwarded), {
    ip: "203.0.113.9",
    protocol: "http",
  });
  assert.deepEqual(
    await fromPeer("172.18.0.5", { ...forwarded, "x-forwarded-for": "198.51.100.7" }),
    {
      ip: "198.51.100.7",
      protocol: "https",
    },
  );
});
