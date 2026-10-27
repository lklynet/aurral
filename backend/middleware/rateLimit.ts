import { createMiddleware } from "hono/factory";
import ipaddr from "ipaddr.js";
import type { AppEnv } from "./requestUser.ts";

function clientKey(ip: string) {
  if (!ipaddr.isValid(ip)) return ip;
  const address = ipaddr.process(ip);
  return address.kind() === "ipv6"
    ? address.toByteArray().slice(0, 7).join(".")
    : address.toString();
}

export function rateLimit({
  windowMs,
  limit,
  skipSuccessfulRequests = false,
}: {
  windowMs: number;
  limit: number;
  skipSuccessfulRequests?: boolean;
}) {
  const windows = new Map<string, { hits: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
  }, windowMs).unref();

  return createMiddleware<AppEnv>(async (c, next) => {
    const now = Date.now();
    const key = clientKey(c.var.clientIp);
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { hits: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits > limit) {
      c.header("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)));
      return c.text("Too many requests, please try again later.", 429);
    }
    await next();
    if (skipSuccessfulRequests && c.res.status < 400) window.hits -= 1;
  });
}
