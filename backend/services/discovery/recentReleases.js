import { getReleaseCalendarEntries } from "../releaseCalendarStore.js";

const RECENT_RELEASE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function resolveTimeMs(value, fallback = Date.now()) {
  if (value == null) return fallback;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallback;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function resolveDayMs(value) {
  if (value == null) return null;
  const text = String(value || "").trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return Number.isFinite(time) ? time : null;
  }
  const time = resolveTimeMs(value, null);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export async function getRecentMissingReleases(limit = 24, options = {}) {
  const now = resolveTimeMs(options?.now);
  const recentCutoff = now - RECENT_RELEASE_WINDOW_MS;
  const today = resolveDayMs(now);
  const includeFuture = options?.includeFuture !== false;
  const normalizedLimit = Math.max(1, Math.round(Number(limit) || 24));
  const providedArtists =
    Array.isArray(options?.artists) && options.artists.length > 0 ? options.artists : null;

  return getReleaseCalendarEntries({
    from: new Date(recentCutoff).toISOString().slice(0, 10),
    to: includeFuture ? null : new Date(today).toISOString().slice(0, 10),
    limit: normalizedLimit,
    artistIds: providedArtists
      ? providedArtists.map((artist) => artist?.canonicalId || artist?.id)
      : [],
  });
}
