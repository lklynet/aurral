import { readLocalWrappedHistory } from "./history.ts";
import { calculateWrapped } from "./metrics.ts";

const TOP_PLAYS_DAYS = 30;
const TOP_TRACKS = 10;
const DAY_MS = 86_400_000;

function topOf(userId: number, now: number) {
  const period = {
    year: new Date(now).getUTCFullYear(),
    timeZone: "UTC",
    start: now - TOP_PLAYS_DAYS * DAY_MS,
    end: now,
  };
  return calculateWrapped(readLocalWrappedHistory(userId, period), period);
}

const summaryOf = (top: ReturnType<typeof topOf>) => ({
  artists: top.topArtists.map(({ name, plays }) => ({ name, plays })),
  albums: top.topAlbums.map(({ name, artist, plays }) => ({ title: name, artist, plays })),
  tracks: top.topSongs
    .slice(0, TOP_TRACKS)
    .map(({ name, artist, plays }) => ({ title: name, artist, plays })),
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
