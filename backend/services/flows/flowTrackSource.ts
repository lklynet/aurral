import {
  deezerGetAlbumTracks,
  getDeezerAlbumsForArtist,
  getDeezerArtist,
  lastfmRequest,
  normalizeTitle,
} from "../apiClients/index.ts";
import * as musicData from "../musicDataSource/index.ts";
import { getUserDiscovery } from "../discovery/userDiscovery.ts";
import { userOps } from "../../db/helpers/index.ts";
import { asAppError } from "../../../lib/errors.ts";
import { UUID_REGEX } from "../../../lib/uuid.ts";
import { FLOW_SOURCES, splitFlowTotal, type FlowMix, type FlowSource } from "../../../lib/flows.ts";
import { logger } from "../logger.ts";
import type { FlowConfig } from "../playlists/flowPlaylistConfig.ts";
import { getBlockedArtistKeys } from "../discovery/feedback.ts";
import { getBlockedTagKeys, hasBlockedTag, withoutBlockedTags } from "../discovery/blockedTags.ts";
import { buildArtistMatchKeySet, getArtistMatchKeys } from "../discovery/artistKeys.ts";
import { getYear } from "../providers/brainzmashRanking.ts";
import { buildLibraryReadModel } from "../libraryReadModel.ts";
import {
  getLibraryForArtistReferences,
  iterateLibraryArtistProjection,
} from "../libraryQueryService.ts";
import { getRecentListeningArtists } from "./flowTemplates.ts";
import BoundedMap from "../boundedMap.ts";
import type { ArtistMatchFields } from "../discovery/artistKeys.ts";
import type { NormalizedTrack } from "../providers/brainzmashMappers.ts";

type ArtistTopTrack = {
  name: string;
  albumName: string | null;
  mbid: string | null;
  durationMs: number | null;
  popularity: number;
};

type DeepDiveRange = { start: number; end: number };

type ArtistTagsCacheEntry = { value: string[]; expiresAt: number };

type ArtistTopTracksCacheEntry =
  | { trackList: ArtistTopTrack[]; expiresAt: number; promise?: undefined }
  | { promise: Promise<ArtistTopTrack[]>; trackList?: undefined; expiresAt?: undefined };

type Ownership = { ownedTitles: Set<string>; ownedAlbums: Set<string> };

type OwnershipCacheEntry = { data: Ownership; expiresAt: number };

type ArtistKeySetCacheEntry =
  | { set: Set<string>; expiresAt: number; promise?: undefined }
  | { promise: Promise<Set<string>>; set?: undefined; expiresAt?: undefined };

export type FlowRunSpec = Partial<
  Pick<
    FlowConfig,
    | "id"
    | "ownerUserId"
    | "deepDive"
    | "recentListening"
    | "size"
    | "tags"
    | "relatedArtists"
    | "yearFrom"
    | "yearTo"
  >
> & { mix?: Partial<FlowMix> };

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

type TrackPick = Omit<TrackEntryInput, "artistName" | "reason">;

type FlowTrackEntry = NonNullable<ReturnType<FlowTrackSource["_buildTrackEntry"]>>;

type FlowFilters = { tags: Map<string, string>; yearFrom: number | null; yearTo: number | null };

type HarvestArtist = ArtistMatchFields & { tags?: string[] | null; reason?: string };

type HarvestOptions = {
  filters: FlowFilters;
  excludeArtistKeys: ReadonlySet<string>;
  blockedTags?: ReadonlySet<string>;
  maxArtists?: number;
  pick: (artist: HarvestArtist, name: string) => Promise<TrackPick | null>;
};

type SourceContext = {
  ownerUserId: number | null;
  deepDive: boolean;
  filters: FlowFilters;
  excludeArtistKeys: ReadonlySet<string>;
  blockedTags: ReadonlySet<string>;
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

const HARVEST_BATCH = 24;
const LIBRARY_ARTIST_LIMIT = 45;
const FILTERED_ARTIST_LIMIT = 300;
const FILTERED_CHART_LIMIT = 500;
const ARTIST_TOP_TRACKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_OWNERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
const LIBRARY_ARTIST_KEYS_CACHE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_CACHE_MAX = 1000;

const NO_FILTERS: FlowFilters = { tags: new Map(), yearFrom: null, yearTo: null };

const DEFAULT_CONTEXT: SourceContext = {
  ownerUserId: null,
  deepDive: false,
  filters: NO_FILTERS,
  excludeArtistKeys: new Set(),
  blockedTags: new Set(),
};

const tagKey = (tag: unknown) =>
  String(tag ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const dedupeNames = (values: readonly unknown[] | null | undefined) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const name = String(value ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
};

const shuffled = <T>(items: readonly T[]) => {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
};

const rankedWindows = <T>(items: readonly T[], size: number) => {
  const out: T[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(...shuffled(items.slice(start, start + size)));
  }
  return out;
};

const artistMbidOf = (artist: ArtistMatchFields) =>
  [artist.artistMbid, artist.mbid, artist.foreignArtistId, artist.id]
    .map((value) => String(value ?? "").trim())
    .find((value) => UUID_REGEX.test(value)) || null;

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

  _hasYears(filters: FlowFilters) {
    return filters.yearFrom != null || filters.yearTo != null;
  }

  _isFiltered(filters: FlowFilters) {
    return filters.tags.size > 0 || this._hasYears(filters);
  }

  _matchesYearRange(
    releaseYear: string | number | null | undefined,
    yearFrom: number | null | undefined,
    yearTo: number | null | undefined,
  ) {
    if (yearFrom == null && yearTo == null) return true;
    const year = Number(getYear(releaseYear == null ? null : String(releaseYear)));
    if (!Number.isFinite(year) || year <= 0) return false;
    if (yearFrom != null && year < yearFrom) return false;
    if (yearTo != null && year > yearTo) return false;
    return true;
  }

  _harvestLimitFor(count: number) {
    return Math.min(72, Math.max(Number(count || 0) * 3, 16));
  }

  async _getArtistTopTrackList(artistName: string): Promise<ArtistTopTrack[]> {
    const name = String(artistName || "").trim();
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

  _buildFeedbackExcludeKeys(ownerUserId: number | null | undefined) {
    if (ownerUserId == null) return [];
    return [...getBlockedArtistKeys(String(ownerUserId))];
  }

  _getRecommendations(ownerUserId: number | null) {
    return getUserDiscovery(ownerUserId ?? this._firstActiveAdminId(), 0).body.recommendations;
  }

  _firstActiveAdminId() {
    const adminIds = userOps
      .getAllUsers()
      .filter((user) => user.role === "admin" && user.status === "active")
      .map((user) => user.id);
    return adminIds.length > 0 ? Math.min(...adminIds) : null;
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
    const safeDuration =
      durationMs != null && Number.isFinite(Number(durationMs))
        ? Math.max(0, Math.round(Number(durationMs)))
        : null;
    return {
      artistName: safeArtist,
      trackName: safeTrack,
      albumName: String(albumName || "").trim() || null,
      artistMbid: String(artistMbid || "").trim() || null,
      albumMbid: String(albumMbid || "").trim() || null,
      trackMbid: String(trackMbid || "").trim() || null,
      releaseYear: String(releaseYear || "").trim() || null,
      durationMs: safeDuration,
      artistAliases: Array.isArray(artistAliases)
        ? artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
      reason: String(reason || "").trim() || "Flow selection",
      ...(releaseMbid ? { releaseMbid, trackNumber, discNumber } : {}),
    };
  }

  async _getLibraryArtistKeySet(): Promise<Set<string>> {
    const now = Date.now();
    if (this.libraryArtistKeysCache?.set && this.libraryArtistKeysCache.expiresAt > now) {
      return this.libraryArtistKeysCache.set;
    }
    if (this.libraryArtistKeysCache?.promise) {
      return this.libraryArtistKeysCache.promise;
    }
    const promise = (async () =>
      buildArtistMatchKeySet([...iterateLibraryArtistProjection({ pageSize: 100 })]))();
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

  async _getTagArtists(tag: string, limit: number) {
    if (!tag || limit <= 0) return [];
    const { artists } = await musicData.getTagArtists(tag, { limit });
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
      for (const candidate of shuffled(candidates)) {
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
      for (const candidate of shuffled(candidates)) {
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
          const albumTitle = String(info?.track?.album?.title || "").trim();
          if (albumTitle && !ownedAlbums.has(albumTitle.toLowerCase())) {
            return { pick: candidate, albumName: albumTitle };
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
    return (
      this._pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
        trackList,
        ownedTitles,
        ownedAlbums,
        ranges,
      ) ??
      this._pickTrackFromRangesWithOwnedAlbumsViaInfo(
        trackList,
        ownedTitles,
        ownedAlbums,
        artistName,
        ranges,
      )
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

  _matchedTag(tags: readonly string[] | null | undefined, filters: FlowFilters) {
    for (const tag of tags ?? []) {
      const match = filters.tags.get(tagKey(tag));
      if (match) return match;
    }
    return null;
  }

  async _keepByTags<T extends { artist: HarvestArtist; name: string }>(
    entries: T[],
    filters: FlowFilters,
    blockedTags: ReadonlySet<string> | undefined,
  ) {
    const blocked = blockedTags ?? new Set<string>();
    if (entries.length === 0 || (filters.tags.size === 0 && blocked.size === 0)) return entries;
    const missing = entries.filter((entry) => !entry.artist.tags?.length);
    const fetched = missing.length
      ? await this._getArtistTopTagLists(
          missing.map((entry) => ({ name: entry.name, artistMbid: artistMbidOf(entry.artist) })),
        )
      : [];
    const fetchedTags = new Map(missing.map((entry, index) => [entry, fetched[index]]));
    return entries.filter((entry) => {
      const tags = entry.artist.tags?.length ? entry.artist.tags : fetchedTags.get(entry) || [];
      if (hasBlockedTag(tags, blocked)) return false;
      return filters.tags.size === 0 || this._matchedTag(tags, filters) !== null;
    });
  }

  async _releasesInYears(artistName: string, filters: FlowFilters, owned: Ownership | null) {
    const artist = await getDeezerArtist(artistName);
    if (!artist) return [];
    const earliest = new Map<string, { id: number; title: string; year: number }>();
    for (const album of await getDeezerAlbumsForArtist(artist)) {
      const year = Number(album["first-release-date"]);
      if (!Number.isFinite(year) || year <= 0) continue;
      const known = earliest.get(album._normalizedTitle);
      if (!known || year < known.year) {
        earliest.set(album._normalizedTitle, { id: album.id, title: album.title, year });
      }
    }
    return [...earliest.values()].filter(
      (release) =>
        this._matchesYearRange(release.year, filters.yearFrom, filters.yearTo) &&
        !owned?.ownedAlbums.has(release.title.toLowerCase()),
    );
  }

  async _pickTrackInYears(
    artistName: string,
    filters: FlowFilters,
    deepDive: boolean,
    owned: Ownership | null = null,
  ): Promise<TrackPick | null> {
    const releases = await this._releasesInYears(artistName, filters, owned);
    if (releases.length === 0) return null;
    const byTitle = new Map(releases.map((release) => [normalizeTitle(release.title), release]));
    const isOwned = (title: string) => owned?.ownedTitles.has(title.trim().toLowerCase()) === true;
    const popular = (await this._getArtistTopTrackList(artistName)).filter(
      (track) =>
        track.albumName && byTitle.has(normalizeTitle(track.albumName)) && !isOwned(track.name),
    );
    const hit = this._pickTrackFromRanges(popular, this._deepDiveRanges(deepDive));
    const hitRelease = hit?.albumName ? byTitle.get(normalizeTitle(hit.albumName)) : null;
    if (hit && hitRelease) {
      return {
        trackName: hit.name,
        albumName: hitRelease.title,
        trackMbid: hit.mbid,
        durationMs: hit.durationMs,
        releaseYear: String(hitRelease.year),
      };
    }
    const release = shuffled(releases)[0];
    const albumTracks = (await deezerGetAlbumTracks(release.id)).filter(
      (track) => !isOwned(track.trackName),
    );
    const track = [...albumTracks].sort((left, right) => right.rank - left.rank)[0];
    if (!track) return null;
    return {
      trackName: track.trackName,
      albumName: release.title,
      durationMs: track.duration_ms,
      releaseYear: String(release.year),
    };
  }

  async _pickTrack(
    name: string,
    filters: FlowFilters,
    deepDive: boolean,
    owned: Ownership | null = null,
  ): Promise<TrackPick | null> {
    if (this._hasYears(filters)) return this._pickTrackInYears(name, filters, deepDive, owned);
    const trackList = await this._getArtistTopTrackList(name);
    const ranges = this._deepDiveRanges(deepDive);
    if (owned) {
      const picked = await this._pickTrackFromRangesWithOwnedAlbums(
        trackList,
        owned.ownedTitles,
        owned.ownedAlbums,
        name,
        ranges,
      );
      return picked
        ? {
            trackName: picked.pick.name,
            albumName: picked.albumName || picked.pick.albumName,
            trackMbid: picked.pick.mbid,
            durationMs: picked.pick.durationMs,
          }
        : null;
    }
    const pick = this._pickTrackFromRanges(trackList, ranges);
    return pick
      ? {
          trackName: pick.name,
          albumName: pick.albumName,
          trackMbid: pick.mbid,
          durationMs: pick.durationMs,
        }
      : null;
  }

  async _harvestArtists(artists: HarvestArtist[], limit: number, options: HarvestOptions) {
    const { filters, excludeArtistKeys, blockedTags, pick } = options;
    const end = Math.min(artists.length, options.maxArtists ?? artists.length);
    const tracks: FlowTrackEntry[] = [];
    const seen = new Set<string>();
    let cursor = 0;
    while (tracks.length < limit && cursor < end) {
      const batch: { artist: HarvestArtist; name: string }[] = [];
      while (batch.length < HARVEST_BATCH && cursor < end) {
        const artist = artists[cursor];
        cursor += 1;
        const name = String(artist?.name || artist?.artistName || "").trim();
        const key = this._artistKey(name);
        if (!key || seen.has(key)) continue;
        if (getArtistMatchKeys(artist).some((entry) => excludeArtistKeys.has(entry))) continue;
        seen.add(key);
        batch.push({ artist, name });
      }
      const eligible = await this._keepByTags(batch, filters, blockedTags);
      const entries = await Promise.all(
        eligible.map(async ({ artist, name }) => {
          const picked = await pick(artist, name).catch(() => null);
          return picked
            ? this._buildTrackEntry({
                artistMbid: artistMbidOf(artist),
                ...picked,
                artistName: name,
                reason: artist.reason,
              })
            : null;
        }),
      );
      for (const entry of entries) {
        if (entry && tracks.length < limit) tracks.push(entry);
      }
    }
    return tracks;
  }

  _selectFromCandidates(candidates: FlowTrackEntry[], count: number, usedArtistKeys: Set<string>) {
    const picked = [];
    for (const candidate of candidates) {
      if (picked.length >= count) break;
      const artistKeys = getArtistMatchKeys(candidate);
      if (artistKeys.length === 0 || artistKeys.some((key) => usedArtistKeys.has(key))) continue;
      artistKeys.forEach((key) => usedArtistKeys.add(key));
      picked.push(candidate);
    }
    return picked;
  }

  _assembleFlowPlan({
    candidateMap,
    excludeArtistKeys,
    targetSize,
    sourceTargets,
  }: {
    candidateMap: Record<FlowSource, FlowTrackEntry[]>;
    excludeArtistKeys: ReadonlySet<string>;
    targetSize: number;
    sourceTargets: Record<FlowSource, number>;
  }) {
    const orderedSources: FlowSource[] = ["newReleases", "focus", "mix", "discover", "trending"];
    const usedArtistKeys = new Set(excludeArtistKeys);
    const primaryTracks = orderedSources.flatMap((source) =>
      this._selectFromCandidates(candidateMap[source], sourceTargets[source], usedArtistKeys),
    );
    if (primaryTracks.length < targetSize) {
      primaryTracks.push(
        ...this._selectFromCandidates(
          orderedSources.flatMap((source) => candidateMap[source]),
          targetSize - primaryTracks.length,
          usedArtistKeys,
        ),
      );
    }
    return { primaryTracks: primaryTracks.slice(0, targetSize) };
  }

  _buildFilters(flow: FlowRunSpec, blockedTags: ReadonlySet<string>): FlowFilters {
    const tags = new Map<string, string>();
    for (const tag of withoutBlockedTags(dedupeNames(flow.tags), blockedTags)) {
      const key = tagKey(tag);
      if (key && !tags.has(key)) tags.set(key, tag);
    }
    return { tags, yearFrom: flow.yearFrom ?? null, yearTo: flow.yearTo ?? null };
  }

  async buildFlowRunPlan(flow: FlowRunSpec) {
    const requestedSize = Number(flow?.size || 0);
    const targetSize =
      Number.isFinite(requestedSize) && requestedSize > 0 ? Math.round(requestedSize) : 30;
    const sourceTargets = splitFlowTotal(
      flow?.mix || { discover: 34, mix: 33, trending: 33 },
      targetSize,
    );
    if (!sourceTargets) return { primaryTracks: [] };
    const ownerUserId = flow?.ownerUserId ?? null;
    const blockedTags = getBlockedTagKeys(ownerUserId);
    const excludeArtistKeys = new Set(this._buildFeedbackExcludeKeys(ownerUserId));
    const libraryArtistKeys = await this._getLibraryArtistKeySet().catch(() => new Set<string>());
    const outsideLibrary = new Set([...excludeArtistKeys, ...libraryArtistKeys]);
    const base = {
      ownerUserId,
      deepDive: flow?.deepDive === true,
      filters: this._buildFilters(flow, blockedTags),
      blockedTags,
    };
    const sources: Record<FlowSource, (limit: number) => Promise<FlowTrackEntry[]>> = {
      discover: (limit) =>
        this.getDiscoverTracks(limit, { ...base, excludeArtistKeys: outsideLibrary }),
      mix: (limit) => this.getMixTracks(limit, { ...base, excludeArtistKeys }),
      trending: (limit) =>
        this.getTrendingTracks(limit, { ...base, excludeArtistKeys: outsideLibrary }),
      focus: (limit) =>
        this.getFocusTracks(limit, flow, { ...base, excludeArtistKeys: outsideLibrary }),
      newReleases: (limit) => this.getNewReleaseTracks(limit, { ...base, excludeArtistKeys }),
    };
    const harvested = await Promise.all(
      FLOW_SOURCES.map(async (source) => {
        if (sourceTargets[source] <= 0) return [];
        try {
          return await sources[source](
            Math.max(targetSize, this._harvestLimitFor(sourceTargets[source])),
          );
        } catch (error) {
          logger.warn(
            "flows",
            `Skipped the ${source} source for flow ${flow?.id || "preview"}: ${asAppError(error)?.message}`,
          );
          return [];
        }
      }),
    );
    const candidateMap: Record<FlowSource, FlowTrackEntry[]> = {
      discover: [],
      mix: [],
      trending: [],
      focus: [],
      newReleases: [],
    };
    FLOW_SOURCES.forEach((source, index) => {
      candidateMap[source] = harvested[index];
    });
    return this._assembleFlowPlan({ candidateMap, excludeArtistKeys, targetSize, sourceTargets });
  }

  async getDiscoverTracks(limit: number, context: Partial<SourceContext> = {}) {
    const { ownerUserId, deepDive, filters, excludeArtistKeys } = {
      ...DEFAULT_CONTEXT,
      ...context,
    };
    const recommendations = this._getRecommendations(ownerUserId);
    if (recommendations.length === 0) {
      throw new Error("No discovery recommendations available. Update discovery cache first.");
    }
    const artists = recommendations.map((recommendation) => {
      const seed =
        recommendation.supportingSeeds?.find((entry) => entry?.artistName)?.artistName ||
        recommendation.sourceArtists?.[0];
      const ownTags =
        recommendation.candidateTagsHydrated === true && recommendation.tagSource !== "inherited";
      return {
        ...recommendation,
        tags: ownTags ? recommendation.tags : null,
        reason: seed ? `Similar to ${seed}` : "Recommended for you",
      };
    });
    return this._harvestArtists(rankedWindows(artists, limit), limit, {
      filters,
      excludeArtistKeys,
      pick: (_artist, name) => this._pickTrack(name, filters, deepDive),
    });
  }

  async _getTrendingChart(limit: number) {
    return musicData.getTrendingTracks({ limit });
  }

  async getTrendingTracks(limit: number, context: Partial<SourceContext> = {}) {
    const { filters, excludeArtistKeys, blockedTags } = { ...DEFAULT_CONTEXT, ...context };
    const chart = await this._getTrendingChart(
      this._isFiltered(filters) ? FILTERED_CHART_LIMIT : Math.max(limit * 3, 50),
    );
    const chartTracks = new Map<string, (typeof chart)[number]>();
    for (const track of chart) {
      if (!chartTracks.has(track.artistName)) chartTracks.set(track.artistName, track);
    }
    return this._harvestArtists(
      [...chartTracks.values()].map((track) => ({
        name: track.artistName,
        artistMbid: track.artistMbid,
        reason: "Trending this week",
      })),
      limit,
      {
        filters,
        excludeArtistKeys,
        blockedTags,
        pick: async (_artist, name) => {
          const track = chartTracks.get(name);
          if (!track) return null;
          if (!this._hasYears(filters)) {
            return { trackName: track.name, albumName: track.albumName };
          }
          const release = track.albumName
            ? (await this._releasesInYears(name, filters, null)).find(
                (entry) => normalizeTitle(entry.title) === normalizeTitle(track.albumName),
              )
            : null;
          return release
            ? { trackName: track.name, albumName: release.title, releaseYear: String(release.year) }
            : null;
        },
      },
    );
  }

  async _getLibraryOwnership(artistId: ArtistMatchFields["id"]): Promise<Ownership> {
    const key = String(artistId ?? "");
    if (!key) {
      return { ownedTitles: new Set(), ownedAlbums: new Set() };
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
    const titles = (values: string[]) =>
      new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
    const data = {
      ownedTitles: titles(
        tracks
          .filter((track) => track.available)
          .map((track) => String(track.trackName || track.title || "")),
      ),
      ownedAlbums: titles(
        albums
          .filter((album) => album.available)
          .map((album) => String(album.albumName || album.title || "")),
      ),
    };
    this.libraryOwnershipCache.set(key, {
      data,
      expiresAt: Date.now() + LIBRARY_OWNERSHIP_CACHE_TTL_MS,
    });
    return data;
  }

  async getMixTracks(limit: number, context: Partial<SourceContext> = {}) {
    const { deepDive, filters, excludeArtistKeys } = { ...DEFAULT_CONTEXT, ...context };
    const artists = [...iterateLibraryArtistProjection({ pageSize: 100 })];
    if (artists.length === 0) {
      throw new Error("No artists in library. Add artists to enable Mix.");
    }
    return this._harvestArtists(
      shuffled(artists).map((artist) => ({ ...artist, reason: "In your Library" })),
      limit,
      {
        filters,
        excludeArtistKeys,
        maxArtists: this._isFiltered(filters) ? FILTERED_ARTIST_LIMIT : LIBRARY_ARTIST_LIMIT,
        pick: async (artist, name) =>
          this._pickTrack(name, filters, deepDive, await this._getLibraryOwnership(artist.id)),
      },
    );
  }

  async _buildFocusArtistPool(seeds: string[], limit: number, filters: FlowFilters) {
    const perGroup = Math.min(150, Math.max(limit * 6, 60));
    const groups = await Promise.all([
      ...seeds.map(async (seed) => ({
        reason: `Similar to ${seed}`,
        artists: await this._getSimilarArtists(seed, perGroup).catch(() => []),
      })),
      ...[...filters.tags.values()].map(async (tag) => ({
        reason: `Tagged ${tag}`,
        artists: await this._getTagArtists(tag, perGroup).catch(() => []),
      })),
    ]);
    const pool = new Map<string, HarvestArtist>();
    const deepest = Math.max(0, ...groups.map((group) => group.artists.length));
    for (let rank = 0; rank < deepest; rank += 1) {
      for (const { reason, artists } of groups) {
        const name = String(artists[rank]?.name || "").trim();
        const key = this._artistKey(name);
        if (!key || pool.has(key)) continue;
        pool.set(key, {
          name,
          artistMbid: String(artists[rank]?.mbid || "").trim() || null,
          reason,
        });
      }
    }
    return [...pool.values()];
  }

  async getFocusTracks(limit: number, flow: FlowRunSpec, context: Partial<SourceContext> = {}) {
    const { ownerUserId, deepDive, filters, excludeArtistKeys, blockedTags } = {
      ...DEFAULT_CONTEXT,
      ...context,
    };
    const seeds = dedupeNames([
      ...(flow.relatedArtists ?? []),
      ...(flow.recentListening && ownerUserId != null
        ? getRecentListeningArtists(ownerUserId)
        : []),
    ]);
    if (limit <= 0 || (filters.tags.size === 0 && seeds.length === 0)) return [];
    return this._harvestArtists(await this._buildFocusArtistPool(seeds, limit, filters), limit, {
      filters,
      excludeArtistKeys,
      blockedTags,
      pick: (_artist, name) => this._pickTrack(name, filters, deepDive),
    });
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
      .filter((entry) => entry !== null)
      .sort((left, right) => left.rank - right.rank);
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
    releaseYear = null,
  }: {
    artistName: string;
    albumTitle: string;
    albumMbid?: string | null;
    releaseYear?: string | null;
  }): Promise<TrackPick | null> {
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

    if (!pick) {
      try {
        const data = await this._getLastfmAlbumInfo(normalizedArtist, normalizedAlbum);
        pick = this._pickTopAlbumTrackInfo(data?.album?.tracks?.track)[0] || null;
      } catch {}
    }

    if (!pick) {
      try {
        const trackList = await this._getArtistTopTrackList(normalizedArtist);
        const albumKey = this._releaseTitleKey(normalizedAlbum);
        const albumMatch = trackList.find(
          (entry) => entry.albumName && this._releaseTitleKey(entry.albumName) === albumKey,
        );
        pick = albumMatch ? this._pickTopAlbumTrackInfo([albumMatch])[0] || null : null;
      } catch {}
    }

    if (!pick) return null;
    return {
      trackName: pick.trackName,
      albumName: normalizedAlbum,
      albumMbid,
      trackMbid: pick.trackMbid,
      durationMs: pick.durationMs,
      releaseMbid: pick.releaseMbid,
      trackNumber: pick.trackNumber,
      discNumber: pick.discNumber,
      releaseYear,
    };
  }

  async getNewReleaseTracks(limit: number, context: Partial<SourceContext> = {}) {
    const { filters, excludeArtistKeys } = { ...DEFAULT_CONTEXT, ...context };
    if (limit <= 0) return [];
    const { getRecentMissingReleases } = await import("../discovery/recentReleases.ts");
    const albums = await getRecentMissingReleases(
      this._isFiltered(filters) ? FILTERED_ARTIST_LIMIT : limit,
      { includeFuture: false },
    );
    const albumByArtist = new Map<string, (typeof albums)[number]>();
    for (const album of albums) {
      if (!albumByArtist.has(album.artistName)) albumByArtist.set(album.artistName, album);
    }
    return this._harvestArtists(
      [...albumByArtist.values()].map((album) => ({
        name: album.artistName,
        artistMbid: album.artistMbid || album.foreignArtistId || null,
        reason: "New release",
      })),
      limit,
      {
        filters,
        excludeArtistKeys,
        pick: async (_artist, name) => {
          const album = albumByArtist.get(name);
          if (!album) return null;
          const releaseYear = String(album.releaseDate || "").slice(0, 4) || null;
          if (!this._matchesYearRange(releaseYear, filters.yearFrom, filters.yearTo)) return null;
          return this._pickTrackFromRelease({
            artistName: album.artistName,
            albumTitle: album.albumName,
            albumMbid: album.mbid || album.foreignAlbumId || null,
            releaseYear,
          });
        },
      },
    );
  }
}

export type FlowRunPlan = Awaited<ReturnType<FlowTrackSource["buildFlowRunPlan"]>>;

export const flowTrackSource = new FlowTrackSource();
