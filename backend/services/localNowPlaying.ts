const DEFAULT_TRACK_MS = 4 * 60_000;
const MAX_TRACK_MS = 30 * 60_000;

type Track = { title: string; artist: string; album: string | null };

const playing = new Map<number, Track & { until: number }>();

export function setLocalNowPlaying(
  userId: number,
  { durationMs, ...track }: Track & { durationMs: number | null },
  now = Date.now(),
) {
  playing.set(userId, {
    ...track,
    until: now + Math.min(durationMs ?? DEFAULT_TRACK_MS, MAX_TRACK_MS),
  });
}

export function localNowPlaying(userId: number, now = Date.now()) {
  const entry = playing.get(userId);
  if (!entry || entry.until <= now) return null;
  return { title: entry.title, artist: entry.artist, album: entry.album };
}
