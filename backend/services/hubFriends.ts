import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { friendPath } from "../../lib/profilePaths.ts";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import type { HubLinksRow } from "../db/rows.ts";
import {
  authorized,
  hubLinksEnabled,
  hubRequest,
  linkedLink,
  markLinkBroken,
  refusalOf,
  selectLink,
} from "./hubLink.ts";
import { topPlaysSchema, topPlaysWithArt, withArt } from "./friendArt.ts";
import { logger } from "./logger.ts";

const HANDLE = /^[a-z0-9_]{3,20}$/;

const friendSchema = v.object({
  handle: v.string(),
  sentAt: v.nullish(v.number()),
  receivedAt: v.nullish(v.number()),
});
const trackSchema = v.object({
  title: v.string(),
  artist: v.string(),
  album: v.nullable(v.string()),
});
const listeningSchema = v.object({
  ...friendSchema.entries,
  nowPlaying: v.nullish(trackSchema),
  lastPlayed: v.nullish(v.object({ ...trackSchema.entries, at: v.number() })),
  topPlays: v.nullish(topPlaysSchema),
});
const listsSchema = v.object({
  friends: v.array(listeningSchema),
  incoming: v.array(friendSchema),
  outgoing: v.array(friendSchema),
});
const requestedSchema = v.object({ status: v.picklist(["sent", "friends"]) });
const tracksSchema = v.array(v.object({ title: v.string(), artist: v.string() }));
const friendTracksSchema = v.object({
  friends: v.array(v.object({ handle: v.string(), tracks: tracksSchema })),
});

export class FriendError extends Error {
  status: 404 | 409 | 422 | 502;
  constructor(message: string, status: FriendError["status"]) {
    super(message);
    this.status = status;
  }
}

const unreachable = () => new FriendError("Couldn't reach aurral.org. Try again.", 502);
const relink = () =>
  new FriendError("Your aurral.org link stopped working. Relink in Profile.", 409);

async function callHub(link: HubLinksRow, method: string, path: string, body?: unknown) {
  const response = await hubRequest(link.origin, path, authorized(link, method, body)).catch(
    () => null,
  );
  if (!response) throw unreachable();
  if (response.ok) return response;
  const refusal = await refusalOf(response);
  if (refusal === "link_revoked") {
    markLinkBroken(link.user_id);
    return null;
  }
  if (refusal === "no_account") {
    throw new FriendError("No one on aurral.org has that handle.", 404);
  }
  if (refusal === "self") throw new FriendError("That's your handle.", 422);
  throw unreachable();
}

function changeableLink(userId: number) {
  const link = linkedLink(userId);
  if (!link) throw new FriendError("Link an aurral.org account first.", 409);
  return link;
}

export const handleOf = (input: string) => {
  const handle = input.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE.test(handle)) throw new FriendError("No one on aurral.org has that handle.", 404);
  return handle;
};

const forgetFriendTracks = db.prepare<[number]>("DELETE FROM hub_friend_tracks WHERE user_id = ?");
const forgetTracksOf = db.prepare<[number, string]>(
  "DELETE FROM hub_friend_tracks WHERE user_id = ? AND handle = ?",
);
const keepTracksOf = db.prepare<[number, string]>(
  "DELETE FROM hub_friend_tracks WHERE user_id = ? AND handle NOT IN (SELECT value FROM json_each(?))",
);
const insertFriendTracks = db.prepare<[number, string, string, number]>(
  "INSERT INTO hub_friend_tracks (user_id, handle, tracks, fetched_at) VALUES (?, ?, ?, ?)",
);

const sharedFriendTracksStmt = db.prepare<
  [number],
  { handle: string; tracks: string; fetchedAt: number; viewer: string }
>(`
  SELECT friend.handle, friend.tracks, friend.fetched_at AS fetchedAt, viewer.username AS viewer
  FROM hub_friend_tracks AS friend
  JOIN hub_links AS link ON link.user_id = friend.user_id
    AND link.linked_at IS NOT NULL AND link.broken = 0 AND link.share_listening = 1
  JOIN users AS viewer ON viewer.id = friend.user_id
  WHERE friend.user_id = ?
  ORDER BY friend.handle
`);

export function sharedFriendTracks(userId: number) {
  if (!hubLinksEnabled()) return [];
  return sharedFriendTracksStmt.all(userId).flatMap((row) => {
    let tracks: unknown = null;
    try {
      tracks = JSON.parse(row.tracks);
    } catch {}
    const parsed = v.safeParse(tracksSchema, tracks);
    return parsed.success ? [{ ...row, tracks: parsed.output }] : [];
  });
}

export type FriendTracks = ReturnType<typeof sharedFriendTracks>[number];

const keepSharingFriends = (userId: number, friends: v.InferOutput<typeof listeningSchema>[]) =>
  keepTracksOf.run(
    userId,
    JSON.stringify(friends.filter(({ topPlays }) => topPlays).map(({ handle }) => handle)),
  );

async function refreshFriendTracks(link: HubLinksRow, now = Date.now()) {
  const response = await callHub(link, "GET", "/v1/friends/blend-tracks").catch(
    quietly("friends' tracks"),
  );
  const parsed =
    response && v.safeParse(friendTracksSchema, await response.json().catch(() => null));
  if (!parsed?.success) return;
  db.transaction(() => {
    forgetFriendTracks.run(link.user_id);
    for (const { handle, tracks } of parsed.output.friends) {
      insertFriendTracks.run(link.user_id, handle, JSON.stringify(tracks), now);
    }
  })();
}

export async function friendLists(userId: number) {
  if (!hubLinksEnabled()) return { state: "off" as const };
  const link = selectLink.get(userId);
  if (!link?.linked_at) return { state: "none" as const };
  const response = link.broken ? null : await callHub(link, "GET", "/v1/friends");
  if (!response) return { state: "broken" as const };
  const lists = v.safeParse(listsSchema, await response.json().catch(() => null));
  if (!lists.success) throw unreachable();
  const { friends, incoming, outgoing } = lists.output;
  return {
    state: "linked" as const,
    sharing: link.share_listening === 1,
    friends: friends.map(({ handle, nowPlaying, lastPlayed, topPlays }) => ({
      handle,
      nowPlaying: nowPlaying ? withArt(nowPlaying) : null,
      lastPlayed: lastPlayed ? withArt(lastPlayed) : null,
      topPlays: topPlays ? topPlaysWithArt(topPlays) : null,
    })),
    incoming: incoming.map(({ handle }) => ({ handle })),
    outgoing: outgoing.map(({ handle }) => ({ handle })),
  };
}

const requestKey = (handle: string) => `request:${handle}`;
const forgetRequest = db.prepare<[number, string]>(
  "DELETE FROM inbox_items WHERE user_id = ? AND kind = 'friend' AND source_key = ?",
);
const forgetAnsweredRequests = db.prepare<[number, string]>(
  `DELETE FROM inbox_items WHERE user_id = ? AND kind = 'friend' AND source_key LIKE 'request:%'
     AND source_key NOT IN (SELECT value FROM json_each(?))`,
);

export async function addFriend(userId: number, input: string) {
  if (!hubLinksEnabled()) throw new FriendError("aurral.org accounts are turned off.", 409);
  const link = changeableLink(userId);
  const handle = handleOf(input);
  const response = await callHub(link, "PUT", `/v1/friends/${handle}`);
  if (!response) throw relink();
  const added = v.safeParse(requestedSchema, await response.json().catch(() => null));
  if (!added.success) throw unreachable();
  forgetRequest.run(userId, requestKey(handle));
  const sharing = added.output.status === "friends" && sharingLink(userId);
  if (sharing) await refreshFriendTracks(sharing);
  return added.output;
}

export async function removeFriend(userId: number, input: string) {
  const link = changeableLink(userId);
  const handle = handleOf(input);
  if (!(await callHub(link, "DELETE", `/v1/friends/${handle}`))) throw relink();
  forgetRequest.run(userId, requestKey(handle));
  forgetTracksOf.run(userId, handle);
}

const NOTICE_EVERY_MS = 15 * 60_000;
const ACCEPTED_WITHIN_MS = 7 * 86_400_000;
const NOTICE_TTL_MS = 30 * 86_400_000;
const noticeChecks = new Map<number, number>();

export async function refreshFriendNotices(userId: number, now = Date.now()) {
  if (now - (noticeChecks.get(userId) ?? -Infinity) < NOTICE_EVERY_MS) return;
  noticeChecks.set(userId, now);
  if (!hubLinksEnabled()) return;
  const link = linkedLink(userId);
  if (!link) return;
  const response = await callHub(link, "GET", "/v1/friends").catch(quietly("friend requests"));
  const lists = response && v.safeParse(listsSchema, await response.json().catch(() => null));
  if (!lists?.success) return;
  const { friends, incoming } = lists.output;
  keepSharingFriends(userId, friends);
  const accepted = friends.filter(
    ({ sentAt, receivedAt }) => sentAt != null && receivedAt != null && receivedAt > sentAt,
  );
  db.transaction(() => {
    forgetAnsweredRequests.run(
      userId,
      JSON.stringify(incoming.map(({ handle }) => requestKey(handle))),
    );
    for (const { handle, receivedAt } of incoming) {
      dbOps.upsertInboxItem({
        userId,
        kind: "friend",
        sourceKey: requestKey(handle),
        title: `@${handle}`,
        subtitle: "Wants to be friends",
        href: friendPath(handle),
        metadata: { handle, request: true, at: receivedAt ?? null },
      });
    }
    for (const { handle, receivedAt } of accepted) {
      if (receivedAt == null || receivedAt < now - ACCEPTED_WITHIN_MS) continue;
      dbOps.upsertInboxItem({
        userId,
        kind: "friend",
        sourceKey: `accepted:${handle}:${receivedAt}`,
        title: `@${handle}`,
        subtitle: "Accepted your friend request",
        href: friendPath(handle),
        metadata: { handle, at: receivedAt },
        expiresAt: receivedAt + NOTICE_TTL_MS,
      });
    }
  })();
}

const setSharing = db.prepare<[number, number]>(
  "UPDATE hub_links SET share_listening = ? WHERE user_id = ?",
);
const sharingUsers = db
  .prepare<[], number>(
    "SELECT user_id FROM hub_links WHERE linked_at IS NOT NULL AND broken = 0 AND share_listening = 1",
  )
  .pluck();

const sharingLink = (userId: number) => {
  if (!hubLinksEnabled()) return null;
  const link = linkedLink(userId);
  return link?.share_listening ? link : null;
};

const quietly = (what: string) => (error: unknown) => {
  logger.info("friends", `aurral.org didn't take ${what}`, { error: asAppError(error)?.message });
};

export async function shareNowPlaying(
  userId: number,
  track: { title: string; artist: string; album: string | null; durationMs: number | null },
) {
  const link = sharingLink(userId);
  if (link) {
    await callHub(link, "PUT", "/v1/listening/now-playing", track).catch(quietly("now playing"));
  }
}

async function shareTopPlays(link: HubLinksRow) {
  const { sharedTopPlaysOf } = await import("./wrapped/topPlays.ts");
  const snapshot = sharedTopPlaysOf(link.user_id);
  await callHub(link, "PUT", "/v1/listening/top-plays", snapshot).catch(quietly("top plays"));
}

export async function shareAllTopPlays() {
  const links = sharingUsers.all().flatMap((userId) => sharingLink(userId) ?? []);
  for (const link of links) await shareTopPlays(link);
  for (const link of links) await refreshFriendTracks(link);
}

export async function shareListening(userId: number, shared: boolean) {
  const link = selectLink.get(userId);
  if (!link?.linked_at) throw new FriendError("Link an aurral.org account first.", 409);
  setSharing.run(shared ? 1 : 0, userId);
  if (!shared) forgetFriendTracks.run(userId);
  if (shared) {
    const sharing = sharingLink(userId);
    if (sharing) {
      await shareTopPlays(sharing);
      await refreshFriendTracks(sharing);
    }
    return;
  }
  if (link.broken) return;
  try {
    await callHub(link, "DELETE", "/v1/listening");
  } catch (error) {
    setSharing.run(link.share_listening, userId);
    throw error;
  }
}
