import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";

export const HANDLE_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

const HANDLE = /^[a-z0-9_]{3,20}$/;

const OFFICIAL_NAMES = ["aurral", "lklynet"];

const RESERVED = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "official",
  "staff",
  "mod",
  "moderator",
  "team",
  "api",
  "www",
  "account",
  "settings",
  "link",
  "null",
  "undefined",
  "lidarr",
  "brainzmash",
]);

const profanity = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export const allowedText = (value: string) => !profanity.hasMatch(value);

export type HandleClaim = "claimed" | "invalid" | "reserved" | "not_allowed" | "taken";

export const normalizeHandle = (input: string) => input.trim().replace(/^@/, "").toLowerCase();

export function checkHandle(handle: string): HandleClaim | null {
  if (!HANDLE.test(handle)) return "invalid";
  if (RESERVED.has(handle) || OFFICIAL_NAMES.some((name) => handle.includes(name))) {
    return "reserved";
  }
  if (profanity.hasMatch(handle)) return "not_allowed";
  return null;
}

export async function claimHandle(
  db: D1Database,
  accountId: string,
  input: string,
  now = Date.now(),
): Promise<HandleClaim> {
  const handle = normalizeHandle(input);
  const problem = checkHandle(handle);
  if (problem) return problem;
  const claimed = await db
    .prepare(
      `INSERT INTO handles (handle, account_id, released_at)
       SELECT ?1, ?2, NULL WHERE NOT EXISTS (SELECT 1 FROM handles WHERE account_id = ?2)
       ON CONFLICT (handle) DO UPDATE SET account_id = excluded.account_id, released_at = NULL
       WHERE handles.account_id IS NULL AND handles.released_at <= ?3`,
    )
    .bind(handle, accountId, now - HANDLE_HOLD_MS)
    .run();
  return claimed.meta.changes > 0 ? "claimed" : "taken";
}

export const handleOf = (db: D1Database, accountId: string) =>
  db
    .prepare("SELECT handle FROM handles WHERE account_id = ?")
    .bind(accountId)
    .first<string>("handle");

export const deleteAccount = (db: D1Database, accountId: string, now = Date.now()) =>
  db.batch([
    db
      .prepare("UPDATE handles SET account_id = NULL, released_at = ? WHERE account_id = ?")
      .bind(now, accountId),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);
