import crypto from "node:crypto";
import { db } from "../../config/db-sqlite.js";

export const SHARE_ORIGIN = String(process.env.AURRAL_SHARE_ORIGIN || "https://aurral.org").replace(
  /\/+$/,
  "",
);
const INSTANCE_ID_KEY = "shareInstanceId";
const INSTANCE_SECRET_KEY = "shareInstanceSecret";

const toShareLink = (row) => row && {
  id: row.id,
  token: row.token,
  userId: row.user_id,
  kind: row.kind,
  targetRef: row.target_ref,
  albumRef: row.album_ref || null,
  payload: row.payload,
  title: row.title,
  artistName: row.artist_name,
  allowDownload: row.allow_download === 1,
  expiresAt: row.expires_at ?? null,
  createdAt: row.created_at,
};

const randomId = (bytes) => crypto.randomBytes(bytes).toString("base64url");

function claimSetting(key, value) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key).value;
}

export function getShareInstance() {
  return {
    id: claimSetting(INSTANCE_ID_KEY, randomId(12)),
    secret: claimSetting(INSTANCE_SECRET_KEY, randomId(32)),
  };
}

export function shareLinkUrl(link) {
  return `${SHARE_ORIGIN}/s/${link.payload}~${getShareInstance().id}.${link.token}`;
}

export function deleteExpiredShareLinks(now = Date.now()) {
  return db.prepare("DELETE FROM share_links WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now)
    .changes;
}

export function createShareLink({
  userId,
  kind,
  targetRef,
  albumRef = null,
  payload,
  title,
  artistName,
  allowDownload,
  expiresAt,
}) {
  const row = db.prepare(
    `INSERT INTO share_links
       (token, user_id, kind, target_ref, album_ref, payload, title, artist_name,
        allow_download, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(
    randomId(16),
    userId,
    kind,
    String(targetRef),
    albumRef == null ? null : String(albumRef),
    payload,
    title,
    artistName,
    allowDownload ? 1 : 0,
    expiresAt ?? null,
    Date.now(),
  );
  return toShareLink(row);
}

export function listShareLinks(userId) {
  deleteExpiredShareLinks();
  return db.prepare("SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC, id DESC")
    .all(userId)
    .map(toShareLink);
}

export function getLiveShareLink(token) {
  const value = String(token || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) return null;
  const link = toShareLink(db.prepare("SELECT * FROM share_links WHERE token = ?").get(value));
  if (!link || (link.expiresAt != null && link.expiresAt <= Date.now())) return null;
  return link;
}

export function deleteShareLink(userId, id) {
  return db.prepare("DELETE FROM share_links WHERE id = ? AND user_id = ?").run(Number(id), userId)
    .changes > 0;
}

export function getShareLinkSchedule() {
  deleteExpiredShareLinks();
  const row = db.prepare(
    "SELECT COUNT(*) AS count, MIN(expires_at) AS next_expires_at FROM share_links",
  ).get();
  return { count: row.count, nextExpiresAt: row.next_expires_at ?? null };
}
