import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { db } from "../../config/db-sqlite.ts";
import BoundedMap from "../boundedMap.ts";
import { buildRadio } from "../radio.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIX_SIZE = 50;
const MIN_MIX_TRACKS = 10;
const DAILY_MIXES = 6;
const DAILY_SEED_ARTISTS = 4;
const TOP_ARTISTS = 30;
const BEST_OF_ARTISTS = 3;
const RADIO_MIXES = 3;
const DECADE_MIXES = 3;
const MIN_DECADE_TRACKS = 50;
const MIN_PLAYED_FOR_UNPLAYED = 50;
const PER_ARTIST = 3;
const ON_REPEAT_MS = 30 * DAY_MS;
const REWIND_MS = 365 * DAY_MS;
const TOP_ARTIST_MS = 90 * DAY_MS;
const CACHE_TTL_MS = 30 * 60 * 1000;

export type Mix = {
  id: string;
  name: string;
  description: string;
  trackIds: number[];
  artistId?: number;
};

type TrackPlays = {
  trackId: string;
  artist: string;
  title: string;
  total: number;
  recent: number;
  rewind: number;
  season: number;
  lastPlayedAt: number;
};

type Candidate = { trackId: number; artistId: number; artist: string; title: string };

type LibraryArtist = { id: number; name: string };

const AVAILABLE = `EXISTS (
  SELECT 1 FROM library_media_files AS media
  WHERE media.track_id = track.id AND media.available = 1
)`;

const CANDIDATES = `
  SELECT track.id AS trackId, album.artist_id AS artistId,
         lower(coalesce(track.artist_name, artist.name)) AS artist, lower(track.title) AS title
  FROM library_albums AS album
  JOIN library_artists AS artist ON artist.id = album.artist_id
  JOIN library_album_tracks AS link ON link.album_id = album.id
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE ${AVAILABLE}`;

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");

const playKey = (artist: string, title: string) =>
  `${artist.trim().toLowerCase()}\0${title.trim().toLowerCase()}`;

const playsStmt = db.prepare<[number, number, number, number, number, number], TrackPlays>(`
  SELECT MIN(track_id) AS trackId, MIN(artist) AS artist, MIN(title) AS title,
         COUNT(*) AS total,
         SUM(played_at >= ?) AS recent,
         SUM(played_at >= ? AND played_at < ?) AS rewind,
         SUM(played_at >= ?) AS season,
         MAX(played_at) AS lastPlayedAt
  FROM play_events
  WHERE user_id = ? AND played_at <= ?
  GROUP BY lower(artist), lower(title)
`);

const latestPlayStmt = db.prepare<[number], { at: number | null }>(
  "SELECT MAX(played_at) AS at FROM play_events WHERE user_id = ?",
);

const decadesStmt = db.prepare<[number, number], { decade: number; tracks: number }>(`
  SELECT CAST(substr(album.release_date, 1, 3) AS INTEGER) * 10 AS decade,
         COUNT(DISTINCT track.id) AS tracks
  FROM library_albums AS album
  JOIN library_album_tracks AS link ON link.album_id = album.id
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE album.release_date GLOB '[12][0-9][0-9][0-9]*' AND ${AVAILABLE}
  GROUP BY decade HAVING tracks >= ?
  ORDER BY tracks DESC LIMIT ?
`);

const decadeTracksStmt = db.prepare<[string, string], Candidate>(
  `${CANDIDATES} AND album.release_date >= ? AND album.release_date < ? GROUP BY track.id`,
);

export function seededRandom(seed: string) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(
  candidates: Candidate[],
  weight: (candidate: Candidate) => number,
  random: () => number,
) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      key: Math.log(Math.max(random(), Number.EPSILON)) / Math.max(weight(candidate), 0.01),
    }))
    .sort((left, right) => right.key - left.key);
  const perArtist = new Map<number, number>();
  const picked: number[] = [];
  for (const { candidate } of ranked) {
    if (picked.length >= MIX_SIZE) break;
    const count = perArtist.get(candidate.artistId) ?? 0;
    if (count >= PER_ARTIST) continue;
    perArtist.set(candidate.artistId, count + 1);
    picked.push(candidate.trackId);
  }
  return picked;
}

function resolvePlays(plays: TrackPlays[]) {
  const byId = new Map<number, TrackPlays>();
  const byIdentity = new Map<string, TrackPlays>();
  for (const play of plays) {
    if (/^\d+$/.test(play.trackId)) byId.set(Number(play.trackId), play);
    else if (play.trackId.startsWith("song:")) {
      try {
        byIdentity.set(decodeURIComponent(play.trackId.slice(5)), play);
      } catch {}
    }
  }
  const resolved = new Map<TrackPlays, number>();
  const ids = [...byId.keys()];
  for (const row of ids.length
    ? db
        .prepare<number[], { id: number }>(
          `SELECT track.id FROM library_tracks AS track
           WHERE track.id IN (${placeholders(ids)}) AND ${AVAILABLE}`,
        )
        .all(...ids)
    : []) {
    const play = byId.get(row.id);
    if (play) resolved.set(play, row.id);
  }
  const identities = [...byIdentity.keys()];
  for (const row of identities.length
    ? db
        .prepare<string[], { id: number; identityKey: string }>(
          `SELECT track.id, track.identity_key AS identityKey FROM library_tracks AS track
           WHERE track.identity_key IN (${placeholders(identities)}) AND ${AVAILABLE}`,
        )
        .all(...identities)
    : []) {
    const play = byIdentity.get(row.identityKey);
    if (play) resolved.set(play, row.id);
  }
  const byName = new Map(
    plays
      .filter((play) => !resolved.has(play))
      .map((play) => [playKey(play.artist, play.title), play]),
  );
  const titles = [...new Set([...byName.values()].map((play) => play.title.toLowerCase()))];
  if (titles.length) {
    const rows = db
      .prepare<string[], Candidate>(
        `${CANDIDATES} AND lower(track.title) IN (${placeholders(titles)}) GROUP BY track.id`,
      )
      .all(...titles);
    for (const row of rows) {
      const play = byName.get(playKey(row.artist, row.title));
      if (play && !resolved.has(play)) resolved.set(play, row.trackId);
    }
  }
  return resolved;
}

function ranked(
  plays: TrackPlays[],
  resolved: Map<TrackPlays, number>,
  keep: (play: TrackPlays) => boolean,
  score: (play: TrackPlays) => number,
) {
  const ids = plays
    .filter(keep)
    .sort((left, right) => score(right) - score(left) || right.lastPlayedAt - left.lastPlayedAt)
    .flatMap((play) => {
      const id = resolved.get(play);
      return id === undefined ? [] : [id];
    });
  return [...new Set(ids)].slice(0, MIX_SIZE);
}

function topLibraryArtists(plays: TrackPlays[]) {
  const totals = new Map<string, { recent: number; season: number; total: number }>();
  for (const play of plays) {
    const key = play.artist.trim().toLowerCase();
    const entry = totals.get(key) ?? { recent: 0, season: 0, total: 0 };
    entry.recent += play.recent;
    entry.season += play.season;
    entry.total += play.total;
    totals.set(key, entry);
  }
  const names = [...totals.entries()]
    .sort(([, left], [, right]) => right.season - left.season || right.total - left.total)
    .slice(0, TOP_ARTISTS * 2)
    .map(([key]) => key);
  if (!names.length) return { artists: [], playsByArtist: totals };
  const rows = db
    .prepare<string[], LibraryArtist & { key: string }>(
      `SELECT artist.id, artist.name, lower(artist.name) AS key FROM library_artists AS artist
       WHERE lower(artist.name) IN (${placeholders(names)})
         AND EXISTS (
           SELECT 1 FROM library_albums AS album
           JOIN library_album_tracks AS link ON link.album_id = album.id
           JOIN library_tracks AS track ON track.id = link.track_id
           WHERE album.artist_id = artist.id AND ${AVAILABLE}
         )`,
    )
    .all(...names);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const artists = names.flatMap((name) => {
    const row = byKey.get(name);
    return row ? [{ id: row.id, name: row.name }] : [];
  });
  return { artists: artists.slice(0, TOP_ARTISTS), playsByArtist: totals };
}

function artistGenres(artistIds: number[]) {
  const genres = new Map<number, Set<string>>();
  if (!artistIds.length) return genres;
  const rows = db
    .prepare<number[], { artistId: number; genre: string }>(
      `SELECT entity_id AS artistId, lower(name) AS genre FROM library_entity_genres
       WHERE entity_kind = 'artists' AND entity_id IN (${placeholders(artistIds)})
       UNION
       SELECT album.artist_id, lower(genres.name) FROM library_entity_genres AS genres
       JOIN library_albums AS album ON album.id = genres.entity_id
       WHERE genres.entity_kind = 'albums' AND album.artist_id IN (${placeholders(artistIds)})`,
    )
    .all(...artistIds, ...artistIds);
  for (const row of rows) {
    genres.set(row.artistId, (genres.get(row.artistId) ?? new Set()).add(row.genre));
  }
  return genres;
}

function clusterArtists(artists: LibraryArtist[]) {
  const genres = artistGenres(artists.map((artist) => artist.id));
  const weights = new Map<string, number>();
  for (const [rank, artist] of artists.entries()) {
    for (const genre of genres.get(artist.id) ?? []) {
      weights.set(genre, (weights.get(genre) ?? 0) + 1 / (rank + 1));
    }
  }
  const assigned = new Set<number>();
  const clusters: LibraryArtist[][] = [];
  for (const [genre] of [...weights].sort(([, left], [, right]) => right - left)) {
    if (clusters.length >= DAILY_MIXES) break;
    const members = artists.filter(
      (artist) => !assigned.has(artist.id) && genres.get(artist.id)?.has(genre),
    );
    if (members.length < 2) continue;
    const seeds = members.slice(0, DAILY_SEED_ARTISTS);
    for (const artist of seeds) assigned.add(artist.id);
    clusters.push(seeds);
  }
  if (!clusters.length && artists.length) clusters.push(artists.slice(0, DAILY_SEED_ARTISTS));
  return clusters;
}

const listNames = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

const decadeName = (decade: number) =>
  decade >= 2000 ? `${decade}s Mix` : `${String(decade).slice(2)}s Mix`;

async function buildMixes(userId: number, now: number): Promise<Mix[]> {
  const day = Math.floor(now / DAY_MS);
  const random = (id: string) => seededRandom(`${userId}:${day}:${id}`);
  const plays = playsStmt.all(
    now - ON_REPEAT_MS,
    now - REWIND_MS,
    now - ON_REPEAT_MS,
    now - TOP_ARTIST_MS,
    userId,
    now,
  );
  const played = new Map(plays.map((play) => [playKey(play.artist, play.title), play]));
  const { artists, playsByArtist } = topLibraryArtists(plays);
  const artistWeight = (candidate: Candidate) => {
    const entry = playsByArtist.get(candidate.artist);
    return 1 + Math.log1p(entry ? entry.season || entry.total : 0);
  };

  const mixes: Mix[] = [];
  const noSimilarArtists = async () => [];
  for (const [index, seeds] of clusterArtists(artists).entries()) {
    const id = `daily-${index + 1}`;
    await yieldToEventLoop();
    const trackIds = await buildRadio({
      userId,
      seed: { artists: seeds.map((artist) => ({ id: String(artist.id) })) },
      limit: MIX_SIZE,
      random: random(id),
      now,
      similarArtists: noSimilarArtists,
    });
    mixes.push({
      id,
      name: `Daily Mix ${index + 1}`,
      description: listNames(seeds.map((artist) => artist.name)),
      trackIds,
      artistId: seeds[0]?.id,
    });
  }

  const recentPlays = (artist: LibraryArtist) =>
    playsByArtist.get(artist.name.trim().toLowerCase())?.recent ?? 0;
  const radioSeeds = artists
    .filter((artist) => recentPlays(artist) > 0)
    .sort((left, right) => recentPlays(right) - recentPlays(left))
    .slice(0, RADIO_MIXES);
  const radios = await Promise.all(
    radioSeeds.map(async (artist) => {
      const id = `radio-${artist.id}`;
      await yieldToEventLoop();
      const trackIds = await buildRadio({
        userId,
        seed: { artists: [{ id: String(artist.id) }] },
        limit: MIX_SIZE,
        random: random(id),
        now,
      });
      return {
        id,
        name: `${artist.name} Radio`,
        description: `${artist.name} and similar artists from your Library`,
        trackIds,
        artistId: artist.id,
      };
    }),
  );
  mixes.push(...radios);
  await yieldToEventLoop();

  const candidates = [
    ...plays.filter((play) => play.recent >= 2),
    ...plays.filter((play) => play.rewind >= 2 && play.recent === 0),
    ...plays.filter((play) => play.total >= 3 && play.lastPlayedAt < now - REWIND_MS),
  ];
  const resolved = resolvePlays([...new Set(candidates)]);
  mixes.push(
    {
      id: "on-repeat",
      name: "On Repeat",
      description: "What you've played most this month",
      trackIds: ranked(
        plays,
        resolved,
        (play) => play.recent >= 2,
        (play) => play.recent,
      ),
    },
    {
      id: "rewind",
      name: "Rewind",
      description: "Songs you played a lot this year and haven't lately",
      trackIds: ranked(
        plays,
        resolved,
        (play) => play.rewind >= 2 && play.recent === 0,
        (play) => play.rewind,
      ),
    },
    {
      id: "rediscover",
      name: "Rediscover",
      description: "Old favorites you haven't played in over a year",
      trackIds: ranked(
        plays,
        resolved,
        (play) => play.total >= 3 && play.lastPlayedAt < now - REWIND_MS,
        (play) => play.total,
      ),
    },
  );

  await yieldToEventLoop();
  const topIds = artists.map((artist) => artist.id);
  const artistTracks = topIds.length
    ? db
        .prepare<number[], Candidate>(
          `${CANDIDATES} AND album.artist_id IN (${placeholders(topIds)}) GROUP BY track.id`,
        )
        .all(...topIds)
    : [];
  for (const artist of artists.slice(0, BEST_OF_ARTISTS)) {
    const id = `artist-${artist.id}`;
    const shuffled = random(id);
    const trackIds = artistTracks
      .filter((track) => track.artistId === artist.id)
      .map((track) => ({
        trackId: track.trackId,
        plays: played.get(playKey(track.artist, track.title))?.total ?? 0,
        tiebreak: shuffled(),
      }))
      .sort((left, right) => right.plays - left.plays || left.tiebreak - right.tiebreak)
      .slice(0, MIX_SIZE)
      .map((track) => track.trackId);
    mixes.push({
      id,
      name: `Best of ${artist.name}`,
      description: `${artist.name}, from your Library`,
      trackIds,
      artistId: artist.id,
    });
  }

  for (const { decade } of decadesStmt
    .all(MIN_DECADE_TRACKS, DECADE_MIXES)
    .sort((left, right) => left.decade - right.decade)) {
    const id = `decade-${decade}`;
    mixes.push({
      id,
      name: decadeName(decade),
      description: `Your Library from the ${decadeName(decade).replace(" Mix", "")}`,
      trackIds: pick(
        decadeTracksStmt.all(String(decade), String(decade + 10)),
        artistWeight,
        random(id),
      ),
    });
  }

  if (played.size >= MIN_PLAYED_FOR_UNPLAYED) {
    mixes.push({
      id: "unplayed",
      name: "Unplayed",
      description: "Songs by artists you love that you haven't played yet",
      trackIds: pick(
        artistTracks.filter((track) => !played.has(playKey(track.artist, track.title))),
        artistWeight,
        random("unplayed"),
      ),
    });
  }

  return mixes.filter((mix) => mix.trackIds.length >= MIN_MIX_TRACKS);
}

type CachedMixes = { expiresAt: number; day: number; lastPlayedAt: number; mixes: Promise<Mix[]> };

const cache = new BoundedMap<number, CachedMixes>(500);

export function getUserMixes(userId: number, now = Date.now()) {
  const day = Math.floor(now / DAY_MS);
  const cached = cache.get(userId);
  if (cached && cached.day === day && cached.expiresAt > now) return cached.mixes;
  const lastPlayedAt = latestPlayStmt.get(userId)?.at ?? 0;
  if (cached && cached.day === day && cached.lastPlayedAt === lastPlayedAt) {
    cached.expiresAt = now + CACHE_TTL_MS;
    return cached.mixes;
  }
  const mixes = buildMixes(userId, now);
  cache.set(userId, { expiresAt: now + CACHE_TTL_MS, day, lastPlayedAt, mixes });
  mixes.catch(() => cache.delete(userId));
  return mixes;
}

export async function getUserMix(userId: number, id: string, now = Date.now()) {
  return (await getUserMixes(userId, now)).find((mix) => mix.id === id) ?? null;
}

export function clearUserMixes() {
  cache.clear();
}
