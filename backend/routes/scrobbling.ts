import { Hono } from "hono";
import * as v from "valibot";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../config/db-sqlite.ts";
import {
  getLastfmApiKey,
  getLastfmApiSecret,
  lastfmGetSession,
  listenbrainzValidateToken,
} from "../services/apiClients/index.ts";
import { userOps } from "../db/helpers/index.ts";
import { requireAuth, requirePermission, requireUserAccount } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { getKoitoListenBrainzBaseUrl, normalizeKoitoBaseUrl } from "../services/koitoClient.ts";
import {
  getScrobbleEncryptionKey,
  scrobbleConnectionStore,
} from "../services/scrobbleConnectionStore.ts";
import { logger } from "../services/logger.ts";
import { asAppError } from "../../lib/errors.ts";

const LASTFM_LINK_COOKIE = "aurral_lastfm_link";
const LASTFM_LINK_TTL_MS = 10 * 60 * 1000;
const providerErrorStatus = (error: unknown) => {
  const status = Number(asAppError(error)?.response?.status);
  return status >= 400 && status < 500 ? 400 : 502;
};
const encode = (value: string) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(String(value || ""), "base64url").toString("utf8");
const hash = (value: string) =>
  createHash("sha256")
    .update(String(value || ""))
    .digest("hex");

const insertLinkStateStmt = db.prepare(`
  INSERT INTO lastfm_link_states
    (token_hash, user_id, browser_nonce_hash, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const pruneLinkStatesStmt = db.prepare(
  "DELETE FROM lastfm_link_states WHERE expires_at <= ? OR consumed_at IS NOT NULL",
);
const consumeLinkStateStmt = db.prepare(`
  UPDATE lastfm_link_states
  SET consumed_at = ?
  WHERE token_hash = ? AND user_id = ? AND browser_nonce_hash = ?
    AND expires_at > ? AND consumed_at IS NULL
`);

const createLinkToken = (userId: number) => {
  const payload = `${userId}.${Date.now() + 10 * 60 * 1000}.${randomBytes(12).toString("hex")}`;
  const signature = createHmac("sha256", getScrobbleEncryptionKey())
    .update(payload)
    .digest("base64url");
  return `${encode(payload)}.${signature}`;
};

const verifyLinkToken = (token: string) => {
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) return null;
  const payload = decode(encodedPayload);
  const expected = createHmac("sha256", getScrobbleEncryptionKey())
    .update(payload)
    .digest("base64url");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  const [userId, expiresAt] = payload.split(".");
  if (!Number.isFinite(Number(userId)) || Number(expiresAt) <= Date.now()) return null;
  return Math.trunc(Number(userId));
};

const createLinkState = (userId: number) => {
  const token = createLinkToken(userId);
  const browserNonce = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + LASTFM_LINK_TTL_MS;
  db.transaction(() => {
    pruneLinkStatesStmt.run(Date.now());
    insertLinkStateStmt.run(hash(token), userId, hash(browserNonce), expiresAt, Date.now());
  })();
  return { token, browserNonce };
};

export const consumeLinkState = (token: string, userId: number, browserNonce: string) => {
  if (!token || !Number.isFinite(Number(userId)) || !browserNonce) return false;
  return (
    consumeLinkStateStmt.run(
      Date.now(),
      hash(token),
      Math.trunc(Number(userId)),
      hash(browserNonce),
      Date.now(),
    ).changes === 1
  );
};

const readCookie = (header: string | undefined, name: string) => {
  const entry = String(header || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return "";
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return "";
  }
};

const linkCookie = (
  secure: boolean,
  value: string,
  maxAge = Math.floor(LASTFM_LINK_TTL_MS / 1000),
) => {
  const attributes = [
    "Path=/api/scrobbling/lastfm/link/callback",
    `Max-Age=${Math.max(0, Math.trunc(maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return `${LASTFM_LINK_COOKIE}=${encodeURIComponent(value)}; ${attributes.join("; ")}`;
};

const normalizeLinkToken = (value: unknown) => {
  const token = String(value || "").trim();
  return token.includes(".") ? token : decode(token);
};

const callbackUrl = (request: { protocol: string; host: string | undefined }, token: string) => {
  const configuredOrigin = String(process.env.AURRAL_PUBLIC_URL || "").trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        return `${url.origin}/api/scrobbling/lastfm/link/callback?uid=${encodeURIComponent(token)}`;
      }
    } catch {}
  }
  const protocol = String(request.protocol || "http").trim();
  const host = String(request.host || "").trim();
  return `${protocol}://${host}/api/scrobbling/lastfm/link/callback?uid=${encodeURIComponent(token)}`;
};

const callbackQuery = v.object({ uid: v.optional(v.string()), token: v.optional(v.string()) });
const tokenBody = v.object({ token: v.optional(v.string()) });
const koitoBody = v.object({ url: v.optional(v.string()), token: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/scrobbling")
  .get("/status", requireAuth, (c) => {
    const status = scrobbleConnectionStore.getPublicStatus(c.var.user.id);
    status.lastfm.configured = Boolean(getLastfmApiKey() && getLastfmApiSecret());
    return c.json(status, 200);
  })
  .get("/lastfm/link", requireAuth, requireUserAccount, (c) => {
    const apiKey = getLastfmApiKey();
    if (!apiKey || !getLastfmApiSecret()) {
      return c.json({ error: "Last.fm API key and secret are required first." }, 400);
    }
    const { token, browserNonce } = createLinkState(c.var.user.id);
    c.header("Set-Cookie", linkCookie(c.var.protocol === "https", browserNonce));
    const callback = callbackUrl({ protocol: c.var.protocol, host: c.req.header("host") }, token);
    return c.json(
      {
        configured: true as const,
        connected: scrobbleConnectionStore.getConnection(c.var.user.id, "lastfm") != null,
        authorizeUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&cb=${encodeURIComponent(callback)}`,
      },
      200,
    );
  })
  .get("/lastfm/link/callback", validate("query", callbackQuery), async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Set-Cookie", linkCookie(c.var.protocol === "https", "", 0));
    const query = c.req.valid("query");
    const stateToken = normalizeLinkToken(query.uid);
    const token = (query.token || "").trim();
    if (!stateToken || !token) {
      return c.html("Invalid Last.fm link state", 400);
    }

    let userId;
    try {
      userId = verifyLinkToken(stateToken);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("scrobbling", "Last.fm link state verification failed", {
        message: failure?.message || String(error),
      });
      return c.html("Last.fm connection failed", 500);
    }
    if (
      userId == null ||
      !consumeLinkState(stateToken, userId, readCookie(c.req.header("cookie"), LASTFM_LINK_COOKIE))
    ) {
      return c.html("Invalid Last.fm link state", 400);
    }

    let session;
    try {
      session = await lastfmGetSession(token);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("scrobbling", "Last.fm session exchange failed", {
        message: failure?.message || String(error),
        status: failure?.response?.status || null,
      });
      const status = providerErrorStatus(error);
      return c.html(
        status === 400 ? "Last.fm authorization failed" : "Last.fm is unavailable",
        status,
      );
    }
    const key = session?.session?.key;
    if (!key) {
      return c.html("Last.fm did not return a session", 400);
    }
    try {
      scrobbleConnectionStore.saveConnection(userId, "lastfm", {
        token: key,
        displayName: session.session.name,
      });
    } catch (error) {
      const failure = asAppError(error);
      logger.error("scrobbling", "Last.fm connection could not be saved", {
        message: failure?.message || String(error),
      });
      return c.html("Last.fm connection could not be saved", 500);
    }
    return c.html("<p>Last.fm connected. You can close this window.</p>", 200);
  })
  .delete("/lastfm/link", requireAuth, (c) => {
    scrobbleConnectionStore.deleteConnection(c.var.user.id, "lastfm");
    return c.body(null, 204);
  })
  .get("/listenbrainz/link", requireAuth, (c) => {
    const connection = scrobbleConnectionStore.getConnection(c.var.user.id, "listenbrainz");
    return c.json(
      { connected: Boolean(connection), displayName: connection?.displayName || null },
      200,
    );
  })
  .put(
    "/listenbrainz/link",
    requireAuth,
    requireUserAccount,
    validate("json", tokenBody),
    async (c) => {
      const token = (c.req.valid("json").token || "").trim();
      if (!token) return c.json({ error: "Token is required" }, 400);
      let validation;
      try {
        validation = await listenbrainzValidateToken(token);
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("scrobbling", "ListenBrainz token validation failed", {
          message: failure?.message || String(error),
          status: failure?.response?.status || null,
        });
        const status = providerErrorStatus(error);
        return c.json(
          { error: status === 400 ? "Invalid token" : "ListenBrainz is unavailable" },
          status,
        );
      }
      if (!validation?.valid) return c.json({ error: "Invalid token" }, 400);
      try {
        const connection = scrobbleConnectionStore.saveConnection(c.var.user.id, "listenbrainz", {
          token,
          displayName: validation.user_name,
        });
        return c.json({ connected: true as const, displayName: connection!.displayName }, 200);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("scrobbling", "ListenBrainz connection could not be saved", {
          message: failure?.message || String(error),
        });
        return c.json({ error: "ListenBrainz connection could not be saved" }, 500);
      }
    },
  )
  .delete("/listenbrainz/link", requireAuth, (c) => {
    scrobbleConnectionStore.deleteConnection(c.var.user.id, "listenbrainz");
    return c.body(null, 204);
  })
  .put(
    "/koito/link",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("json", koitoBody),
    async (c) => {
      const body = c.req.valid("json");
      const rawUrl = (
        body.url ||
        userOps.getUserById(c.var.user.id)?.listenHistoryUrl ||
        ""
      ).trim();
      const validation = validateExternalUrl(rawUrl);
      const token = (body.token || "").trim();
      if (!validation.valid || !token) {
        return c.json({ error: validation.error || "Token is required" }, 400);
      }
      const baseUrl = normalizeKoitoBaseUrl(validation.url);
      try {
        const tokenValidation = await listenbrainzValidateToken(
          token,
          getKoitoListenBrainzBaseUrl(baseUrl),
        );
        if (!tokenValidation?.valid) return c.json({ error: "Invalid Koito API key" }, 400);
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("scrobbling", "Koito token validation failed", {
          message: failure?.message || String(error),
          status: failure?.response?.status || null,
        });
        const status = providerErrorStatus(error);
        return c.json(
          { error: status === 400 ? "Invalid Koito API key" : "Koito is unavailable" },
          status,
        );
      }
      try {
        const connection = scrobbleConnectionStore.saveConnection(c.var.user.id, "koito", {
          token,
          baseUrl,
          displayName: new URL(baseUrl).host,
        });
        return c.json({ connected: true as const, displayName: connection!.displayName }, 200);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("scrobbling", "Koito connection could not be saved", {
          message: failure?.message || String(error),
        });
        return c.json({ error: "Koito connection could not be saved" }, 500);
      }
    },
  )
  .delete("/koito/link", requireAuth, (c) => {
    scrobbleConnectionStore.deleteConnection(c.var.user.id, "koito");
    return c.body(null, 204);
  });
