import {
  deezerGetRelatedArtists,
  getDeezerArtist,
  musicbrainzSearchArtistsByTag,
} from "../apiClients/index.ts";
import createCache from "../apiClients/simpleCache.ts";
import { cachedArtistGuess, guessArtistMbid } from "../artistMatch.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import {
  getArtistByMbid,
  getCachedArtistByMbid,
  getGenreBySlug,
} from "../providers/metadataProvider.ts";
import {
  genreSlug,
  getLinkedDeezerArtistId,
  similarScoreToMatch,
  type NormalizedArtist,
} from "../providers/metadataMappers.ts";
import type { SourceHealth } from "../discovery/tasteProfile.ts";
import type { MusicArtistRef } from "./index.ts";
import { normalizeMbid, recordHealth, text } from "./common.ts";

const TAG_SEARCH_PAGE_SIZE = 100;
const RESOLVE_CONCURRENCY = 4;
const METADATA_GENRE_ARTISTS_CAP = 200;
const LISTED_GENRES_TTL_SECONDS = 60 * 60;
const LISTED_GENRES_MAX = 5000;

// A similar list names each artist's genres. Recommendations ask for the tags
// of artists a similar list just named, so those answers need no file of their own.
const listedGenres = createCache<string[]>(LISTED_GENRES_TTL_SECONDS, LISTED_GENRES_MAX);

type TagSearchArtist = Awaited<ReturnType<typeof musicbrainzSearchArtistsByTag>>["artists"][number];

const resolveArtistMbid = async (artist: MusicArtistRef) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) return mbid;
  const name = text(artist?.name);
  if (!name) return null;
  return guessArtistMbid(name);
};

const searchTagArtists = async (
  tag: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
) => {
  const artists = [];
  let nextOffset = offset;
  let total = Infinity;
  while (artists.length < limit && nextOffset < total) {
    const page = await musicbrainzSearchArtistsByTag(tag, {
      limit: Math.min(TAG_SEARCH_PAGE_SIZE, limit - artists.length),
      offset: nextOffset,
    });
    total = page.total;
    if (page.nextOffset <= nextOffset) break;
    nextOffset = page.nextOffset;
    artists.push(...page.artists.map((artist: TagSearchArtist) => ({ ...artist, image: null })));
  }
  return { artists: artists.slice(0, limit), hasMore: nextOffset < total };
};

const getTagArtists = async (tag: string, options?: Parameters<typeof searchTagArtists>[1]) => {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const slug = genreSlug(tag);
  if (slug && offset < METADATA_GENRE_ARTISTS_CAP) {
    const genre = await getGenreBySlug(slug).catch(() => null);
    if (genre && genre.artists.length > 0) {
      const slice = genre.artists.slice(offset, offset + limit);
      return {
        artists: slice.map((artist) => ({
          mbid: artist.id,
          name: artist.name,
          image: artist.image,
        })),
        hasMore: offset + slice.length < genre.artists.length,
      };
    }
  }
  return searchTagArtists(tag, options).catch(() => ({ artists: [], hasMore: false }));
};

const getDeezerSimilarArtists = async (
  artist: MusicArtistRef,
  limit: number,
  knownArtist?: NormalizedArtist | null,
) => {
  const mbid = normalizeMbid(artist?.mbid);
  const name = text(artist?.name);
  const known =
    knownArtist !== undefined
      ? knownArtist
      : mbid
        ? await (name ? getCachedArtistByMbid(mbid) : getArtistByMbid(mbid)).catch(() => null)
        : null;
  const deezerId =
    getLinkedDeezerArtistId(known?.links) || (await getDeezerArtist(name || text(known?.name)))?.id;
  const related = await deezerGetRelatedArtists(deezerId ?? null, { limit }).catch(() => []);
  return related.map((entry, index) => ({
    mbid: cachedArtistGuess(entry.name),
    name: entry.name,
    match: 1 - index / related.length,
    image: entry.image,
  }));
};

export const listenbrainzSource = {
  name: "listenbrainz",

  async getSimilarArtists(
    artist: MusicArtistRef,
    { limit = 50, health }: { limit?: number; health?: SourceHealth } = {},
  ) {
    const mbid = normalizeMbid(artist?.mbid) ?? cachedArtistGuess(text(artist?.name));
    let known: NormalizedArtist | null | undefined;
    if (mbid) {
      known = await getArtistByMbid(mbid).catch(() => null);
      if (known?.similar.length) {
        recordHealth(health, true);
        for (const { id, genres } of known.similar) if (genres) listedGenres.set(id, genres);
        return known.similar.slice(0, limit).map((entry) => ({
          mbid: normalizeMbid(entry.id),
          name: entry.name,
          match: similarScoreToMatch(entry.score),
          image: entry.image,
        }));
      }
    }
    const related = await getDeezerSimilarArtists(artist, limit, known);
    recordHealth(health, related.length > 0 || known != null);
    return related;
  },

  async getArtistTagLists(artists: MusicArtistRef[], { health }: { health?: SourceHealth } = {}) {
    const mbids = await mapWithConcurrency(artists, RESOLVE_CONCURRENCY, resolveArtistMbid);
    const unique = [...new Set(mbids.flatMap((mbid) => (mbid ? [mbid] : [])))];
    const fetched = new Map<string, { name: string; count: number }[]>();
    await mapWithConcurrency(unique, RESOLVE_CONCURRENCY, async (mbid) => {
      try {
        const genres = listedGenres.get(mbid) ?? (await getArtistByMbid(mbid)).genres;
        recordHealth(health, true);
        fetched.set(
          mbid,
          genres.map((name) => ({ name: name.toLowerCase(), count: 100 })),
        );
      } catch {
        recordHealth(health, false);
        fetched.set(mbid, []);
      }
    });
    return mbids.map((mbid) => (mbid && fetched.get(mbid)) || []);
  },

  getTagArtists,
};
