import { createHash, randomBytes } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type { PluginDevKeysRow } from "../../db/rows.ts";
import { logger } from "../logger.ts";

const KEY_PREFIX = "aurral_dev_";
const KEY_TTL_MS = 24 * 60 * 60_000;

const insertKey = db.prepare<[string, string, number, number]>(
  "INSERT INTO plugin_dev_keys (key_hash, hint, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const selectKeys = db.prepare<[number], PluginDevKeysRow>(
  "SELECT * FROM plugin_dev_keys WHERE expires_at > ? ORDER BY created_at DESC",
);
const selectKey = db.prepare<[string, number], PluginDevKeysRow>(
  "SELECT * FROM plugin_dev_keys WHERE key_hash = ? AND expires_at > ?",
);
const touchKey = db.prepare<[number, number]>(
  "UPDATE plugin_dev_keys SET last_used_at = ? WHERE id = ?",
);
const deleteKey = db.prepare<[number]>("DELETE FROM plugin_dev_keys WHERE id = ?");
const deleteExpired = db.prepare<[number]>("DELETE FROM plugin_dev_keys WHERE expires_at <= ?");

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export function createPluginDevKey() {
  const now = Date.now();
  deleteExpired.run(now);
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  insertKey.run(hash(key), key.slice(-4), now, now + KEY_TTL_MS);
  logger.info("plugins", "Plugin developer key created");
  return { key, expiresAt: now + KEY_TTL_MS };
}

export function listPluginDevKeys() {
  return selectKeys.all(Date.now()).map((row) => ({
    id: row.id,
    hint: row.hint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  }));
}

export function revokePluginDevKey(id: number) {
  deleteKey.run(id);
  logger.info("plugins", "Plugin developer key revoked");
}

export function verifyPluginDevKey(key: string | null | undefined) {
  if (!key?.startsWith(KEY_PREFIX)) return false;
  const row = selectKey.get(hash(key), Date.now());
  if (!row) return false;
  touchKey.run(Date.now(), row.id);
  return true;
}
