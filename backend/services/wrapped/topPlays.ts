import { readLocalWrappedHistory } from "./history.ts";
import { calculateWrapped } from "./metrics.ts";

const TOP_PLAYS_DAYS = 30;
const TOP_TRACKS = 10;
const DAY_MS = 86_400_000;

export function topPlaysOf(userId: number, now = Date.now()) {
  const period = {
    year: new Date(now).getUTCFullYear(),
    timeZone: "UTC",
    start: now - TOP_PLAYS_DAYS * DAY_MS,
    end: now,
  };
  const top = calculateWrapped(readLocalWrappedHistory(userId, period), period);
  return {
    artists: top.topArtists.map(({ name, plays }) => ({ name, plays })),
    albums: top.topAlbums.map(({ name, artist, plays }) => ({ title: name, artist, plays })),
    tracks: top.topSongs
      .slice(0, TOP_TRACKS)
      .map(({ name, artist, plays }) => ({ title: name, artist, plays })),
  };
}
