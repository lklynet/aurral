import type { D1Database } from "@cloudflare/workers-types/index.ts";

export const LINK_CODE_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export const normalizeCode = (input: string | undefined) => {
  const code = (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_PATTERN.test(code) ? code : null;
};

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => CODE_ALPHABET[byte % 32]).join(
    "",
  );

export async function startLink(
  db: D1Database,
  link: { instanceId: string; userName: string; tokenHash: string },
  now = Date.now(),
) {
  const expiresAt = now + LINK_CODE_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const userCode = newCode();
    const [, inserted] = await db.batch([
      db.prepare("DELETE FROM links WHERE account_id IS NULL AND expires_at <= ?").bind(now),
      db
        .prepare(
          "INSERT INTO links (id, instance_id, user_name, token_hash, user_code, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(
          crypto.randomUUID(),
          link.instanceId,
          link.userName,
          link.tokenHash,
          userCode,
          expiresAt,
        ),
    ]);
    if (inserted?.meta.changes) return { userCode: formatCode(userCode), expiresAt };
  }
  return null;
}

export async function linkStatus(db: D1Database, tokenHash: string, now = Date.now()) {
  const row = await db
    .prepare(
      "SELECT links.account_id, links.expires_at, handles.handle FROM links LEFT JOIN handles ON handles.account_id = links.account_id WHERE links.token_hash = ?",
    )
    .bind(tokenHash)
    .first<{ account_id: string | null; expires_at: number | null; handle: string | null }>();
  if (!row) return null;
  if (row.account_id && row.handle) return { status: "linked" as const, handle: row.handle };
  if (!row.account_id && row.expires_at && row.expires_at > now) {
    return { status: "pending" as const, expiresAt: row.expires_at };
  }
  return null;
}

export const linkedAccountId = (db: D1Database, tokenHash: string) =>
  db
    .prepare("SELECT account_id FROM links WHERE token_hash = ? AND account_id IS NOT NULL")
    .bind(tokenHash)
    .first<string>("account_id");

export const revokeLink = (db: D1Database, instanceId: string, tokenHash: string) =>
  db
    .prepare("DELETE FROM links WHERE instance_id = ? AND token_hash = ?")
    .bind(instanceId, tokenHash)
    .run();

export const pendingLink = (db: D1Database, code: string, now = Date.now()) =>
  db
    .prepare(
      "SELECT user_name FROM links WHERE user_code = ? AND account_id IS NULL AND expires_at > ?",
    )
    .bind(code, now)
    .first<string>("user_name");

export async function approveLink(
  db: D1Database,
  code: string,
  accountId: string,
  now = Date.now(),
) {
  const result = await db
    .prepare(
      "UPDATE links SET account_id = ?, linked_at = ?, user_code = NULL, expires_at = NULL WHERE user_code = ? AND account_id IS NULL AND expires_at > ?",
    )
    .bind(accountId, now, code, now)
    .run();
  return result.meta.changes > 0;
}

const PUBLIC_COUNT =
  "(SELECT COUNT(*) FROM publications WHERE publications.link_id = links.id AND publications.delisted = 0) AS public_count";

type LinkSummary = { id: string; user_name: string; linked_at: number; public_count: number };

export const accountLinks = async (db: D1Database, accountId: string) =>
  (
    await db
      .prepare(
        `SELECT id, user_name, linked_at, ${PUBLIC_COUNT} FROM links WHERE account_id = ? ORDER BY linked_at DESC`,
      )
      .bind(accountId)
      .all<LinkSummary>()
  ).results;

export const accountLink = (db: D1Database, accountId: string, id: string) =>
  db
    .prepare(
      `SELECT id, user_name, linked_at, ${PUBLIC_COUNT} FROM links WHERE account_id = ? AND id = ?`,
    )
    .bind(accountId, id)
    .first<LinkSummary>();

export const unlinkForAccount = (db: D1Database, accountId: string, id: string) =>
  db.prepare("DELETE FROM links WHERE account_id = ? AND id = ?").bind(accountId, id).run();
