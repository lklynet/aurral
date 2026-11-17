import type { RequestUser } from "../middleware/requestUser.ts";
import { getPersonPlaylists } from "./discovery/browsePlaylists.ts";
import { sharesListening, visiblePeople } from "./discovery/mixes.ts";
import { topPlaysWithArt, withArt } from "./friendArt.ts";
import { allLocalNowPlaying, localNowPlaying } from "./localNowPlaying.ts";
import { getSong, songIdsForQueueEntries } from "./subsonicLibraryService.ts";
import { topPlaysOf } from "./wrapped/topPlays.ts";

export function listPeople(userId: number, now = Date.now()) {
  return {
    sharing: sharesListening(userId),
    people: visiblePeople(userId, now).map((person) => {
      const nowPlaying = localNowPlaying(person.id, now);
      return {
        id: person.id,
        username: person.username,
        handle: person.handle,
        lastPlayedAt: person.lastPlayedAt,
        nowPlaying: nowPlaying && withArt(nowPlaying),
        lastPlayed: withArt({
          title: person.lastTitle,
          artist: person.lastArtist,
          album: person.lastAlbum,
          at: person.lastPlayedAt,
        }),
      };
    }),
  };
}

export async function personProfile(user: RequestUser, username: string, now = Date.now()) {
  const name = username.toLowerCase();
  if (name === user.username.toLowerCase()) {
    return {
      id: user.id,
      username: user.username,
      topPlays: topPlaysWithArt(topPlaysOf(user.id, now)),
      playlists: [],
    };
  }
  const person = visiblePeople(user.id, now).find((each) => each.username.toLowerCase() === name);
  if (!person) return null;
  return {
    id: person.id,
    username: person.username,
    topPlays: topPlaysWithArt(topPlaysOf(person.id, now)),
    playlists: await getPersonPlaylists(user, person.id),
  };
}

export function nowPlayingSongs(user: RequestUser, now = Date.now()) {
  const playing = allLocalNowPlaying(now);
  if (!playing.length) return [];
  const names = new Map([[user.id, user.username]]);
  if (playing.some(({ userId }) => userId !== user.id)) {
    for (const person of visiblePeople(user.id, now)) names.set(person.id, person.username);
  }
  const shown = playing.filter(({ userId, entry }) => entry && names.has(userId));
  const songIds = songIdsForQueueEntries(
    user,
    shown.map(({ entry }) => entry),
  );
  return shown.flatMap(({ userId, startedAt }, index) => {
    const songId = songIds[index];
    const song = songId && getSong(songId, user);
    return song
      ? [
          {
            ...song,
            username: names.get(userId) ?? "",
            minutesAgo: Math.max(0, Math.floor((now - startedAt) / 60_000)),
            playerId: 0,
          },
        ]
      : [];
  });
}
