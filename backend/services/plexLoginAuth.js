import crypto from "crypto";
import { createSession } from "../config/session-helpers.js";
import { userOps, userIdentityOps } from "../db/helpers/index.js";
import { isPlexLoginEnabled } from "../routes/users/plexLinkHandlers.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const TRANSACTION_COOKIE = "aurral_plex_login_transaction";
const pendingLogins = new Map();

function prunePendingLogins(now = Date.now()) {
  for (const [transactionId, entry] of pendingLogins) {
    if (!entry || entry.expiresAt <= now) pendingLogins.delete(transactionId);
  }
}

function getTransactionCookie(req) {
  const cookies = String(req.headers?.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name !== TRANSACTION_COOKIE) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function setTransactionCookie(req, res, value, maxAge) {
  const secure = req.secure || req.protocol === "https";
  const attributes = [
    `${TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (maxAge != null) attributes.push(`Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearTransactionCookie(req, res) {
  setTransactionCookie(req, res, "", 0);
}

function isSafeForwardUrl(forwardUrl) {
  const value = String(forwardUrl || "");
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const base = "https://aurral.invalid";
    return new URL(value, base).origin === base;
  } catch {
    return false;
  }
}

export async function startPlexLogin(req, res) {
  if (!isPlexLoginEnabled()) {
    res.status(404).json({ error: "Plex login is not enabled" });
    return;
  }
  const forwardUrl = req.body?.forwardUrl;
  if (forwardUrl != null && !isSafeForwardUrl(forwardUrl)) {
    res.status(400).json({ error: "Invalid forward URL" });
    return;
  }

  const { PlexClient } = await import("./plex.js");
  const clientId = PlexClient.generateClientId();
  const { id: pinId, code } = await PlexClient.generatePin(clientId);
  const transactionId = crypto.randomBytes(24).toString("hex");

  prunePendingLogins();
  pendingLogins.set(transactionId, {
    pinId,
    code,
    clientId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  setTransactionCookie(req, res, transactionId, Math.floor(STATE_TTL_MS / 1000));
  res.json({ authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl) });
}

export async function completePlexLogin(req, res) {
  if (!isPlexLoginEnabled()) {
    res.status(404).json({ error: "Plex login is not enabled" });
    return;
  }

  const transactionId = getTransactionCookie(req);
  prunePendingLogins();
  const pending = transactionId ? pendingLogins.get(transactionId) : null;
  if (!pending || pending.expiresAt <= Date.now()) {
    res.status(400).json({ error: "Plex login session expired" });
    return;
  }

  const { PlexClient } = await import("./plex.js");
  const token = await PlexClient.checkPin(pending.pinId, pending.code, pending.clientId);
  if (!token) {
    res.json({ pending: true });
    return;
  }

  pendingLogins.delete(transactionId);
  clearTransactionCookie(req, res);

  const identity = await PlexClient.validateToken(token, pending.clientId);
  const subject = identity?.id != null ? String(identity.id) : null;
  if (!subject) {
    res.status(400).json({ error: "Could not verify the Plex account" });
    return;
  }

  const linked = userIdentityOps.findByProvider("plex", "plex", subject);
  if (!linked) {
    res.status(403).json({
      error: "not_linked",
      message:
        "This Plex account isn't linked to an Aurral account yet. Sign in another way and link it in Settings.",
    });
    return;
  }
  const user = userOps.getUserById(linked.userId);
  if (!user) {
    res.status(500).json({ error: "Linked Plex identity has no matching user" });
    return;
  }
  if (user.status !== "active") {
    res.status(403).json({ error: "This account has been suspended or disabled" });
    return;
  }

  const session = createSession(user.id, req.ip || null, req.headers["user-agent"] || null);
  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
    },
  });
}

export function resetPlexLoginStateForTests() {
  pendingLogins.clear();
}
