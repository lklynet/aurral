import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../config/db-sqlite.js";
import { userOps } from "../db/helpers/index.js";

const SECRET_PATTERN = /^aurral_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_MS = 60_000;
const deviceFields = "a.id, a.user_id AS userId, a.name, a.created_at AS createdAt, a.last_used_at AS lastUsedAt, u.username";

const insertStmt = db.prepare("INSERT INTO app_passwords (id, user_id, name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)");
const listAllStmt = db.prepare(`SELECT ${deviceFields} FROM app_passwords a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC, a.id`);
const listByUserStmt = db.prepare(`SELECT ${deviceFields} FROM app_passwords a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? ORDER BY a.created_at DESC, a.id`);
const getOwnerStmt = db.prepare("SELECT user_id FROM app_passwords WHERE id = ?");
const getByHashStmt = db.prepare("SELECT id FROM app_passwords WHERE secret_hash = ?");
const touchStmt = db.prepare("UPDATE app_passwords SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)");
const deleteStmt = db.prepare("DELETE FROM app_passwords WHERE id = ? RETURNING user_id AS userId");
const deleteOwnedStmt = db.prepare("DELETE FROM app_passwords WHERE id = ? AND user_id = ? RETURNING user_id AS userId");

const hashSecret = (secret) => createHash("sha256").update(secret).digest("hex");

export const isAppPasswordSecret = (value) => typeof value === "string" && SECRET_PATTERN.test(value);

export function createAppPassword(userId, name) {
  const secret = `aurral_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  insertStmt.run(id, userId, name, hashSecret(secret), Date.now());
  return { device: listByUserStmt.all(userId).find((device) => device.id === id), secret };
}

export function listAppPasswords(userId = null) {
  return userId === null ? listAllStmt.all() : listByUserStmt.all(userId);
}

export function getAppPasswordUser(id) {
  const device = getOwnerStmt.get(id);
  const user = device && userOps.getUserById(device.user_id);
  if (!user || user.status !== "active") return null;
  const now = Date.now();
  touchStmt.run(now, id, now - LAST_USED_RESOLUTION_MS);
  return { user, appPasswordId: id };
}

export function resolveAppPassword(secret, username = null) {
  if (!isAppPasswordSecret(secret)) return null;
  const device = getByHashStmt.get(hashSecret(secret));
  const resolved = device && getAppPasswordUser(device.id);
  if (!resolved || (username !== null && resolved.user.username !== String(username).trim().toLowerCase())) return null;
  return resolved;
}

export function revokeAppPassword(id, userId = null) {
  return (userId === null ? deleteStmt.get(id) : deleteOwnedStmt.get(id, userId)) || null;
}
