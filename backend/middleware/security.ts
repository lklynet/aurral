import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./requestUser.ts";

const isPublic = (c: Context<AppEnv>) => {
  const { method, path } = c.req;
  return (
    path === "/rest" ||
    path.startsWith("/rest/") ||
    ((method === "GET" || method === "HEAD") && path.startsWith("/api/image-proxy/"))
  );
};

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const corsHeaders = createMiddleware<AppEnv>(async (c, next) => {
  const publicRoute = isPublic(c);
  if (!publicRoute && allowedOrigins.length === 0) return next();
  const origin = c.req.header("origin") ?? "";
  const allowOrigin = publicRoute ? "*" : allowedOrigins.includes(origin) ? origin : null;
  if (allowOrigin) c.res.headers.set("Access-Control-Allow-Origin", allowOrigin);
  if (!publicRoute) c.res.headers.append("Vary", "Origin");
  if (c.req.method !== "OPTIONS") return next();
  c.res.headers.set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return c.body(null, 204);
});

const connectSources = [
  "'self'",
  "ws:",
  "wss:",
  "https://api.github.com",
  process.env.AUTH_PROXY_DOMAIN,
  process.env.OIDC_DOMAIN,
].filter(Boolean);

const headers = Object.entries({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources.join(" ")}`,
    "media-src 'self' data: blob: https:",
    "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",
  ].join(";"),
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-XSS-Protection": "0",
});

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  for (const [name, value] of headers) c.res.headers.set(name, value);
  c.res.headers.set("Cross-Origin-Resource-Policy", isPublic(c) ? "cross-origin" : "same-origin");
  await next();
});
