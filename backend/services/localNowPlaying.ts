import type { QueueEntry } from "./queueEntry.ts";

const DEFAULT_TRACK_MS = 4 * 60_000;
const MAX_TRACK_MS = 30 * 60_000;

type Track = { title: string; artist: string; album: string | null; entry: QueueEntry | null };
type Playing = Track & { startedAt: number; until: number; fromScrobble: boolean };

const playing = new Map<number, Playing>();

const windowOf = (durationMs: number | null) =>
  Math.min(durationMs ?? DEFAULT_TRACK_MS, MAX_TRACK_MS);

const live = (entry: Playing | undefined, now: number) =>
  entry && entry.until > now ? entry : undefined;

export function setLocalNowPlaying(
  userId: number,
  { durationMs, ...track }: Track & { durationMs: number | null },
  now = Date.now(),
) {
  playing.set(userId, {
    ...track,
    startedAt: now,
    until: now + windowOf(durationMs),
    fromScrobble: false,
  });
}

export function setNowPlayingFromScrobble(
  userId: number,
  { durationMs, playedAt, ...track }: Track & { durationMs: number | null; playedAt: number },
  now = Date.now(),
) {
  const window = windowOf(durationMs);
  if (now - playedAt > window) return false;
  if (live(playing.get(userId), now)?.fromScrobble === false) return false;
  playing.set(userId, { ...track, startedAt: playedAt, until: now + window, fromScrobble: true });
  return true;
}

export function localNowPlaying(userId: number, now = Date.now()) {
  const entry = live(playing.get(userId), now);
  return entry ? { title: entry.title, artist: entry.artist, album: entry.album } : null;
}

export function allLocalNowPlaying(now = Date.now()) {
  return [...playing].flatMap(([userId, entry]) =>
    live(entry, now) ? [{ userId, entry: entry.entry, startedAt: entry.startedAt }] : [],
  );
}
