import { Hono, type Context } from "hono";
import * as v from "valibot";
import { userOps, userIdentityOps } from "../db/helpers/index.ts";
import {
  createSession,
  deleteSession,
  getSessionByToken,
  touchReauth,
} from "../config/session-helpers.ts";
import { requireAdmin, requireAuth, requireRecentAuth } from "../middleware/guards.ts";
import { getApiKey, rotateApiKey } from "../middleware/auth.ts";
import { hashPassword, verifyPassword, needsRehash } from "../middleware/passwordHash.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import {
  clearedOidcTransactionCookie,
  exchangeOidcCallback,
  startOidcLogin,
} from "../services/oidcAuth.ts";
import {
  clearedGoogleTransactionCookie,
  exchangeGoogleCallback,
  startGoogleAuth,
} from "../services/googleAuth.ts";
import {
  clearedPlexLoginCookie,
  endPlexLogin,
  getPendingPlexLogin,
  isSafeForwardUrl,
  readPlexLoginTransaction,
  startPlexLogin,
} from "../services/plexLoginAuth.ts";
import { logger } from "../services/logger.ts";
import { isPlexLoginEnabled } from "./users/plexLinkHandlers.ts";
import { isErrorStatus } from "./shared/errorStatus.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";

const bearerToken = <E extends AppEnv>(c: Context<E>) => {
  const header = c.req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

const isSecure = <E extends AppEnv>(c: Context<E>) => c.var.protocol === "https";

const exchangeRequest = <E extends AppEnv>(c: Context<E>) => ({
  cookie: c.req.header("cookie"),
  ip: c.var.clientIp || null,
  userAgent: c.req.header("user-agent") || null,
});

const exchangeStatus = (failure: AppError | undefined) =>
  isErrorStatus(failure?.status) ? failure.status : 500;

const loginBody = v.object({
  username: v.optional(v.string()),
  password: v.optional(v.string()),
});
const reauthBody = v.object({ currentPassword: v.optional(v.string()) });
const exchangeBody = v.object({ code: v.optional(v.string()) });
const plexPinBody = v.object({ forwardUrl: v.nullish(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/auth")
  .post("/login", validate("json", loginBody), (c) => {
    try {
      const body = c.req.valid("json");
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";
      if (!username || !password) {
        return c.json({ error: "Username and password are required" }, 400);
      }
      const user = userOps.getUserByUsername(username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return c.json({ error: "Invalid username or password" }, 401);
      }
      if (user.status !== "active") {
        return c.json({ error: "This account has been suspended or disabled" }, 403);
      }
      const updates: Parameters<typeof userOps.updateUser>[1] = { subsonicPassword: password };
      if (needsRehash(user.passwordHash)) {
        updates.passwordHash = hashPassword(password);
      }
      if (!user.hasLocalPassword) {
        updates.hasLocalPassword = true;
      }
      userOps.updateUser(user.id, updates);
      const session = createSession(
        user.id,
        c.var.clientIp || null,
        c.req.header("user-agent") || null,
      );
      return c.json(
        {
          token: session.token,
          expiresAt: session.expiresAt,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
          },
        },
        200,
      );
    } catch {
      return c.json({ error: "Login failed" }, 500);
    }
  })
  .post("/logout", requireAuth, (c) => {
    const token = bearerToken(c);
    if (token) {
      deleteSession(token);
    }
    return c.json({ success: true }, 200);
  })
  .get("/me", requireAuth, (c) => {
    const token = bearerToken(c);
    const session = token ? getSessionByToken(token) : null;
    if (!session?.user) {
      return c.json({ user: c.var.user, expiresAt: null }, 200);
    }
    return c.json({ user: session.user, expiresAt: session.expiresAt }, 200);
  })
  .post("/reauth", requireAuth, validate("json", reauthBody), (c) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: "Reauthentication requires an active session" }, 400);
    }
    const user = userOps.getUserById(c.var.user.id);
    if (!user) {
      return c.json({ error: "Current password is incorrect" }, 400);
    }
    if (!user.hasLocalPassword) {
      return c.json(
        {
          error: "no_local_password",
          message:
            "This account has no local password. Sign out and back in to refresh your session.",
        },
        400,
      );
    }
    if (!verifyPassword(c.req.valid("json").currentPassword || "", user.passwordHash)) {
      return c.json({ error: "Current password is incorrect" }, 400);
    }
    touchReauth(token);
    return c.json({ success: true }, 200);
  })
  .get("/api-key", requireAuth, requireAdmin, (c) => c.json({ apiKey: getApiKey() }, 200))
  .post("/api-key/rotate", requireAuth, requireAdmin, (c) =>
    c.json({ apiKey: rotateApiKey() }, 200),
  )
  .get("/oidc/login", async (c) => {
    try {
      const login = await startOidcLogin({ secure: isSecure(c) });
      if (!login) return c.json({ error: "OIDC is not enabled" }, 404);
      c.header("Set-Cookie", login.cookie);
      return c.redirect(login.authUrl, 302);
    } catch (error) {
      logger.error("auth", "OIDC login start failed:", { message: asAppError(error)?.message });
      return c.json({ error: "OIDC login failed" }, 500);
    }
  })
  .post("/oidc/link/start", requireAuth, requireRecentAuth(), async (c) => {
    try {
      const login = await startOidcLogin({
        mode: "link",
        linkUserId: c.var.user.id,
        secure: isSecure(c),
      });
      if (!login) return c.json({ error: "OIDC is not enabled" }, 404);
      c.header("Set-Cookie", login.cookie);
      return c.json({ authUrl: login.authUrl }, 200);
    } catch (error) {
      logger.error("auth", "OIDC link start failed:", { message: asAppError(error)?.message });
      return c.json({ error: "Single sign-on link failed" }, 500);
    }
  })
  .post("/oidc/exchange", validate("json", exchangeBody), (c) => {
    try {
      const result = exchangeOidcCallback(c.req.valid("json").code, exchangeRequest(c));
      c.header("Set-Cookie", clearedOidcTransactionCookie(isSecure(c)));
      return c.json(result, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json({ error: failure?.message || "OIDC exchange failed" }, exchangeStatus(failure));
    }
  })
  .get("/google/login", async (c) => {
    try {
      const login = await startGoogleAuth({ mode: "login", secure: isSecure(c) });
      if (!login) return c.json({ error: "Google login is not enabled" }, 404);
      c.header("Set-Cookie", login.cookie);
      return c.redirect(login.authUrl, 302);
    } catch (error) {
      logger.error("auth", "Google login start failed:", { message: asAppError(error)?.message });
      return c.json({ error: "Google login failed" }, 500);
    }
  })
  .get("/google/link", requireAuth, requireRecentAuth(), async (c) => {
    try {
      const login = await startGoogleAuth({
        mode: "link",
        linkUserId: c.var.user.id,
        secure: isSecure(c),
      });
      if (!login) return c.json({ error: "Google login is not enabled" }, 404);
      c.header("Set-Cookie", login.cookie);
      return c.redirect(login.authUrl, 302);
    } catch (error) {
      logger.error("auth", "Google link start failed:", { message: asAppError(error)?.message });
      return c.json({ error: "Google link failed" }, 500);
    }
  })
  .post("/google/link/start", requireAuth, requireRecentAuth(), async (c) => {
    try {
      const login = await startGoogleAuth({
        mode: "link",
        linkUserId: c.var.user.id,
        secure: isSecure(c),
      });
      if (!login) return c.json({ error: "Google login is not enabled" }, 404);
      c.header("Set-Cookie", login.cookie);
      return c.json({ authUrl: login.authUrl }, 200);
    } catch (error) {
      logger.error("auth", "Google link start failed:", { message: asAppError(error)?.message });
      return c.json({ error: "Google link failed" }, 500);
    }
  })
  .post("/google/exchange", validate("json", exchangeBody), (c) => {
    try {
      const result = exchangeGoogleCallback(c.req.valid("json").code, exchangeRequest(c));
      c.header("Set-Cookie", clearedGoogleTransactionCookie(isSecure(c)));
      return c.json(result, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: failure?.message || "Google exchange failed" },
        exchangeStatus(failure),
      );
    }
  })
  .post("/plex/login/pin", validate("json", plexPinBody), async (c) => {
    try {
      if (!isPlexLoginEnabled()) return c.json({ error: "Plex login is not enabled" }, 404);
      const { forwardUrl } = c.req.valid("json");
      if (forwardUrl != null && !isSafeForwardUrl(forwardUrl)) {
        return c.json({ error: "Invalid forward URL" }, 400);
      }
      const login = await startPlexLogin(forwardUrl, isSecure(c));
      c.header("Set-Cookie", login.cookie);
      return c.json({ authUrl: login.authUrl }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("auth", "Plex login PIN generation failed:", failure?.message);
      return c.json({ error: "Failed to start Plex login", message: failure?.message }, 500);
    }
  })
  .post("/plex/login/complete", async (c) => {
    try {
      if (!isPlexLoginEnabled()) return c.json({ error: "Plex login is not enabled" }, 404);
      const transactionId = readPlexLoginTransaction(c.req.header("cookie"));
      const pending = getPendingPlexLogin(transactionId);
      if (!pending) return c.json({ error: "Plex login session expired" }, 400);

      const { PlexClient } = await import("../services/plex.ts");
      const token = await PlexClient.checkPin(pending.pinId, pending.code, pending.clientId);
      if (!token) return c.json({ pending: true }, 200);

      let identity;
      try {
        identity = await PlexClient.validateToken(token, pending.clientId, {
          throwOnTransient: true,
        });
      } catch {
        return c.json(
          { error: "Plex account validation is temporarily unavailable", retryable: true },
          503,
        );
      }
      endPlexLogin(transactionId);
      c.header("Set-Cookie", clearedPlexLoginCookie(isSecure(c)));
      const subject = identity?.id != null ? String(identity.id) : null;
      if (!subject) return c.json({ error: "Could not verify the Plex account" }, 400);

      const linked = userIdentityOps.findByProvider("plex", "plex", subject);
      if (!linked) {
        return c.json(
          {
            error: "not_linked",
            message: "Plex account not linked. Sign in another way and link Plex in Profile.",
          },
          403,
        );
      }
      const user = userOps.getUserById(linked.userId);
      if (!user) return c.json({ error: "Linked Plex identity has no matching user" }, 500);
      if (user.status !== "active") {
        return c.json({ error: "This account has been suspended or disabled" }, 403);
      }

      const session = createSession(
        user.id,
        c.var.clientIp || null,
        c.req.header("user-agent") || null,
      );
      return c.json(
        {
          token: session.token,
          expiresAt: session.expiresAt,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
          },
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("auth", "Plex login completion failed:", failure?.message);
      return c.json({ error: "Plex login failed", message: failure?.message }, 500);
    }
  });
