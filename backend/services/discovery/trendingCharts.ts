import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { deezerPreviewPath } from "../apiClients/deezer.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import { EDITORIAL_GENRES, deezerRequest } from "../importLists/deezerPlaylists.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { findLibraryPlaylist } from "./editorialPlaylists.ts";
import { mapWithConcurrency } from "./helpers.ts";
import type { TrendingChartDaysRow, TrendingChartsRow } from "../../db/rows.ts";

const DEEZER_CHARTS_USER_ID = 637006841;
const WORLDWIDE_CHART_TITLE = "Top Worldwide";
const DEEZER_REGION_NAMES: Record<string, string> = {
  US: "USA",
  GB: "UK",
  CZ: "Czech Republic",
  CI: "Ivory Coast",
  TR: "Turkey",
};
const APPLE_FEED_URL = "https://rss.marketingtools.apple.com/api/v2";
const FALLBACK_REGION = "US";
const SONG_LIMIT = 100;
const ALBUM_LIMIT = 100;
const ALBUM_RAIL_LIMIT = 25;
const ARTIST_LIMIT = 25;
const GENRE_TRACK_LIMIT = 50;
const GENRE_COVER_COUNT = 4;
const GENRE_SHARE_LIMIT = 6;
const HISTORY_DAYS = 30;
const SPOTLIGHT_DAYS = 14;
const FRESH_FOR_MS = 5 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DeezerTrackPayload {
  id?: number | string;
  title?: string;
  duration?: number;
  preview?: string | null;
  artist?: { name?: string };
  album?: {
    id?: number | string;
    title?: string;
    cover_medium?: string | null;
    cover_xl?: string | null;
  };
}

interface DeezerArtistPayload {
  id?: number | string;
  name?: string;
  picture_big?: string | null;
  picture_xl?: string | null;
  nb_fan?: number;
}

interface DeezerPage<T> {
  data?: T[];
  next?: string;
}

interface AppleAlbumPayload {
  id?: string;
  name?: string;
  artistName?: string;
  artworkUrl100?: string;
  releaseDate?: string;
  genres?: { name?: string }[];
}

const text = (value: unknown) => String(value ?? "").trim();

const isPresent = <T>(value: T | null): value is T => value !== null;

const uniqueByKey = <T extends { key: string }>(items: T[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
};

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

const shiftDay = (day: string, offset: number) =>
  dayOf(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS);

const toSong = (track: DeezerTrackPayload) => {
  const key = text(track.id);
  const trackName = text(track.title);
  const artistName = text(track.artist?.name);
  if (!key || !trackName || !artistName) return null;
  return {
    key,
    trackName,
    artistName,
    albumName: text(track.album?.title) || null,
    deezerAlbumId: text(track.album?.id) || null,
    durationMs: Number(track.duration) > 0 ? Number(track.duration) * 1000 : null,
    artworkUrl: track.album?.cover_medium || null,
    largeArtworkUrl: track.album?.cover_xl || null,
    preview_url: track.preview ? deezerPreviewPath(key) : null,
  };
};

const toAlbum = (album: AppleAlbumPayload) => {
  const key = text(album.id);
  const name = text(album.name);
  const artistName = text(album.artistName);
  if (!key || !name || !artistName) return null;
  return {
    key,
    name,
    artistName,
    artworkUrl: album.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/500x500bb.") || null,
    releaseDate: text(album.releaseDate) || null,
    genre:
      (album.genres || []).map((genre) => text(genre.name)).find((g) => g && g !== "Music") || null,
  };
};

type TrendingSong = NonNullable<ReturnType<typeof toSong>>;
type TrendingAlbum = NonNullable<ReturnType<typeof toAlbum>>;
type TrendingArtist = Awaited<ReturnType<typeof fetchArtists>>["items"][number];
type SongsChart = Awaited<ReturnType<typeof fetchSongs>>;
type GenreChart = { name: string; items: TrendingSong[] };
type ChartDay = { day: string; keys: string[] };

export const chartPlaylistTitle = (region: string) => {
  const code = region.toUpperCase();
  try {
    return `Top ${DEEZER_REGION_NAMES[code] ?? new Intl.DisplayNames(["en"], { type: "region" }).of(code)}`;
  } catch {
    return WORLDWIDE_CHART_TITLE;
  }
};

async function fetchRegion() {
  const info = await deezerRequest<{ country_iso?: string }>("/infos");
  const region = text(info.country_iso).toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new Error("Deezer did not report a country");
  return region;
}

async function findChartPlaylist(region: string) {
  const wanted = chartPlaylistTitle(region);
  const playlists: { id?: number | string; title?: string }[] = [];
  for (let index = 0; index < 500; index += 100) {
    const page = await deezerRequest<DeezerPage<{ id?: number | string; title?: string }>>(
      `/user/${DEEZER_CHARTS_USER_ID}/playlists`,
      { index, limit: 100 },
    );
    const items = page.data || [];
    playlists.push(...items);
    if (!page.next || items.length === 0) break;
  }
  const match =
    playlists.find((playlist) => text(playlist.title) === wanted) ||
    playlists.find((playlist) => text(playlist.title) === WORLDWIDE_CHART_TITLE);
  if (!match?.id) throw new Error("Deezer has no chart playlist");
  return { id: text(match.id), name: text(match.title) };
}

async function fetchSongs(region: string) {
  const playlist = await findChartPlaylist(region);
  const page = await deezerRequest<DeezerPage<DeezerTrackPayload>>(
    `/playlist/${playlist.id}/tracks`,
    { limit: SONG_LIMIT },
  );
  const items = uniqueByKey((page.data || []).map(toSong).filter(isPresent));
  if (items.length === 0) throw new Error("Deezer returned an empty chart");
  return { playlistId: playlist.id, playlistName: playlist.name, items };
}

async function fetchAppleAlbums(storefront: string) {
  const response = await fetch(
    `${APPLE_FEED_URL}/${storefront}/music/most-played/${ALBUM_LIMIT}/albums.json`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`Apple Music returned ${response.status}`);
  const body: { feed?: { results?: AppleAlbumPayload[] } } | null = await response
    .json()
    .catch(() => null);
  const items = uniqueByKey((body?.feed?.results || []).map(toAlbum).filter(isPresent));
  if (items.length === 0) throw new Error("Apple Music returned an empty chart");
  return { items };
}

async function fetchAlbums(region: string) {
  try {
    return { region, data: await fetchAppleAlbums(region.toLowerCase()) };
  } catch (error) {
    if (region === FALLBACK_REGION) throw error;
    return { region: FALLBACK_REGION, data: await fetchAppleAlbums("us") };
  }
}

async function fetchArtists() {
  const page = await deezerRequest<DeezerPage<DeezerArtistPayload>>("/chart/0/artists", {
    limit: ARTIST_LIMIT,
  });
  const items = await mapWithConcurrency(
    (page.data || []).filter((artist) => text(artist.id) && text(artist.name)),
    3,
    async (artist) => {
      const key = text(artist.id);
      const name = text(artist.name);
      const [details, mbid] = await Promise.all([
        deezerRequest<DeezerArtistPayload>(`/artist/${key}`).catch(() => null),
        guessArtistMbid(name),
      ]);
      return {
        key,
        name,
        imageUrl: artist.picture_xl || artist.picture_big || null,
        fans: Number(details?.nb_fan) || null,
        mbid: mbid || null,
      };
    },
  );
  if (items.length === 0) throw new Error("Deezer returned an empty artist chart");
  return { items };
}

async function fetchGenreCharts() {
  const genres = EDITORIAL_GENRES.filter((genre) => genre.id !== 0);
  const charts = await mapWithConcurrency(genres, 2, async (genre) => {
    try {
      const page = await deezerRequest<DeezerPage<DeezerTrackPayload>>(
        `/chart/${genre.id}/tracks`,
        { limit: GENRE_TRACK_LIMIT },
      );
      const items = uniqueByKey((page.data || []).map(toSong).filter(isPresent));
      return items.length > 0 ? { id: genre.id, name: genre.name, items } : null;
    } catch {
      return null;
    }
  });
  const found = charts.filter(isPresent);
  if (found.length === 0) throw new Error("Deezer returned no genre charts");
  return found;
}

const selectChartsStmt = db.prepare<[], TrendingChartsRow>("SELECT * FROM trending_charts");
const selectChartStmt = db.prepare<[string], TrendingChartsRow>(
  "SELECT * FROM trending_charts WHERE chart = ?",
);
const upsertChartStmt = db.prepare<[string, string, number, string]>(`
  INSERT INTO trending_charts (chart, region, updated_at, data) VALUES (?, ?, ?, ?)
  ON CONFLICT(chart) DO UPDATE SET
    region = excluded.region,
    updated_at = excluded.updated_at,
    data = excluded.data
`);
const selectDaysStmt = db.prepare<
  [string, number],
  Pick<TrendingChartDaysRow, "day" | "item_keys">
>("SELECT day, item_keys FROM trending_chart_days WHERE chart = ? ORDER BY day DESC LIMIT ?");
const upsertDayStmt = db.prepare<[string, string, string]>(`
  INSERT INTO trending_chart_days (chart, day, item_keys) VALUES (?, ?, ?)
  ON CONFLICT(chart, day) DO UPDATE SET item_keys = excluded.item_keys
`);
const pruneDaysStmt = db.prepare<[string]>("DELETE FROM trending_chart_days WHERE day < ?");

const saveChart = (chart: string, region: string, data: unknown, now: number) =>
  upsertChartStmt.run(chart, region, now, JSON.stringify(data));

const songHistoryKey = (region: string) => `songs:${region}`;

function readChart<T>(row: TrendingChartsRow | undefined): T | null {
  return row ? dbHelpers.parseJSON(row.data) : null;
}

function readDays(chart: string, limit: number): ChartDay[] {
  return selectDaysStmt.all(chart, limit).map((row) => ({
    day: row.day,
    keys: (dbHelpers.parseJSON(row.item_keys) || []).map(String),
  }));
}

export function summarizeChartHistory(days: ChartDay[]) {
  const [latest, previous] = days;
  const previousPositions = previous
    ? new Map(previous.keys.map((key, index) => [key, index]))
    : null;
  const movementOf = (key: string, index: number) => {
    if (!previousPositions) return null;
    const before = previousPositions.get(key);
    return before === undefined ? ("new" as const) : before - index;
  };
  if (!latest || days.length < 2 || latest.keys.length === 0) {
    return { movementOf, spotlight: null };
  }
  const lead = latest.keys[0];
  const keysByDay = new Map(days.map((entry) => [entry.day, entry.keys]));
  const ranks = Array.from({ length: SPOTLIGHT_DAYS }, (_, index) => {
    const keys = keysByDay.get(shiftDay(latest.day, index - (SPOTLIGHT_DAYS - 1)));
    const position = keys ? keys.indexOf(lead) : -1;
    return position === -1 ? null : position + 1;
  });
  let daysAtTop = 0;
  while (
    daysAtTop < days.length &&
    days[daysAtTop].day === shiftDay(latest.day, -daysAtTop) &&
    days[daysAtTop].keys[0] === lead
  ) {
    daysAtTop += 1;
  }
  return { movementOf, spotlight: { ranks, daysAtTop } };
}

function summarizeGenres(albums: TrendingAlbum[]) {
  const counts = new Map<string, number>();
  for (const album of albums) {
    if (album.genre) counts.set(album.genre, (counts.get(album.genre) || 0) + 1);
  }
  const ranked = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const top = ranked.slice(0, GENRE_SHARE_LIMIT);
  return {
    total: albums.length,
    other: albums.length - top.reduce((sum, genre) => sum + genre.count, 0),
    genres: top,
  };
}

const isFresh = (now: number) => {
  const row = selectChartStmt.get("songs");
  return Boolean(row && now - row.updated_at < FRESH_FOR_MS);
};

export async function refreshTrendingCharts({
  now = Date.now(),
  force = false,
}: { now?: number; force?: boolean } = {}) {
  if (!force && isFresh(now)) return false;
  const region = await fetchRegion().catch(
    () => selectChartStmt.get("songs")?.region || FALLBACK_REGION,
  );
  const sections = {
    songs: async () => {
      const songs = await fetchSongs(region);
      db.transaction(() => {
        saveChart("songs", region, songs, now);
        upsertDayStmt.run(
          songHistoryKey(region),
          dayOf(now),
          JSON.stringify(songs.items.map((item) => item.key)),
        );
        pruneDaysStmt.run(shiftDay(dayOf(now), -HISTORY_DAYS));
      })();
    },
    albums: async () => {
      const albums = await fetchAlbums(region);
      saveChart("albums", albums.region, albums.data, now);
    },
    artists: async () => {
      saveChart("artists", region, await fetchArtists(), now);
    },
    genres: async () => {
      const charts = await fetchGenreCharts();
      db.transaction(() => {
        for (const chart of charts) {
          saveChart(`genre:${chart.id}`, region, { name: chart.name, items: chart.items }, now);
        }
      })();
    },
  };
  const entries = Object.entries(sections);
  const results = await Promise.allSettled(entries.map(([, run]) => run()));
  const failed = results.flatMap((result, index) =>
    result.status === "rejected" ? [{ name: entries[index][0], reason: result.reason }] : [],
  );
  for (const { name, reason } of failed) {
    logger.warn("discovery", `Could not refresh the trending ${name} chart`, {
      reason: safeLogDiagnostic(reason),
    });
  }
  if (failed.length === entries.length) throw new Error("Trending charts could not be refreshed");
  return true;
}

export function getTrendingCharts(userId: number) {
  const rows = selectChartsStmt.all();
  const byChart = new Map(rows.map((row) => [row.chart, row]));
  const songsRow = byChart.get("songs");
  const songs = readChart<SongsChart>(songsRow);
  const albums = readChart<{ items: TrendingAlbum[] }>(byChart.get("albums"));
  const artists = readChart<{ items: TrendingArtist[] }>(byChart.get("artists"));
  const history = songsRow
    ? summarizeChartHistory(readDays(songHistoryKey(songsRow.region), HISTORY_DAYS))
    : null;
  const genres = EDITORIAL_GENRES.flatMap(({ id }) => {
    const chart = readChart<GenreChart>(byChart.get(`genre:${id}`));
    if (!chart) return [];
    return [
      {
        id,
        name: chart.name,
        covers: chart.items
          .map((item) => item.artworkUrl)
          .filter((url) => url !== null)
          .slice(0, GENRE_COVER_COUNT),
        artists: [...new Set(chart.items.map((item) => item.artistName))].slice(0, 2),
      },
    ];
  });

  return {
    region: songsRow?.region || byChart.get("albums")?.region || null,
    updatedAt: rows.length > 0 ? Math.max(...rows.map((row) => row.updated_at)) : null,
    songs: songs
      ? {
          playlistId: songs.playlistId,
          playlistName: songs.playlistName,
          libraryPlaylistId: findLibraryPlaylist(userId, songs.playlistId)?.id || null,
          items: songs.items.map((item, index) => ({
            ...item,
            position: index + 1,
            movement: history?.movementOf(item.key, index) ?? null,
          })),
          spotlight: history?.spotlight || null,
        }
      : null,
    albums: albums
      ? albums.items
          .slice(0, ALBUM_RAIL_LIMIT)
          .map((item, index) => ({ ...item, position: index + 1 }))
      : null,
    genreShare: albums ? summarizeGenres(albums.items) : null,
    artists: artists
      ? artists.items.map((item, index) => ({ ...item, position: index + 1 }))
      : null,
    genres,
  };
}

export function getTrendingGenreChart(genreId: number) {
  const row = selectChartStmt.get(`genre:${genreId}`);
  const chart = readChart<GenreChart>(row);
  if (!row || !chart) return null;
  return {
    id: genreId,
    name: chart.name,
    region: row.region,
    updatedAt: row.updated_at,
    items: chart.items.map((item, index) => ({ ...item, position: index + 1 })),
  };
}
