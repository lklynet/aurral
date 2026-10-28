import { UUID_REGEX } from "../../../lib/uuid.ts";
import { LISTENBRAINZ_LABS_API } from "../../config/constants.ts";
import {
  deezerGetArtistTopTrackList,
  deezerGetRelatedArtists,
  getDeezerArtist,
  listenbrainzRequest,
  musicbrainzSearchArtistsByTag,
} from "../apiClients/index.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import { getArtistByMbid } from "../providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../providers/brainzmashMappers.ts";
import { listMusicbrainzGenres } from "../musicGenres.ts";
import type { SourceHealth } from "../discovery/tasteProfile.ts";
import type { MusicArtistRef, MusicTrendingArtist } from "./index.ts";

const LISTENBRAINZ_EXPLORER_SIMILARITY_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";
const ARTIST_METADATA_BATCH_SIZE = 50;
const TAG_SEARCH_PAGE_SIZE = 100;
const RESOLVE_CONCURRENCY = 4;
const TAG_TRACK_CONCURRENCY = 4;
const TRENDING_ARTIST_COUNT = 100;
const TRENDING_RECORDING_COUNT = 500;
const SITEWIDE_STATS_TIMEOUT_MS = 20000;

type ListenbrainzTag = { tag?: string; count?: number };
type ListenbrainzSimilarArtist = { artist_mbid?: string | null; name?: string; score?: number };
type ListenbrainzArtistTags = {
  artist_mbid?: string;
  mbid?: string;
  tag?: { artist?: ListenbrainzTag[] };
};
type ListenbrainzTopArtist = {
  artist_name?: string;
  artist_mbid?: string;
  artist_mbids?: string[];
  listen_count?: number;
};
type ListenbrainzTopRecording = {
  artist_name?: string;
  artist_mbids?: string[];
  track_name?: string;
  release_name?: string | null;
};
type ListenbrainzTopArtists = { payload?: { artists?: ListenbrainzTopArtist[] } };
type ListenbrainzTopRecordings = { payload?: { recordings?: ListenbrainzTopRecording[] } };

type TagSearchArtist = Awaited<ReturnType<typeof musicbrainzSearchArtistsByTag>>["artists"][number];

const text = (value: unknown) => String(value ?? "").trim();
const normalizeMbid = (value: unknown) => {
  const mbid = text(value).toLowerCase();
  return UUID_REGEX.test(mbid) ? mbid : null;
};
const firstMbid = (values: unknown) =>
  (Array.isArray(values) ? values.map(normalizeMbid).find(Boolean) : null) || null;

const recordHealth = (health: SourceHealth | undefined, ok: boolean) => {
  if (!health) return;
  if (ok) health.success += 1;
  else health.failure += 1;
};

const resolveArtistMbid = async (artist: MusicArtistRef) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) return mbid;
  const name = text(artist?.name);
  if (!name) return null;
  return guessArtistMbid(name);
};

const toTagList = (tags: ListenbrainzTag[] | null | undefined) => {
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

type TagArtist = Awaited<ReturnType<typeof searchTagArtists>>["artists"][number];

const getTagArtists = (tag: string, options?: Parameters<typeof searchTagArtists>[1]) =>
  searchTagArtists(tag, options).catch(() => ({ artists: [], hasMore: false }));

const getTopTrack = async (artist: TagArtist) => {
  const [track] = await deezerGetArtistTopTrackList(artist.name, { limit: 5 }).catch(() => []);
  return track
    ? {
        artistName: artist.name,
        artistMbid: artist.mbid || null,
        name: track.name,
        albumName: track.albumName,
      }
    : null;
};

const getDeezerSimilarArtists = async (
  artist: MusicArtistRef,
  mbid: string | null,
  limit: number,
) => {
  const metadata = mbid ? await getArtistByMbid(mbid).catch(() => null) : null;
  const deezerId =
    getLinkedDeezerArtistId(metadata?.links) ||
    (await getDeezerArtist(text(artist?.name) || text(metadata?.name)))?.id;
  const related = await deezerGetRelatedArtists(deezerId ?? null, { limit }).catch(() => []);
  return mapWithConcurrency(related, RESOLVE_CONCURRENCY, async (entry, index) => ({
    mbid: await guessArtistMbid(entry.name),
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
    const mbid = await resolveArtistMbid(artist);
    if (mbid) {
      try {
        const rows: ListenbrainzSimilarArtist[] | undefined = await listenbrainzRequest(
          "/similar-artists/json",
          { artist_mbids: mbid, algorithm: LISTENBRAINZ_EXPLORER_SIMILARITY_ALGORITHM },
          { baseUrl: LISTENBRAINZ_LABS_API },
        );
        recordHealth(health, true);
        const similar = (Array.isArray(rows) ? rows : []).filter((row) => {
          const similarMbid = normalizeMbid(row?.artist_mbid);
          return similarMbid && similarMbid !== mbid && text(row?.name);
        });
        const topScore = Math.max(0, ...similar.map((row) => Number(row.score) || 0));
        if (similar.length) {
          return similar.slice(0, limit).map((row) => ({
            mbid: normalizeMbid(row.artist_mbid),
            name: text(row.name),
            match: topScore > 0 ? (Number(row.score) || 0) / topScore : 0,
            image: null,
          }));
        }
      } catch {
        recordHealth(health, false);
      }
    }
    return getDeezerSimilarArtists(artist, mbid, limit);
  },

  async getArtistTagLists(artists: MusicArtistRef[], { health }: { health?: SourceHealth } = {}) {
    const mbids = await mapWithConcurrency(artists, RESOLVE_CONCURRENCY, resolveArtistMbid);
    const unique = [...new Set(mbids.filter(Boolean))];
    const tagsByMbid = new Map<string, ReturnType<typeof toTagList>>();
    for (let index = 0; index < unique.length; index += ARTIST_METADATA_BATCH_SIZE) {
      try {
        const rows: ListenbrainzArtistTags[] | undefined = await listenbrainzRequest(
          "/1/metadata/artist/",
          {
            artist_mbids: unique.slice(index, index + ARTIST_METADATA_BATCH_SIZE).join(","),
            inc: "tag",
          },
        );
        recordHealth(health, true);
        for (const row of Array.isArray(rows) ? rows : []) {
          const mbid = normalizeMbid(row?.artist_mbid || row?.mbid);
          if (mbid) tagsByMbid.set(mbid, toTagList(row?.tag?.artist));
        }
      } catch {
        recordHealth(health, false);
      }
    }
    return mbids.map((mbid) => (mbid && tagsByMbid.get(mbid)) || []);
  },

  async getArtistTopTracks(artist: MusicArtistRef, { limit = 25 }: { limit?: number } = {}) {
    const name = text(artist?.name);
    return name ? deezerGetArtistTopTrackList(name, { limit }).catch(() => []) : [];
  },

  getTagArtists,

  async getTagTracks(tag: string, { limit = 50 }: { limit?: number } = {}) {
    const { artists } = await getTagArtists(tag, { limit });
    const tracks = await mapWithConcurrency(artists, TAG_TRACK_CONCURRENCY, getTopTrack);
    return tracks.filter((track) => track !== null);
  },

  async getTrendingArtists({ limit = 100 } = {}) {
    const data: ListenbrainzTopArtists = await listenbrainzRequest(
      "/1/stats/sitewide/artists",
      { count: TRENDING_ARTIST_COUNT, range: "week" },
      { timeoutMs: SITEWIDE_STATS_TIMEOUT_MS },
    );
    return (Array.isArray(data?.payload?.artists) ? data.payload.artists : [])
      .slice(0, limit)
      .map((artist, index): MusicTrendingArtist | null => {
        const name = text(artist?.artist_name);
        if (!name) return null;
        const mbid = normalizeMbid(artist?.artist_mbid) || firstMbid(artist?.artist_mbids);
        return {
          id: mbid,
          name,
          image: null,
          type: "Artist",
          popularityLabel: "Trending on ListenBrainz",
          listeners: 0,
          playcount: Number.parseInt(String(artist?.listen_count || 0), 10) || 0,
          popularityRank: index + 1,
        };
      })
      .filter((artist): artist is MusicTrendingArtist => artist !== null);
  },

  async getTrendingTracks() {
    const data: ListenbrainzTopRecordings | null = await listenbrainzRequest(
      "/1/stats/sitewide/recordings",
      { count: TRENDING_RECORDING_COUNT, range: "week" },
      { timeoutMs: SITEWIDE_STATS_TIMEOUT_MS },
    ).catch(() => null);
    return (Array.isArray(data?.payload?.recordings) ? data.payload.recordings : [])
      .map((recording) => ({
        artistName: text(recording?.artist_name),
        artistMbid: firstMbid(recording?.artist_mbids),
        name: text(recording?.track_name),
        albumName: text(recording?.release_name) || null,
      }))
      .filter((track) => track.artistName && track.name);
  },

  async getPopularTags() {
    return listMusicbrainzGenres();
  },
};
