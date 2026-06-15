import { lastfmRequest, getLastfmApiKey } from "./apiClients.js";
import { getDiscoveryCache } from "./discoveryService.js";
import { dbOps } from "../config/db-helpers.js";

const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LASTFM_HARVEST_CONCURRENCY = 12;
const ARTIST_TOP_TRACKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
const LIBRARY_ARTIST_KEYS_CACHE_TTL_MS = 10 * 60 * 1000;

export class WeeklyFlowPlaylistSource {
  constructor() {
    this.artistTopTagsCache = new Map();
    this.relatedArtistMatchCache = new Map();
    this.artistTopTracksCache = new Map();
    this.libraryOwnershipCache = new Map();
    this.libraryArtistKeysCache = null;
    this.libraryAlbumMbidCache = null;
  }

  _deepDiveRanges(deepDive) {
    return deepDive
      ? [
          { start: 9, end: 24 },
          { start: 0, end: 9 },
          { start: 0, end: Number.MAX_SAFE_INTEGER },
        ]
      : [
          { start: 0, end: 9 },
          { start: 0, end: Number.MAX_SAFE_INTEGER },
        ];
  }

  _harvestLimitFor(count) {
    return Math.min(72, Math.max(Number(count || 0) * 3, 16));
  }

  async _getArtistTopTrackList(artistName) {
    const name = String(artistName || "").trim();
    if (!name) return [];
    const cacheKey = this._artistKey(name);
    if (!cacheKey) return [];
    const cached = this.artistTopTracksCache.get(cacheKey);
    if (cached?.trackList && cached.expiresAt > Date.now()) {
      return cached.trackList;
    }
    if (cached?.promise) return cached.promise;
    const promise = (async () => {
      const topTracks = await lastfmRequest("artist.getTopTracks", {
        artist: name,
        limit: 25,
      });
      const trackList = topTracks?.toptracks?.track
        ? Array.isArray(topTracks.toptracks.track)
          ? topTracks.toptracks.track
          : [topTracks.toptracks.track]
        : [];
      this.artistTopTracksCache.set(cacheKey, {
        trackList,
        expiresAt: Date.now() + ARTIST_TOP_TRACKS_CACHE_TTL_MS,
      });
      return trackList;
    })();
    this.artistTopTracksCache.set(cacheKey, { promise });
    try {
      return await promise;
    } catch {
      this.artistTopTracksCache.delete(cacheKey);
      return [];
    }
  }

  async _harvestTopTracksFromArtists(artists, limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!Array.isArray(artists) || artists.length === 0 || limit <= 0) return [];
    const deepDive = options?.deepDive === true;
    const ranges = this._deepDiveRanges(deepDive);
    const excludeSet = options?.excludeArtistKeys;
    const shuffled = [...artists].sort(() => 0.5 - Math.random());
    const entries = [];
    for (const artist of shuffled) {
      const artistName = (artist?.name || artist?.artistName || "").trim();
      if (!artistName) continue;
      const artistKeys = this._artistKeysFromArtist(artist);
      if (artistKeys.some((key) => excludeSet?.has(key))) continue;
      entries.push({ artist, artistName });
    }
    const tracks = [];
    const seenArtists = new Set();
    let cursor = 0;
    const batchSize = LASTFM_HARVEST_CONCURRENCY * 2;
    while (tracks.length < limit && cursor < entries.length) {
      const batch = entries.slice(cursor, cursor + batchSize);
      cursor += batch.length;
      const batchResults = await Promise.all(
        batch.map(async ({ artist, artistName }) => {
          const artistKey = this._artistKey(artistName);
          if (!artistKey || seenArtists.has(artistKey)) return null;
          if (!deepDive && artist?.sampleTrack?.trackName) {
            return this._buildTrackEntry({
              artistName,
              trackName: artist.sampleTrack.trackName,
              albumName: artist.sampleTrack.albumName || null,
              artistMbid: artist?.id || artist?.mbid || artist?.foreignArtistId,
              reason: options?.reason,
            });
          }
          try {
            const trackList = await this._getArtistTopTrackList(artistName);
            if (!trackList.length) return null;
            const pick = this._pickTrackFromRanges(trackList, ranges);
            const trackName = pick?.name?.trim();
            if (!trackName) return null;
            return this._buildTrackEntry({
              artistName,
              trackName,
              albumName: pick?.album?.title || pick?.album?.["#text"] || null,
              artistMbid: artist?.id || artist?.mbid || artist?.foreignArtistId,
              reason: options?.reason,
            });
          } catch {
            return null;
          }
        }),
      );
      for (const trackEntry of batchResults) {
        if (!trackEntry) continue;
        const artistKey = this._trackArtistKey(trackEntry);
        if (!artistKey || seenArtists.has(artistKey)) continue;
        seenArtists.add(artistKey);
        tracks.push(trackEntry);
        if (tracks.length >= limit) break;
      }
    }
    return this._filterTracksByArtists(tracks, null, excludeSet);
  }

  _buildCounts(size, mix) {
    const weights = [
      { key: "discover", value: Number(mix?.discover ?? 0) },
      { key: "mix", value: Number(mix?.mix ?? 0) },
      { key: "trending", value: Number(mix?.trending ?? 0) },
      { key: "focus", value: Number(mix?.focus ?? 0) },
    ];
    const sum = weights.reduce(
      (acc, w) => acc + (Number.isFinite(w.value) ? w.value : 0),
      0,
    );
    if (sum <= 0 || !Number.isFinite(sum)) {
      return { discover: 0, mix: 0, trending: 0, focus: 0 };
    }
    const scaled = weights.map((w) => ({
      ...w,
      raw: (w.value / sum) * size,
    }));
    const floored = scaled.map((w) => ({
      ...w,
      count: Math.floor(w.raw),
      remainder: w.raw - Math.floor(w.raw),
    }));
    let remaining = size - floored.reduce((acc, w) => acc + w.count, 0);
    const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < ordered.length && remaining > 0; i++) {
      ordered[i].count += 1;
      remaining -= 1;
    }
    const out = {};
    for (const item of ordered) {
      out[item.key] = item.count;
    }
    return out;
  }

  _normalizeWeightMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [key, rawValue] of Object.entries(value)) {
      const name = String(key || "").trim();
      if (!name) continue;
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) continue;
      const rounded = Math.round(parsed);
      if (rounded <= 0) continue;
      out[name] = rounded;
    }
    return out;
  }

  _sumWeightMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.values(value).reduce((acc, entry) => {
      const parsed = Number(entry);
      return acc + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);
  }

  _normalizeRecipeCounts(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const parseField = (entry) => {
      const parsed = Number(entry);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(Math.round(parsed), 0);
    };
    return {
      discover: parseField(value?.discover ?? 0),
      mix: parseField(value?.mix ?? 0),
      trending: parseField(value?.trending ?? 0),
    };
  }

  _normalizeList(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }

  _normalizeFocusEntries(value) {
    if (Array.isArray(value)) {
      const seen = new Set();
      const out = [];
      for (const entry of value) {
        const text = String(entry || "").trim();
        const key = this._artistKey(text);
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
      }
      return out;
    }
    return Object.keys(this._normalizeWeightMap(value));
  }

  _normalizeFocusStrength(value) {
    const strength = String(value || "").trim().toLowerCase();
    if (strength === "light" || strength === "medium" || strength === "heavy") {
      return strength;
    }
    return null;
  }

  _getStrengthWeight(strength) {
    if (strength === "light") return 0.35;
    if (strength === "medium") return 0.65;
    if (strength === "heavy") return 1;
    return 0;
  }

  _artistKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  _artistKeysFromArtist(artist) {
    return [
      artist?.id,
      artist?.mbid,
      artist?.foreignArtistId,
      artist?.name,
      artist?.artistName,
    ]
      .map((value) => this._artistKey(value))
      .filter(Boolean);
  }

  _trackArtistKey(track) {
    const key = this._artistKey(track?.artistName);
    return key || null;
  }

  _normalizeArtistKeySet(value) {
    if (value instanceof Set) {
      return new Set(
        [...value].map((entry) => this._artistKey(entry)).filter(Boolean),
      );
    }
    if (Array.isArray(value)) {
      return new Set(
        value.map((entry) => this._artistKey(entry)).filter(Boolean),
      );
    }
    return null;
  }

  _buildArtistKeySet(artists = []) {
    const set = new Set();
    for (const artist of Array.isArray(artists) ? artists : []) {
      for (const key of this._artistKeysFromArtist(artist)) {
        set.add(key);
      }
    }
    return set;
  }

  _resolveDiscoveryCache(options = {}) {
    if (options?.discoveryCache && typeof options.discoveryCache === "object") {
      return options.discoveryCache;
    }
    return getDiscoveryCache(options?.listenHistoryProfile);
  }

  _normalizeTrackReason(value, fallback = "Flow selection") {
    const text = String(value || "").trim();
    return text || fallback;
  }

  _buildTrackEntry({
    artistName,
    trackName,
    albumName,
    artistMbid,
    albumMbid,
    trackMbid,
    releaseYear,
    durationMs,
    artistAliases,
    reason,
  }) {
    const safeArtist = String(artistName || "").trim();
    const safeTrack = String(trackName || "").trim();
    if (!safeArtist || !safeTrack) return null;
    const safeAlbum = String(albumName || "").trim();
    const safeMbid = String(artistMbid || "").trim();
    const safeAlbumMbid = String(albumMbid || "").trim();
    const safeTrackMbid = String(trackMbid || "").trim();
    const safeReleaseYear = String(releaseYear || "").trim();
    const safeDuration =
      durationMs != null && Number.isFinite(Number(durationMs))
        ? Math.max(0, Math.round(Number(durationMs)))
        : null;
    const normalizedAliases = Array.isArray(artistAliases)
      ? artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    return {
      artistName: safeArtist,
      trackName: safeTrack,
      albumName: safeAlbum || null,
      artistMbid: safeMbid || null,
      albumMbid: safeAlbumMbid || null,
      trackMbid: safeTrackMbid || null,
      releaseYear: safeReleaseYear || null,
      durationMs: safeDuration,
      artistAliases: normalizedAliases,
      reason: this._normalizeTrackReason(reason),
    };
  }

  _getRecommendedArtists(listenHistoryProfile = null) {
    const discoveryCache = getDiscoveryCache(listenHistoryProfile);
    return Array.isArray(discoveryCache.recommendations)
      ? discoveryCache.recommendations
      : [];
  }

  _getRecommendedArtistSet(listenHistoryProfile = null) {
    const set = new Set();
    for (const artist of this._getRecommendedArtists(listenHistoryProfile)) {
      if (artist?.id) {
        set.add(this._artistKey(artist.id));
      }
      if (artist?.name) {
        set.add(this._artistKey(artist.name));
      }
      if (artist?.artistName) {
        set.add(this._artistKey(artist.artistName));
      }
    }
    return set;
  }

  _getRecommendedArtistMap(listenHistoryProfile = null) {
    const map = new Map();
    for (const artist of this._getRecommendedArtists(listenHistoryProfile)) {
      if (!artist) continue;
      const keys = this._artistKeysFromArtist(artist);
      for (const key of keys) {
        if (!map.has(key)) {
          map.set(key, artist);
        }
      }
    }
    return map;
  }

  _getRecommendedArtistsByTags(tags, match, listenHistoryProfile = null) {
    const wanted = tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
    if (wanted.length === 0) return [];
    const requiredAll = match === "all";
    return this._getRecommendedArtists(listenHistoryProfile).filter((artist) => {
      const artistTags = Array.isArray(artist.tags)
        ? artist.tags.map((t) => String(t).toLowerCase())
        : [];
      if (requiredAll) {
        return wanted.every((tag) => artistTags.includes(tag));
      }
      return wanted.some((tag) => artistTags.includes(tag));
    });
  }

  _filterTracksByArtists(tracks, includeSet, excludeSet) {
    return (tracks || []).filter((track) => {
      const artistKey = this._trackArtistKey(track);
      if (!artistKey) return false;
      if (excludeSet?.has(artistKey)) return false;
      if (includeSet && includeSet.size > 0 && !includeSet.has(artistKey))
        return false;
      return true;
    });
  }

  _filterArtistsByKeySet(artists, excludeSet) {
    if (!Array.isArray(artists) || artists.length === 0 || !excludeSet?.size) {
      return Array.isArray(artists) ? artists : [];
    }
    return artists.filter((artist) => {
      const keys = this._artistKeysFromArtist(artist);
      return !keys.some((key) => excludeSet.has(key));
    });
  }

  async _getLibraryArtistKeySet(options = {}) {
    const providedSet = this._normalizeArtistKeySet(options?.libraryArtistKeys);
    if (providedSet) return providedSet;
    if (Array.isArray(options?.libraryArtists)) {
      return this._buildArtistKeySet(options.libraryArtists);
    }

    const now = Date.now();
    if (
      this.libraryArtistKeysCache?.set &&
      this.libraryArtistKeysCache.expiresAt > now
    ) {
      return this.libraryArtistKeysCache.set;
    }
    if (this.libraryArtistKeysCache?.promise) {
      return this.libraryArtistKeysCache.promise;
    }

    const promise = (async () => {
      const { libraryManager } = await import("./libraryManager.js");
      const artists = await libraryManager.getAllArtists();
      return this._buildArtistKeySet(artists);
    })();
    this.libraryArtistKeysCache = { promise };
    try {
      const set = await promise;
      this.libraryArtistKeysCache = {
        set,
        expiresAt: Date.now() + LIBRARY_ARTIST_KEYS_CACHE_TTL_MS,
      };
      return set;
    } catch (error) {
      this.libraryArtistKeysCache = null;
      throw error;
    }
  }

  async _getTopTrackForArtist(artistName, options = {}) {
    const name = String(artistName || "").trim();
    if (!name) return null;
    const ranges = this._deepDiveRanges(options?.deepDive === true);
    const trackList = await this._getArtistTopTrackList(name);
    if (!trackList.length) return null;
    const pick = this._pickTrackFromRanges(trackList, ranges);
    const trackName = pick?.name?.trim();
    if (!trackName) return null;
    return this._buildTrackEntry({
      artistName: name,
      trackName,
      albumName: pick?.album?.title || pick?.album?.["#text"] || null,
      reason: options?.reason || "Flow selection",
    });
  }

  async _getTracksForArtists(artistNames, limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!Array.isArray(artistNames) || artistNames.length === 0) return [];
    return this._harvestTopTracksFromArtists(
      artistNames.map((name) => ({ name: String(name || "").trim() })),
      limit,
      options,
    );
  }

  async _getTracksForRankedArtists(artists, limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!Array.isArray(artists) || artists.length === 0 || limit <= 0) return [];
    const tracks = [];
    const seen = new Set();
    let cursor = 0;
    const batchSize = LASTFM_HARVEST_CONCURRENCY * 2;
    while (tracks.length < limit && cursor < artists.length) {
      const batch = [];
      while (batch.length < batchSize && cursor < artists.length) {
        const entry = artists[cursor];
        cursor += 1;
        const artistName =
          typeof entry === "string"
            ? String(entry).trim()
            : String(entry?.name || entry?.artistName || "").trim();
        if (!artistName) continue;
        const key = this._artistKey(artistName);
        if (!key || seen.has(key)) continue;
        if (options?.excludeArtistKeys?.has(key)) continue;
        batch.push({ artistName, key, entry });
      }
      if (batch.length === 0) continue;
      const results = await Promise.all(
        batch.map(({ artistName }) =>
          this._getTopTrackForArtist(artistName, options).catch(() => null),
        ),
      );
      for (let index = 0; index < results.length; index += 1) {
        if (tracks.length >= limit) break;
        const track = results[index];
        const key = batch[index]?.key;
        if (!track || !key || seen.has(key)) continue;
        seen.add(key);
        tracks.push(track);
      }
    }
    return this._filterTracksByArtists(
      tracks,
      null,
      options?.excludeArtistKeys,
    );
  }

  async _getTagArtists(tag, limit) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!tag || limit <= 0) return [];
    const data = await lastfmRequest("tag.getTopArtists", {
      tag,
      limit,
    });
    if (!data?.topartists?.artist) return [];
    const artists = Array.isArray(data.topartists.artist)
      ? data.topartists.artist
      : [data.topartists.artist];
    return artists
      .map((artist) => String(artist?.name || "").trim())
      .filter(Boolean);
  }

  async _getSimilarArtists(artistKey, limit = 25) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!artistKey || limit <= 0) return [];
    const params = this._isMbid(artistKey)
      ? { mbid: artistKey, limit }
      : { artist: artistKey, limit };
    const similar = await lastfmRequest("artist.getSimilar", params);
    return similar?.similarartists?.artist
      ? Array.isArray(similar.similarartists.artist)
        ? similar.similarartists.artist
        : [similar.similarartists.artist]
      : [];
  }

  _buildRankedArtistPool(groups) {
    const scoreMap = new Map();
    for (const group of Array.isArray(groups) ? groups : []) {
      const seenInGroup = new Set();
      for (const artist of Array.isArray(group?.artists) ? group.artists : []) {
        const artistName =
          typeof artist === "string"
            ? String(artist).trim()
            : String(artist?.name || artist?.artistName || "").trim();
        const key = this._artistKey(artistName);
        if (!key || seenInGroup.has(key)) continue;
        seenInGroup.add(key);
        const current = scoreMap.get(key) || {
          name: artistName,
          score: 0,
          rankSum: 0,
        };
        current.score += 1;
        current.rankSum += seenInGroup.size;
        if (!current.name) current.name = artistName;
        scoreMap.set(key, current);
      }
    }
    return [...scoreMap.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
        return a.name.localeCompare(b.name);
      });
  }

  async _getTieredGroupTracks(groups, limit, options = {}) {
    if (!Array.isArray(groups) || groups.length === 0 || limit <= 0) return [];
    const rankedArtists = this._buildRankedArtistPool(groups);
    if (rankedArtists.length === 0) return [];
    const maxScore = rankedArtists.reduce(
      (highest, entry) => Math.max(highest, Number(entry?.score || 0)),
      0,
    );
    if (maxScore <= 0) return [];
    const picked = [];
    const used = new Set();
    for (let score = maxScore; score >= 1 && picked.length < limit; score -= 1) {
      const tierArtists = rankedArtists
        .filter((entry) => Number(entry?.score || 0) === score)
        .map((entry) => entry.name)
        .filter(Boolean);
      if (tierArtists.length === 0) continue;
      const remaining = limit - picked.length;
      const tierTracks = await this._getTracksForRankedArtists(
        tierArtists,
        remaining,
        options,
      ).catch(() => []);
      for (const track of tierTracks) {
        if (picked.length >= limit) break;
        const key = this._trackArtistKey(track);
        if (!key || used.has(key)) continue;
        used.add(key);
        picked.push(track);
      }
    }
    return picked;
  }

  async getTagGroupTracks(tagsMap, limit, options = {}) {
    const tags = Object.keys(this._normalizeWeightMap(tagsMap));
    if (tags.length === 0 || limit <= 0) return [];
    if (tags.length === 1) {
      return this.getTagTracks(tags[0], limit, options);
    }
    const requestedArtists = Math.max(limit * 6, 100);
    const groups = await Promise.all(
      tags.map(async (tag) => ({
        tag,
        artists: await this._getTagArtists(tag, requestedArtists).catch(() => []),
      })),
    );
    return this._getTieredGroupTracks(
      groups,
      limit,
      {
        deepDive: options?.deepDive === true,
        reason: options?.reason || `From genres: ${tags.join(", ")}`,
        excludeArtistKeys: options?.excludeArtistKeys,
      },
    ).catch(() => []);
  }

  async getRelatedArtistGroupTracks(relatedArtistsMap, limit, options = {}) {
    const artists = Object.keys(this._normalizeWeightMap(relatedArtistsMap));
    if (artists.length === 0 || limit <= 0) return [];
    if (artists.length === 1) {
      return this.getRelatedArtistTracks(artists[0], limit, options);
    }
    const groups = await Promise.all(
      artists.map(async (artist) => ({
        artist,
        artists: await this._getSimilarArtists(artist, 75).catch(() => []),
      })),
    );
    return this._getTieredGroupTracks(
      groups,
      limit,
      {
        deepDive: options?.deepDive === true,
        reason: options?.reason || `Similar to ${artists.join(", ")}`,
        excludeArtistKeys: options?.excludeArtistKeys,
      },
    ).catch(() => []);
  }

  _buildWeightedSourceCounts(total, sources) {
    const items = sources.filter(
      (source) => Number.isFinite(source.weight) && source.weight > 0,
    );
    if (total <= 0 || items.length === 0) return [];
    const sum = items.reduce((acc, item) => acc + item.weight, 0);
    if (!Number.isFinite(sum) || sum <= 0) return [];
    const scaled = items.map((item) => ({
      ...item,
      raw: (item.weight / sum) * total,
    }));
    const floored = scaled.map((item) => ({
      ...item,
      count: Math.floor(item.raw),
      remainder: item.raw - Math.floor(item.raw),
    }));
    let remaining = total - floored.reduce((acc, item) => acc + item.count, 0);
    const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < ordered.length && remaining > 0; i++) {
      ordered[i].count += 1;
      remaining -= 1;
    }
    return ordered;
  }

  _isMbid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  _sliceRange(trackList, start, end) {
    if (!Array.isArray(trackList) || trackList.length === 0) return [];
    if (start >= trackList.length) return [];
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(trackList.length - 1, end);
    if (safeEnd < safeStart) return [];
    return trackList.slice(safeStart, safeEnd + 1);
  }

  _pickRandomTrack(trackList) {
    if (!Array.isArray(trackList) || trackList.length === 0) return null;
    return trackList
      .filter((track) => String(track?.name || "").trim().length > 0)
      .sort((left, right) => {
        const leftAlbum = String(
          left?.album?.title || left?.album?.["#text"] || "",
        ).trim();
        const rightAlbum = String(
          right?.album?.title || right?.album?.["#text"] || "",
        ).trim();
        if (Boolean(rightAlbum) !== Boolean(leftAlbum)) {
          return Number(Boolean(rightAlbum)) - Number(Boolean(leftAlbum));
        }
        const leftPlaycount = Number(left?.playcount || left?.listeners || 0);
        const rightPlaycount = Number(right?.playcount || right?.listeners || 0);
        if (rightPlaycount !== leftPlaycount) {
          return rightPlaycount - leftPlaycount;
        }
        return String(left?.name || "").localeCompare(String(right?.name || ""));
      })[0] || null;
  }

  _pickTrackFromRanges(trackList, ranges) {
    for (const range of ranges) {
      const candidates = this._sliceRange(
        trackList,
        range.start,
        range.end,
      ).filter((track) => String(track?.name || "").trim().length > 0);
      const pick = this._pickRandomTrack(candidates);
      if (pick) return pick;
    }
    return null;
  }

  _pickTrackFromRangesWithOwned(trackList, ownedTitles, ranges) {
    for (const range of ranges) {
      const candidates = this._sliceRange(
        trackList,
        range.start,
        range.end,
      ).filter((track) => {
        const name = String(track?.name || "")
          .trim()
          .toLowerCase();
        return name && !ownedTitles.has(name);
      });
      const pick = this._pickRandomTrack(candidates);
      if (pick) return pick;
    }
    return null;
  }

  _pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
    trackList,
    ownedTitles,
    ownedAlbums,
    ranges,
  ) {
    for (const range of ranges) {
      const candidates = this._sliceRange(
        trackList,
        range.start,
        range.end,
      ).filter((track) => {
        const name = String(track?.name || "")
          .trim()
          .toLowerCase();
        return name && !ownedTitles.has(name);
      });
      const shuffled = [...candidates].sort(() => 0.5 - Math.random());
      for (const candidate of shuffled) {
        const albumTitle = String(
          candidate?.album?.title || candidate?.album?.["#text"] || "",
        )
          .trim()
          .toLowerCase();
        if (!albumTitle) continue;
        if (!ownedAlbums.has(albumTitle)) {
          return {
            pick: candidate,
            albumName:
              String(
                candidate?.album?.title || candidate?.album?.["#text"] || "",
              ).trim() || null,
          };
        }
      }
    }
    return null;
  }

  async _pickTrackFromRangesWithOwnedAlbumsViaInfo(
    trackList,
    ownedTitles,
    ownedAlbums,
    artistName,
    ranges,
  ) {
    let checked = 0;
    const maxChecks = 12;
    for (const range of ranges) {
      const candidates = this._sliceRange(
        trackList,
        range.start,
        range.end,
      ).filter((track) => {
        const name = String(track?.name || "")
          .trim()
          .toLowerCase();
        return name && !ownedTitles.has(name);
      });
      const shuffled = [...candidates].sort(() => 0.5 - Math.random());
      for (const candidate of shuffled) {
        if (checked >= maxChecks) return null;
        checked += 1;
        const trackName = String(candidate?.name || "").trim();
        if (!trackName) continue;
        try {
          const info = await lastfmRequest("track.getInfo", {
            artist: artistName,
            track: trackName,
            autocorrect: 1,
          });
          const albumTitle = String(info?.track?.album?.title || "")
            .trim()
            .toLowerCase();
          if (!albumTitle) continue;
          if (!ownedAlbums.has(albumTitle)) {
            return {
              pick: candidate,
              albumName:
                String(info?.track?.album?.title || "").trim() || null,
            };
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  async _pickTrackFromRangesWithOwnedAlbums(
    trackList,
    ownedTitles,
    ownedAlbums,
    artistName,
    ranges,
  ) {
    const fromList = this._pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
      trackList,
      ownedTitles,
      ownedAlbums,
      ranges,
    );
    if (fromList) return fromList;
    return this._pickTrackFromRangesWithOwnedAlbumsViaInfo(
      trackList,
      ownedTitles,
      ownedAlbums,
      artistName,
      ranges,
    );
  }

  _dedupeAndFill(size, sources, counts) {
    const seen = new Set();
    const picked = [];
    const indices = {
      discover: 0,
      mix: 0,
      trending: 0,
    };

    const takeFrom = (type, count) => {
      const list = sources[type] || [];
      let added = 0;
      while (indices[type] < list.length && added < count) {
        const track = list[indices[type]];
        indices[type] += 1;
        const key = this._trackArtistKey(track);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        picked.push(track);
        added += 1;
      }
    };

    takeFrom("discover", counts.discover || 0);
    takeFrom("mix", counts.mix || 0);
    takeFrom("trending", counts.trending || 0);

    const order = ["discover", "mix", "trending"];
    let looped = false;
    while (picked.length < size) {
      let progress = false;
      for (const type of order) {
        const list = sources[type] || [];
        while (indices[type] < list.length) {
          const track = list[indices[type]];
          indices[type] += 1;
          const key = this._trackArtistKey(track);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          picked.push(track);
          progress = true;
          break;
        }
        if (picked.length >= size) break;
      }
      if (!progress) {
        if (looped) break;
        looped = true;
      } else {
        looped = false;
      }
    }

    return picked.slice(0, size);
  }

  _dedupeAndFillSources(size, sources) {
    const seen = new Set();
    const picked = [];
    const indices = new Map();
    for (const source of sources) {
      indices.set(source.key, 0);
    }

    const takeFrom = (source) => {
      const list = source.tracks || [];
      let added = 0;
      let index = indices.get(source.key) || 0;
      while (index < list.length && added < source.count) {
        const track = list[index];
        index += 1;
        const key = this._trackArtistKey(track);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        picked.push(track);
        added += 1;
      }
      indices.set(source.key, index);
    };

    for (const source of sources) {
      takeFrom(source);
    }

    let looped = false;
    while (picked.length < size) {
      let progress = false;
      for (const source of sources) {
        const list = source.tracks || [];
        let index = indices.get(source.key) || 0;
        while (index < list.length) {
          const track = list[index];
          index += 1;
          const key = this._trackArtistKey(track);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          picked.push(track);
          progress = true;
          break;
        }
        indices.set(source.key, index);
        if (picked.length >= size) break;
      }
      if (!progress) {
        if (looped) break;
        looped = true;
      } else {
        looped = false;
      }
    }

    return picked.slice(0, size);
  }

  async getCuratedDiscoverTracks(limit, options = {}) {
    const tags = options?.tags || {};
    const relatedArtists = options?.relatedArtists || {};
    const deepDive = options?.deepDive === true;
    const sources = [];

    for (const [tag, weight] of Object.entries(tags)) {
      sources.push({ type: "tag", key: tag, weight: Number(weight) });
    }
    for (const [artist, weight] of Object.entries(relatedArtists)) {
      sources.push({ type: "related", key: artist, weight: Number(weight) });
    }

    if (sources.length === 0) {
      return await this.getDiscoverTracks(limit, {
        ...options,
        deepDive,
      });
    }

    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key required for curated discovery");
    }

    const counts = this._buildWeightedSourceCounts(limit, sources);
    const curated = [];
    for (const source of counts) {
      if (!source.count) continue;
      try {
        if (source.type === "tag") {
          const tracks = await this.getTagTracks(source.key, source.count, {
            reason: `From genre: ${source.key}`,
          });
          curated.push(...tracks);
        } else {
          const tracks = await this.getRelatedArtistTracks(
            source.key,
            source.count,
            {
              deepDive,
              reason: `Similar to ${source.key}`,
            },
          );
          curated.push(...tracks);
        }
      } catch {
        continue;
      }
    }

    if (curated.length >= limit) {
      return curated.slice(0, limit);
    }

    const fallback = await this.getDiscoverTracks(limit - curated.length, {
      ...options,
      deepDive,
    }).catch(() => []);
    return [...curated, ...fallback];
  }

  async _getArtistTopTags(artistName, artistMbid = null) {
    const name = String(artistName || "").trim();
    const mbid = String(artistMbid || "").trim();
    const cacheKey = mbid || this._artistKey(name);
    if (!cacheKey) return [];
    if (this.artistTopTagsCache.has(cacheKey)) {
      return this.artistTopTagsCache.get(cacheKey);
    }
    const promise = (async () => {
      if (!getLastfmApiKey()) return [];
      const params = mbid ? { mbid, limit: 12 } : { artist: name, limit: 12 };
      try {
        const data = await lastfmRequest("artist.getTopTags", params);
        const list = data?.toptags?.tag
          ? Array.isArray(data.toptags.tag)
            ? data.toptags.tag
            : [data.toptags.tag]
          : [];
        const seen = new Set();
        const tags = [];
        for (const entry of list) {
          const tag = String(entry?.name || "").trim();
          const key = this._artistKey(tag);
          if (!tag || !key || seen.has(key)) continue;
          seen.add(key);
          tags.push(tag);
          if (tags.length >= 12) break;
        }
        return tags;
      } catch {
        return [];
      }
    })();
    this.artistTopTagsCache.set(cacheKey, promise);
    const tags = await promise;
    this.artistTopTagsCache.set(cacheKey, tags);
    return tags;
  }

  async _buildRelatedArtistMatchMap(seedArtists) {
    const normalizedSeeds = this._normalizeFocusEntries(seedArtists);
    const cacheKey = normalizedSeeds.map((entry) => this._artistKey(entry)).join("\u0001");
    if (!cacheKey) return new Map();
    if (this.relatedArtistMatchCache.has(cacheKey)) {
      return this.relatedArtistMatchCache.get(cacheKey);
    }
    const promise = (async () => {
      const matchMap = new Map();
      for (const seed of normalizedSeeds) {
        const seedKey = this._artistKey(seed);
        if (seedKey) {
          matchMap.set(seedKey, {
            count: normalizedSeeds.length,
            seeds: new Set([seedKey]),
          });
        }
        const similarArtists = await this._getSimilarArtists(seed, 75).catch(() => []);
        for (const artist of similarArtists) {
          const artistName = String(artist?.name || artist?.artistName || "").trim();
          const key = this._artistKey(artistName);
          if (!key) continue;
          const current = matchMap.get(key) || {
            count: 0,
            seeds: new Set(),
          };
          current.seeds.add(seedKey);
          current.count = Math.max(current.count, current.seeds.size);
          matchMap.set(key, current);
        }
      }
      return matchMap;
    })();
    this.relatedArtistMatchCache.set(cacheKey, promise);
    const resolved = await promise;
    this.relatedArtistMatchCache.set(cacheKey, resolved);
    return resolved;
  }

  _buildBaseCandidate(track, source, sourceRank = 0, extra = {}) {
    const artistKey = this._trackArtistKey(track);
    const trackKey = `${artistKey || ""}::${String(track?.trackName || "")
      .trim()
      .toLowerCase()}`;
    const metadataConfidence =
      (track?.albumName ? 0.45 : 0) +
      (track?.releaseYear ? 0.2 : 0) +
      (track?.durationMs ? 0.25 : 0) +
      (track?.trackMbid ? 0.1 : 0);
    const sourceBaseScore = Math.max(0, 200 - sourceRank);
    const downloadabilityHint =
      metadataConfidence * 10 + (track?.artistMbid ? 4 : 0) + (track?.trackMbid ? 4 : 0);
    return {
      ...track,
      source,
      sourceRank,
      trackKey,
      artistTags: Array.isArray(extra.artistTags) ? extra.artistTags : [],
      tagCoverage: Number(extra.tagCoverage || 0),
      tagCoverageRatio: Number(extra.tagCoverageRatio || 0),
      relatedCoverage: Number(extra.relatedCoverage || 0),
      relatedCoverageRatio: Number(extra.relatedCoverageRatio || 0),
      focusTier: extra.focusTier || "none",
      focusPriority: Number(extra.focusPriority || 0),
      metadataConfidence,
      downloadabilityHint,
      finalScore:
        Number(extra.finalScore) ||
        sourceBaseScore + metadataConfidence * 25 + downloadabilityHint,
    };
  }

  _getFocusTierDetails(tagCoverage, totalTags, relatedCoverage, totalRelated) {
    const safeTagCoverage = Number(tagCoverage || 0);
    const safeRelatedCoverage = Number(relatedCoverage || 0);
    const hasTags = totalTags > 0;
    const hasRelated = totalRelated > 0;
    if (!hasTags && !hasRelated) {
      return {
        focusTier: "none",
        focusPriority: 0,
        tagCoverageRatio: 0,
        relatedCoverageRatio: 0,
      };
    }
    const tagCoverageRatio = hasTags
      ? Math.min(1, safeTagCoverage / totalTags)
      : 0;
    const relatedCoverageRatio = hasRelated
      ? Math.min(1, safeRelatedCoverage / totalRelated)
      : 0;

    if (hasTags && hasRelated) {
      if (safeRelatedCoverage >= totalRelated && safeTagCoverage >= totalTags) {
        return {
          focusTier: "both_all",
          focusPriority: 8,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeRelatedCoverage >= totalRelated && safeTagCoverage > 0) {
        return {
          focusTier: "both_partial",
          focusPriority: 7,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeRelatedCoverage > 0 && safeTagCoverage >= totalTags) {
        return {
          focusTier: "both_partial",
          focusPriority: 6,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeRelatedCoverage > 0 && safeTagCoverage > 0) {
        return {
          focusTier: "both_partial",
          focusPriority: 5,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeRelatedCoverage >= totalRelated) {
        return {
          focusTier: "related_all_only",
          focusPriority: 4,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeRelatedCoverage > 0) {
        return {
          focusTier: "related_partial_only",
          focusPriority: 3,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeTagCoverage >= totalTags) {
        return {
          focusTier: "tag_all_only",
          focusPriority: 2,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      if (safeTagCoverage > 0) {
        return {
          focusTier: "tag_partial_only",
          focusPriority: 1,
          tagCoverageRatio,
          relatedCoverageRatio,
        };
      }
      return {
        focusTier: "none",
        focusPriority: 0,
        tagCoverageRatio,
        relatedCoverageRatio,
      };
    }

    if (hasRelated) {
      return {
        focusTier:
          safeRelatedCoverage >= totalRelated
            ? "related_all_only"
            : safeRelatedCoverage > 0
              ? "related_partial_only"
              : "none",
        focusPriority:
          safeRelatedCoverage >= totalRelated ? 4 : safeRelatedCoverage > 0 ? 3 : 0,
        tagCoverageRatio,
        relatedCoverageRatio,
      };
    }

    return {
      focusTier:
        safeTagCoverage >= totalTags
          ? "tag_all_only"
          : safeTagCoverage > 0
            ? "tag_partial_only"
            : "none",
      focusPriority:
        safeTagCoverage >= totalTags ? 2 : safeTagCoverage > 0 ? 1 : 0,
      tagCoverageRatio,
      relatedCoverageRatio,
    };
  }

  async _buildFocusArtistPool(tags, relatedArtists, limit, options = {}) {
    const normalizedTags = this._normalizeFocusEntries(tags);
    const normalizedRelated = this._normalizeFocusEntries(relatedArtists);
    const totalTags = normalizedTags.length;
    const totalRelated = normalizedRelated.length;
    if (limit <= 0 || (totalTags === 0 && totalRelated === 0)) {
      return [];
    }

    const excludeArtistKeys = options?.excludeArtistKeys || new Set();
    const requestedArtists = Math.min(150, Math.max(limit * 6, 60));
    const candidateMap = new Map();
    const ensureEntry = (artistName, mbid = null) => {
      const name = String(artistName || "").trim();
      const key = this._artistKey(name);
      if (!name || !key || excludeArtistKeys.has(key)) return null;
      let entry = candidateMap.get(key);
      if (!entry) {
        entry = {
          key,
          name,
          artistMbid: String(mbid || "").trim() || null,
          tagMatches: new Set(),
          relatedSeeds: new Set(),
          tagRankSum: 0,
          relatedRankSum: 0,
          popularityHint: 0,
        };
        candidateMap.set(key, entry);
      } else if (!entry.artistMbid && mbid) {
        entry.artistMbid = String(mbid || "").trim() || null;
      }
      return entry;
    };

    const [tagGroups, relatedGroups] = await Promise.all([
      Promise.all(
        normalizedTags.map(async (tag) => ({
          tag,
          artists: await this._getTagArtists(tag, requestedArtists).catch(() => []),
        })),
      ),
      Promise.all(
        normalizedRelated.map(async (seed) => ({
          seed,
          artists: await this._getSimilarArtists(seed, requestedArtists).catch(() => []),
        })),
      ),
    ]);

    for (const group of tagGroups) {
      const tagKey = this._artistKey(group.tag);
      for (let index = 0; index < group.artists.length; index += 1) {
        const entry = ensureEntry(group.artists[index], null);
        if (!entry) continue;
        entry.tagMatches.add(tagKey);
        entry.tagRankSum += index + 1;
      }
    }

    for (const group of relatedGroups) {
      const seedKey = this._artistKey(group.seed);
      for (let index = 0; index < group.artists.length; index += 1) {
        const artist = group.artists[index];
        const artistName = String(artist?.name || artist?.artistName || "").trim();
        const entry = ensureEntry(
          artistName,
          artist?.mbid || artist?.id || artist?.foreignArtistId || null,
        );
        if (!entry) continue;
        entry.relatedSeeds.add(seedKey);
        entry.relatedRankSum += index + 1;
        entry.popularityHint = Math.max(
          entry.popularityHint,
          Math.log10(1 + Math.max(0, Number(artist?.listeners || 0))) +
            Math.max(0, Number(artist?.match || 0)),
        );
      }
    }

    const preliminary = [...candidateMap.values()]
      .sort((left, right) => {
        const leftSignal = left.tagMatches.size + left.relatedSeeds.size;
        const rightSignal = right.tagMatches.size + right.relatedSeeds.size;
        if (rightSignal !== leftSignal) return rightSignal - leftSignal;
        if (right.relatedSeeds.size !== left.relatedSeeds.size) {
          return right.relatedSeeds.size - left.relatedSeeds.size;
        }
        if (right.tagMatches.size !== left.tagMatches.size) {
          return right.tagMatches.size - left.tagMatches.size;
        }
        if (left.relatedRankSum !== right.relatedRankSum) {
          return left.relatedRankSum - right.relatedRankSum;
        }
        if (left.tagRankSum !== right.tagRankSum) {
          return left.tagRankSum - right.tagRankSum;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, Math.max(limit * 2, 60));

    const normalizedTagSet = new Set(normalizedTags.map((entry) => this._artistKey(entry)));
    const enriched = await Promise.all(
      preliminary.map(async (artist, index) => {
        const topTags = await this._getArtistTopTags(artist.name, artist.artistMbid);
        const tagMatches = new Set(artist.tagMatches);
        for (const tag of topTags) {
          const tagKey = this._artistKey(tag);
          if (normalizedTagSet.has(tagKey)) {
            tagMatches.add(tagKey);
          }
        }
        const focusDetails = this._getFocusTierDetails(
          tagMatches.size,
          totalTags,
          artist.relatedSeeds.size,
          totalRelated,
        );
        return {
          ...artist,
          sourceRank: index,
          artistTags: topTags,
          tagCoverage: tagMatches.size,
          relatedCoverage: artist.relatedSeeds.size,
          ...focusDetails,
        };
      }),
    );

    return enriched
      .filter((artist) => Number(artist.focusPriority || 0) > 0)
      .sort((left, right) => {
        if (right.focusPriority !== left.focusPriority) {
          return right.focusPriority - left.focusPriority;
        }
        if (right.tagCoverage !== left.tagCoverage) {
          return right.tagCoverage - left.tagCoverage;
        }
        if (right.relatedCoverage !== left.relatedCoverage) {
          return right.relatedCoverage - left.relatedCoverage;
        }
        if (right.popularityHint !== left.popularityHint) {
          return right.popularityHint - left.popularityHint;
        }
        if (left.relatedRankSum !== right.relatedRankSum) {
          return left.relatedRankSum - right.relatedRankSum;
        }
        if (left.tagRankSum !== right.tagRankSum) {
          return left.tagRankSum - right.tagRankSum;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, Math.max(limit, 1));
  }

  async _getFocusCandidates(limit, options = {}) {
    const tags = this._normalizeFocusEntries(options?.tags);
    const relatedArtists = this._normalizeFocusEntries(options?.relatedArtists);
    if (limit <= 0 || (tags.length === 0 && relatedArtists.length === 0)) {
      return [];
    }
    const focusArtistPool = await this._buildFocusArtistPool(
      tags,
      relatedArtists,
      Math.min(150, Math.max(limit * 4, 48)),
      options,
    );
    if (focusArtistPool.length === 0) return [];
    const tracks = await this._getTracksForRankedArtists(focusArtistPool, limit, {
      deepDive: options?.deepDive === true,
      reason: "From focus filters",
      excludeArtistKeys: options?.excludeArtistKeys,
    }).catch(() => []);
    const focusArtistMap = new Map(
      focusArtistPool.map((artist) => [this._artistKey(artist.name), artist]),
    );
    return tracks
      .map((track, index) => {
        const artist = focusArtistMap.get(this._trackArtistKey(track));
        if (!artist) return null;
        return this._buildBaseCandidate(track, "focus", index, {
          artistTags: artist.artistTags,
          tagCoverage: artist.tagCoverage,
          tagCoverageRatio: artist.tagCoverageRatio,
          relatedCoverage: artist.relatedCoverage,
          relatedCoverageRatio: artist.relatedCoverageRatio,
          focusTier: artist.focusTier,
          focusPriority: artist.focusPriority,
          finalScore:
            artist.focusPriority * 1000 +
            artist.tagCoverageRatio * 120 +
            artist.relatedCoverageRatio * 140 +
            (artist.popularityHint || 0),
        });
      })
      .filter((candidate) => {
        if (!candidate) return false;
        if (!(options?.excludeTrackKeys instanceof Set)) return true;
        return !options.excludeTrackKeys.has(candidate.trackKey);
      })
      .sort((left, right) => {
        if (right.focusPriority !== left.focusPriority) {
          return right.focusPriority - left.focusPriority;
        }
        if (right.finalScore !== left.finalScore) {
          return right.finalScore - left.finalScore;
        }
        return left.sourceRank - right.sourceRank;
      });
  }

  _sortSourceCandidates(candidates) {
    return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
      if (right.finalScore !== left.finalScore) {
        return right.finalScore - left.finalScore;
      }
      return left.sourceRank - right.sourceRank;
    });
  }

  _selectFromCandidates(candidates, count, usedArtistKeys) {
    const picked = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (picked.length >= count) break;
      const artistKey = this._trackArtistKey(candidate);
      if (!artistKey || usedArtistKeys.has(artistKey)) continue;
      usedArtistKeys.add(artistKey);
      picked.push(candidate);
    }
    return picked;
  }

  _buildSourceTargets(size, mix) {
    return this._buildCounts(size, mix);
  }

  async _harvestFlowSources(flow, harvestTargets, options = {}) {
    const tags = this._normalizeFocusEntries(flow?.tags);
    const relatedArtists = this._normalizeFocusEntries(flow?.relatedArtists);
    const excludeArtistKeys = new Set(
      Array.isArray(options?.excludeArtistKeys)
        ? options.excludeArtistKeys
        : options?.excludeArtistKeys || [],
    );
    const excludeTrackKeys = new Set(
      Array.isArray(options?.excludeTrackKeys)
        ? options.excludeTrackKeys
        : options?.excludeTrackKeys || [],
    );
    const libraryArtistKeys = await this._getLibraryArtistKeySet(options).catch(
      () => new Set(),
    );
    const nonLibraryExcludeArtistKeys = new Set(excludeArtistKeys);
    for (const entry of libraryArtistKeys) {
      nonLibraryExcludeArtistKeys.add(entry);
    }
    const listenHistoryProfile = options?.listenHistoryProfile || null;
    const [discoverTracks, mixTracks, trendingTracks, focusCandidates] = await Promise.all([
      harvestTargets.discover > 0
        ? this.getDiscoverTracks(this._harvestLimitFor(harvestTargets.discover), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From discovery recommendations",
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
            listenHistoryProfile,
          }).catch(() => [])
        : [],
      harvestTargets.mix > 0
        ? this.getMixTracks(this._harvestLimitFor(harvestTargets.mix), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From your library mix",
          }).catch(() => [])
        : [],
      harvestTargets.trending > 0
        ? this.getTrendingTracks(this._harvestLimitFor(harvestTargets.trending), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From trending artists",
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
            listenHistoryProfile,
          }).catch(() => [])
        : [],
      harvestTargets.focus > 0
        ? this._getFocusCandidates(this._harvestLimitFor(harvestTargets.focus), {
            tags,
            relatedArtists,
            deepDive: flow?.deepDive === true,
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
            excludeTrackKeys,
          }).catch(() => [])
        : [],
    ]);
    return {
      candidateMap: {
        discover: this._sortSourceCandidates(
          discoverTracks
            .map((track, index) => this._buildBaseCandidate(track, "discover", index))
            .filter((candidate) => {
              const artistKey = this._trackArtistKey(candidate);
              return (
                artistKey &&
                !nonLibraryExcludeArtistKeys.has(artistKey) &&
                !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        mix: this._sortSourceCandidates(
          mixTracks
            .map((track, index) => this._buildBaseCandidate(track, "mix", index))
            .filter((candidate) => {
              const artistKey = this._trackArtistKey(candidate);
              return (
                artistKey &&
                !excludeArtistKeys.has(artistKey) &&
                !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        trending: this._sortSourceCandidates(
          trendingTracks
            .map((track, index) => this._buildBaseCandidate(track, "trending", index))
            .filter((candidate) => {
              const artistKey = this._trackArtistKey(candidate);
              return (
                artistKey &&
                !nonLibraryExcludeArtistKeys.has(artistKey) &&
                !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        focus: this._sortSourceCandidates(focusCandidates),
      },
      excludeArtistKeys,
    };
  }

  _assembleFlowPlan({
    candidateMap,
    excludeArtistKeys,
    targetSize,
    reserveSize,
    sourceTargets,
    reserveTargets,
    includeReserve = true,
  }) {
    const orderedSources = ["focus", "mix", "discover", "trending"];
    const usedArtistKeys = new Set(excludeArtistKeys);
    const primaryTracks = [];
    for (const source of orderedSources) {
      primaryTracks.push(
        ...this._selectFromCandidates(
          candidateMap[source],
          Number(sourceTargets[source] || 0),
          usedArtistKeys,
        ),
      );
    }
    const remainingPrimaryNeeded = Math.max(0, targetSize - primaryTracks.length);
    if (remainingPrimaryNeeded > 0) {
      const pooled = orderedSources.flatMap((source) => candidateMap[source]);
      primaryTracks.push(
        ...this._selectFromCandidates(pooled, remainingPrimaryNeeded, usedArtistKeys),
      );
    }
    const reserveTracks = [];
    if (includeReserve) {
      for (const source of orderedSources) {
        const needed = Math.max(0, Number(reserveTargets[source] || 0));
        reserveTracks.push(
          ...this._selectFromCandidates(candidateMap[source], needed, usedArtistKeys),
        );
      }
      const remainingReserveNeeded = Math.max(0, reserveSize - reserveTracks.length);
      if (remainingReserveNeeded > 0) {
        const pooled = orderedSources.flatMap((source) => candidateMap[source]);
        reserveTracks.push(
          ...this._selectFromCandidates(pooled, remainingReserveNeeded, usedArtistKeys),
        );
      }
    }
    const finalPrimary = primaryTracks
      .slice(0, targetSize)
      .map(({ trackKey, ...track }) => track);
    const finalReserve = reserveTracks
      .slice(0, reserveSize)
      .map(({ trackKey, ...track }) => track);
    return {
      primaryTracks: finalPrimary,
      reserveTracks: finalReserve,
      diagnostics: {
        requested: {
          size: targetSize,
          reserveSize,
          sources: sourceTargets,
          reserveSources: reserveTargets,
        },
        achieved: {
          primary: finalPrimary.length,
          reserve: finalReserve.length,
          sourceCounts: orderedSources.reduce((acc, source) => {
            acc[source] = finalPrimary.filter((track) => track.source === source).length;
            return acc;
          }, {}),
          reserveSourceCounts: orderedSources.reduce((acc, source) => {
            acc[source] = finalReserve.filter((track) => track.source === source).length;
            return acc;
          }, {}),
          focusTiers: [...finalPrimary, ...finalReserve].reduce((acc, track) => {
            const tier = String(track.focusTier || "none");
            acc[tier] = Number(acc[tier] || 0) + 1;
            return acc;
          }, {}),
        },
      },
    };
  }

  async buildFlowRunPlan(flow, options = {}) {
    const requestedSize = Number(flow?.size || 0);
    const targetSize =
      Number.isFinite(requestedSize) && requestedSize > 0
        ? Math.round(requestedSize)
        : 30;
    if (flow?.discoverPresetId === "release-radar") {
      const basedOn =
        options?.basedOn ||
        this._resolveDiscoveryCache(options)?.basedOn ||
        [];
      const primaryTracks = await this.getReleaseRadarTracks(targetSize, {
        listenHistoryProfile: options?.listenHistoryProfile || null,
        basedOn,
      });
      return {
        primaryTracks,
        reserveTracks: [],
        diagnostics: {
          targets: { releaseRadar: targetSize, maxSize: targetSize },
          achieved: { primary: primaryTracks.length, reserve: 0 },
        },
      };
    }
    const mix = flow?.mix || { discover: 34, mix: 33, trending: 33, focus: 0 };
    const sourceTargets = this._buildSourceTargets(targetSize, mix);
    const { candidateMap, excludeArtistKeys } = await this._harvestFlowSources(
      flow,
      sourceTargets,
      options,
    );
    return this._assembleFlowPlan({
      candidateMap,
      excludeArtistKeys,
      targetSize,
      reserveSize: 0,
      sourceTargets,
      reserveTargets: { discover: 0, mix: 0, trending: 0, focus: 0 },
      includeReserve: false,
    });
  }

  async buildFlowReservePlan(flow, primaryTracks, options = {}) {
    const requestedSize = Number(flow?.size || 0);
    const targetSize =
      Number.isFinite(requestedSize) && requestedSize > 0
        ? Math.round(requestedSize)
        : 30;
    const reserveSize =
      Number.isFinite(Number(options?.reserveSize)) && Number(options.reserveSize) >= 0
        ? Math.round(Number(options.reserveSize))
        : Math.max(Math.ceil(targetSize * 0.75), 8);
    const mix = flow?.mix || { discover: 34, mix: 33, trending: 33, focus: 0 };
    const sourceTargets = this._buildSourceTargets(targetSize, mix);
    const reserveTargets = this._buildSourceTargets(reserveSize, mix);
    const { candidateMap, excludeArtistKeys } = await this._harvestFlowSources(
      flow,
      reserveTargets,
      options,
    );
    return this._assembleFlowPlan({
      candidateMap,
      excludeArtistKeys,
      targetSize: 0,
      reserveSize,
      sourceTargets: { discover: 0, mix: 0, trending: 0, focus: 0 },
      reserveTargets,
      includeReserve: true,
    });
  }

  async getTracksForFlow(flow) {
    const plan = await this.buildFlowRunPlan(flow);
    return Array.isArray(plan?.primaryTracks) ? plan.primaryTracks : [];
  }

  async getDiscoverTracks(limit, options = {}) {
    const discoveryCache = this._resolveDiscoveryCache(options);
    const recommendations = discoveryCache.recommendations || [];
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      throw new Error(
        "No discovery recommendations available. Update discovery cache first.",
      );
    }
    return this._harvestTopTracksFromArtists(recommendations, limit, {
      ...options,
      reason: options?.reason || "From discovery recommendations",
    });
  }

  async getTrendingTracks(limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    const discoveryCache = this._resolveDiscoveryCache(options);
    const globalTop = discoveryCache.globalTop || [];
    const candidates = this._filterArtistsByKeySet(
      globalTop,
      options?.excludeArtistKeys,
    );
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(
        "No trending artists available. Update discovery cache first.",
      );
    }
    return this._harvestTopTracksFromArtists(candidates, limit, {
      ...options,
      reason: options?.reason || "From trending artists",
    });
  }

  async getTagTracks(tag, limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!tag || limit <= 0) return [];
    const normalizedTag = this._artistKey(tag);
    const requested = Math.max(limit * 3, 50);
    const trackData = await lastfmRequest("tag.getTopTracks", {
      tag,
      limit: requested,
    });
    const tracks = trackData?.tracks?.track
      ? Array.isArray(trackData.tracks.track)
        ? trackData.tracks.track
        : [trackData.tracks.track]
      : [];
    const result = [];
    const seen = new Set();
    for (const track of tracks) {
      if (result.length >= limit) break;
      const artistName = (
        track.artist?.name ||
        track.artist?.["#text"] ||
        ""
      ).trim();
      const trackName = track?.name?.trim();
      if (!artistName || !trackName) continue;
      const key = artistName.toLowerCase();
      if (!key || seen.has(key)) continue;
      if (options?.excludeArtistKeys?.has(key)) continue;
      seen.add(key);
      const trackEntry = this._buildTrackEntry({
        artistName,
        trackName,
        albumName: track?.album?.title || track?.album?.["#text"] || null,
        artistMbid: track?.artist?.mbid || null,
        reason: options?.reason || `From genre: ${tag}`,
      });
      if (trackEntry) result.push(trackEntry);
    }
    return this._filterTracksByArtists(
      result,
      null,
      options?.excludeArtistKeys,
    );
  }

  async getRelatedArtistTracks(artistKey, limit, options = {}) {
    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key not configured");
    }
    if (!artistKey || limit <= 0) return [];
    const params = this._isMbid(artistKey)
      ? { mbid: artistKey, limit: 25 }
      : { artist: artistKey, limit: 25 };
    const similar = await lastfmRequest("artist.getSimilar", params);
    const list = similar?.similarartists?.artist
      ? Array.isArray(similar.similarartists.artist)
        ? similar.similarartists.artist
        : [similar.similarartists.artist]
      : [];
    const candidates = this._filterArtistsByKeySet(
      list,
      options?.excludeArtistKeys,
    );
    return this._harvestTopTracksFromArtists(
      candidates.map((candidate) => ({
        name: String(candidate?.name || "").trim(),
        mbid: candidate?.mbid || null,
      })),
      limit,
      {
        ...options,
        reason: options?.reason || `Similar to ${artistKey}`,
      },
    );
  }

  async getRecommendedTracks(limit, options = {}) {
    const discoveryCache = this._resolveDiscoveryCache(options);
    const recommendations = discoveryCache.recommendations || [];
    const globalTop = discoveryCache.globalTop || [];

    if (recommendations.length === 0 && globalTop.length === 0) {
      throw new Error(
        "No discovery recommendations available. Update discovery cache first.",
      );
    }

    const includeGlobalTop = options?.includeGlobalTop !== false;
    const excludeSet = options?.excludeArtistKeys;
    const baseArtists = includeGlobalTop
      ? [...recommendations, ...globalTop]
      : [...recommendations];
    const artists = excludeSet
      ? baseArtists.filter((artist) => {
          const keys = this._artistKeysFromArtist(artist);
          return !keys.some((key) => excludeSet.has(key));
        })
      : baseArtists;

    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key required for recommended tracks");
    }

    const tracks = await this._harvestTopTracksFromArtists(artists, limit, {
      ...options,
      reason: options?.reason || "From discovery recommendations",
    });
    return tracks.slice(0, limit);
  }

  async _getLibraryOwnership(libraryManager, artistId) {
    const key = String(artistId ?? "");
    if (!key) {
      return { ownedTitles: new Set(), ownedAlbums: new Set() };
    }
    const cached = this.libraryOwnershipCache.get(key);
    if (cached?.data && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const albums = await libraryManager.getAlbums(artistId);
    const [ownedTitles, ownedAlbums] = await Promise.all([
      this.getLibraryTrackTitles(libraryManager, artistId, albums),
      this.getLibraryAlbumNames(libraryManager, artistId, albums),
    ]);
    const data = { ownedTitles, ownedAlbums };
    this.libraryOwnershipCache.set(key, {
      data,
      expiresAt: Date.now() + LIBRARY_OWNERSHIP_CACHE_TTL_MS,
    });
    return data;
  }

  async getLibraryTrackTitles(libraryManager, artistId, knownAlbums = null) {
    const albums = Array.isArray(knownAlbums)
      ? knownAlbums
      : await libraryManager.getAlbums(artistId);
    const titles = new Set();
    const maxAlbums = 30;
    const trackLists = await Promise.all(
      albums.slice(0, maxAlbums).map((album) => libraryManager.getTracks(album.id)),
    );
    for (const tracks of trackLists) {
      for (const t of tracks) {
        const name = (t.trackName || t.title || "").trim().toLowerCase();
        if (name) titles.add(name);
      }
    }
    return titles;
  }

  async getLibraryAlbumNames(libraryManager, artistId, knownAlbums = null) {
    const albums = Array.isArray(knownAlbums)
      ? knownAlbums
      : await libraryManager.getAlbums(artistId);
    const names = new Set();
    const maxAlbums = 40;
    for (const album of albums.slice(0, maxAlbums)) {
      const name = (album.albumName || album.title || "").trim().toLowerCase();
      if (name) names.add(name);
    }
    return names;
  }

  async getMixTracks(limit, options = {}) {
    const { libraryManager } = await import("./libraryManager.js");
    const artists = Array.isArray(options?.libraryArtists)
      ? options.libraryArtists
      : await libraryManager.getAllArtists();
    if (artists.length === 0) {
      throw new Error("No artists in library. Add artists to enable Mix.");
    }

    if (!getLastfmApiKey()) {
      throw new Error("Last.fm API key required for Mix");
    }

    const shuffled = [...artists].sort(() => 0.5 - Math.random());
    const ranges = this._deepDiveRanges(options?.deepDive === true);
    const maxArtistsToTry = Math.min(45, Math.max(limit * 2, 30));
    const candidates = shuffled.slice(0, maxArtistsToTry);
    const tracks = [];
    const seenArtists = new Set();
    let cursor = 0;
    const batchSize = LASTFM_HARVEST_CONCURRENCY * 2;

    while (tracks.length < limit && cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + batchSize);
      cursor += batch.length;
      const batchResults = await Promise.all(
        batch.map(async (artist) => {
          const artistName = (artist.artistName || artist.name || "").trim();
          if (!artistName) return null;
          const artistKey = this._artistKey(artistName);
          if (!artistKey || seenArtists.has(artistKey)) return null;
          try {
            const { ownedTitles, ownedAlbums } = await this._getLibraryOwnership(
              libraryManager,
              artist.id,
            );
            const trackList = await this._getArtistTopTrackList(artistName);
            if (!trackList.length) return null;
            const picked = await this._pickTrackFromRangesWithOwnedAlbums(
              trackList,
              ownedTitles,
              ownedAlbums,
              artistName,
              ranges,
            );
            const trackName = picked?.pick?.name?.trim();
            if (!trackName) return null;
            return this._buildTrackEntry({
              artistName,
              trackName,
              albumName:
                picked?.albumName ||
                picked?.pick?.album?.title ||
                picked?.pick?.album?.["#text"] ||
                null,
              artistMbid: artist?.mbid || artist?.foreignArtistId || null,
              reason: options?.reason || "From your library mix",
            });
          } catch (error) {
            console.warn(
              `[WeeklyFlowPlaylistSource] Failed to get Mix tracks for ${artistName}:`,
              error.message,
            );
            return null;
          }
        }),
      );
      for (const trackEntry of batchResults) {
        if (!trackEntry) continue;
        const artistKey = this._trackArtistKey(trackEntry);
        if (!artistKey || seenArtists.has(artistKey)) continue;
        seenArtists.add(artistKey);
        tracks.push(trackEntry);
        if (tracks.length >= limit) break;
      }
    }

    return tracks;
  }

  async _getLibraryAlbumMbidSet() {
    const now = Date.now();
    if (
      this.libraryAlbumMbidCache?.set &&
      this.libraryAlbumMbidCache.expiresAt > now
    ) {
      return this.libraryAlbumMbidCache.set;
    }
    const set = new Set();
    try {
      const { lidarrClient } = await import("./lidarrClient.js");
      if (lidarrClient.isConfigured()) {
        const albums = await lidarrClient.request("/album");
        for (const album of Array.isArray(albums) ? albums : []) {
          const mbid = String(album?.foreignAlbumId || "").trim().toLowerCase();
          if (mbid) set.add(mbid);
        }
      }
    } catch {}
    this.libraryAlbumMbidCache = {
      set,
      expiresAt: now + LIBRARY_ARTIST_KEYS_CACHE_TTL_MS,
    };
    return set;
  }

  _pickTopAlbumTrack(trackList) {
    const entries = Array.isArray(trackList) ? trackList : [trackList];
    const ranked = [...entries]
      .map((entry) => {
        const trackName = String(entry?.name || "").trim();
        if (!trackName) return null;
        const rank = Number(entry?.["@attr"]?.rank ?? entry?.attr?.rank ?? NaN);
        return {
          trackName,
          rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.rank - right.rank);
    return ranked[0]?.trackName || null;
  }

  async _pickTrackFromRelease({
    artistName,
    albumTitle,
    albumMbid = null,
    artistMbid = null,
    releaseYear = null,
  }) {
    const normalizedArtist = String(artistName || "").trim();
    const normalizedAlbum = String(albumTitle || "").trim();
    if (!normalizedArtist || !normalizedAlbum) return null;

    let trackName = null;
    try {
      const data = await lastfmRequest("album.getInfo", {
        artist: normalizedArtist,
        album: normalizedAlbum,
      });
      trackName = this._pickTopAlbumTrack(data?.album?.tracks?.track);
    } catch {}

    if (!trackName && getLastfmApiKey()) {
      try {
        const trackList = await this._getArtistTopTrackList(normalizedArtist);
        const albumKey = this._artistKey(normalizedAlbum);
        const albumMatch = trackList.find((entry) => {
          const candidateAlbum = String(
            entry?.album?.title || entry?.album?.["#text"] || "",
          ).trim();
          return candidateAlbum && this._artistKey(candidateAlbum) === albumKey;
        });
        trackName = String(
          albumMatch?.name || trackList[0]?.name || "",
        ).trim();
      } catch {}
    }

    if (!trackName) return null;
    return this._buildTrackEntry({
      artistName: normalizedArtist,
      trackName,
      albumName: normalizedAlbum,
      artistMbid: artistMbid || null,
      albumMbid,
      releaseYear,
      reason: "New release from an artist in your library",
    });
  }

  async getReleaseRadarTracks(limit, options = {}) {
    if (limit <= 0) return [];
    const { getRecentMissingReleases } = await import(
      "./recentReleasesService.js"
    );
    const albums = await getRecentMissingReleases(limit, {
      artists: options?.libraryArtists,
    });
    if (albums.length === 0) return [];

    const tracks = [];
    const seenAlbums = new Set();

    for (const album of albums) {
      if (tracks.length >= limit) break;
      const albumKey = String(album.mbid || album.foreignAlbumId || "")
        .trim()
        .toLowerCase();
      if (albumKey && seenAlbums.has(albumKey)) continue;
      const releaseDate = String(album.releaseDate || "").trim();
      const trackEntry = await this._pickTrackFromRelease({
        artistName: album.artistName,
        albumTitle: album.albumName,
        albumMbid: album.mbid || album.foreignAlbumId || null,
        artistMbid: album.artistMbid || album.foreignArtistId || null,
        releaseYear: releaseDate ? releaseDate.slice(0, 4) : null,
      });
      if (!trackEntry) continue;
      if (albumKey) seenAlbums.add(albumKey);
      tracks.push(trackEntry);
    }

    return tracks;
  }
}

export const playlistSource = new WeeklyFlowPlaylistSource();
