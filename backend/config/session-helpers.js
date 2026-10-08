import crypto from "crypto";
import { db } from "./db-sqlite.js";
import { userOps } from "../db/helpers/index.js";

const DEFAULT_EXPIRY_HOURS = 24 * 30;

const insertSessionStmt = db.prepare(
  "INSERT INTO sessions (user_id, token, created_at, expires_at, ip_address, user_agent, reauthenticated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const getSessionByTokenStmt = db.prepare("SELECT * FROM sessions WHERE token = ? LIMIT 1");
const deleteSessionByTokenStmt = db.prepare("DELETE FROM sessions WHERE token = ?");
const deleteSessionsByUserIdStmt = db.prepare("DELETE FROM sessions WHERE user_id = ?");
const deleteExpiredSessionsStmt = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
const touchReauthStmt = db.prepare("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?");

const getSessionExpiryMs = () => {
  const hours = Number(process.env.SESSION_EXPIRY_HOURS);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_EXPIRY_HOURS;
  return safeHours * 60 * 60 * 1000;
};

const toUserPayload = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
  };
};

export const createSession = (userId, ipAddress = null, userAgent = null) => {
  const now = Date.now();
  const expiresAt = now + getSessionExpiryMs();
  const token = crypto.randomBytes(32).toString("hex");
  insertSessionStmt.run(
    Number(userId),
    token,
    now,
    expiresAt,
    ipAddress ? String(ipAddress).slice(0, 255) : null,
    userAgent ? String(userAgent).slice(0, 1024) : null,
    now,
  );
  return {
    token,
    expiresAt,
  };
};

export const touchReauth = (token) => {
  const rawToken = String(token || "").trim();
  if (!rawToken) return false;
  const result = touchReauthStmt.run(Date.now(), rawToken);
  return result.changes > 0;
};

export const getSessionByToken = (token) => {
  const rawToken = String(token || "").trim();
  if (!rawToken) return null;
  const row = getSessionByTokenStmt.get(rawToken);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    deleteSessionByTokenStmt.run(rawToken);
    return null;
  }
  const user = userOps.getUserAuthById(row.user_id);
  if (!user || user.status !== "active") {
    deleteSessionByTokenStmt.run(rawToken);
    return null;
  }
  return {
    id: row.id,
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    reauthenticatedAt: row.reauthenticated_at || row.created_at,
    user: toUserPayload(user),
  };
};

export const deleteSession = (token) => {
  const result = deleteSessionByTokenStmt.run(String(token || "").trim());
  return result.changes > 0;
};

export const deleteSessionsByUserId = (userId) => {
  const result = deleteSessionsByUserIdStmt.run(Number(userId));
  return result.changes;
};

export const cleanExpiredSessions = () => {
  const result = deleteExpiredSessionsStmt.run(Date.now());
  return result.changes;
};
