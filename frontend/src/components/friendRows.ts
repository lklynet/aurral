import type { InferResponseType } from "hono/client";
import type { peopleClient } from "../utils/api/clients/people.ts";

type LocalPerson = InferResponseType<typeof peopleClient.$get>["people"][number];
type HubFriend = { handle: string; nowPlaying?: LocalPerson["nowPlaying"] };

export const friendPath = (handle: string) => `/friends/${encodeURIComponent(handle)}`;
export const personPath = (username: string) => `/people/${encodeURIComponent(username)}`;

export function mergeFriendRows(local: LocalPerson[], hub: HubFriend[]) {
  const hubPlaying = new Map(hub.map((friend) => [friend.handle, friend.nowPlaying ?? null]));
  const localHandles = new Set(local.flatMap((person) => (person.handle ? [person.handle] : [])));
  return [
    ...local.map((person) => ({
      key: `local:${person.id}`,
      name: person.username,
      local: true,
      to: personPath(person.username),
      nowPlaying:
        person.nowPlaying ?? (person.handle ? (hubPlaying.get(person.handle) ?? null) : null),
      lastPlayedAt: person.lastPlayedAt,
    })),
    ...hub
      .filter((friend) => !localHandles.has(friend.handle))
      .map((friend) => ({
        key: `hub:${friend.handle}`,
        name: `@${friend.handle}`,
        local: false,
        to: friendPath(friend.handle),
        nowPlaying: friend.nowPlaying ?? null,
        lastPlayedAt: 0,
      })),
  ].sort(
    (left, right) =>
      Number(!!right.nowPlaying) - Number(!!left.nowPlaying) ||
      right.lastPlayedAt - left.lastPlayedAt,
  );
}
