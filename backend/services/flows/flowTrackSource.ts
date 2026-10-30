import { lastfmRequest } from "../apiClients/index.ts";
import * as musicData from "../musicDataSource/index.ts";
import { getUserDiscovery } from "../discovery/userDiscovery.ts";
import { userOps } from "../../db/helpers/index.ts";
import { asAppError } from "../../../lib/errors.ts";
import { logger } from "../logger.ts";
import { normalizeWeightMap, type FlowConfig } from "../playlists/flowPlaylistConfig.ts";
import { getBlockedArtistKeys } from "../discovery/feedback.ts";
import { getBlockedTagKeys, hasBlockedTag, withoutBlockedTags } from "../discovery/blockedTags.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import { getYear } from "../providers/brainzmashRanking.ts";
import { resolveTrackSearchContext } from "../downloadJobs/trackSearchContext.ts";
import { buildLibraryReadModel } from "../libraryReadModel.ts";
import {
  getLibraryForArtistReferences,
  iterateLibraryArtistProjection,
} from "../libraryQueryService.ts";
import BoundedMap from "../boundedMap.ts";
import type { ArtistMatchFields } from "../discovery/artistKeys.ts";
import type { NormalizedTrack } from "../providers/brainzmashMappers.ts";

type WeightMap = Record<string, number>;

type FlowMix = { discover?: number; mix?: number; trending?: number; focus?: number };

type FlowSource = "discover" | "mix" | "trending" | "focus";

type ArtistTopTrack = {
  name: string;
  albumName: string | null;
  mbid: string | null;
  durationMs: number | null;
  popularity: number;
};

type TagArtist = { name: string; mbid: string | null };

type ChartTrack = Awaited<ReturnType<typeof musicData.getTrendingTracks>>[number];

type DeepDiveRange = { start: number; end: number };

type ArtistTagsCacheEntry = { value: string[]; expiresAt: number };

type ArtistTopTracksCacheEntry =
  | { trackList: ArtistTopTrack[]; expiresAt: number; promise?: undefined }
  | { promise: Promise<ArtistTopTrack[]>; trackList?: undefined; expiresAt?: undefined };

type OwnershipCacheEntry = {
  data: { ownedTitles: Set<string>; ownedAlbums: Set<string> };
  expiresAt: number;
};

type ArtistKeySetCacheEntry =
  | { set: Set<string>; expiresAt: number; promise?: undefined }
  | { promise: Promise<Set<string>>; set?: undefined; expiresAt?: undefined };

export type FlowRunSpec = Partial<
  Pick<
    FlowConfig,
    | "id"
    | "ownerUserId"
    | "deepDive"
    | "size"
    | "mix"
    | "tags"
    | "relatedArtists"
    | "yearFrom"
    | "yearTo"
    | "discoverPresetId"
  >
>;

export type FlowRunOptions = {
  ownerUserId?: number | null;
  deepDive?: boolean;
  reason?: string;
  tags?: WeightMap | string[];
  relatedArtists?: WeightMap | string[];
  excludeArtistKeys?: string[];
  excludeTrackKeys?: Set<string> | string[];
  libraryArtistKeys?: Set<string> | string[];
  libraryArtists?: ArtistMatchFields[];
};

type FlowStageOptions = Omit<FlowRunOptions, "excludeArtistKeys"> & {
  excludeArtistKeys?: Set<string>;
};

type TrackEntryInput = {
  artistName: string;
  trackName: string;
  albumName?: string | null;
  artistMbid?: string | number | null;
  albumMbid?: string | null;
  trackMbid?: string | null;
  releaseYear?: string | null;
  durationMs?: number | null;
  artistAliases?: string[];
  reason?: string | null;
  releaseMbid?: string | null;
  trackNumber?: number | null;
  discNumber?: number | null;
};

type FlowTrackEntry = NonNullable<ReturnType<FlowTrackSource["_buildTrackEntry"]>>;

type FocusExtras = {
  artistTags?: string[];
  tagCoverage?: number;
  tagCoverageRatio?: number;
  relatedCoverage?: number;
  relatedCoverageRatio?: number;
  focusTier?: string;
  focusPriority?: number;
  finalScore?: number;
};

type FlowCandidate = ReturnType<FlowTrackSource["_buildBaseCandidate"]>;

type FlowCandidateMap = Record<FlowSource, FlowCandidate[]>;

type FocusArtist = Awaited<ReturnType<FlowTrackSource["_buildFocusArtistPool"]>>[number];

type FocusArtistCandidate = {
  key: string;
  name: string;
  artistMbid: string | null;
  tagMatches: Set<string>;
  relatedSeeds: Set<string>;
  tagRankSum: number;
  relatedRankSum: number;
  popularityHint: number;
};

type ArtistRef = string | ArtistMatchFields;

type HarvestArtist = ArtistMatchFields & {
  sampleTrack?: { trackName?: string | null; albumName?: string | null } | null;
};

type AlbumTrackRow = Partial<
  NormalizedTrack &
    ArtistTopTrack & {
      releaseMbid: string | null;
      "@attr": { rank: string };
      attr: { rank: string };
      trackName: string;
      position: number | string;
      track_number: number | string;
      recordingMbid: string;
    }
>;

const HARVEST_CONCURRENCY = 12;
const ARTIST_TOP_TRACKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
const LIBRARY_ARTIST_KEYS_CACHE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_CACHE_MAX = 1000;

export class FlowTrackSource {
  declare artistTopTagsCache: BoundedMap<string, ArtistTagsCacheEntry>;
  declare artistTopTracksCache: BoundedMap<string, ArtistTopTracksCacheEntry>;
  declare libraryOwnershipCache: BoundedMap<string, OwnershipCacheEntry>;
  declare libraryArtistKeysCache: ArtistKeySetCacheEntry | null;

  constructor() {
    this.artistTopTagsCache = new BoundedMap(PROVIDER_CACHE_MAX);
    this.artistTopTracksCache = new BoundedMap(PROVIDER_CACHE_MAX);
    this.libraryOwnershipCache = new BoundedMap(PROVIDER_CACHE_MAX);
    this.libraryArtistKeysCache = null;
  }

  _deepDiveRanges(deepDive: boolean) {
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

  _hasYearRange(yearFrom: number | null | undefined, yearTo: number | null | undefined) {
    return yearFrom != null || yearTo != null;
  }

  _matchesYearRange(
    releaseYear: string | null | undefined,
    yearFrom: number | null | undefined,
    yearTo: number | null | undefined,
  ) {
    if (!this._hasYearRange(yearFrom, yearTo)) return true;
    const extractedYear = getYear(releaseYear);
    if (extractedYear == null) return false;
    const year = Number(extractedYear);
    if (!Number.isFinite(year)) return false;
    if (yearFrom != null && year < yearFrom) return false;
    if (yearTo != null && year > yearTo) return false;
    return true;
  }

  async _resolveTrackReleaseYear(track: FlowCandidate) {
    const existing = getYear(track?.releaseYear);
    if (existing) return existing;
    try {
      const resolved = await resolveTrackSearchContext(track);
      return getYear(resolved?.releaseYear) || null;
    } catch {
      return null;
    }
  }

  async _selectFromCandidates(
    candidates: FlowCandidate[],
    count: number,
    usedArtistKeys: Set<string>,
    yearFrom: number | null = null,
    yearTo: number | null = null,
  ) {
    const picked = [];
    const rangeActive = this._hasYearRange(yearFrom, yearTo);
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (picked.length >= count) break;
      const artistKeys = this._artistKeysFromArtist(candidate);
      if (artistKeys.length === 0 || artistKeys.some((key) => usedArtistKeys.has(key))) continue;
      if (rangeActive && candidate?.source === "focus") {
        const year = await this._resolveTrackReleaseYear(candidate);
        candidate.releaseYear = year;
        if (!this._matchesYearRange(year, yearFrom, yearTo)) continue;
      }
      artistKeys.forEach((key) => usedArtistKeys.add(key));
      picked.push(candidate);
    }
    return picked;
  }

  _harvestLimitFor(count: number) {
    return Math.min(72, Math.max(Number(count || 0) * 3, 16));
  }

  async _getArtistTopTrackList(artistName: string): Promise<ArtistTopTrack[]> {
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
      const trackList: ArtistTopTrack[] = await musicData.getArtistTopTracks(
        { name },
        { limit: 25 },
      );
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

  async _harvestTopTracksFromArtists(
    artists: HarvestArtist[],
    limit: number,
    options: FlowStageOptions = {},
  ) {
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
    const batchSize = HARVEST_CONCURRENCY * 2;
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
              albumName: pick!.albumName,
              trackMbid: pick!.mbid,
              durationMs: pick!.durationMs,
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

  _buildCounts(size: number, mix: FlowMix) {
    const weights = [
      { key: "discover", value: Number(mix?.discover ?? 0) },
      { key: "mix", value: Number(mix?.mix ?? 0) },
      { key: "trending", value: Number(mix?.trending ?? 0) },
      { key: "focus", value: Number(mix?.focus ?? 0) },
    ];
    const sum = weights.reduce((acc, w) => acc + (Number.isFinite(w.value) ? w.value : 0), 0);
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
    const out: Record<string, number> = {};
    for (const item of ordered) {
      out[item.key] = item.count;
    }
    return out;
  }

  _normalizeFocusEntries(value: unknown) {
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
    return Object.keys(normalizeWeightMap(value));
  }

  _artistKey(value: unknown) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  _releaseTitleKey(value: unknown) {
    return String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _artistKeysFromArtist(artist: ArtistMatchFields) {
    const aliases = Array.isArray(artist?.artistAliases) ? artist.artistAliases : [];
    return [
      artist?.id,
      artist?.mbid,
      artist?.foreignArtistId,
      artist?.artistMbid,
      artist?.name,
      artist?.artistName,
      ...aliases,
    ]
      .map((value) => this._artistKey(value))
      .filter(Boolean);
  }

  _buildFeedbackExcludeKeys(ownerUserId: number | null | undefined) {
    if (ownerUserId == null) return [];
    return [...getBlockedArtistKeys(String(ownerUserId))];
  }

  _trackArtistKey(track: Pick<FlowTrackEntry, "artistName">) {
    const key = this._artistKey(track?.artistName);
    return key || null;
  }

  _normalizeArtistKeySet(value: unknown) {
    if (value instanceof Set) {
      return new Set([...value].map((entry) => this._artistKey(entry)).filter(Boolean));
    }
    if (Array.isArray(value)) {
      return new Set(value.map((entry) => this._artistKey(entry)).filter(Boolean));
    }
    return null;
  }

  _buildArtistKeySet(artists: ArtistMatchFields[] = []) {
    const set = new Set<string>();
    for (const artist of Array.isArray(artists) ? artists : []) {
      for (const key of this._artistKeysFromArtist(artist)) {
        set.add(key);
      }
    }
    return set;
  }

  _resolveDiscoveryCache(options: Pick<FlowRunOptions, "ownerUserId"> = {}) {
    return getUserDiscovery(options?.ownerUserId ?? this._firstActiveAdminId(), 0).body;
  }

  _firstActiveAdminId() {
    const adminIds = userOps
      .getAllUsers()
      .filter((user) => user.role === "admin" && user.status === "active")
      .map((user) => user.id);
    return adminIds.length > 0 ? Math.min(...adminIds) : null;
  }

  _normalizeTrackReason(value: unknown, fallback = "Flow selection") {
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
    releaseMbid = null,
    trackNumber = null,
    discNumber = null,
  }: TrackEntryInput) {
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
      ...(releaseMbid ? { releaseMbid, trackNumber, discNumber } : {}),
    };
  }

  _filterTracksByArtists<T extends ArtistMatchFields>(
    tracks: T[],
    includeSet: Set<string> | null,
    excludeSet: Set<string> | undefined,
  ) {
    return (tracks || []).filter((track) => {
      const artistKeys = this._artistKeysFromArtist(track);
      if (artistKeys.length === 0) return false;
      if (excludeSet && artistKeys.some((key) => excludeSet.has(key))) return false;
      if (includeSet && includeSet.size > 0 && !artistKeys.some((key) => includeSet.has(key))) {
        return false;
      }
      return true;
    });
  }

  async _getLibraryArtistKeySet(options: FlowRunOptions = {}): Promise<Set<string>> {
    const providedSet = this._normalizeArtistKeySet(options?.libraryArtistKeys);
    if (providedSet) return providedSet;
    if (Array.isArray(options?.libraryArtists)) {
      return this._buildArtistKeySet(options.libraryArtists);
    }

    const now = Date.now();
    if (this.libraryArtistKeysCache?.set && this.libraryArtistKeysCache.expiresAt > now) {
      return this.libraryArtistKeysCache.set;
    }
    if (this.libraryArtistKeysCache?.promise) {
      return this.libraryArtistKeysCache.promise;
    }

    const promise = (async () => {
      const artists = [...iterateLibraryArtistProjection({ pageSize: 100 })];
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

  async _getTopTrackForArtist(artistName: string, options: FlowStageOptions = {}) {
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
      albumName: pick!.albumName,
      trackMbid: pick!.mbid,
      durationMs: pick!.durationMs,
      reason: options?.reason || "Flow selection",
    });
  }

  async _getTracksForRankedArtists(
    artists: ArtistRef[],
    limit: number,
    options: FlowStageOptions = {},
  ) {
    if (!Array.isArray(artists) || artists.length === 0 || limit <= 0) return [];
    const tracks = [];
    const seen = new Set();
    let cursor = 0;
    const batchSize = HARVEST_CONCURRENCY * 2;
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
    return this._filterTracksByArtists(tracks, null, options?.excludeArtistKeys);
  }

  async _getTagArtists(tag: string, limit: number) {
    if (!tag || limit <= 0) return [];
    const { artists }: { artists: TagArtist[] } = await musicData.getTagArtists(tag, {
      limit,
    });
    return artists;
  }

  async _getSimilarArtists(artistKey: string, limit = 25) {
    if (!artistKey || limit <= 0) return [];
    return musicData.getSimilarArtists(
      this._isMbid(artistKey) ? { mbid: artistKey } : { name: artistKey },
      { limit },
    );
  }

  _isMbid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  _sliceRange<T>(trackList: T[], start: number, end: number) {
    if (!Array.isArray(trackList) || trackList.length === 0) return [];
    if (start >= trackList.length) return [];
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(trackList.length - 1, end);
    if (safeEnd < safeStart) return [];
    return trackList.slice(safeStart, safeEnd + 1);
  }

  _pickRandomTrack(trackList: ArtistTopTrack[]) {
    if (!Array.isArray(trackList) || trackList.length === 0) return null;
    return (
      trackList
        .filter((track) => String(track?.name || "").trim().length > 0)
        .sort((left, right) => {
          if (Boolean(right?.albumName) !== Boolean(left?.albumName)) {
            return Number(Boolean(right?.albumName)) - Number(Boolean(left?.albumName));
          }
          const leftPopularity = Number(left?.popularity || 0);
          const rightPopularity = Number(right?.popularity || 0);
          if (rightPopularity !== leftPopularity) {
            return rightPopularity - leftPopularity;
          }
          return String(left?.name || "").localeCompare(String(right?.name || ""));
        })[0] || null
    );
  }

  _pickTrackFromRanges(trackList: ArtistTopTrack[], ranges: DeepDiveRange[]) {
    for (const range of ranges) {
      const candidates = this._sliceRange(trackList, range.start, range.end).filter(
        (track) => String(track?.name || "").trim().length > 0,
      );
      const pick = this._pickRandomTrack(candidates);
      if (pick) return pick;
    }
    return null;
  }

  _pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
    trackList: ArtistTopTrack[],
    ownedTitles: Set<string>,
    ownedAlbums: Set<string>,
    ranges: DeepDiveRange[],
  ) {
    for (const range of ranges) {
      const candidates = this._sliceRange(trackList, range.start, range.end).filter((track) => {
        const name = String(track?.name || "")
          .trim()
          .toLowerCase();
        return name && !ownedTitles.has(name);
      });
      const shuffled = [...candidates].sort(() => 0.5 - Math.random());
      for (const candidate of shuffled) {
        const albumName = String(candidate?.albumName || "").trim();
        if (!albumName) continue;
        if (!ownedAlbums.has(albumName.toLowerCase())) {
          return { pick: candidate, albumName };
        }
      }
    }
    return null;
  }

  async _pickTrackFromRangesWithOwnedAlbumsViaInfo(
    trackList: ArtistTopTrack[],
    ownedTitles: Set<string>,
    ownedAlbums: Set<string>,
    artistName: string,
    ranges: DeepDiveRange[],
  ) {
    let checked = 0;
    const maxChecks = 12;
    for (const range of ranges) {
      const candidates = this._sliceRange(trackList, range.start, range.end).filter((track) => {
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
              albumName: String(info?.track?.album?.title || "").trim() || null,
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
    trackList: ArtistTopTrack[],
    ownedTitles: Set<string>,
    ownedAlbums: Set<string>,
    artistName: string,
    ranges: DeepDiveRange[],
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

  async _getArtistTopTagLists(artists: ArtistMatchFields[]) {
    const now = Date.now();
    const keys = artists.map(
      (artist) => String(artist.artistMbid || "").trim() || this._artistKey(artist.name),
    );
    const missing = keys
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => key && !((this.artistTopTagsCache.get(key)?.expiresAt ?? 0) > now));
    if (missing.length > 0) {
      const lists: { name: string }[][] = await musicData.getArtistTagLists(
        missing.map(({ index }) => ({
          mbid: artists[index].artistMbid,
          name: artists[index].name,
        })),
      );
      missing.forEach(({ key }, position) => {
        const tags = [
          ...new Map(
            lists[position].map((tag) => [this._artistKey(tag.name), tag.name] as const),
          ).values(),
        ];
        this.artistTopTagsCache.set(key, {
          value: tags.slice(0, 12),
          expiresAt: now + ARTIST_TOP_TRACKS_CACHE_TTL_MS,
        });
      });
    }
    return keys.map((key) => this.artistTopTagsCache.get(key)?.value || []);
  }

  async _withoutBlockedTagArtists(tracks: FlowTrackEntry[], blockedTags: ReadonlySet<string>) {
    if (blockedTags.size === 0 || tracks.length === 0) return tracks;
    const tagLists = await this._getArtistTopTagLists(
      tracks.map((track) => ({ name: track.artistName, artistMbid: track.artistMbid })),
    );
    return tracks.filter((_, index) => !hasBlockedTag(tagLists[index], blockedTags));
  }

  _buildBaseCandidate(
    track: FlowTrackEntry,
    source: FlowSource,
    sourceRank = 0,
    extra: FocusExtras = {},
  ) {
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
        Number(extra.finalScore) || sourceBaseScore + metadataConfidence * 25 + downloadabilityHint,
    };
  }

  _getFocusTierDetails(
    tagCoverage: number,
    totalTags: number,
    relatedCoverage: number,
    totalRelated: number,
  ) {
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
    const tagCoverageRatio = hasTags ? Math.min(1, safeTagCoverage / totalTags) : 0;
    const relatedCoverageRatio = hasRelated ? Math.min(1, safeRelatedCoverage / totalRelated) : 0;

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
        focusPriority: safeRelatedCoverage >= totalRelated ? 4 : safeRelatedCoverage > 0 ? 3 : 0,
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
      focusPriority: safeTagCoverage >= totalTags ? 2 : safeTagCoverage > 0 ? 1 : 0,
      tagCoverageRatio,
      relatedCoverageRatio,
    };
  }

  async _buildFocusArtistPool(
    tags: string[],
    relatedArtists: string[],
    limit: number,
    options: FlowStageOptions = {},
  ) {
    const normalizedTags = this._normalizeFocusEntries(tags);
    const normalizedRelated = this._normalizeFocusEntries(relatedArtists);
    const totalTags = normalizedTags.length;
    const totalRelated = normalizedRelated.length;
    if (limit <= 0 || (totalTags === 0 && totalRelated === 0)) {
      return [];
    }

    const excludeArtistKeys = options?.excludeArtistKeys || new Set();
    const requestedArtists = Math.min(150, Math.max(limit * 6, 60));
    const candidateMap = new Map<string, FocusArtistCandidate>();
    const ensureEntry = (artistName: string, mbid: string | null = null) => {
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
        const artist = group.artists[index];
        const entry = ensureEntry(artist.name, artist.mbid);
        if (!entry) continue;
        entry.tagMatches.add(tagKey);
        entry.tagRankSum += index + 1;
      }
    }

    for (const group of relatedGroups) {
      const seedKey = this._artistKey(group.seed);
      for (let index = 0; index < group.artists.length; index += 1) {
        const artist = group.artists[index];
        const artistName = String(artist?.name || "").trim();
        const entry = ensureEntry(artistName, artist?.mbid || null);
        if (!entry) continue;
        entry.relatedSeeds.add(seedKey);
        entry.relatedRankSum += index + 1;
        entry.popularityHint = Math.max(
          entry.popularityHint,
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
    const topTagLists = await this._getArtistTopTagLists(preliminary);
    const enriched = preliminary.map((artist, index) => {
      const topTags = topTagLists[index];
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
    });

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

  async _getFocusCandidates(limit: number, options: FlowStageOptions = {}) {
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
    const focusArtistMap = new Map<string | null, FocusArtist>(
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
      .filter((candidate): candidate is FlowCandidate => {
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

  _sortSourceCandidates<T extends { finalScore: number; sourceRank: number }>(
    candidates: T[],
  ): T[] {
    return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
      if (right.finalScore !== left.finalScore) {
        return right.finalScore - left.finalScore;
      }
      return left.sourceRank - right.sourceRank;
    });
  }

  _buildSourceTargets(size: number, mix: FlowMix) {
    return this._buildCounts(size, mix);
  }

  async _harvestFlowSources(
    flow: FlowRunSpec,
    harvestTargets: Record<string, number>,
    options: FlowRunOptions = {},
  ) {
    const blockedTags = getBlockedTagKeys(flow?.ownerUserId);
    const tags = withoutBlockedTags(this._normalizeFocusEntries(flow?.tags), blockedTags);
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
      () => new Set<string>(),
    );
    const nonLibraryExcludeArtistKeys = new Set(excludeArtistKeys);
    for (const entry of libraryArtistKeys) {
      nonLibraryExcludeArtistKeys.add(entry);
    }
    const skipSource = (sourceName: string) => (error: unknown) => {
      logger.warn(
        "flows",
        `Skipped the ${sourceName} source for flow ${flow?.id || "preview"}: ${asAppError(error)?.message}`,
      );
      return [];
    };
    const [discoverTracks, mixTracks, trendingTracks, focusCandidates] = await Promise.all([
      harvestTargets.discover > 0
        ? this.getDiscoverTracks(this._harvestLimitFor(harvestTargets.discover), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From discovery recommendations",
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
          }).catch(skipSource("discover"))
        : [],
      harvestTargets.mix > 0
        ? this.getMixTracks(this._harvestLimitFor(harvestTargets.mix), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From your library mix",
          }).catch(skipSource("mix"))
        : [],
      harvestTargets.trending > 0
        ? this.getTrendingTracks(this._harvestLimitFor(harvestTargets.trending), {
            ...options,
            deepDive: flow?.deepDive === true,
            reason: "From trending artists",
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
          })
            .then((tracks) => this._withoutBlockedTagArtists(tracks, blockedTags))
            .catch(skipSource("trending"))
        : [],
      harvestTargets.focus > 0
        ? this._getFocusCandidates(this._harvestLimitFor(harvestTargets.focus), {
            tags,
            relatedArtists,
            deepDive: flow?.deepDive === true,
            excludeArtistKeys: nonLibraryExcludeArtistKeys,
            excludeTrackKeys,
          }).catch(skipSource("focus"))
        : [],
    ]);
    return {
      candidateMap: {
        discover: this._sortSourceCandidates(
          discoverTracks
            .map((track, index) => this._buildBaseCandidate(track, "discover", index))
            .filter((candidate) => {
              return (
                this._filterTracksByArtists([candidate], null, nonLibraryExcludeArtistKeys).length >
                  0 && !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        mix: this._sortSourceCandidates(
          mixTracks
            .map((track, index) => this._buildBaseCandidate(track, "mix", index))
            .filter((candidate) => {
              return (
                this._filterTracksByArtists([candidate], null, excludeArtistKeys).length > 0 &&
                !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        trending: this._sortSourceCandidates(
          trendingTracks
            .map((track, index) => this._buildBaseCandidate(track, "trending", index))
            .filter((candidate) => {
              return (
                this._filterTracksByArtists([candidate], null, nonLibraryExcludeArtistKeys).length >
                  0 && !excludeTrackKeys.has(candidate.trackKey)
              );
            }),
        ),
        focus: this._sortSourceCandidates(
          focusCandidates.filter((candidate) => !hasBlockedTag(candidate.artistTags, blockedTags)),
        ),
      },
      excludeArtistKeys,
    };
  }

  async _assembleFlowPlan({
    candidateMap,
    excludeArtistKeys,
    targetSize,
    sourceTargets,
    yearFrom = null,
    yearTo = null,
  }: {
    candidateMap: FlowCandidateMap;
    excludeArtistKeys: Set<string>;
    targetSize: number;
    sourceTargets: Record<string, number>;
    yearFrom?: number | null;
    yearTo?: number | null;
  }) {
    const orderedSources: FlowSource[] = ["focus", "mix", "discover", "trending"];
    const usedArtistKeys = new Set(excludeArtistKeys);
    const primaryTracks = [];
    for (const source of orderedSources) {
      primaryTracks.push(
        ...(await this._selectFromCandidates(
          candidateMap[source],
          Number(sourceTargets[source] || 0),
          usedArtistKeys,
          yearFrom,
          yearTo,
        )),
      );
    }
    const remainingPrimaryNeeded = Math.max(0, targetSize - primaryTracks.length);
    if (remainingPrimaryNeeded > 0) {
      const pooled = orderedSources.flatMap((source) => candidateMap[source]);
      primaryTracks.push(
        ...(await this._selectFromCandidates(
          pooled,
          remainingPrimaryNeeded,
          usedArtistKeys,
          yearFrom,
          yearTo,
        )),
      );
    }
    return {
      primaryTracks: primaryTracks
        .slice(0, targetSize)
        .map(({ trackKey: _trackKey, ...track }) => track),
    };
  }

  async buildFlowRunPlan(flow: FlowRunSpec, planOptions: FlowRunOptions = {}) {
    const options = {
      ...planOptions,
      ownerUserId: planOptions?.ownerUserId ?? flow?.ownerUserId ?? null,
    };
    const requestedSize = Number(flow?.size || 0);
    const targetSize =
      Number.isFinite(requestedSize) && requestedSize > 0 ? Math.round(requestedSize) : 30;
    if (flow?.discoverPresetId === "release-radar") {
      const generatedTracks = await this.getReleaseRadarTracks(targetSize);
      return {
        primaryTracks: this._filterTracksByArtists(
          generatedTracks,
          null,
          new Set(this._buildFeedbackExcludeKeys(flow?.ownerUserId)),
        ),
      };
    }
    const mix = flow?.mix || { discover: 34, mix: 33, trending: 33, focus: 0 };
    const _sourceTargets = this._buildSourceTargets(targetSize, mix);
    const feedbackExcludeKeys = this._buildFeedbackExcludeKeys(flow?.ownerUserId);
    const mergedOptions = {
      ...options,
      excludeArtistKeys: [
        ...(Array.isArray(options?.excludeArtistKeys)
          ? options.excludeArtistKeys
          : options?.excludeArtistKeys
            ? [options.excludeArtistKeys]
            : []),
        ...feedbackExcludeKeys,
      ],
    };
    const { candidateMap, excludeArtistKeys } = await this._harvestFlowSources(
      flow,
      _sourceTargets,
      mergedOptions,
    );
    return this._assembleFlowPlan({
      candidateMap,
      excludeArtistKeys,
      targetSize,
      sourceTargets: _sourceTargets,
      yearFrom: flow?.yearFrom ?? null,
      yearTo: flow?.yearTo ?? null,
    });
  }

  async getDiscoverTracks(limit: number, options: FlowStageOptions = {}) {
    const discoveryCache = this._resolveDiscoveryCache(options);
    const recommendations = discoveryCache.recommendations || [];
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      throw new Error("No discovery recommendations available. Update discovery cache first.");
    }
    return this._harvestTopTracksFromArtists(recommendations, limit, {
      ...options,
      reason: options?.reason || "From discovery recommendations",
    });
  }

  _buildChartTracks(
    tracks: ChartTrack[],
    limit: number,
    options: FlowStageOptions,
    reason: string,
  ) {
    const result: FlowTrackEntry[] = [];
    const seen = new Set<string>();
    for (const track of tracks) {
      if (result.length >= limit) break;
      const key = this._artistKey(track.artistName);
      if (!key || seen.has(key)) continue;
      if (options?.excludeArtistKeys?.has(key)) continue;
      seen.add(key);
      const trackEntry = this._buildTrackEntry({
        artistName: track.artistName,
        trackName: track.name,
        albumName: track.albumName,
        artistMbid: track.artistMbid,
        reason: options?.reason || reason,
      });
      if (trackEntry) result.push(trackEntry);
    }
    return this._filterTracksByArtists(result, null, options?.excludeArtistKeys);
  }

  async getTrendingTracks(limit: number, options: FlowStageOptions = {}) {
    const tracks = await musicData.getTrendingTracks({
      limit: Math.max(limit * 3, 50),
    });
    return this._buildChartTracks(tracks, limit, options, "From trending tracks");
  }

  async _getLibraryOwnership(_libraryManager: unknown, artistId: ArtistMatchFields["id"]) {
    const key = String(artistId ?? "");
    if (!key) {
      return { ownedTitles: new Set<string>(), ownedAlbums: new Set<string>() };
    }
    const cached = this.libraryOwnershipCache.get(key);
    if (cached?.data && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const { albums, tracks } = buildLibraryReadModel(
      getLibraryForArtistReferences({
        source: "all",
        availableOnly: false,
        references: [artistId],
      }),
    );
    const ownedTitles = new Set(
      tracks
        .filter((track) => track.available)
        .map((track) =>
          String(track.trackName || track.title || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const ownedAlbums = new Set(
      albums
        .filter((album) => album.available)
        .map((album) =>
          String(album.albumName || album.title || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const data = { ownedTitles, ownedAlbums };
    this.libraryOwnershipCache.set(key, {
      data,
      expiresAt: Date.now() + LIBRARY_OWNERSHIP_CACHE_TTL_MS,
    });
    return data;
  }

  async getMixTracks(limit: number, options: FlowRunOptions = {}) {
    const artists: ArtistMatchFields[] = Array.isArray(options?.libraryArtists)
      ? options.libraryArtists
      : [...iterateLibraryArtistProjection({ pageSize: 100 })];
    if (artists.length === 0) {
      throw new Error("No artists in library. Add artists to enable Mix.");
    }

    const shuffled = [...artists].sort(() => 0.5 - Math.random());
    const ranges = this._deepDiveRanges(options?.deepDive === true);
    const maxArtistsToTry = Math.min(45, Math.max(limit * 2, 30));
    const candidates = shuffled.slice(0, maxArtistsToTry);
    const tracks = [];
    const seenArtists = new Set();
    let cursor = 0;
    const batchSize = HARVEST_CONCURRENCY * 2;

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
            const { ownedTitles, ownedAlbums } = await this._getLibraryOwnership(null, artist.id);
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
              albumName: picked!.albumName || picked!.pick.albumName,
              trackMbid: picked!.pick.mbid,
              durationMs: picked!.pick.durationMs,
              artistMbid: artist?.mbid || artist?.foreignArtistId || null,
              reason: options?.reason || "From your library mix",
            });
          } catch (error) {
            console.warn(
              `[FlowTrackSource] Failed to get Mix tracks for ${artistName}:`,
              asAppError(error)?.message,
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

  _pickTopAlbumTrackInfo(trackList: AlbumTrackRow | AlbumTrackRow[] | null | undefined) {
    const entries = Array.isArray(trackList) ? trackList : [trackList];
    return [...entries]
      .map((entry) => {
        const trackName = String(entry?.name || entry?.title || entry?.trackName || "").trim();
        if (!trackName) return null;
        const rank = Number(entry?.["@attr"]?.rank ?? entry?.attr?.rank ?? NaN);
        const fallbackRank = Number(
          entry?.trackNumber ??
            entry?.trackPosition ??
            entry?.position ??
            entry?.track_number ??
            NaN,
        );
        return {
          trackName,
          trackMbid:
            String(
              entry?.recordingId || entry?.recordingMbid || entry?.mbid || entry?.id || "",
            ).trim() || null,
          durationMs:
            entry?.durationMs != null && Number.isFinite(Number(entry.durationMs))
              ? Math.max(0, Math.round(Number(entry.durationMs)))
              : null,
          releaseMbid: entry?.releaseMbid || null,
          trackNumber: entry?.trackPosition ?? null,
          discNumber: entry?.mediumNumber ?? null,
          rank: Number.isFinite(rank)
            ? rank
            : Number.isFinite(fallbackRank)
              ? fallbackRank
              : Number.MAX_SAFE_INTEGER,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left!.rank - right!.rank);
  }

  async _getMetadataAlbumTrackList(albumMbid: string) {
    const safeAlbumMbid = String(albumMbid || "").trim();
    if (!safeAlbumMbid) return [];
    const { getAlbumTracksByAlbumMbid } = await import("../providers/brainzmashProvider.ts");
    return getAlbumTracksByAlbumMbid(safeAlbumMbid);
  }

  async _getLastfmAlbumInfo(artistName: string, albumTitle: string) {
    return lastfmRequest("album.getInfo", {
      artist: artistName,
      album: albumTitle,
    });
  }

  async _pickTrackFromRelease({
    artistName,
    albumTitle,
    albumMbid = null,
    artistMbid = null,
    releaseYear = null,
  }: {
    artistName: string;
    albumTitle: string;
    albumMbid?: string | null;
    artistMbid?: string | null;
    releaseYear?: string | null;
  }) {
    const normalizedArtist = String(artistName || "").trim();
    const normalizedAlbum = String(albumTitle || "").trim();
    if (!normalizedArtist || !normalizedAlbum) return null;

    let pick = null;
    if (albumMbid) {
      try {
        pick =
          this._pickTopAlbumTrackInfo(await this._getMetadataAlbumTrackList(albumMbid))[0] || null;
      } catch {}
    }

    let trackName = pick?.trackName || null;
    try {
      if (!trackName) {
        const data = await this._getLastfmAlbumInfo(normalizedArtist, normalizedAlbum);
        pick = this._pickTopAlbumTrackInfo(data?.album?.tracks?.track)[0] || null;
        trackName = pick?.trackName || null;
      }
    } catch {}

    if (!trackName) {
      try {
        const trackList = await this._getArtistTopTrackList(normalizedArtist);
        const albumKey = this._releaseTitleKey(normalizedAlbum);
        const albumMatch = trackList.find(
          (entry) => entry.albumName && this._releaseTitleKey(entry.albumName) === albumKey,
        );
        pick = albumMatch ? this._pickTopAlbumTrackInfo([albumMatch])[0] || null : null;
        trackName = pick?.trackName || null;
      } catch {}
    }

    if (!trackName) return null;
    return this._buildTrackEntry({
      artistName: normalizedArtist,
      trackName,
      albumName: normalizedAlbum,
      artistMbid: artistMbid || null,
      albumMbid,
      trackMbid: pick?.trackMbid || null,
      durationMs: pick?.durationMs || null,
      releaseMbid: pick?.releaseMbid,
      trackNumber: pick?.trackNumber,
      discNumber: pick?.discNumber,
      releaseYear,
      reason: "New release from an artist in your library",
    });
  }

  async getReleaseRadarTracks(limit: number, options: FlowStageOptions = {}) {
    if (limit <= 0) return [];
    const { getRecentMissingReleases } = await import("../discovery/recentReleases.ts");
    const albums = await getRecentMissingReleases(limit, {
      artists: options?.libraryArtists,
      includeFuture: false,
    });
    if (albums.length === 0) return [];

    const seenAlbums = new Set();
    const uniqueAlbums = albums.filter((album) => {
      const albumKey = String(album.mbid || album.foreignAlbumId || "")
        .trim()
        .toLowerCase();
      if (!albumKey) return true;
      if (seenAlbums.has(albumKey)) return false;
      seenAlbums.add(albumKey);
      return true;
    });

    const resolved = await mapWithConcurrency(
      uniqueAlbums,
      4,
      (album: (typeof uniqueAlbums)[number]) => {
        const releaseDate = String(album.releaseDate || "").trim();
        return this._pickTrackFromRelease({
          artistName: album.artistName,
          albumTitle: album.albumName,
          albumMbid: album.mbid || album.foreignAlbumId || null,
          artistMbid: album.artistMbid || album.foreignArtistId || null,
          releaseYear: releaseDate ? releaseDate.slice(0, 4) : null,
        });
      },
    );

    return resolved.filter((track) => track !== null).slice(0, limit);
  }
}

export type FlowRunPlan = Awaited<ReturnType<FlowTrackSource["buildFlowRunPlan"]>>;

export const flowTrackSource = new FlowTrackSource();
