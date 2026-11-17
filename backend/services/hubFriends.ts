import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { db } from "../config/db-sqlite.ts";
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
import { logger } from "./logger.ts";

const HANDLE = /^[a-z0-9_]{3,20}$/;
const TOP_PLAYS_DAYS = 30;
const TOP_TRACKS = 10;
const DAY_MS = 86_400_000;

const friendSchema = v.object({ handle: v.string() });
const ranked = <Entries extends v.ObjectEntries>(entries: Entries) =>
  v.array(v.object({ ...entries, plays: v.number() }));
const listeningSchema = v.object({
  ...friendSchema.entries,
  nowPlaying: v.nullish(
    v.object({ title: v.string(), artist: v.string(), album: v.nullable(v.string()) }),
  ),
  topPlays: v.nullish(
    v.object({
      artists: ranked({ name: v.string() }),
      albums: ranked({ title: v.string(), artist: v.string() }),
      tracks: ranked({ title: v.string(), artist: v.string() }),
    }),
  ),
});
const listsSchema = v.object({
  friends: v.array(listeningSchema),
  incoming: v.array(friendSchema),
  outgoing: v.array(friendSchema),
});
const requestedSchema = v.object({ status: v.picklist(["sent", "friends"]) });

export class FriendError extends Error {
  status: 404 | 409 | 422 | 502;
  constructor(message: string, status: FriendError["status"]) {
    super(message);
    this.status = status;
  }
}

const friendArtUrl = (artist: string, album?: string | null) =>
  `/api/hub-link/friends/art?${new URLSearchParams(album ? { artist, album } : { artist })}`;

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

const handleOf = (input: string) => {
  const handle = input.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE.test(handle)) throw new FriendError("No one on aurral.org has that handle.", 404);
  return handle;
};

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
    friends: friends.map(({ handle, nowPlaying, topPlays }) => ({
      handle,
      nowPlaying: nowPlaying
        ? { ...nowPlaying, artworkUrl: friendArtUrl(nowPlaying.artist, nowPlaying.album) }
        : null,
      topPlays: topPlays
        ? {
            artists: topPlays.artists.map((artist) => ({
              ...artist,
              artworkUrl: friendArtUrl(artist.name),
            })),
            albums: topPlays.albums.map((album) => ({
              ...album,
              artworkUrl: friendArtUrl(album.artist, album.title),
            })),
            tracks: topPlays.tracks,
          }
        : null,
    })),
    incoming,
    outgoing,
  };
}

export async function addFriend(userId: number, input: string) {
  if (!hubLinksEnabled()) throw new FriendError("aurral.org accounts are turned off.", 409);
  const link = changeableLink(userId);
  const response = await callHub(link, "PUT", `/v1/friends/${handleOf(input)}`);
  if (!response) throw relink();
  const added = v.safeParse(requestedSchema, await response.json().catch(() => null));
  if (!added.success) throw unreachable();
  return added.output;
}

export async function removeFriend(userId: number, input: string) {
  const link = changeableLink(userId);
  if (!(await callHub(link, "DELETE", `/v1/friends/${handleOf(input)}`))) throw relink();
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
  const { readLocalWrappedHistory } = await import("./wrapped/history.ts");
  const { calculateWrapped } = await import("./wrapped/metrics.ts");
  const now = Date.now();
  const period = {
    year: new Date(now).getUTCFullYear(),
    timeZone: "UTC",
    start: now - TOP_PLAYS_DAYS * DAY_MS,
    end: now,
  };
  const top = calculateWrapped(readLocalWrappedHistory(link.user_id, period), period);
  const snapshot = {
    artists: top.topArtists.map(({ name, plays }) => ({ name, plays })),
    albums: top.topAlbums.map(({ name, artist, plays }) => ({ title: name, artist, plays })),
    tracks: top.topSongs
      .slice(0, TOP_TRACKS)
      .map(({ name, artist, plays }) => ({ title: name, artist, plays })),
  };
  await callHub(link, "PUT", "/v1/listening/top-plays", snapshot).catch(quietly("top plays"));
}

export async function shareAllTopPlays() {
  for (const userId of sharingUsers.all()) {
    const link = sharingLink(userId);
    if (link) await shareTopPlays(link);
  }
}

export async function shareListening(userId: number, shared: boolean) {
  const link = selectLink.get(userId);
  if (!link?.linked_at) throw new FriendError("Link an aurral.org account first.", 409);
  setSharing.run(shared ? 1 : 0, userId);
  if (shared) {
    const sharing = sharingLink(userId);
    if (sharing) await shareTopPlays(sharing);
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
