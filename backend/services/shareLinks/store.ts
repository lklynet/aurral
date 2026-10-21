import crypto from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type { SettingsRow, ShareLinksRow } from "../../db/rows.ts";

export const SHARE_ORIGIN = String(process.env.AURRAL_SHARE_ORIGIN || "https://aurral.org").replace(
  /\/+$/,
  "",
);
const INSTANCE_ID_KEY = "shareInstanceId";
const INSTANCE_SECRET_KEY = "shareInstanceSecret";

type ShareLink = NonNullable<ReturnType<typeof toShareLink>>;

const toShareLink = (row: ShareLinksRow | undefined) =>
  row && {
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

const randomId = (bytes: number) => crypto.randomBytes(bytes).toString("base64url");

function claimSetting(key: string, value: string) {
  db.prepare<[string, string]>("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
  return db
    .prepare<[string], Pick<SettingsRow, "value">>("SELECT value FROM settings WHERE key = ?")
    .get(key)!.value;
}

export function getShareInstance() {
  return {
    id: claimSetting(INSTANCE_ID_KEY, randomId(12)),
    secret: claimSetting(INSTANCE_SECRET_KEY, randomId(32)),
  };
}

export function shareLinkUrl(link: ShareLink) {
  return `${SHARE_ORIGIN}/s/${link.payload}~${getShareInstance().id}.${link.token}`;
}

export function deleteExpiredShareLinks(now = Date.now()) {
  return db
    .prepare("DELETE FROM share_links WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(now).changes;
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
}: {
  userId: number;
  kind: string;
  targetRef: string;
  albumRef?: string | null;
  payload: string;
  title: string;
  artistName: string;
  allowDownload: boolean;
  expiresAt: number | null;
}) {
  const row = db
    .prepare<
      [
        string,
        number,
        string,
        string,
        string | null,
        string,
        string,
        string,
        number,
        number | null,
        number,
      ],
      ShareLinksRow
    >(
      `INSERT INTO share_links
       (token, user_id, kind, target_ref, album_ref, payload, title, artist_name,
        allow_download, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    )
    .get(
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

export function listShareLinks(userId: number) {
  deleteExpiredShareLinks();
  return db
    .prepare<[number], ShareLinksRow>(
      "SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all(userId)
    .map(toShareLink);
}

export function getLiveShareLink(token: string | undefined) {
  const value = String(token || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) return null;
  const link = toShareLink(
    db.prepare<[string], ShareLinksRow>("SELECT * FROM share_links WHERE token = ?").get(value),
  );
  if (!link || (link.expiresAt != null && link.expiresAt <= Date.now())) return null;
  return link;
}

export function deleteShareLink(userId: number, id: string) {
  return (
    db
      .prepare<[number, number]>("DELETE FROM share_links WHERE id = ? AND user_id = ?")
      .run(Number(id), userId).changes > 0
  );
}

export function getShareLinkSchedule() {
  deleteExpiredShareLinks();
  const row = db
    .prepare<[], { count: number; next_expires_at: number | null }>(
      "SELECT COUNT(*) AS count, MIN(expires_at) AS next_expires_at FROM share_links",
    )
    .get()!;
  return { count: row.count, nextExpiresAt: row.next_expires_at ?? null };
}
