import * as v from "valibot";
import {
  deezerGetRelatedArtists,
  getDeezerArtist,
  listenbrainzRequest,
  musicbrainzSearchArtistsByTag,
} from "../apiClients/index.ts";
import { lenient, lenientCount, lenientText } from "../integrationData.ts";
import { dbOps } from "../../db/helpers/index.ts";
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

const ARTIST_METADATA_BATCH_SIZE = 50;
const TAG_SEARCH_PAGE_SIZE = 100;
const RESOLVE_CONCURRENCY = 4;
const ARTIST_TAGS_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const METADATA_GENRE_ARTISTS_CAP = 200;

const tagSchema = v.fallback(v.looseObject({ tag: lenientText, count: lenientCount }), {});
const artistTagsSchema = lenient(
  v.array(
    v.fallback(
      v.looseObject({
        artist_mbid: lenientText,
        mbid: lenientText,
        tag: lenient(v.looseObject({ artist: lenient(v.array(tagSchema)) })),
      }),
      {},
    ),
  ),
);

const fetchArtistTags = async (mbids: string[], health?: SourceHealth) => {
  const fetched = new Map<string, ReturnType<typeof toTagList>>();
  for (let index = 0; index < mbids.length; index += ARTIST_METADATA_BATCH_SIZE) {
    const batch = mbids.slice(index, index + ARTIST_METADATA_BATCH_SIZE);
    try {
      const rows = v.parse(
        artistTagsSchema,
        await listenbrainzRequest("/1/metadata/artist/", {
          artist_mbids: batch.join(","),
          inc: "tag",
        }),
      );
      recordHealth(health, true);
      const found = new Map(
        (Array.isArray(rows) ? rows : []).map((row) => [
          normalizeMbid(row?.artist_mbid || row?.mbid),
          toTagList(row?.tag?.artist),
        ]),
      );
      for (const mbid of batch) fetched.set(mbid, found.get(mbid) ?? []);
    } catch {
      recordHealth(health, false);
    }
  }
  if (fetched.size) dbOps.saveListenbrainzArtistTags(fetched, Date.now());
  return fetched;
};

type TagSearchArtist = Awaited<ReturnType<typeof musicbrainzSearchArtistsByTag>>["artists"][number];

const resolveArtistMbid = async (artist: MusicArtistRef) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) return mbid;
  const name = text(artist?.name);
  if (!name) return null;
  return guessArtistMbid(name);
};

const toTagList = (tags: v.InferOutput<typeof tagSchema>[] | undefined) => {
  const entries = (Array.isArray(tags) ? tags : []).filter((tag) => text(tag?.tag));
  const topCount = Math.max(1, ...entries.map((tag) => Number(tag.count) || 0));
  return entries
    .sort((left, right) => (Number(right.count) || 0) - (Number(left.count) || 0))
    .map((tag) => ({
      name: text(tag.tag),
      count: Math.max(1, Math.round(((Number(tag.count) || 0) / topCount) * 100)),
    }));
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
    const mbid = normalizeMbid(artist?.mbid);
    let known: NormalizedArtist | null | undefined;
    if (mbid) {
      known = await getArtistByMbid(mbid).catch(() => null);
      if (known?.similar.length) {
        recordHealth(health, true);
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
    const stored = dbOps.getListenbrainzArtistTags(unique);
    const freshAfter = Date.now() - ARTIST_TAGS_FRESH_MS;
    const stale = unique.filter((mbid) => (stored.get(mbid)?.checkedAt ?? Infinity) < freshAfter);
    if (stale.length) void fetchArtistTags(stale).catch(() => {});
    const fetched = await fetchArtistTags(
      unique.filter((mbid) => !stored.has(mbid)),
      health,
    );
    return mbids.map((mbid) => (mbid && (fetched.get(mbid) ?? stored.get(mbid)?.tags)) || []);
  },

  getTagArtists,
};
