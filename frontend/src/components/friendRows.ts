import type { InferResponseType } from "hono/client";
import type { peopleClient } from "../utils/api/clients/people.ts";
import { friendPath, personPath } from "../../../lib/profilePaths.ts";

type LocalPerson = InferResponseType<typeof peopleClient.$get>["people"][number];
type LastPlayed = LocalPerson["lastPlayed"];
type HubFriend = {
  handle: string;
  nowPlaying?: LocalPerson["nowPlaying"];
  lastPlayed?: LastPlayed | null;
};

const latest = (...plays: (LastPlayed | null | undefined)[]) =>
  plays.reduce<LastPlayed | null>(
    (found, play) => (play && (!found || play.at > found.at) ? play : found),
    null,
  );

export function mergeFriendRows(local: LocalPerson[], hub: HubFriend[]) {
  const byHandle = new Map(hub.map((friend) => [friend.handle, friend]));
  const localHandles = new Set(local.flatMap((person) => (person.handle ? [person.handle] : [])));
  return [
    ...local.map((person) => {
      const friend = person.handle ? byHandle.get(person.handle) : undefined;
      return {
        key: `local:${person.id}`,
        name: person.username,
        local: true,
        to: personPath(person.username),
        nowPlaying: person.nowPlaying ?? friend?.nowPlaying ?? null,
        lastPlayed: latest(person.lastPlayed, friend?.lastPlayed),
      };
    }),
    ...hub
      .filter((friend) => !localHandles.has(friend.handle))
      .map((friend) => ({
        key: `hub:${friend.handle}`,
        name: `@${friend.handle}`,
        local: false,
        to: friendPath(friend.handle),
        nowPlaying: friend.nowPlaying ?? null,
        lastPlayed: friend.lastPlayed ?? null,
      })),
  ].sort(
    (left, right) =>
      Number(!!right.nowPlaying) - Number(!!left.nowPlaying) ||
      (right.lastPlayed?.at ?? 0) - (left.lastPlayed?.at ?? 0),
  );
}
