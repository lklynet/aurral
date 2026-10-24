import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Permission } from "../db/helpers/users.ts";
import {
  getUnauthorizedDetails,
  hasPermission,
  isAuthRequiredByConfig,
  isRecentlyAuthenticated,
} from "./auth.ts";
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
  if (!c.get("user") && isAuthRequiredByConfig()) {
    return c.json({ error: "Unauthorized", message: "Authentication required" }, 401);
  }
  await next();
});
