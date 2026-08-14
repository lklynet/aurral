import express from "express";
import { userOps, userIdentityOps } from "../db/helpers/index.js";
import { isPlexLoginEnabled } from "./users/plexLinkHandlers.js";
import {
  createSession,
  deleteSession,
  getSessionByToken,
  touchReauth,
} from "../config/session-helpers.js";
import { requireAuth, requireRecentAuth } from "../middleware/requirePermission.js";
import { getApiKey, rotateApiKey } from "../middleware/auth.js";
import { hashPassword, verifyPassword, needsRehash } from "../middleware/passwordHash.js";
import { clearOidcTransactionCookie, exchangeOidcCallback, startOidcLogin } from "../services/oidcAuth.js";
import {
  clearGoogleTransactionCookie,
  exchangeGoogleCallback,
  startGoogleAuth,
} from "../services/googleAuth.js";
import { logger } from "../services/logger.js";

const router = express.Router();

const getBearerToken = (req) => {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
};

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const user = userOps.getUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    if (user.status !== "active") {
      return res.status(403).json({ error: "This account has been suspended or disabled" });
    }
    if (needsRehash(user.passwordHash)) {
      userOps.updateUser(user.id, { passwordHash: hashPassword(password) });
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
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/logout", requireAuth, (req, res) => {
  const token = getBearerToken(req);
  if (token) {
    deleteSession(token);
  }
  res.json({ success: true });
});

router.get("/me", requireAuth, (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.json({
      user: req.user,
      expiresAt: null,
    });
  }
  const session = getSessionByToken(token);
  if (!session?.user) {
    return res.json({
      user: req.user,
      expiresAt: null,
    });
  }
  res.json({
    user: session.user,
    expiresAt: session.expiresAt,
  });
});

router.post("/reauth", requireAuth, (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(400).json({ error: "Reauthentication requires an active session" });
  }
  const user = userOps.getUserById(req.user.id);
  if (!user) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }
  if (!user.hasLocalPassword) {
    return res.status(400).json({
      error: "no_local_password",
      message: "This account has no local password. Sign out and back in to refresh your session.",
    });
  }
  const { currentPassword } = req.body || {};
  if (!verifyPassword(currentPassword || "", user.passwordHash)) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }
  touchReauth(token);
  res.json({ success: true });
});

router.get("/api-key", requireAuth, (req, res) => {
  res.json({ apiKey: getApiKey() });
});

router.post("/api-key/rotate", requireAuth, (req, res) => {
  const newKey = rotateApiKey();
  res.json({ apiKey: newKey });
});

router.get("/oidc/login", async (req, res) => {
  try {
    await startOidcLogin(req, res);
  } catch (error) {
    logger.error("auth", "OIDC login start failed:", { message: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "OIDC login failed" });
    }
  }
});

router.post("/oidc/exchange", (req, res) => {
  try {
    const result = exchangeOidcCallback(req.body?.code, req);
    clearOidcTransactionCookie(req, res);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "OIDC exchange failed" });
  }
});

router.get("/google/login", async (req, res) => {
  try {
    await startGoogleAuth(req, res, { mode: "login" });
  } catch (error) {
    logger.error("auth", "Google login start failed:", { message: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Google login failed" });
    }
  }
});

router.get("/google/link", requireAuth, requireRecentAuth(), async (req, res) => {
  try {
    await startGoogleAuth(req, res, { mode: "link", linkUserId: req.user.id });
  } catch (error) {
    logger.error("auth", "Google link start failed:", { message: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Google link failed" });
    }
  }
});

router.post("/google/exchange", (req, res) => {
  try {
    const result = exchangeGoogleCallback(req.body?.code, req);
    clearGoogleTransactionCookie(req, res);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Google exchange failed" });
  }
});

router.post("/plex/login/pin", async (req, res) => {
  try {
    if (!isPlexLoginEnabled()) {
      return res.status(404).json({ error: "Plex login is not enabled" });
    }
    const { PlexClient } = await import("../services/plex.js");
    const clientId = PlexClient.generateClientId();
    const { id, code } = await PlexClient.generatePin(clientId);
    const forwardUrl = req.body?.forwardUrl;
    res.json({
      pinId: id,
      code,
      clientId,
      authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl),
    });
  } catch (error) {
    logger.error("auth", "Plex login PIN generation failed:", error.message);
    res.status(500).json({ error: "Failed to start Plex login", message: error.message });
  }
});

router.post("/plex/login/complete", async (req, res) => {
  try {
    if (!isPlexLoginEnabled()) {
      return res.status(404).json({ error: "Plex login is not enabled" });
    }
    const { PlexClient } = await import("../services/plex.js");
    const { pinId, code, clientId } = req.body || {};
    if (!pinId || !code || !clientId) {
      return res.status(400).json({ error: "pinId, code and clientId are required" });
    }
    const token = await PlexClient.checkPin(pinId, code, clientId);
    if (!token) return res.json({ pending: true });

    const identity = await PlexClient.validateToken(token, clientId);
    const subject = identity?.id != null ? String(identity.id) : null;
    if (!subject) {
      return res.status(400).json({ error: "Could not verify the Plex account" });
    }

    const linked = userIdentityOps.findByProvider("plex", "plex", subject);
    if (!linked) {
      return res.status(403).json({
        error: "not_linked",
        message:
          "This Plex account isn't linked to an Aurral account yet. Sign in another way and link it in Settings.",
      });
    }
    const user = userOps.getUserById(linked.userId);
    if (!user) {
      return res.status(500).json({ error: "Linked Plex identity has no matching user" });
    }
    if (user.status !== "active") {
      return res.status(403).json({ error: "This account has been suspended or disabled" });
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
  } catch (error) {
    logger.error("auth", "Plex login completion failed:", error.message);
    res.status(500).json({ error: "Plex login failed", message: error.message });
  }
});

export default router;
