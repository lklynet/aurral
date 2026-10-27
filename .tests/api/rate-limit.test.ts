import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import { rateLimit } from "../../backend/middleware/rateLimit.ts";
import type { AppEnv } from "../../backend/middleware/requestUser.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval"] }));
afterEach(() => vi.useRealTimers());

function signIn() {
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("clientIp", c.req.header("x-client-ip") ?? "203.0.113.9");
      await next();
    })
    .use(rateLimit({ windowMs: 60_000, limit: 2, skipSuccessfulRequests: true }))
    .post("/login", (c) => c.body(null, c.req.query("ok") ? 200 : 401));
  return (ok: boolean, clientIp?: string) =>
    app.request(`/login${ok ? "?ok=1" : ""}`, {
      method: "POST",
      headers: clientIp ? { "x-client-ip": clientIp } : {},
    });
}

test("failed sign-ins are limited per client for one window, and successful ones are free", async () => {
  const attempt = signIn();
  for (let i = 0; i < 3; i++) assert.equal((await attempt(true)).status, 200);
  assert.equal((await attempt(false)).status, 401);
  assert.equal((await attempt(false)).status, 401);

  const limited = await attempt(false);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await attempt(false, "198.51.100.1")).status, 401);

  vi.advanceTimersByTime(60_000);
  assert.equal((await attempt(false)).status, 401);
});

test("IPv6 clients in one /56 share a limit, and IPv4-mapped addresses count as IPv4", async () => {
  const attempt = signIn();
  assert.equal((await attempt(false, "2001:db8:0:1::1")).status, 401);
  assert.equal((await attempt(false, "2001:db8:0:2::1")).status, 401);
  assert.equal((await attempt(false, "2001:db8:0:3::5")).status, 429);
  assert.equal((await attempt(false, "2001:db8:0:100::1")).status, 401);

  assert.equal((await attempt(false, "::ffff:192.0.2.4")).status, 401);
  assert.equal((await attempt(false, "192.0.2.4")).status, 401);
  assert.equal((await attempt(false, "192.0.2.4")).status, 429);
});
