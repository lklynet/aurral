import type { RequestUser } from "../middleware/requestUser.ts";
import { getPersonPlaylists } from "./discovery/browsePlaylists.ts";
import { sharesListening, visiblePeople } from "./discovery/mixes.ts";
import { friendArtUrl, topPlaysWithArt } from "./friendArt.ts";
import { localNowPlaying } from "./localNowPlaying.ts";
import { topPlaysOf } from "./wrapped/topPlays.ts";

export function listPeople(userId: number, now = Date.now()) {
  return {
    sharing: sharesListening(userId),
    people: visiblePeople(userId, now).map(({ id, username, handle, lastPlayedAt }) => {
      const nowPlaying = localNowPlaying(id, now);
      return {
        id,
        username,
        handle,
        lastPlayedAt,
        nowPlaying: nowPlaying && {
          ...nowPlaying,
          artworkUrl: friendArtUrl(nowPlaying.artist, nowPlaying.album),
        },
      };
    }),
  };
}

export async function personProfile(user: RequestUser, username: string, now = Date.now()) {
  const name = username.toLowerCase();
  const person = visiblePeople(user.id, now).find((each) => each.username.toLowerCase() === name);
  if (!person) return null;
  return {
    id: person.id,
    username: person.username,
    topPlays: topPlaysWithArt(topPlaysOf(person.id, now)),
    playlists: await getPersonPlaylists(user, person.id),
  };
}
