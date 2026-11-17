import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { normalizeHandle } from "./handles.ts";
import { friendsListening } from "./listening.ts";

type FriendRequest = "sent" | "friends" | "missing" | "self";

const accountOf = (db: D1Database, handle: string) =>
  db
    .prepare("SELECT account_id FROM handles WHERE handle = ? AND account_id IS NOT NULL")
    .bind(normalizeHandle(handle))
    .first<string>("account_id");

const wants = (db: D1Database, accountId: string, friendId: string) =>
  db
    .prepare("SELECT 1 FROM friends WHERE account_id = ? AND friend_id = ?")
    .bind(accountId, friendId)
    .first();

export async function requestFriend(
  db: D1Database,
  accountId: string,
  handle: string,
  now = Date.now(),
): Promise<FriendRequest> {
  const friendId = await accountOf(db, handle);
  if (!friendId) return "missing";
  if (friendId === accountId) return "self";
  await db
    .prepare("INSERT OR IGNORE INTO friends (account_id, friend_id, created_at) VALUES (?, ?, ?)")
    .bind(accountId, friendId, now)
    .run();
  return (await wants(db, friendId, accountId)) ? "friends" : "sent";
}

export async function removeFriend(db: D1Database, accountId: string, handle: string) {
  const friendId = await accountOf(db, handle);
  if (!friendId) return;
  await db
    .prepare(
      "DELETE FROM friends WHERE (account_id = ?1 AND friend_id = ?2) OR (account_id = ?2 AND friend_id = ?1)",
    )
    .bind(accountId, friendId)
    .run();
}

export async function friendLists(db: D1Database, accountId: string) {
  const { results } = await db
    .prepare(
      `SELECT handles.handle,
         EXISTS (SELECT 1 FROM friends WHERE account_id = ?1 AND friend_id = other) AS sent,
         EXISTS (SELECT 1 FROM friends WHERE account_id = other AND friend_id = ?1) AS received
       FROM (
         SELECT friend_id AS other FROM friends WHERE account_id = ?1
         UNION SELECT account_id FROM friends WHERE friend_id = ?1
       )
       JOIN handles ON handles.account_id = other
       ORDER BY handles.handle`,
    )
    .bind(accountId)
    .all<{ handle: string; sent: number; received: number }>();
  const where = (keep: (row: (typeof results)[number]) => boolean) =>
    results.filter(keep).map(({ handle }) => ({ handle }));
  const listening = await friendsListening(db, accountId);
  return {
    friends: where((row) => Boolean(row.sent && row.received)).map(({ handle }) => ({
      handle,
      nowPlaying: listening.get(handle)?.nowPlaying ?? null,
      topPlays: listening.get(handle)?.topPlays ?? null,
    })),
    incoming: where((row) => !row.sent),
    outgoing: where((row) => !row.received),
  };
}
