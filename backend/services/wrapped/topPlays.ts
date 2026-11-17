import { MBID_PATTERN } from "../../../lib/mbid.ts";
import type { TopPlays } from "../friendArt.ts";
import { readLocalWrappedHistory } from "./history.ts";
import { calculateWrapped } from "./metrics.ts";

const TOP_PLAYS_DAYS = 30;
const TOP_TRACKS = 10;
const DAY_MS = 86_400_000;

const known = (mbid: string | null) => (mbid && MBID_PATTERN.test(mbid) ? mbid : null);

function topOf(userId: number, now: number) {
  const period = {
    year: new Date(now).getUTCFullYear(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    start: now - TOP_PLAYS_DAYS * DAY_MS,
    end: now,
  };
  return calculateWrapped(readLocalWrappedHistory(userId, period), period);
}

const summaryOf = (top: ReturnType<typeof topOf>): TopPlays => ({
  artists: top.topArtists.map(({ name, plays, mbid }) => ({ name, plays, mbid: known(mbid) })),
  albums: top.topAlbums.map(({ name, artist, plays, mbid }) => ({
    title: name,
    artist,
    plays,
    mbid: known(mbid),
  })),
  tracks: top.topSongs.slice(0, TOP_TRACKS).map(({ name, artist, plays, mbid, albumMbid }) => ({
    title: name,
    artist,
    plays,
    mbid: known(mbid),
    albumMbid: known(albumMbid),
  })),
  stats: {
    plays: top.totalPlays,
    minutes: top.minutes ?? 0,
    artists: top.uniqueArtists,
    hours: top.hours,
  },
});

export const topPlaysOf = (userId: number, now = Date.now()) => summaryOf(topOf(userId, now));

export function sharedTopPlaysOf(userId: number, now = Date.now()) {
  const top = topOf(userId, now);
  return {
    ...summaryOf(top),
    blendTracks: top.topSongs
      .filter(({ name, artist }) => name.trim() && artist.trim())
      .map(({ name, artist }) => ({ title: name, artist })),
  };
}
