import { getReleaseCalendarEntries } from "../releaseCalendarStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_RELEASE_WINDOW_MS = 90 * DAY_MS;

export type ReleaseWindow = "released" | "upcoming";

type TimeInput = string | number | Date | null | undefined;

interface RecentReleaseArtist {
  id?: string | number | null;
}

interface RecentReleaseOptions {
  now?: TimeInput;
  when?: ReleaseWindow;
  artists?: RecentReleaseArtist[] | null;
}

function resolveTimeMs(value: TimeInput, fallback?: number): number;
function resolveTimeMs(value: TimeInput, fallback: null): number | null;
function resolveTimeMs(value: TimeInput, fallback: number | null = Date.now()) {
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

function resolveDayMs(value: TimeInput) {
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
  const date = new Date(time!);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export async function getRecentMissingReleases(limit = 24, options: RecentReleaseOptions = {}) {
  const now = resolveTimeMs(options?.now);
  const today = resolveDayMs(now)!;
  const upcoming = options?.when === "upcoming";
  const normalizedLimit = Math.max(1, Math.round(Number(limit) || 24));
  const providedArtists =
    Array.isArray(options?.artists) && options.artists.length > 0 ? options.artists : null;

  return getReleaseCalendarEntries({
    from: toDay(upcoming ? today + DAY_MS : now - RECENT_RELEASE_WINDOW_MS),
    to: upcoming ? null : toDay(today),
    limit: normalizedLimit,
    artistIds: providedArtists ? providedArtists.map((artist) => artist?.id) : [],
    soonestFirst: upcoming,
  });
}
