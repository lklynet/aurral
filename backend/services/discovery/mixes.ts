import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { db } from "../../config/db-sqlite.ts";
import BoundedMap from "../boundedMap.ts";
import { buildRadio } from "../radio.ts";
import { matchesArtistKeys } from "../../../lib/artistMatch.ts";
import { getBlockedArtistKeys } from "./feedback.ts";
import {
  BLEND_MIX_PREFIX,
  FRIEND_BLEND_MIX_PREFIX,
  LISTENS_MIX_PREFIX,
} from "../../../lib/browsePlaylists.ts";
import { sharedFriendTracks, type FriendTracks } from "../hubFriends.ts";

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
const BLEND_CANDIDATES = 200;
const BLEND_WINDOW = 1000;
const MIN_BLEND_SHARE = 5;
const MAX_BLENDS = 3;

export type Mix = {
  id: string;
  name: string;
  description: string;
  trackIds: number[];
  artistId?: number;
  reasons?: Map<number, string>;
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

const lowerForms = (text: string) => [
  text.toLowerCase(),
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
];

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

const latestPlayStmt = db.prepare<[number], { id: number | null }>(
  "SELECT MAX(id) AS id FROM play_events WHERE user_id = ?",
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
  const titles = [...new Set([...byName.values()].flatMap((play) => lowerForms(play.title)))];
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

type BlendSource = "both" | 0 | 1;
type Favorite = { play: TrackPlays; weight: number };

type BlendPartner = {
  id: number;
  username: string;
  viewer: string;
  handle: string | null;
  lastPlayedAt: number;
  lastTitle: string;
  lastArtist: string;
  lastAlbum: string | null;
};

const visiblePeopleStmt = db.prepare<[number, number], BlendPartner>(`
  SELECT * FROM (
    SELECT partner.id, partner.username, viewer.username AS viewer,
           CASE WHEN link.origin = mine.origin THEN link.handle END AS handle,
           last.played_at AS lastPlayedAt, last.title AS lastTitle,
           last.artist AS lastArtist, last.album AS lastAlbum
    FROM users AS viewer
    JOIN users AS partner
      ON partner.blend = 1 AND partner.status = 'active' AND partner.id <> viewer.id
    JOIN play_events AS last ON last.id = (
      SELECT id FROM play_events WHERE user_id = partner.id ORDER BY played_at DESC LIMIT 1
    )
    LEFT JOIN hub_links AS link
      ON link.user_id = partner.id AND link.linked_at IS NOT NULL AND link.broken = 0
    LEFT JOIN hub_links AS mine
      ON mine.user_id = viewer.id AND mine.linked_at IS NOT NULL AND mine.broken = 0
    WHERE viewer.id = ? AND viewer.blend = 1 AND viewer.status = 'active'
  )
  WHERE lastPlayedAt >= ?
  ORDER BY username COLLATE NOCASE
`);

export const visiblePeople = (userId: number, now = Date.now()) =>
  visiblePeopleStmt.all(userId, now - REWIND_MS);

const recentArtistsStmt = db.prepare<[number, number], { artist: string }>(
  "SELECT DISTINCT lower(artist) AS artist FROM play_events WHERE user_id = ? AND played_at >= ?",
);

const artistSets = new BoundedMap<number, { day: number; artists: Set<string> }>(500);

function recentArtists(userId: number, now: number) {
  const day = Math.floor(now / DAY_MS);
  const cached = artistSets.get(userId);
  if (cached?.day === day) return cached.artists;
  const artists = new Set(
    recentArtistsStmt.all(userId, now - TOP_ARTIST_MS).map(({ artist }) => artist),
  );
  artistSets.set(userId, { day, artists });
  return artists;
}

type Partner = { person: BlendPartner } | { friend: FriendTracks };

const artistsOf = (partner: Partner, now: number) =>
  "person" in partner
    ? recentArtists(partner.person.id, now)
    : new Set(partner.friend.tracks.map(({ artist }) => artist.toLowerCase()));

function closestPartners(userId: number, partners: Partner[], now: number) {
  if (partners.length <= MAX_BLENDS) return partners;
  const mine = recentArtists(userId, now);
  const sharedWith = (partner: Partner) => {
    let shared = 0;
    for (const artist of artistsOf(partner, now)) if (mine.has(artist)) shared += 1;
    return shared;
  };
  return partners
    .map((partner) => ({ partner, shared: sharedWith(partner) }))
    .sort((left, right) => right.shared - left.shared)
    .slice(0, MAX_BLENDS)
    .map(({ partner }) => partner);
}

function blendFavorites(userId: number, now: number, blocked: Set<string>): Favorite[] {
  return playsStmt
    .all(now - ON_REPEAT_MS, now - REWIND_MS, now - ON_REPEAT_MS, now - TOP_ARTIST_MS, userId, now)
    .filter((play) => !matchesArtistKeys({ name: play.artist }, blocked))
    .map((play) => ({ play, weight: 2 * Math.log1p(play.season) + Math.log1p(play.total) }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, BLEND_WINDOW);
}

function spareTracksBy(names: string[], taken: Set<number>) {
  const spares = new Map<string, number[]>();
  const artists = [...new Set(names.flatMap(lowerForms))];
  if (!artists.length) return spares;
  const rows = db
    .prepare<string[], Candidate>(
      `${CANDIDATES} AND lower(coalesce(track.artist_name, artist.name)) IN (${placeholders(artists)})
       GROUP BY track.id`,
    )
    .all(...artists);
  for (const row of rows) {
    if (taken.has(row.trackId)) continue;
    const key = row.artist.trim().toLowerCase();
    const tracks = spares.get(key);
    if (tracks) tracks.push(row.trackId);
    else spares.set(key, [row.trackId]);
  }
  return spares;
}

function friendFavorites(friend: FriendTracks, blocked: Set<string>): Favorite[] {
  const plays = friend.tracks
    .filter(({ artist }) => !matchesArtistKeys({ name: artist }, blocked))
    .map(({ title, artist }): TrackPlays => ({
      trackId: "",
      artist,
      title,
      total: 0,
      recent: 0,
      rewind: 0,
      season: 0,
      lastPlayedAt: 0,
    }));
  const resolved = resolvePlays(plays);
  const artistOf = (play: TrackPlays) => play.artist.trim().toLowerCase();
  const missing = plays.filter((play) => !resolved.has(play)).map((play) => play.artist.trim());
  const spares = spareTracksBy(missing, new Set(resolved.values()));
  return plays.flatMap((play, rank) => {
    const id = resolved.get(play) ?? spares.get(artistOf(play))?.shift();
    return id === undefined
      ? []
      : [{ play: { ...play, trackId: String(id) }, weight: Math.log1p(plays.length - rank) }];
  });
}

async function buildBlend(seed: string, favorites: () => Favorite[][]) {
  const draw = (id: number) => seededRandom(`${seed}:blend:${id}`)();
  const sides = favorites();
  await yieldToEventLoop();
  const [mine, theirs] = sides.map((side) => {
    const resolved = resolvePlays(side.map(({ play }) => play));
    const tracks = new Map<number, { weight: number; artist: string }>();
    for (const { play, weight } of side) {
      const id = resolved.get(play);
      if (tracks.size >= BLEND_CANDIDATES) break;
      if (id !== undefined && !tracks.has(id)) {
        tracks.set(id, { weight, artist: play.artist.trim().toLowerCase() });
      }
    }
    return tracks;
  });
  if (!mine || !theirs) return null;
  const shuffled = (tracks: [number, { weight: number; artist: string }][]) =>
    tracks
      .map(([id, { weight, artist }]) => ({
        id,
        artist,
        key: Math.log(Math.max(draw(id), Number.EPSILON)) / Math.max(weight, 0.01),
      }))
      .sort((a, b) => b.key - a.key);
  const queues: [BlendSource, ReturnType<typeof shuffled>][] = [
    [
      "both",
      shuffled(
        [...mine].flatMap(([id, track]) => {
          const other = theirs.get(id);
          return other ? [[id, { ...track, weight: track.weight + other.weight }] as const] : [];
        }),
      ),
    ],
    [0, shuffled([...mine].filter(([id]) => !theirs.has(id)))],
    [1, shuffled([...theirs].filter(([id]) => !mine.has(id)))],
  ];
  const sources = new Map<number, BlendSource>();
  const perArtist = new Map<string, number>();
  const take = (queue: ReturnType<typeof shuffled>) => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const count = perArtist.get(next.artist) ?? 0;
      if (count >= PER_ARTIST) continue;
      perArtist.set(next.artist, count + 1);
      return next;
    }
    return null;
  };
  let lanes = queues;
  while (lanes.length && sources.size < MIX_SIZE) {
    lanes = lanes.filter(([source, queue]) => {
      const next = sources.size < MIX_SIZE && take(queue);
      if (next) sources.set(next.id, source);
      return !!next;
    });
  }
  const share = (side: 0 | 1) =>
    [...sources.values()].filter((source) => source === "both" || source === side).length;
  return sources.size >= MIN_MIX_TRACKS &&
    share(0) >= MIN_BLEND_SHARE &&
    share(1) >= MIN_BLEND_SHARE
    ? sources
    : null;
}

type CachedBlend = {
  day: number;
  inputs: string;
  sources: Promise<Map<number, BlendSource> | null>;
};

const blendCache = new BoundedMap<string, CachedBlend>(500);

function cachedBlend(key: string, inputs: string, now: number, favorites: () => Favorite[][]) {
  const day = Math.floor(now / DAY_MS);
  const cached = blendCache.get(key);
  if (cached && cached.day === day && cached.inputs === inputs) return cached.sources;
  const sources = buildBlend(`${key}:${day}`, favorites);
  blendCache.set(key, { day, inputs, sources });
  sources.catch(() => blendCache.delete(key));
  return sources;
}

function getBlend(userId: number, partnerId: number, now: number) {
  const [left, right] = userId < partnerId ? [userId, partnerId] : [partnerId, userId];
  const blocked = new Set([...getBlockedArtistKeys(left), ...getBlockedArtistKeys(right)]);
  const inputs = [latestPlayStmt.get(left)?.id, latestPlayStmt.get(right)?.id, ...blocked].join(
    "\0",
  );
  return cachedBlend(`${left}:${right}`, inputs, now, () => [
    blendFavorites(left, now, blocked),
    blendFavorites(right, now, blocked),
  ]);
}

function getFriendBlend(userId: number, friend: FriendTracks, now: number) {
  const blocked = getBlockedArtistKeys(userId);
  const inputs = [latestPlayStmt.get(userId)?.id, friend.fetchedAt, ...blocked].join("\0");
  return cachedBlend(`${userId}:@${friend.handle}`, inputs, now, () => [
    blendFavorites(userId, now, blocked),
    friendFavorites(friend, blocked),
  ]);
}

export function getUserBlends(userId: number, now = Date.now()) {
  const people = visiblePeople(userId, now);
  const here = new Set(people.map(({ handle }) => handle));
  const partners: Partner[] = [
    ...people.map((person) => ({ person })),
    ...sharedFriendTracks(userId)
      .filter(({ handle }) => !here.has(handle))
      .map((friend) => ({ friend })),
  ];
  return blendsWith(userId, closestPartners(userId, partners, now), now);
}

const recentPlaysStmt = db.prepare<[number, number, number], TrackPlays>(`
  SELECT MIN(track_id) AS trackId, MIN(artist) AS artist, MIN(title) AS title,
         COUNT(*) AS total, COUNT(*) AS recent, 0 AS rewind, COUNT(*) AS season,
         MAX(played_at) AS lastPlayedAt
  FROM play_events
  WHERE user_id = ? AND played_at >= ? AND played_at <= ?
  GROUP BY lower(artist), lower(title)
  ORDER BY total DESC, lastPlayedAt DESC
  LIMIT ${BLEND_WINDOW}
`);

function listensOf(userId: number, person: BlendPartner, now: number): Mix | null {
  const blocked = getBlockedArtistKeys(userId);
  const plays = recentPlaysStmt
    .all(person.id, now - ON_REPEAT_MS, now)
    .filter((play) => !matchesArtistKeys({ name: play.artist }, blocked));
  const trackIds = ranked(
    plays,
    resolvePlays(plays),
    () => true,
    (play) => play.total,
  );
  return trackIds.length >= MIN_MIX_TRACKS
    ? {
        id: `${LISTENS_MIX_PREFIX}${person.id}`,
        name: `${person.username}'s tracks`,
        description: `What ${person.username} played most in the last 30 days`,
        trackIds,
      }
    : null;
}

async function blendsWith(userId: number, partners: Partner[], now: number) {
  const mixes: Mix[] = [];
  const waiting: string[] = [];
  for (const partner of partners) {
    const local = "person" in partner;
    const sources = await (local
      ? getBlend(userId, partner.person.id, now)
      : getFriendBlend(userId, partner.friend, now));
    if (!sources) {
      if (local) waiting.push(partner.person.username);
      continue;
    }
    const { id, name, viewer, mine } = local
      ? {
          id: `${BLEND_MIX_PREFIX}${partner.person.id}`,
          name: partner.person.username,
          viewer: partner.person.viewer,
          mine: userId < partner.person.id ? 0 : 1,
        }
      : {
          id: `${FRIEND_BLEND_MIX_PREFIX}${partner.friend.handle}`,
          name: `@${partner.friend.handle}`,
          viewer: partner.friend.viewer,
          mine: 0,
        };
    const reasonFor = (source: BlendSource) =>
      source === "both" ? "You both play this" : source === mine ? "From you" : `From ${name}`;
    mixes.push({
      id,
      name: `Blend with ${name}`,
      description: `${viewer} and ${name}`,
      trackIds: [...sources.keys()],
      reasons: new Map([...sources].map(([track, source]) => [track, reasonFor(source)])),
    });
  }
  return { mixes, waiting };
}

const blendSettingStmt = db.prepare<[number], { blend: number }>(
  "SELECT blend FROM users WHERE id = ?",
);
const setBlendStmt = db.prepare<[number, number]>("UPDATE users SET blend = ? WHERE id = ?");

export const sharesListening = (userId: number) => blendSettingStmt.get(userId)?.blend === 1;

export async function getBlendSetting(userId: number) {
  const enabled = sharesListening(userId);
  return { enabled, waiting: enabled ? (await getUserBlends(userId)).waiting : [] };
}

export function setBlendSetting(userId: number, enabled: boolean) {
  setBlendStmt.run(enabled ? 1 : 0, userId);
  return getBlendSetting(userId);
}

type CachedMixes = { expiresAt: number; day: number; lastPlayId: number; mixes: Promise<Mix[]> };

const cache = new BoundedMap<number, CachedMixes>(500);

export async function getUserMixes(userId: number, now = Date.now()) {
  const [blends, mixes] = await Promise.all([getUserBlends(userId, now), getOwnMixes(userId, now)]);
  return blends.mixes.length ? [...mixes, ...blends.mixes] : mixes;
}

function getOwnMixes(userId: number, now: number) {
  const day = Math.floor(now / DAY_MS);
  const cached = cache.get(userId);
  if (cached && cached.day === day && cached.expiresAt > now) return cached.mixes;
  const lastPlayId = latestPlayStmt.get(userId)?.id ?? 0;
  if (cached && cached.day === day && cached.lastPlayId === lastPlayId) {
    cached.expiresAt = now + CACHE_TTL_MS;
    return cached.mixes;
  }
  const mixes = buildMixes(userId, now);
  cache.set(userId, { expiresAt: now + CACHE_TTL_MS, day, lastPlayId, mixes });
  mixes.catch(() => cache.delete(userId));
  return mixes;
}

export async function getUserMix(userId: number, id: string, now = Date.now()) {
  if (id.startsWith(FRIEND_BLEND_MIX_PREFIX)) {
    const handle = id.slice(FRIEND_BLEND_MIX_PREFIX.length);
    const friend = sharedFriendTracks(userId).find((each) => each.handle === handle);
    return friend ? ((await blendsWith(userId, [{ friend }], now)).mixes[0] ?? null) : null;
  }
  const prefix = [BLEND_MIX_PREFIX, LISTENS_MIX_PREFIX].find((each) => id.startsWith(each));
  if (prefix) {
    const personId = Number(id.slice(prefix.length));
    const person = visiblePeople(userId, now).find((each) => each.id === personId);
    if (!person) return null;
    return prefix === LISTENS_MIX_PREFIX
      ? listensOf(userId, person, now)
      : ((await blendsWith(userId, [{ person }], now)).mixes[0] ?? null);
  }
  return (await getOwnMixes(userId, now)).find((mix) => mix.id === id) ?? null;
}

export function clearUserMixes() {
  cache.clear();
  blendCache.clear();
  artistSets.clear();
}
