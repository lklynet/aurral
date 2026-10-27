export const WRAPPED_SOURCES = [
  "aurral",
  "lastfm",
  "listenbrainz",
  "koito",
  "navidrome",
  "plex",
  "jellyfin",
] as const;

export type WrappedPlay = {
  source: (typeof WRAPPED_SOURCES)[number];
  account: string;
  id: string;
  playedAt: number;
  startedAt?: number;
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
  albumTrackCount?: number;
};

export const wrappedName = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

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
        format.formatToParts(timestamp).map(({ type, value }) => [type, value]),
      );
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      const next = timestamp + target - represented;
      if (next === timestamp) break;
      timestamp = next;
    }
    return timestamp;
  };
  const start = midnight(year);
  const end = Math.min(midnight(year + 1), cutoff);
  return { year, timeZone, start, end };
}

function identityResolver(plays: WrappedPlay[], kind: "track" | "artist" | "album") {
  const ids = new Map<string, Set<string>>();
  const name = (play: WrappedPlay) =>
    kind === "artist"
      ? wrappedName(play.artist)
      : `${wrappedName(play.artist)}\u0000${wrappedName(kind === "album" ? play.album || "" : play.title)}`;
  for (const play of plays) {
    const mbid =
      kind === "artist" ? play.artistMbid : kind === "album" ? play.albumMbid : play.trackMbid;
    if (!mbid) continue;
    const matches = ids.get(name(play)) ?? new Set<string>();
    matches.add(mbid.toLowerCase());
    ids.set(name(play), matches);
  }
  return (play: WrappedPlay) => {
    const explicit =
      kind === "artist" ? play.artistMbid : kind === "album" ? play.albumMbid : play.trackMbid;
    const matches = ids.get(name(play));
    return explicit?.toLowerCase() || (matches?.size === 1 ? [...matches][0] : name(play));
  };
}

export function mergeWrappedPlays(input: WrappedPlay[]) {
  const plays = input.filter(
    (play) => play.artist.trim() && play.title.trim() && Number.isFinite(play.playedAt),
  );
  const trackKey = identityResolver(plays, "track");
  const seen = new Set<string>();
  const buckets = new Map<string, number[]>();
  const merged: (WrappedPlay & { origins: string[] })[] = [];
  for (const play of [...plays].sort(
    (a, b) => a.playedAt - b.playedAt || a.source.localeCompare(b.source),
  )) {
    const origin = `${play.source}:${play.account}`;
    const eventId = `${origin}:${play.id}`;
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    const times = [
      ...new Set(
        [play.playedAt, play.startedAt].filter((time): time is number => Number.isFinite(time)),
      ),
    ];
    const candidates = new Set<number>();
    for (const time of times) {
      for (let offset = -2; offset <= 2; offset++) {
        for (const index of buckets.get(`${trackKey(play)}:${Math.floor(time / 1000) + offset}`) ??
          [])
          candidates.add(index);
      }
    }
    const match = [...candidates]
      .filter((index) => !merged[index].origins.includes(origin))
      .map((index) => {
        const other = merged[index];
        const otherTimes = [other.playedAt, other.startedAt].filter((time): time is number =>
          Number.isFinite(time),
        );
        return {
          index,
          difference: Math.min(
            ...times.flatMap((time) => otherTimes.map((otherTime) => Math.abs(time - otherTime))),
          ),
        };
      })
      .filter(({ difference }) => difference <= 2000)
      .sort((a, b) => a.difference - b.difference || a.index - b.index)[0];
    let index: number;
    if (match) {
      index = match.index;
      const other = merged[index];
      other.origins.push(origin);
      for (const key of [
        "album",
        "trackMbid",
        "artistMbid",
        "albumMbid",
        "artwork",
        "libraryTrackId",
        "libraryAlbumId",
        "albumTrackCount",
        "startedAt",
      ] as const) {
        if (other[key] == null && play[key] != null) Object.assign(other, { [key]: play[key] });
      }
      if (!positive(other.durationMs) && positive(play.durationMs))
        other.durationMs = play.durationMs;
      if (!positive(other.listenedMs) && positive(play.listenedMs))
        other.listenedMs = play.listenedMs;
      other.genres = [...new Set([...(other.genres ?? []), ...(play.genres ?? [])])];
    } else {
      index = merged.length;
      merged.push({ ...play, origins: [origin] });
    }
    for (const time of times) {
      const key = `${trackKey(play)}:${Math.floor(time / 1000)}`;
      const values = buckets.get(key) ?? [];
      if (!values.includes(index)) values.push(index);
      buckets.set(key, values);
    }
  }
  return merged;
}

export function calculateWrapped(input: WrappedPlay[], period: ReturnType<typeof wrappedPeriod>) {
  const eligible = input.filter(
    (play) => play.playedAt >= period.start && play.playedAt < period.end,
  );
  const plays = mergeWrappedPlays(eligible);
  const artistKey = identityResolver(plays, "artist");
  const trackKey = identityResolver(plays, "track");
  const albumKey = identityResolver(plays, "album");
  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: period.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  type Ranking = {
    key: string;
    name: string;
    artist: string;
    plays: number;
    firstPlayedAt: number;
    minutes: number;
    artwork: string | null;
    libraryTrackId: number | null;
    libraryAlbumId: number | null;
    mbid: string | null;
    album: string | null;
  };
  const artists = new Map<string, Ranking>();
  const songs = new Map<string, Ranking>();
  const albums = new Map<string, Ranking & { tracks: Set<string>; trackCount: number | null }>();
  const genres = new Map<string, { name: string; plays: number }>();
  const days = new Map<string, number>();
  const months = Array.from({ length: 12 }, (_, month) => ({
    month: `${period.year}-${String(month + 1).padStart(2, "0")}`,
    plays: 0,
    artists: new Map<string, number>(),
  }));
  let measuredPlays = 0;
  let timedPlays = 0;
  let milliseconds = 0;
  let genrePlays = 0;
  const add = (
    target: Map<string, Ranking>,
    key: string,
    name: string,
    play: WrappedPlay,
    duration: number,
  ) => {
    const row = target.get(key) ?? {
      key,
      name,
      artist: play.artist,
      plays: 0,
      firstPlayedAt: play.playedAt,
      minutes: 0,
      artwork: null,
      libraryTrackId: null,
      libraryAlbumId: null,
      mbid:
        (target === artists
          ? play.artistMbid
          : target === albums
            ? play.albumMbid
            : play.trackMbid) ?? null,
      album: play.album ?? null,
    };
    row.plays++;
    row.firstPlayedAt = Math.min(row.firstPlayedAt, play.playedAt);
    row.minutes += duration / 60000;
    row.artwork ||= play.artwork ?? null;
    row.mbid ||=
      (target === artists
        ? play.artistMbid
        : target === albums
          ? play.albumMbid
          : play.trackMbid) ?? null;
    row.libraryTrackId ??= play.libraryTrackId ?? null;
    row.libraryAlbumId ??= play.libraryAlbumId ?? null;
    target.set(key, row);
    return row;
  };
  for (const play of plays) {
    const duration = positive(play.listenedMs)
      ? play.listenedMs!
      : positive(play.durationMs)
        ? play.durationMs!
        : 0;
    if (positive(play.listenedMs)) measuredPlays++;
    if (duration) timedPlays++;
    milliseconds += duration;
    add(artists, artistKey(play), play.artist, play, duration);
    add(songs, trackKey(play), play.title, play, duration);
    if (play.album) {
      const key = albumKey(play);
      const existing = albums.get(key);
      const row = add(albums, key, play.album, play, duration);
      const tracks = existing?.tracks ?? new Set<string>();
      tracks.add(trackKey(play));
      albums.set(key, {
        ...row,
        tracks,
        trackCount: existing?.trackCount ?? play.albumTrackCount ?? null,
      });
    }
    const date = dateFormat.format(play.playedAt);
    days.set(date, (days.get(date) ?? 0) + 1);
    const month = months.find((month) => month.month === date.slice(0, 7));
    if (month) {
      month.plays++;
      month.artists.set(artistKey(play), (month.artists.get(artistKey(play)) ?? 0) + 1);
    }
    const tags = [
      ...new Set((play.genres ?? []).map(wrappedName).filter((name) => name && name !== "unknown")),
    ];
    if (tags.length) genrePlays++;
    for (const name of tags) genres.set(name, { name, plays: (genres.get(name)?.plays ?? 0) + 1 });
  }
  const rank = <T extends { plays: number; name: string }>(rows: Iterable<T>) =>
    [...rows].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
  const rankedArtists = rank(artists.values());
  const rankedSongs = rank(songs.values());
  let longestStreak = 0;
  let streak = 0;
  let previous = 0;
  for (const date of [...days.keys()].sort()) {
    const day = Date.parse(`${date}T00:00:00Z`);
    streak = day - previous === 86400000 ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = day;
  }
  return {
    ...period,
    totalPlays: plays.length,
    importedPlays: eligible.length,
    duplicatesRemoved: eligible.length - plays.length,
    uniqueArtists: artists.size,
    uniqueSongs: songs.size,
    uniqueAlbums: albums.size,
    activeDays: days.size,
    longestStreak,
    firstPlayedAt: plays.length
      ? plays.reduce((first, play) => Math.min(first, play.playedAt), Infinity)
      : null,
    lastPlayedAt: plays.length
      ? plays.reduce((last, play) => Math.max(last, play.playedAt), -Infinity)
      : null,
    listening: {
      minutes: Math.floor(milliseconds / 60000),
      timedPlays,
      measuredPlays,
      estimated: measuredPlays < timedPlays,
    },
    topArtists: rankedArtists.slice(0, 5),
    topSongs: rankedSongs.slice(0, 100),
    topAlbums: rank(albums.values())
      .filter((album) => !album.trackCount || album.tracks.size / album.trackCount >= 0.7)
      .slice(0, 5)
      .map(({ tracks, ...album }) => ({ ...album, tracksPlayed: tracks.size })),
    topGenres: rank(genres.values()).slice(0, 5),
    uniqueGenres: genres.size,
    genrePlays,
    busiestDay:
      [...days]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([date, plays]) => ({ date, plays }))[0] ?? null,
    months: months
      .filter(
        (month) =>
          month.month <= dateFormat.format(Math.max(period.start, period.end - 1)).slice(0, 7),
      )
      .map(({ artists: counts, ...month }) => ({
        ...month,
        artists: rankedArtists
          .slice(0, 5)
          .map((artist) => ({ name: artist.name, plays: counts.get(artist.key) ?? 0 }))
          .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name)),
      })),
  };
}

export type WrappedSummary = ReturnType<typeof calculateWrapped>;
