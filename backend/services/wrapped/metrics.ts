import type { WrappedBeats } from "./beats.ts";
export const WRAPPED_SOURCES = [
  "aurral",
  "lastfm",
  "listenbrainz",
  "koito",
  "navidrome",
  "plex",
  "jellyfin",
] as const;

export type WrappedSource = (typeof WRAPPED_SOURCES)[number];

export type WrappedPlay = {
  source: WrappedSource;
  account: string;
  id: string;
  playedAt: number;
  title: string;
  artist: string;
  album?: string | null;
  trackMbid?: string | null;
  artistMbid?: string | null;
  albumMbid?: string | null;
  durationMs?: number | null;
  listenedMs?: number | null;
  genres?: string[];
  artwork?: string | null;
  libraryTrackId?: number;
  libraryAlbumId?: number;
};

export type WrappedPeriod = ReturnType<typeof wrappedPeriod>;

const DEFAULT_TRACK_MS = 4 * 60_000;
const MIRROR_SLACK_MS = 60_000;
const MAX_MIRROR_GAP_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export const wrappedKey = (value: string) => {
  const folded = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return folded.replace(/[^\p{L}\p{N}]+/gu, "") || folded.trim();
};

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const songKey = (play: WrappedPlay) => `${wrappedKey(play.artist)}\u0000${wrappedKey(play.title)}`;

export function wrappedPeriod(year: number, timeZone: string, cutoff = Date.now()) {
  if (!Number.isInteger(year) || year < 1970 || year > 9998) throw new Error("Invalid year");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const midnight = (value: number) => {
    const target = Date.UTC(value, 0, 1);
    let timestamp = target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = Object.fromEntries(
        format.formatToParts(timestamp).map(({ type, value }) => [type, Number(value)]),
      );
      const represented = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      const next = timestamp + target - represented;
      if (next === timestamp) break;
      timestamp = next;
    }
    return timestamp;
  };
  return { year, timeZone, start: midnight(year), end: Math.min(midnight(year + 1), cutoff) };
}

export function mergeWrappedPlays(input: WrappedPlay[]) {
  const seen = new Set<string>();
  const groups = new Map<string, (WrappedPlay & { origins: Set<string> })[]>();
  const merged: (WrappedPlay & { origins: Set<string> })[] = [];
  const sorted = input
    .filter((play) => play.artist.trim() && play.title.trim() && Number.isFinite(play.playedAt))
    .sort((a, b) => a.playedAt - b.playedAt || a.source.localeCompare(b.source));
  for (const play of sorted) {
    const origin = `${play.source}:${play.account}`;
    if (seen.has(`${origin}:${play.id}`)) continue;
    seen.add(`${origin}:${play.id}`);
    const key = songKey(play);
    const group = groups.get(key) ?? [];
    let mirror: (typeof merged)[number] | undefined;
    for (let index = group.length - 1; index >= 0; index--) {
      const other = group[index];
      const gap = play.playedAt - other.playedAt;
      if (gap > MAX_MIRROR_GAP_MS) break;
      const length = [play.durationMs, other.durationMs].find(positive) ?? DEFAULT_TRACK_MS;
      if (!other.origins.has(origin) && gap <= length + MIRROR_SLACK_MS) {
        mirror = other;
        break;
      }
    }
    if (!mirror) {
      const entry = { ...play, origins: new Set([origin]) };
      merged.push(entry);
      group.push(entry);
      groups.set(key, group);
      continue;
    }
    mirror.origins.add(origin);
    mirror.album ||= play.album;
    mirror.trackMbid ||= play.trackMbid;
    mirror.artistMbid ||= play.artistMbid;
    mirror.albumMbid ||= play.albumMbid;
    mirror.artwork ||= play.artwork;
    if (mirror.libraryTrackId == null) {
      mirror.libraryTrackId = play.libraryTrackId;
      mirror.libraryAlbumId = play.libraryAlbumId;
    }
    if (!positive(mirror.durationMs)) mirror.durationMs = play.durationMs;
    if (!positive(mirror.listenedMs)) mirror.listenedMs = play.listenedMs;
    if (play.genres?.length)
      mirror.genres = [...new Set([...(mirror.genres ?? []), ...play.genres])];
  }
  return merged.map(({ origins: _origins, ...play }) => play);
}

type Tally = {
  key: string;
  name: string;
  artist: string;
  album: string | null;
  plays: number;
  timedMs: number;
  untimedPlays: number;
  firstPlayedAt: number;
  artwork: string | null;
  color: string | null;
  preview: string | null;
  beats: WrappedBeats | null;
  mbid: string | null;
  libraryTrackId: number | null;
  libraryAlbumId: number | null;
};

export function calculateWrapped(
  input: WrappedPlay[],
  period: WrappedPeriod,
  enrich: (plays: WrappedPlay[]) => void = () => {},
) {
  const eligible = input.filter(
    (play) => play.playedAt >= period.start && play.playedAt < period.end,
  );
  const plays = mergeWrappedPlays(eligible);
  enrich(plays);
  const dateOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: period.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const hourOf = new Intl.DateTimeFormat("en-US", {
    timeZone: period.timeZone,
    hour: "numeric",
    hourCycle: "h23",
  });
  const artists = new Map<string, Tally>();
  const songs = new Map<string, Tally>();
  const albums = new Map<string, Tally>();
  const albumSongs = new Map<string, Set<string>>();
  const genres = new Map<string, { name: string; plays: number }>();
  const days = new Map<string, { plays: number; songs: Map<string, number> }>();
  const months = new Map<string, { plays: number; artists: Map<string, number> }>();
  const hours = Array.from({ length: 24 }, () => 0);
  let timedMs = 0;
  let timedPlays = 0;
  let measuredPlays = 0;
  let genrePlays = 0;

  const tally = (
    target: Map<string, Tally>,
    key: string,
    name: string,
    play: WrappedPlay,
    duration: number,
    mbid: string | null | undefined,
  ) => {
    const row = target.get(key) ?? {
      key,
      name,
      artist: play.artist,
      album: play.album ?? null,
      plays: 0,
      timedMs: 0,
      untimedPlays: 0,
      firstPlayedAt: play.playedAt,
      artwork: null,
      color: null,
      preview: null,
      beats: null,
      mbid: null,
      libraryTrackId: null,
      libraryAlbumId: null,
    };
    row.plays++;
    if (duration) row.timedMs += duration;
    else row.untimedPlays++;
    row.artwork ||= play.artwork ?? null;
    row.album ||= play.album ?? null;
    row.mbid ||= mbid ?? null;
    if (row.libraryTrackId == null && play.libraryTrackId != null) {
      row.libraryTrackId = play.libraryTrackId;
      row.libraryAlbumId = play.libraryAlbumId ?? null;
    }
    target.set(key, row);
  };

  for (const play of plays) {
    const duration = positive(play.listenedMs)
      ? play.listenedMs
      : positive(play.durationMs)
        ? play.durationMs
        : 0;
    if (positive(play.listenedMs)) measuredPlays++;
    if (duration) {
      timedPlays++;
      timedMs += duration;
    }
    const artistKey = wrappedKey(play.artist);
    tally(artists, artistKey, play.artist, play, duration, play.artistMbid);
    tally(songs, songKey(play), play.title, play, duration, play.trackMbid);
    if (play.album) {
      const albumKey = `${artistKey}\u0000${wrappedKey(play.album)}`;
      tally(albums, albumKey, play.album, play, duration, play.albumMbid);
      albumSongs.set(albumKey, (albumSongs.get(albumKey) ?? new Set()).add(songKey(play)));
    }

    const date = dateOf.format(play.playedAt);
    const day = days.get(date) ?? { plays: 0, songs: new Map() };
    day.plays++;
    day.songs.set(songKey(play), (day.songs.get(songKey(play)) ?? 0) + 1);
    days.set(date, day);
    const month = months.get(date.slice(0, 7)) ?? { plays: 0, artists: new Map() };
    month.plays++;
    month.artists.set(artistKey, (month.artists.get(artistKey) ?? 0) + 1);
    months.set(date.slice(0, 7), month);
    hours[Number(hourOf.format(play.playedAt)) % 24]++;

    const tags = new Set(
      (play.genres ?? []).map((genre) => genre.trim().toLowerCase()).filter(Boolean),
    );
    tags.delete("unknown");
    if (tags.size) genrePlays++;
    for (const name of tags) genres.set(name, { name, plays: (genres.get(name)?.plays ?? 0) + 1 });
  }

  const averageMs = timedPlays ? timedMs / timedPlays : 0;
  const minutesOf = (row: Pick<Tally, "timedMs" | "untimedPlays">) =>
    Math.round((row.timedMs + row.untimedPlays * averageMs) / 60_000);
  const rank = <T extends { plays: number; name: string }>(rows: Iterable<T>) =>
    [...rows].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
  const ranked = (rows: Map<string, Tally>, limit: number) =>
    rank(rows.values())
      .slice(0, limit)
      .map((tally) => {
        const { timedMs: _timedMs, untimedPlays: _untimedPlays, ...row } = tally;
        return { ...row, minutes: minutesOf(tally) };
      });
  const leader = (counts: Map<string, number>, names: Map<string, Tally>) => {
    const [key, plays] =
      [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    const row = key ? names.get(key) : undefined;
    return row && plays ? { name: row.name, artist: row.artist, plays } : null;
  };

  const dates = [...days.keys()].sort();
  let streak = { days: 0, start: "", end: "" };
  for (let index = 0, runStart = 0; index < dates.length; index++) {
    const contiguous =
      index > 0 && Date.parse(dates[index]) - Date.parse(dates[index - 1]) === DAY_MS;
    if (!contiguous) runStart = index;
    if (index - runStart + 1 > streak.days)
      streak = { days: index - runStart + 1, start: dates[runStart], end: dates[index] };
  }
  const lastDate = dateOf.format(Math.max(period.start, period.end - 1));
  const lastMonth = lastDate.slice(0, 7);
  const firstDay = Date.UTC(period.year, 0, 1);
  const busiest = [...days].sort((a, b) => b[1].plays - a[1].plays || a[0].localeCompare(b[0]))[0];

  return {
    ...period,
    totalPlays: plays.length,
    importedPlays: eligible.length,
    duplicatesRemoved: eligible.length - plays.length,
    minutes: timedPlays ? minutesOf({ timedMs, untimedPlays: plays.length - timedPlays }) : null,
    minutesMeasured: plays.length > 0 && measuredPlays === plays.length,
    uniqueArtists: artists.size,
    uniqueSongs: songs.size,
    uniqueAlbums: albums.size,
    uniqueGenres: genres.size,
    genrePlays,
    activeDays: days.size,
    longestStreak: streak.days ? streak : null,
    firstPlayedAt: plays[0]?.playedAt ?? null,
    topArtists: ranked(artists, 5),
    topSongs: ranked(songs, 100),
    topAlbums: ranked(albums, 5).map((album) => ({
      ...album,
      songs: albumSongs.get(album.key)?.size ?? 0,
    })),
    topGenres: rank(genres.values()).slice(0, 5),
    busiestDay: busiest
      ? { date: busiest[0], plays: busiest[1].plays, topSong: leader(busiest[1].songs, songs) }
      : null,
    months: Array.from(
      { length: 12 },
      (_, index) => `${period.year}-${String(index + 1).padStart(2, "0")}`,
    )
      .filter((month) => month <= lastMonth)
      .map((month) => ({
        month,
        plays: months.get(month)?.plays ?? 0,
        topArtist: leader(months.get(month)?.artists ?? new Map(), artists),
      })),
    hours,
    calendar: Array.from(
      { length: (Date.parse(lastDate) - firstDay) / DAY_MS + 1 },
      (_, index) =>
        days.get(new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10))?.plays ?? 0,
    ),
  };
}

export type WrappedSummary = ReturnType<typeof calculateWrapped>;
