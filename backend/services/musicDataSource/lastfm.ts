import { lastfmRequest } from "../apiClients/index.ts";
import type { LastfmImage } from "../apiClients/lastfm.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import type { SourceHealth } from "../discovery/tasteProfile.ts";
import type { MusicArtistRef } from "./index.ts";
import { normalizeMbid, recordHealth, text } from "./common.ts";

const LASTFM_PLACEHOLDER_IMAGE_HASH = "2a96cbd8b46e442fc41c2b86b821562f";
const TAG_ARTIST_MAX_PAGE_SIZE = 200;
const TAG_LOOKUP_CONCURRENCY = 6;

type LastfmParams = Record<string, string | number | null | undefined>;
type LastfmCallOptions = { health?: SourceHealth; signal?: AbortSignal };

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : value ? [value] : [];

export const pickLastfmImage = (images: LastfmImage | LastfmImage[] | null | undefined) => {
  const list = asArray(images);
  const image =
    list.find((entry) => entry.size === "extralarge") ||
    list.find((entry) => entry.size === "large") ||
    list.at(-1);
  const url = text(image?.["#text"]);
  return url && !url.includes(LASTFM_PLACEHOLDER_IMAGE_HASH) ? url : null;
};

const callLastfm = async (
  method: string,
  params: LastfmParams,
  { health, signal }: LastfmCallOptions = {},
) => {
  const data = await lastfmRequest(method, params, { signal }).catch(() => null);
  const ok = Boolean(data) && !data?.error;
  recordHealth(health, ok);
  return ok ? data : null;
};

const callForArtist = async (
  method: string,
  artist: MusicArtistRef,
  params: LastfmParams,
  options: LastfmCallOptions,
) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) {
    const data = await callLastfm(method, { mbid, ...params }, options);
    if (data) return data;
  }
  const name = text(artist?.name);
  return name ? callLastfm(method, { artist: name, ...params }, options) : null;
};

const getArtistTags = async (artist: MusicArtistRef, options: LastfmCallOptions = {}) => {
  const data = await callForArtist("artist.getTopTags", artist, {}, options);
  return asArray(data?.toptags?.tag)
    .map((tag) => ({ name: text(tag?.name), count: parseInt(String(tag?.count || 0), 10) || 1 }))
    .filter((tag) => tag.name);
};

export const lastfmSource = {
  name: "lastfm",

  async getSimilarArtists(
    artist: MusicArtistRef,
    { limit = 50, health, signal }: LastfmCallOptions & { limit?: number } = {},
  ) {
    const data = await callForArtist("artist.getSimilar", artist, { limit }, { health, signal });
    return asArray(data?.similarartists?.artist)
      .map((entry) => ({
        mbid: normalizeMbid(entry?.mbid),
        name: text(entry?.name),
        match: Number(entry?.match) || 0,
        image: pickLastfmImage(entry?.image),
      }))
      .filter((entry) => entry.name);
  },

  getArtistTagLists(artists: MusicArtistRef[], { health }: LastfmCallOptions = {}) {
    return mapWithConcurrency(artists, TAG_LOOKUP_CONCURRENCY, (artist: MusicArtistRef) =>
      getArtistTags(artist, { health }),
    );
  },

  async getTagArtists(
    tag: string,
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
  ) {
    const required = offset + limit;
    const pageSize = Math.min(TAG_ARTIST_MAX_PAGE_SIZE, Math.max(50, required));
    const artists = [];
    const seen = new Set();
    let page = 1;
    let exhausted = false;
    while (!exhausted && artists.length < required) {
      const data = await callLastfm("tag.getTopArtists", { tag, limit: pageSize, page });
      const entries = asArray(data?.topartists?.artist);
      for (const entry of entries) {
        const name = text(entry?.name);
        const key = normalizeMbid(entry?.mbid) || name.toLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        artists.push({
          mbid: normalizeMbid(entry?.mbid),
          name,
          image: pickLastfmImage(entry?.image),
        });
      }
      const total = Number.parseInt(String(data?.topartists?.["@attr"]?.total), 10);
      exhausted = entries.length < pageSize || (Number.isFinite(total) && page * pageSize >= total);
      page += 1;
    }
    return {
      artists: artists.slice(offset, offset + limit),
      hasMore: !exhausted || artists.length > required,
    };
  },
};
