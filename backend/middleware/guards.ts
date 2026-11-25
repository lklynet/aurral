import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { dbOps } from "../db/helpers/index.ts";
import type { Permission } from "../db/helpers/users.ts";
import { requestCredentials } from "../routes/shared/requestCredentials.ts";
import {
  getUnauthorizedDetails,
  hasPermission,
  isAuthRequiredByConfig,
  isCrossSite,
  isRecentlyAuthenticated,
  resolveRequestUser,
  resolveTokenUser,
} from "../services/auth.ts";
import type { AppEnv, RequestUser } from "./requestUser.ts";

type SignedIn = AppEnv & { Variables: { user: RequestUser } };

const unauthorized = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "Unauthorized", ...getUnauthorizedDetails(c.req.header("authorization")) }, 401);

export const requireAuth = createMiddleware<SignedIn>(async (c, next) => {
  if (!c.get("user")) return unauthorized(c);
  await next();
});

export const requireAdmin = createMiddleware<SignedIn>(async (c, next) => {
  if (c.get("user")?.role !== "admin") {
    return c.json({ error: "Forbidden", message: "Admin access required" }, 403);
  }
  await next();
});

export const requireUserAccount = createMiddleware<SignedIn>(async (c, next) => {
  const userId = Number(c.get("user")?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return c.json(
      {
        error: "User account required",
        message: "Authenticate as a user account before using this endpoint.",
      },
      403,
    );
  }
  await next();
});

export const requirePermission = (permission: Permission) =>
  createMiddleware<SignedIn>(async (c, next) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    if (!hasPermission(user, permission)) {
      return c.json({ error: "Forbidden", message: `Permission required: ${permission}` }, 403);
    }
    await next();
  });

export const requireRecentAuth = (maxAgeMinutes?: number) =>
  createMiddleware<SignedIn>(async (c, next) => {
    if (!c.get("user")) return unauthorized(c);
    if (!isRecentlyAuthenticated(c.req.header("authorization"), maxAgeMinutes)) {
      return c.json(
        { error: "reauth_required", message: "Please confirm your credentials to continue" },
        401,
      );
    }
    await next();
  });

export const requireStreamAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user") && (c.var.viaConnect || isAuthRequiredByConfig())) {
    return c.json({ error: "Unauthorized", message: "Authentication required" }, 401);
  }
  await next();
});

const openPaths = new Set([
  "/api/health",
  "/api/health/live",
  "/api/health/bootstrap",
  "/api/filesystem/browse",
  "/api/filesystem/ensure",
  "/api/auth/login",
  "/api/auth/pair",
  "/api/auth/connect-exchange",
  "/api/auth/oidc/login",
  "/api/auth/oidc/exchange",
  "/api/auth/google/login",
  "/api/auth/google/exchange",
  "/api/mcp",
]);

const connectOpenPaths = new Set([
  "/api/health",
  "/api/health/live",
  "/api/health/bootstrap",
  "/api/auth/login",
  "/api/auth/pair",
  "/api/auth/connect-exchange",
]);

const isOpen = (method: string, path: string) =>
  openPaths.has(path) ||
  ((method === "GET" || method === "HEAD") &&
    (path.startsWith("/api/image-proxy/") || path.startsWith("/api/deezer/preview/"))) ||
  (method === "GET" && /^\/api\/feeds\/lidarr\/flows\/[^/]+\.json$/i.test(path));

const isConnectOpen = (method: string, path: string) =>
  connectOpenPaths.has(path) ||
  ((method === "GET" || method === "HEAD") &&
    (path.startsWith("/api/image-proxy/") || path.startsWith("/api/deezer/preview/")));

const tokenPaths = [
  /^\/api\/library\/stream\/[^/]+\/[^/]+$/i,
  /^\/api\/library\/file-stream\/[^/]+\/[^/]+$/i,
  /^\/api\/playlists\/stream\/[^/]+$/i,
  /^\/api\/playlists\/staging-stream\/[^/]+$/i,
  /^\/api\/deezer\/preview$/i,
];

const tokenArtworkPaths = [
  /^\/api\/library\/(?:albums|artists)\/[1-9]\d*\/cover$/i,
  /^\/api\/library\/artwork\/(?:album|track)\/[^/]+$/i,
  /^\/api\/playlists\/artwork\/[^/]+(?:\/preview)?$/i,
  /^\/api\/playlists\/track-artwork\/[^/]+$/i,
  /^\/api\/playlists\/flow-templates\/[^/]+\/cover$/i,
  /^\/api\/discover\/playlists\/[^/]+\/[^/]+\/cover$/i,
  /^\/api\/artists\/release-group\/[a-f0-9-]{36}\/cover\/image$/i,
  /^\/api\/artists\/[a-f0-9-]{36}\/image$/i,
  /^\/api\/hub-link\/friends\/art$/i,
];

const acceptsLinkToken = (method: string, path: string) =>
  tokenPaths.some((pattern) => pattern.test(path)) ||
  (method === "GET" && tokenArtworkPaths.some((pattern) => pattern.test(path)));

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const { method, path } = c.req;
  if (!path.startsWith("/api") || isOpen(method, path)) return next();
  const credentials = requestCredentials(c);
  const crossSite = isCrossSite(credentials);
  const linkToken = acceptsLinkToken(method, path);
  if (!crossSite && !linkToken) {
    if (path.startsWith("/api/onboarding") && !dbOps.getSettings().onboardingComplete) {
      return next();
    }
    if (!isAuthRequiredByConfig()) return next();
  }
  const user = linkToken ? resolveTokenUser(credentials) : resolveRequestUser(credentials);
  if (user) {
    c.set("user", user);
    c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  } else if (crossSite || !linkToken) return unauthorized(c);
  return next();
});

export const authenticateConnect = createMiddleware<AppEnv>(async (c, next) => {
  const { method, path } = c.req;
  if (!path.startsWith("/api") || isConnectOpen(method, path)) return next();
  const credentials = requestCredentials(c);
  const linkToken = acceptsLinkToken(method, path);
  const user = linkToken ? resolveTokenUser(credentials) : resolveRequestUser(credentials);
  if (user) {
    c.set("user", user);
    c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return next();
  }
  return unauthorized(c);
});
