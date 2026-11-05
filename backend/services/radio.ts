import { db } from "../config/db-sqlite.ts";
import type { LibraryArtistsRow } from "../db/rows.ts";
import * as musicData from "./musicDataSource/index.ts";
import { matchesArtistKeys } from "./discovery/artistKeys.ts";
import { getBlockedArtistKeys } from "./discovery/feedback.ts";
import { getBlockedTagKeys, hasBlockedTag } from "./discovery/blockedTags.ts";

export type RadioArtistRef = { id?: string | null; mbid?: string | null; name?: string | null };

export type RadioSeed = {
  trackIds?: string[];
  albumIds?: string[];
  artists?: RadioArtistRef[];
};

type SimilarArtist = { mbid: string | null; name: string; match: number };

type RadioOptions = {
  userId: number | null;
  seed: RadioSeed;
  exclude?: string[];
  limit?: number;
  random?: () => number;
  now?: number;
  similarArtists?: (artist: RadioArtistRef) => Promise<SimilarArtist[]>;
};

type ArtistRow = Pick<LibraryArtistsRow, "id" | "name" | "mbid">;

type Candidate = {
  trackId: number;
  artistId: number;
  trackKey: string;
  artistKey: string;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SIMILAR_SEEDS = 3;
const SIMILAR_LIMIT = 50;
const SIMILAR_TIMEOUT_MS = 2500;
const MAX_GENRE_ARTISTS = 300;
const RECENT_PLAY_MS = 24 * 60 * 60 * 1000;
const RECENT_PENALTY = 0.15;
const FALLBACK_SCORE = 0.05;

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");

const lowerPlaceholders = (values: readonly unknown[]) => values.map(() => "lower(?)").join(",");

const uniqueText = (values: readonly (string | null | undefined)[] = []) => [
  ...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
];

const positiveIds = (values: readonly unknown[]) =>
  values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);

const defaultSimilarArtists = (artist: RadioArtistRef) =>
  musicData.getSimilarArtists(artist, { limit: SIMILAR_LIMIT });

async function withinBudget<T>(work: Promise<T>, fallback: T) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SIMILAR_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveSeed(seed: RadioSeed) {
  const trackRefs = uniqueText(seed.trackIds);
  const albumRefs = uniqueText(seed.albumIds);
  const artistRefs = (seed.artists ?? []).filter(
    (artist) => uniqueText([artist.id, artist.mbid, artist.name]).length > 0,
  );

  const seedTracks = trackRefs.length
    ? db
        .prepare<string[], { trackId: number; albumId: number; artistId: number }>(
          `SELECT track.id AS trackId, album.id AS albumId, album.artist_id AS artistId
           FROM library_tracks AS track
           JOIN library_album_tracks AS link ON link.track_id = track.id
           JOIN library_albums AS album ON album.id = link.album_id
           WHERE track.id IN (${placeholders(trackRefs)})
              OR track.identity_key IN (${placeholders(trackRefs)})`,
        )
        .all(...trackRefs, ...trackRefs)
    : [];
  const seedAlbums = albumRefs.length
    ? db
        .prepare<string[], { albumId: number; artistId: number }>(
          `SELECT id AS albumId, artist_id AS artistId FROM library_albums
           WHERE id IN (${placeholders(albumRefs)}) OR identity_key IN (${placeholders(albumRefs)})`,
        )
        .all(...albumRefs, ...albumRefs)
    : [];

  const ids = uniqueText(artistRefs.map((artist) => artist.id));
  const mbids = uniqueText(artistRefs.map((artist) => artist.mbid));
  const names = uniqueText(artistRefs.map((artist) => artist.name));
  const matchedArtists =
    ids.length || mbids.length || names.length
      ? db
          .prepare<string[], ArtistRow & { identityKey: string }>(
            `SELECT id, name, mbid, identity_key AS identityKey FROM library_artists
             WHERE id IN (${placeholders(ids)}) OR identity_key IN (${placeholders(ids)})
                OR mbid IN (${placeholders(mbids)}) OR lower(name) IN (${lowerPlaceholders(names)})`,
          )
          .all(...ids, ...ids, ...mbids, ...names)
      : [];
  const external = artistRefs.filter(
    (ref) =>
      Boolean(ref.mbid || ref.name) &&
      !matchedArtists.some(
        (artist) =>
          (ref.id && (String(artist.id) === ref.id || artist.identityKey === ref.id)) ||
          (ref.mbid && artist.mbid === ref.mbid) ||
          (ref.name && artist.name.toLowerCase() === ref.name.toLowerCase()),
      ),
  );

  const artistIds = [
    ...new Set([
      ...seedTracks.map((track) => track.artistId),
      ...seedAlbums.map((album) => album.artistId),
      ...matchedArtists.map((artist) => artist.id),
    ]),
  ];
  const trackIds = [...new Set(seedTracks.map((track) => track.trackId))];
  const albumIds = [...new Set([...seedTracks, ...seedAlbums].map((entry) => entry.albumId))];
  const genres = db
    .prepare<number[], { genre: string }>(
      `SELECT DISTINCT lower(name) AS genre FROM library_entity_genres
       WHERE (entity_kind = 'artists' AND entity_id IN (${placeholders(artistIds)}))
          OR (entity_kind = 'albums' AND entity_id IN (${placeholders(albumIds)}))
          OR (entity_kind = 'tracks' AND entity_id IN (${placeholders(trackIds)}))`,
    )
    .all(...artistIds, ...albumIds, ...trackIds)
    .map((row) => row.genre);
  const artists = artistIds.length
    ? db
        .prepare<number[], ArtistRow>(
          `SELECT id, name, mbid FROM library_artists WHERE id IN (${placeholders(artistIds)})`,
        )
        .all(...artistIds)
    : [];

  return { artists, external, genres, trackIds };
}

async function similarArtistScores(
  seeds: RadioArtistRef[],
  similarArtists: NonNullable<RadioOptions["similarArtists"]>,
) {
  const lists = await Promise.all(
    seeds
      .slice(0, MAX_SIMILAR_SEEDS)
      .map((seed) => withinBudget(similarArtists(seed), [] as SimilarArtist[])),
  );
  const similar = lists.flat();
  const mbids = uniqueText(similar.map((artist) => artist.mbid));
  const names = uniqueText(similar.map((artist) => artist.name));
  const scores = new Map<number, number>();
  if (!mbids.length && !names.length) return scores;
  const libraryArtists = db
    .prepare<string[], ArtistRow>(
      `SELECT id, name, mbid FROM library_artists
       WHERE mbid IN (${placeholders(mbids)}) OR lower(name) IN (${lowerPlaceholders(names)})`,
    )
    .all(...mbids, ...names);
  for (const entry of similar) {
    const name = entry.name.toLowerCase();
    const match = Math.max(0, Math.min(1, entry.match));
    for (const artist of libraryArtists) {
      if ((entry.mbid && artist.mbid === entry.mbid) || artist.name.toLowerCase() === name) {
        scores.set(artist.id, Math.max(scores.get(artist.id) ?? 0, 0.35 + 0.6 * match));
      }
    }
  }
  return scores;
}

function genreArtistScores(genres: string[]) {
  const scores = new Map<number, number>();
  if (!genres.length) return scores;
  const rows = db
    .prepare<unknown[], { artistId: number; overlap: number }>(
      `SELECT artist_id AS artistId, COUNT(DISTINCT genre) AS overlap FROM (
         SELECT entity_id AS artist_id, lower(name) AS genre FROM library_entity_genres
         WHERE entity_kind = 'artists' AND lower(name) IN (${placeholders(genres)})
         UNION
         SELECT album.artist_id, lower(genres.name) FROM library_entity_genres AS genres
         JOIN library_albums AS album ON album.id = genres.entity_id
         WHERE genres.entity_kind = 'albums' AND lower(genres.name) IN (${placeholders(genres)})
       )
       GROUP BY artist_id ORDER BY overlap DESC LIMIT ?`,
    )
    .all(...genres, ...genres, MAX_GENRE_ARTISTS);
  for (const row of rows) {
    scores.set(row.artistId, 0.15 + 0.45 * Math.min(1, row.overlap / genres.length));
  }
  return scores;
}

function withoutBlockedArtists(
  scores: Map<number, number>,
  seedArtistIds: Set<number>,
  userId: number | null,
) {
  const blockedArtists = getBlockedArtistKeys(userId ?? "global");
  const blockedTags = getBlockedTagKeys(userId);
  const removed = new Set<number>();
  if (!blockedArtists.size && !blockedTags.size) return removed;
  const ids = [...scores.keys()].filter((id) => !seedArtistIds.has(id));
  if (!ids.length) return removed;
  const artists = db
    .prepare<number[], ArtistRow>(
      `SELECT id, name, mbid FROM library_artists WHERE id IN (${placeholders(ids)})`,
    )
    .all(...ids);
  const genresByArtist = new Map<number, string[]>();
  if (blockedTags.size) {
    for (const row of db
      .prepare<number[], { artistId: number; name: string }>(
        `SELECT entity_id AS artistId, name FROM library_entity_genres
         WHERE entity_kind = 'artists' AND entity_id IN (${placeholders(ids)})`,
      )
      .all(...ids)) {
      genresByArtist.set(row.artistId, [...(genresByArtist.get(row.artistId) ?? []), row.name]);
    }
  }
  for (const artist of artists) {
    if (
      matchesArtistKeys({ mbid: artist.mbid, name: artist.name }, blockedArtists) ||
      hasBlockedTag(genresByArtist.get(artist.id), blockedTags)
    ) {
      scores.delete(artist.id);
      removed.add(artist.id);
    }
  }
  return removed;
}

const CANDIDATE_SELECT = `
  SELECT track.id AS trackId, album.artist_id AS artistId,
         track.identity_key AS trackKey, artist.identity_key AS artistKey
  FROM library_albums AS album
  JOIN library_artists AS artist ON artist.id = album.artist_id
  JOIN library_album_tracks AS link ON link.album_id = album.id
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE EXISTS (
    SELECT 1 FROM library_media_files AS media
    WHERE media.track_id = track.id AND media.available = 1
  )`;

function candidateTracks(artistIds: number[]) {
  if (!artistIds.length) return [];
  return db
    .prepare<number[], Candidate>(
      `${CANDIDATE_SELECT} AND album.artist_id IN (${placeholders(artistIds)}) GROUP BY track.id`,
    )
    .all(...artistIds);
}

function fallbackTracks(limit: number, skipArtistIds: Set<number>) {
  const skip = [...skipArtistIds];
  return db
    .prepare<number[], Candidate>(
      `${CANDIDATE_SELECT} AND album.artist_id NOT IN (${placeholders(skip)})
       GROUP BY track.id ORDER BY random() LIMIT ?`,
    )
    .all(...skip, limit);
}

function listeningSignals(userId: number | null, now: number) {
  if (userId == null) {
    return { recent: new Set<number>(), songs: new Set<string>(), artists: new Set<string>() };
  }
  const played = db
    .prepare<[number, number], { trackId: string }>(
      "SELECT DISTINCT track_id AS trackId FROM play_events WHERE user_id = ? AND played_at >= ?",
    )
    .all(userId, now - RECENT_PLAY_MS)
    .map((row) => row.trackId);
  const songKeys = played.flatMap((id) =>
    id.startsWith("song:") ? [decodeURIComponent(id.slice(5))] : [],
  );
  const recent = new Set([
    ...positiveIds(played),
    ...db
      .prepare<string[], { id: number }>(
        `SELECT id FROM library_tracks WHERE identity_key IN (${placeholders(songKeys)})`,
      )
      .all(...songKeys)
      .map((row) => row.id),
  ]);
  const stars = db
    .prepare<[number], { kind: string; key: string }>(
      `SELECT entity_kind AS kind, entity_key AS key FROM subsonic_stars
       WHERE user_id = ? AND entity_kind IN ('song', 'artist')`,
    )
    .all(userId);
  return {
    recent,
    songs: new Set(stars.filter((star) => star.kind === "song").map((star) => star.key)),
    artists: new Set(stars.filter((star) => star.kind === "artist").map((star) => star.key)),
  };
}

function spreadArtists(picks: Candidate[]) {
  const remaining = [...picks];
  const ordered: Candidate[] = [];
  const left = new Map<number, number>();
  for (const pick of picks) left.set(pick.artistId, (left.get(pick.artistId) ?? 0) + 1);
  while (remaining.length) {
    const previous = ordered.at(-1)?.artistId;
    let index = 0;
    for (let at = 0; at < remaining.length; at += 1) {
      const artistId = remaining[at]!.artistId;
      const best = remaining[index]!.artistId;
      if (best === previous && artistId !== previous) index = at;
      else if (artistId !== previous && (left.get(artistId) ?? 0) > (left.get(best) ?? 0)) {
        index = at;
      }
    }
    const [next] = remaining.splice(index, 1);
    left.set(next!.artistId, (left.get(next!.artistId) ?? 0) - 1);
    ordered.push(next!);
  }
  return ordered;
}

function choose(
  candidates: Candidate[],
  weightOf: (candidate: Candidate) => number,
  seedArtistIds: Set<number>,
  limit: number,
  random: () => number,
) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      key: Math.log(Math.max(random(), Number.EPSILON)) / weightOf(candidate),
    }))
    .sort((left, right) => right.key - left.key)
    .map((entry) => entry.candidate);
  const seedCap = Math.max(1, Math.ceil(limit / 4));
  const artistCap = Math.max(2, Math.ceil(limit / 12));
  const perArtist = new Map<number, number>();
  let seedCount = 0;
  const picked: Candidate[] = [];
  const skipped: Candidate[] = [];
  for (const candidate of ranked) {
    if (picked.length >= limit) break;
    const isSeed = seedArtistIds.has(candidate.artistId);
    const count = perArtist.get(candidate.artistId) ?? 0;
    if (isSeed ? seedCount >= seedCap : count >= artistCap) {
      skipped.push(candidate);
      continue;
    }
    picked.push(candidate);
    perArtist.set(candidate.artistId, count + 1);
    if (isSeed) seedCount += 1;
  }
  picked.push(...skipped.slice(0, limit - picked.length));
  return spreadArtists(picked);
}

export async function buildRadio({
  userId,
  seed,
  exclude = [],
  limit = DEFAULT_LIMIT,
  random = Math.random,
  now = Date.now(),
  similarArtists = defaultSimilarArtists,
}: RadioOptions) {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));
  const resolved = resolveSeed(seed);
  if (!resolved.artists.length && !resolved.external.length) return [];
  const seedArtistIds = new Set(resolved.artists.map((artist) => artist.id));
  const similarSeeds: RadioArtistRef[] = [
    ...resolved.artists.map((artist) => ({ mbid: artist.mbid, name: artist.name })),
    ...resolved.external,
  ];

  const scores = genreArtistScores(resolved.genres);
  for (const [artistId, score] of await similarArtistScores(similarSeeds, similarArtists)) {
    scores.set(artistId, Math.max(scores.get(artistId) ?? 0, score));
  }
  for (const artistId of seedArtistIds) scores.set(artistId, 1);
  const blocked = withoutBlockedArtists(scores, seedArtistIds, userId);

  const excluded = new Set([...positiveIds(exclude), ...resolved.trackIds]);
  const pool = candidateTracks([...scores.keys()]).filter(
    (candidate) => !excluded.has(candidate.trackId),
  );
  if (pool.length < size * 2) {
    const known = new Set(pool.map((candidate) => candidate.trackId));
    for (const candidate of fallbackTracks(size * 4, blocked)) {
      if (excluded.has(candidate.trackId) || known.has(candidate.trackId)) continue;
      if (!scores.has(candidate.artistId)) scores.set(candidate.artistId, FALLBACK_SCORE);
      known.add(candidate.trackId);
      pool.push(candidate);
    }
    withoutBlockedArtists(scores, seedArtistIds, userId);
  }
  const candidates = pool.filter((candidate) => scores.has(candidate.artistId));

  const tracksPerArtist = new Map<number, number>();
  for (const candidate of candidates) {
    tracksPerArtist.set(candidate.artistId, (tracksPerArtist.get(candidate.artistId) ?? 0) + 1);
  }
  const signals = listeningSignals(userId, now);
  const weightOf = (candidate: Candidate) =>
    ((scores.get(candidate.artistId) ?? FALLBACK_SCORE) *
      (signals.songs.has(candidate.trackKey) ? 2 : 1) *
      (signals.artists.has(candidate.artistKey) ? 1.5 : 1) *
      (signals.recent.has(candidate.trackId) ? RECENT_PENALTY : 1)) /
    Math.sqrt(tracksPerArtist.get(candidate.artistId) ?? 1);

  return choose(candidates, weightOf, seedArtistIds, size, random).map(
    (candidate) => candidate.trackId,
  );
}
