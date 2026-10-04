import { UUID_REGEX } from "../../../lib/uuid.js";
import { lastfmRequest } from "../apiClients/index.js";
import { mapWithConcurrency } from "../discovery/helpers.js";

const LASTFM_PLACEHOLDER_IMAGE_HASH = "2a96cbd8b46e442fc41c2b86b821562f";
const TAG_ARTIST_MAX_PAGE_SIZE = 200;
const TAG_LOOKUP_CONCURRENCY = 6;

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const text = (value) => String(value ?? "").trim();
const normalizeMbid = (value) => {
  const mbid = text(value).toLowerCase();
  return UUID_REGEX.test(mbid) ? mbid : null;
};

const recordHealth = (health, ok) => {
  if (!health) return;
  if (ok) health.success += 1;
  else health.failure += 1;
};

export const pickLastfmImage = (images) => {
  const list = asArray(images);
  const image =
    list.find((entry) => entry.size === "extralarge") ||
    list.find((entry) => entry.size === "large") ||
    list.at(-1);
  const url = text(image?.["#text"]);
  return url && !url.includes(LASTFM_PLACEHOLDER_IMAGE_HASH) ? url : null;
};

const formatCount = (value, noun) =>
  `${new Intl.NumberFormat("en-US", {
    notation: value >= 100000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100000 ? 1 : 0,
  }).format(value)} ${noun} on Last.fm`;

const formatTrendingPopularity = (artist) => {
  const listeners = parseInt(artist?.listeners || 0, 10) || 0;
  if (listeners > 0) return formatCount(listeners, "listeners");
  const playcount = parseInt(artist?.playcount || 0, 10) || 0;
  if (playcount > 0) return formatCount(playcount, "plays");
  const rank = parseInt(artist?.["@attr"]?.rank || artist?.rank || 0, 10) || 0;
  return rank > 0 ? `Trending #${rank} on Last.fm` : "Trending on Last.fm";
};

const callLastfm = async (method, params, { health, signal } = {}) => {
  const data = await lastfmRequest(method, params, { signal }).catch(() => null);
  const ok = Boolean(data) && !data.error;
  recordHealth(health, ok);
  return ok ? data : null;
};

const callForArtist = async (method, artist, params, options) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) {
    const data = await callLastfm(method, { mbid, ...params }, options);
    if (data) return data;
  }
  const name = text(artist?.name);
  return name ? callLastfm(method, { artist: name, ...params }, options) : null;
};

const toTrack = (track) => ({
  artistName: text(track?.artist?.name || track?.artist?.["#text"]),
  artistMbid: normalizeMbid(track?.artist?.mbid),
  name: text(track?.name),
  albumName: text(track?.album?.title || track?.album?.["#text"]) || null,
});

const getArtistTags = async (artist, options = {}) => {
  const data = await callForArtist("artist.getTopTags", artist, {}, options);
  return asArray(data?.toptags?.tag)
    .map((tag) => ({ name: text(tag?.name), count: parseInt(tag?.count || 0, 10) || 1 }))
    .filter((tag) => tag.name);
};

export const lastfmSource = {
  name: "lastfm",

  async getSimilarArtists(artist, { limit = 50, health, signal } = {}) {
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

  getArtistTagLists(artists, { health } = {}) {
    return mapWithConcurrency(artists, TAG_LOOKUP_CONCURRENCY, (artist) =>
      getArtistTags(artist, { health }),
    );
  },

  async getArtistTopTracks(artist, { limit = 25 } = {}) {
    const name = text(artist?.name);
    if (!name) return [];
    const data = await callLastfm("artist.getTopTracks", { artist: name, limit });
    return asArray(data?.toptracks?.track)
      .map((track) => ({
        name: text(track?.name),
        albumName: text(track?.album?.title || track?.album?.["#text"]) || null,
        mbid: normalizeMbid(track?.mbid),
        durationMs: null,
        popularity: Number(track?.playcount || track?.listeners || 0) || 0,
      }))
      .filter((track) => track.name);
  },

  async getTagArtists(tag, { limit = 50, offset = 0 } = {}) {
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
        artists.push({ mbid: normalizeMbid(entry?.mbid), name, image: pickLastfmImage(entry?.image) });
      }
      const total = Number.parseInt(data?.topartists?.["@attr"]?.total, 10);
      exhausted = entries.length < pageSize || (Number.isFinite(total) && page * pageSize >= total);
      page += 1;
    }
    return {
      artists: artists.slice(offset, offset + limit),
      hasMore: !exhausted || artists.length > required,
    };
  },

  async getTagTracks(tag, { limit = 50 } = {}) {
    const data = await callLastfm("tag.getTopTracks", { tag, limit });
    return asArray(data?.tracks?.track).map(toTrack).filter((track) => track.artistName && track.name);
  },

  async getTrendingArtists({ limit = 100 } = {}) {
    const data = await callLastfm("chart.getTopArtists", { limit });
    if (!data) throw new Error("Last.fm trending artists are unavailable");
    return asArray(data?.artists?.artist)
      .map((artist) => {
        const name = text(artist?.name || artist?.["#text"]);
        if (!name) return null;
        return {
          id: normalizeMbid(artist?.mbid),
          name,
          image: pickLastfmImage(artist?.image),
          type: "Artist",
          popularityLabel: formatTrendingPopularity(artist),
          listeners: parseInt(artist?.listeners || 0, 10) || 0,
          playcount: parseInt(artist?.playcount || 0, 10) || 0,
          popularityRank: parseInt(artist?.["@attr"]?.rank || artist?.rank || 0, 10) || null,
        };
      })
      .filter(Boolean);
  },

  async getTrendingTracks({ limit = 50 } = {}) {
    const data = await callLastfm("chart.getTopTracks", { limit });
    return asArray(data?.tracks?.track).map(toTrack).filter((track) => track.artistName && track.name);
  },

  async getPopularTags() {
    const data = await callLastfm("chart.getTopTags", { limit: 100 });
    return asArray(data?.tags?.tag).map((tag) => text(tag?.name)).filter(Boolean);
  },
};
