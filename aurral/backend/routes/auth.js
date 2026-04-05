import express from "express";
import bcrypt from "bcrypt";
import { userOps } from "../config/db-helpers.js";
import { createSession, deleteSession, getSessionByToken } from "../config/session-helpers.js";
import { requireAuth } from "../middleware/requirePermission.js";

const router = express.Router();

const getBearerToken = (req) => {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
};

router.post("/login", (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password are required" });
    }
    const user = userOps.getUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const session = createSession(
      user.id,
      req.ip || null,
      req.headers["user-agent"] || null,
    );
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

export default router;