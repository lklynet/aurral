import { Hono, type Context } from "hono";
import * as v from "valibot";
import { userOps } from "../db/helpers/index.ts";
import {
  createSession,
  deleteSession,
  deleteUserSession,
  getSessionByToken,
  isSessionLive,
  listUserSessions,
  touchReauth,
} from "../config/session-helpers.ts";
import {
  requireAdmin,
  requireAuth,
  requireRecentAuth,
  requireUserAccount,
} from "../middleware/guards.ts";
import {
  getApiKey,
  isApiKeyManagedByEnv,
  rotateApiKey,
  buildPermissions,
} from "../services/auth.ts";
import { hashPassword, verifyPassword, needsRehash } from "../services/passwordHash.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import {
  OIDC_APP_REDIRECTS,
  clearedOidcTransactionCookie,
  exchangeOidcCallback,
  startOidcLogin,
} from "../services/oidcAuth.ts";
import {
  clearedGoogleTransactionCookie,
  exchangeGoogleCallback,
  startGoogleAuth,
} from "../services/googleAuth.ts";
import { logger } from "../services/logger.ts";
import { consumePairingCode, createPairingCode } from "../services/pairingCodes.ts";
import { websocketService } from "../services/websocketService.ts";
import { appOrigin } from "../middleware/security.ts";
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
const oidcExchangeBody = v.object({
  code: v.optional(v.string()),
  code_verifier: v.optional(v.string()),
});
const oidcLoginQuery = v.pipe(
  v.object({
    app_redirect: v.optional(v.picklist(OIDC_APP_REDIRECTS)),
    code_challenge: v.optional(v.pipe(v.string(), v.regex(/^[\w-]{43}$/))),
  }),
  v.check(
    (query) => !query.app_redirect === !query.code_challenge,
    "app_redirect and code_challenge go together",
  ),
);
const pairBody = v.object({ code: v.string() });
const sessionParam = v.object({ id: v.pipe(v.string(), v.toNumber(), v.integer()) });

type SignedInUser = NonNullable<ReturnType<typeof userOps.getUserById>>;

const signedIn = <E extends AppEnv>(
  c: Context<E>,
  user: SignedInUser,
  reauthenticated: boolean,
) => {
  const session = createSession(
    user.id,
    c.var.clientIp || null,
    c.req.header("user-agent") || null,
    { reauthenticated },
  );
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: buildPermissions(user.role, user.permissions),
    },
  };
};

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
      return c.json(signedIn(c, user, true), 200);
    } catch {
      return c.json({ error: "Login failed" }, 500);
    }
  })
  .post("/pair", validate("json", pairBody), (c) => {
    const issued = consumePairingCode(c.req.valid("json").code);
    const user =
      issued && isSessionLive(issued.sessionId) ? userOps.getUserById(issued.userId) : null;
    if (!user || user.status !== "active") {
      return c.json({ error: "That code is wrong or has expired" }, 401);
    }
    return c.json(signedIn(c, user, false), 200);
  })
  .post("/pairing-codes", requireAuth, (c) => {
    const session = getSessionByToken(bearerToken(c));
    if (!session) {
      return c.json(
        { error: "session_required", message: "Sign in with your password to pair a device" },
        403,
      );
    }
    return c.json(createPairingCode(session.userId, session.id), 201);
  })
  .get("/sessions", requireAuth, requireUserAccount, (c) => {
    const current = getSessionByToken(bearerToken(c))?.id ?? null;
    const sessions = listUserSessions(c.var.user.id).map((row) => ({
      id: row.id,
      userAgent: row.user_agent,
      lastUsedAt: row.last_used_at ?? row.created_at,
      current: row.id === current,
    }));
    return c.json({ sessions, appOrigin }, 200);
  })
  .delete(
    "/sessions/:id",
    requireAuth,
    requireUserAccount,
    validate("param", sessionParam),
    (c) => {
      const token = deleteUserSession(c.var.user.id, c.req.valid("param").id);
      if (!token) return c.json({ error: "Not found" }, 404);
      websocketService.disconnectSession(token);
      return c.json({ success: true }, 200);
    },
  )
  .post("/logout", requireAuth, (c) => {
    const token = bearerToken(c);
    if (token && deleteSession(token)) websocketService.disconnectSession(token);
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
  .get("/api-key", requireAuth, requireAdmin, (c) =>
    c.json({ apiKey: getApiKey(), managedByEnv: isApiKeyManagedByEnv() }, 200),
  )
  .post("/api-key/rotate", requireAuth, requireAdmin, (c) => {
    if (isApiKeyManagedByEnv()) {
      return c.json({ error: "API key is set by AURRAL_API_KEY and cannot be rotated" }, 409);
    }
    return c.json({ apiKey: rotateApiKey() }, 200);
  })
  .get("/oidc/login", validate("query", oidcLoginQuery), async (c) => {
    try {
      const { app_redirect: redirect, code_challenge: codeChallenge } = c.req.valid("query");
      const login = await startOidcLogin({
        secure: isSecure(c),
        app: redirect && codeChallenge ? { redirect, codeChallenge } : null,
      });
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
  .post("/oidc/exchange", validate("json", oidcExchangeBody), (c) => {
    try {
      const { code, code_verifier: codeVerifier } = c.req.valid("json");
      const result = exchangeOidcCallback(code, exchangeRequest(c), codeVerifier);
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
  });
