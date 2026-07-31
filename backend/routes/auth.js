import express from "express";
import { userOps } from "../db/helpers/index.js";
import { createSession, deleteSession, getSessionByToken } from "../config/session-helpers.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { getApiKey, rotateApiKey } from "../middleware/auth.js";
import { hashPassword, verifyPassword, needsRehash } from "../middleware/passwordHash.js";

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

router.get("/api-key", requireAuth, (req, res) => {
  res.json({ apiKey: getApiKey() });
});

router.post("/api-key/rotate", requireAuth, (req, res) => {
  const newKey = rotateApiKey();
  res.json({ apiKey: newKey });
});

export default router;
