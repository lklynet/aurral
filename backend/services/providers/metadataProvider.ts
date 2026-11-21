import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { isRecord } from "../../../lib/isRecord.ts";
import { UUID_REGEX } from "../../../lib/uuid.ts";
import { http, isTransientNetworkError } from "../../../lib/http.ts";
import { asAppError } from "../../../lib/errors.ts";
import createCache from "../apiClients/simpleCache.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { APP_NAME, APP_VERSION, DEFAULT_METADATA_BASE_URL } from "../../config/constants.ts";
import {
  getNormalizedText,
  rankAlbumCandidates,
  scoreTextMatch,
  selectAlbumRelease,
} from "./metadataRanking.ts";
import {
  albumSchema,
  artistDetailSchema,
  genreSchema,
  genresIndexSchema,
  searchAlbumSchema,
  searchArtistSchema,
  toNormalizedAlbum,
  toNormalizedArtist,
  toNormalizedGenre,
  toNormalizedSearchArtist,
  type MetadataImage,
  type NormalizedAlbum,
  type NormalizedArtist,
  type NormalizedArtistAlbum,
  type NormalizedRelease,
} from "./metadataMappers.ts";
import { selectAlbumCover } from "../imageRanking.ts";
import {
  coreAlbumTitle,
  isSilenceTrack,
  withoutFeaturedArtists,
} from "../trackMatching/titleText.ts";
import {
  artistCreditSchema,
  musicbrainzGet,
  releaseGroupSchema,
} from "../apiClients/musicbrainzHttp.ts";
import { readMany, readOne } from "../integrationData.ts";
import { albumSearchTexts, parseSearchQuery, rankByMatch } from "../searchText.ts";
import { runSharedInflight, type InflightRequests } from "../sharedInflight.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { describeCurrentWork } from "../eventLoopWatch.ts";
import { recordMetadataCall } from "../metadataProviderBudget.ts";

type CachedMetadata<T> = { value: T; freshUntil: number; staleUntil: number };

const searchResultsSchema = v.array(v.unknown());

const releaseGroupSearchSchema = v.looseObject({ "release-groups": v.array(v.unknown()) });

const releaseGroupHitSchema = v.looseObject({
  ...releaseGroupSchema.entries,
  score: v.optional(v.number()),
});

const musicbrainzGenreSchema = v.looseObject({
  name: v.optional(v.string()),
  count: v.optional(v.number()),
});

const musicbrainzRelationSchema = v.looseObject({
  type: v.optional(v.string()),
  url: v.optional(v.looseObject({ resource: v.optional(v.string()) })),
});

const musicbrainzRatingSchema = v.nullish(
  v.looseObject({
    "votes-count": v.nullish(v.number()),
    value: v.nullish(v.number()),
  }),
);

const musicbrainzArtistDetailSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  "sort-name": v.optional(v.string()),
  type: v.nullish(v.string()),
  disambiguation: v.optional(v.string()),
  genres: v.optional(v.array(musicbrainzGenreSchema)),
  aliases: v.optional(v.array(v.looseObject({ name: v.optional(v.string()) }))),
  relations: v.optional(v.array(musicbrainzRelationSchema)),
  rating: musicbrainzRatingSchema,
  "release-groups": v.optional(v.array(releaseGroupSchema)),
});

const musicbrainzReleaseGroupDetailSchema = v.looseObject({
  ...releaseGroupSchema.entries,
  disambiguation: v.optional(v.string()),
  genres: v.optional(v.array(musicbrainzGenreSchema)),
  relations: v.optional(v.array(musicbrainzRelationSchema)),
  rating: musicbrainzRatingSchema,
});

const musicbrainzTrackSchema = v.looseObject({
  id: v.optional(v.string()),
  title: v.optional(v.string()),
  position: v.optional(v.number()),
  length: v.nullish(v.number()),
  "artist-credit": artistCreditSchema,
  recording: v.optional(
    v.looseObject({
      id: v.optional(v.string()),
      title: v.optional(v.string()),
      length: v.nullish(v.number()),
      "artist-credit": artistCreditSchema,
    }),
  ),
});

const musicbrainzReleaseSchema = v.looseObject({
  id: v.string(),
  title: v.optional(v.string()),
  status: v.nullish(v.string()),
  date: v.optional(v.string()),
  country: v.nullish(v.string()),
  "label-info": v.optional(
    v.array(v.looseObject({ label: v.nullish(v.looseObject({ name: v.optional(v.string()) })) })),
  ),
  media: v.optional(
    v.array(
      v.looseObject({
        position: v.optional(v.number()),
        title: v.nullish(v.string()),
        format: v.nullish(v.string()),
        "track-count": v.optional(v.number()),
        tracks: v.optional(v.array(musicbrainzTrackSchema)),
      }),
    ),
  ),
});

const musicbrainzReleaseBrowseSchema = v.looseObject({
  releases: v.array(v.unknown()),
});

interface AlbumSearchItem {
  id?: string;
  title: string;
  artistName: string;
  artistId: string | null;
  type: string;
  secondaryTypes: string[];
  releaseDate: string | null;
  coverUrl: string | null;
  images: MetadataImage[];
  inLibrary: boolean;
  score: number;
  releaseStatuses: string[];
}

interface MetadataRequestOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  withFallbackReleases?: boolean;
}

type MetadataParams = Record<string, string | number>;

interface MetadataError extends Error {
  code?: string;
  retryAfterMs?: number;
  response?: { status?: number; headers?: Record<string, string> };
}

const METADATA_ENTITY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INCOMPLETE_ALBUM_CACHE_TTL_SECONDS = 60 * 60;
const METADATA_ENTITY_STALE_TTL_SECONDS = 30 * 24 * 60 * 60;
const METADATA_SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_NOT_FOUND_CACHE_TTL_SECONDS = 24 * 60 * 60;
const METADATA_CACHE_MAX_ENTRIES = 20_000;
const METADATA_HOT_CACHE_TTL_SECONDS = 60;
const METADATA_HOT_CACHE_MAX_ENTRIES = 50;
const METADATA_STORE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MUSICBRAINZ_FALLBACK_ENTITY_TTL_SECONDS = 60 * 60;
const MUSICBRAINZ_FALLBACK_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MUSICBRAINZ_FALLBACK_RETRY_SECONDS = 5 * 60;
const MIN_ALBUM_SEARCH_WINDOW = 25;
const METADATA_REQUEST_TIMEOUT_MS = 8000;
const METADATA_RESPONSE_BODY_TIMEOUT_MS = 90_000;
const metadataHotCache = createCache<CachedMetadata<unknown>>(
  METADATA_HOT_CACHE_TTL_SECONDS,
  METADATA_HOT_CACHE_MAX_ENTRIES,
);
let nextMetadataStoreCleanupAt = 0;
const metadataNotFoundCache = createCache<true>(
  METADATA_NOT_FOUND_CACHE_TTL_SECONDS,
  METADATA_CACHE_MAX_ENTRIES,
);
const musicbrainzArtistFallbackCache = createCache<NormalizedArtist | null>(
  MUSICBRAINZ_FALLBACK_ENTITY_TTL_SECONDS,
  500,
);
const musicbrainzAlbumFallbackCache = createCache<NormalizedAlbum | null>(
  MUSICBRAINZ_FALLBACK_ENTITY_TTL_SECONDS,
  500,
);
const musicbrainzAlbumReleasesCache = createCache<NormalizedRelease[]>(
  MUSICBRAINZ_FALLBACK_CACHE_TTL_SECONDS,
  500,
);
const providerInflightRequests: InflightRequests = new Map();
const METADATA_MAX_RETRIES = 1;

export function clearMetadataProviderCaches() {
  metadataHotCache.flushAll();
  dbOps.clearMetadataResponses();
  metadataNotFoundCache.flushAll();
  musicbrainzArtistFallbackCache.flushAll();
  musicbrainzAlbumFallbackCache.flushAll();
  musicbrainzAlbumReleasesCache.flushAll();
  providerInflightRequests.clear();
}

const healthState: {
  configuredProvider: string;
  activeBaseUrl: string | null;
  failoverActive: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string;
} = {
  configuredProvider: "aurral-data",
  activeBaseUrl: null,
  failoverActive: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: "",
};

function nowIso() {
  return new Date().toISOString();
}

function getSettingsMetadata() {
  const settings = dbOps.getSettings();
  return settings.integrations?.metadata || {};
}

export function getMetadataBaseUrl() {
  const metadata = getSettingsMetadata();
  const raw = String(
    metadata.baseUrl || process.env.METADATA_BASE_URL || DEFAULT_METADATA_BASE_URL,
  ).trim();
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_METADATA_BASE_URL;
  }
}

function getUserAgent() {
  return `${APP_NAME}/${APP_VERSION}`;
}

function isEntityMetadataPath(path: string) {
  return /^\/v1\/(?:album|artist|genre)\/[^/]+$/.test(path) || path === "/v1/genres";
}

function isAlbumMetadataPath(path: string) {
  return /^\/v1\/album\/[^/]+$/.test(path);
}

export function isMetadataNotFoundError(error: unknown) {
  const failure = asAppError(error);
  return failure?.code === "ERR_METADATA_NOT_FOUND" || failure?.response?.status === 404;
}

function createMetadataNotFoundError() {
  const error: MetadataError = new Error("Metadata resource not found");
  error.code = "ERR_METADATA_NOT_FOUND";
  error.response = { status: 404 };
  return error;
}

function endpointName(path: string) {
  if (path === "/v1/genres") return "genres";
  const match = /^\/v1\/(album|artist|genre)\/[^/]+$/.exec(path);
  if (match) return match[1]!;
  return path.replace(/^\/+/, "");
}

function countMetadataCall(baseUrl: string, path: string, status: unknown, sentAt: number) {
  try {
    recordMetadataCall(
      {
        server: new URL(baseUrl).host,
        endpoint: endpointName(path),
        work: describeCurrentWork() ?? "other",
        status: String(status),
      },
      sentAt,
    );
  } catch {}
}

const RETRYABLE_STATUSES: (number | undefined)[] = [408, 425, 429, 500, 502, 503, 504];

function isRetryable(error: unknown) {
  const failure = asAppError(error);
  return (
    isTransientNetworkError(error) ||
    failure?.code === "ETIMEDOUT" ||
    RETRYABLE_STATUSES.includes(failure?.response?.status)
  );
}

function getMetadataCachePolicy(path: string, value?: unknown) {
  if (isEntityMetadataPath(path)) {
    return {
      freshTtlSeconds:
        isAlbumMetadataPath(path) &&
        isRecord(value) &&
        (!Array.isArray(value.releases) || value.releases.length === 0)
          ? INCOMPLETE_ALBUM_CACHE_TTL_SECONDS
          : METADATA_ENTITY_CACHE_TTL_SECONDS,
      staleTtlSeconds: METADATA_ENTITY_STALE_TTL_SECONDS,
    };
  }
  return {
    freshTtlSeconds: METADATA_SEARCH_CACHE_TTL_SECONDS,
    staleTtlSeconds: 0,
  };
}

// The SQLite cache outlives versions and is shared by every process, so what it
// holds is checked again when read back. The hot cache only ever holds checked
// values.
function readStoredMetadata<Schema extends v.GenericSchema>(
  cacheKey: string,
  schema: Schema,
  stored: { value: unknown; freshUntil: number; staleUntil: number } | null,
): CachedMetadata<v.InferOutput<Schema>> | null {
  if (!stored) return null;
  const result = v.safeParse(schema, stored.value);
  if (result.success) return { ...stored, value: result.output };
  forgetMetadata(cacheKey);
  logger.warn("metadata", "Dropped a cached metadata response Aurral can't read", {
    cacheKey,
    issue: v.summarize(result.issues),
  });
  return null;
}

const persistedMetadataReads = new Map<string, ReturnType<typeof dbOps.getMetadataResponseAsync>>();

const readPersistedEntryOnce = (cacheKey: string) => {
  const running = persistedMetadataReads.get(cacheKey);
  if (running) return running;
  const read = dbOps
    .getMetadataResponseAsync(cacheKey)
    .finally(() => persistedMetadataReads.delete(cacheKey));
  persistedMetadataReads.set(cacheKey, read);
  return read;
};

async function readCachedMetadata<Schema extends v.GenericSchema>(
  cacheKey: string,
  schema: Schema,
  { persistent = false } = {},
) {
  const readHot = () =>
    persistent
      ? null
      : // A cache key always holds output of the same schema.
        ((metadataHotCache.get(cacheKey) as CachedMetadata<v.InferOutput<Schema>> | undefined) ??
        null);
  let entry = readHot();
  if (!entry) {
    const persisted = readStoredMetadata(
      cacheKey,
      schema,
      await (persistent
        ? dbOps.getMetadataResponseAsync(cacheKey)
        : readPersistedEntryOnce(cacheKey)),
    );
    const current = readHot();
    if (!persisted) {
      if (!current) return null;
      entry = current;
    } else {
      entry = current || persisted;
      if (!current) metadataHotCache.set(cacheKey, persisted);
    }
  }
  const now = Date.now();
  if (entry.staleUntil < now) return null;
  return { value: entry.value, stale: entry.freshUntil < now };
}

async function storeMetadata(
  cacheKey: string,
  value: unknown,
  { freshTtlSeconds, staleTtlSeconds }: ReturnType<typeof getMetadataCachePolicy>,
) {
  const now = Date.now();
  const freshUntil = now + freshTtlSeconds * 1000;
  const entry = { value, freshUntil, staleUntil: freshUntil + staleTtlSeconds * 1000 };
  metadataHotCache.set(cacheKey, entry);
  try {
    await dbOps.setMetadataResponseAsync(cacheKey, entry);
    if (now >= nextMetadataStoreCleanupAt) {
      nextMetadataStoreCleanupAt = now + METADATA_STORE_CLEANUP_INTERVAL_MS;
      dbOps.cleanMetadataResponses(METADATA_CACHE_MAX_ENTRIES);
    }
  } catch (error) {
    logger.warn("metadata", "Could not store metadata response", {
      reason: safeLogDiagnostic(error),
    });
  }
}

function forgetMetadata(cacheKey: string) {
  metadataHotCache.delete(cacheKey);
  dbOps.deleteMetadataResponse(cacheKey);
}

function refreshMetadata<Schema extends v.GenericSchema>(
  schema: Schema,
  cacheKey: string,
  path: string,
  params: MetadataParams,
  {
    signal,
    fallbackValue,
    cacheNotFound = true,
  }: MetadataRequestOptions & {
    fallbackValue?: v.InferOutput<Schema>;
    cacheNotFound?: boolean;
  } = {},
): Promise<v.InferOutput<Schema>> {
  const baseUrl = getMetadataBaseUrl();
  healthState.activeBaseUrl = baseUrl;
  healthState.lastCheckedAt = nowIso();

  return runSharedInflight(
    providerInflightRequests,
    cacheKey,
    async (sharedSignal: AbortSignal) => {
      for (let attempt = 0; attempt <= METADATA_MAX_RETRIES; attempt += 1) {
        if (sharedSignal.aborted) {
          throw sharedSignal.reason || new Error("The operation was aborted");
        }
        const sentAt = Date.now();
        try {
          const response = await http
            .get(`${baseUrl}${path}`, {
              query: params,
              timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
              bodyTimeoutMs: METADATA_RESPONSE_BODY_TIMEOUT_MS,
              headers: {
                "User-Agent": getUserAgent(),
              },
              signal: sharedSignal,
            })
            .then(
              (response) => {
                countMetadataCall(baseUrl, path, response.status, sentAt);
                return response;
              },
              (error: unknown) => {
                const failure = asAppError(error);
                countMetadataCall(
                  baseUrl,
                  path,
                  failure?.response?.status ?? failure?.code ?? "error",
                  sentAt,
                );
                throw error;
              },
            );
          const value = readOne(schema, response.data, { service: "Metadata", endpoint: path });
          await storeMetadata(cacheKey, value, getMetadataCachePolicy(path, value));
          metadataNotFoundCache.delete(cacheKey);
          healthState.lastSuccessAt = healthState.lastCheckedAt;
          healthState.lastFailureReason = "";
          return value;
        } catch (error) {
          if (sharedSignal.aborted) {
            throw sharedSignal.reason || error;
          }
          const failure = asAppError(error);
          const status = failure?.response?.status;
          healthState.lastFailureAt = healthState.lastCheckedAt;
          healthState.lastFailureReason =
            status != null
              ? `HTTP ${status}`
              : String(failure?.code || failure?.message || "Unknown error");
          if (status === 404 && isEntityMetadataPath(path)) {
            forgetMetadata(cacheKey);
            if (cacheNotFound) metadataNotFoundCache.set(cacheKey, true);
          }
          if (attempt === METADATA_MAX_RETRIES || !isRetryable(error)) {
            if (fallbackValue !== undefined && isRetryable(error)) return fallbackValue;
            throw error;
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(sharedSignal.reason || new Error("The operation was aborted"));
            };
            const timer = setTimeout(() => {
              sharedSignal.removeEventListener("abort", onAbort);
              resolve();
            }, 250);
            if (sharedSignal.aborted) onAbort();
            else sharedSignal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      throw new Error("Metadata provider request failed");
    },
    { signal },
  );
}

async function request<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  params: MetadataParams = {},
  {
    signal,
    forceRefresh = false,
    keepStale,
    cacheNotFound = true,
  }: MetadataRequestOptions & {
    keepStale?: (value: v.InferOutput<Schema>) => boolean;
    cacheNotFound?: boolean;
  } = {},
): Promise<v.InferOutput<Schema>> {
  const baseUrl = getMetadataBaseUrl();
  const cacheKey = `${baseUrl}${path}:${JSON.stringify(params)}`;
  if (!forceRefresh && metadataNotFoundCache.get(cacheKey)) {
    throw createMetadataNotFoundError();
  }
  const cached = await readCachedMetadata(cacheKey, schema);
  if (cached && !forceRefresh) {
    if (cached.stale && !keepStale?.(cached.value)) {
      void refreshMetadata(schema, cacheKey, path, params, { fallbackValue: cached.value }).catch(
        () => {},
      );
    }
    return cached.value;
  }
  return refreshMetadata(schema, cacheKey, path, params, {
    signal,
    cacheNotFound,
    ...(cached && { fallbackValue: cached.value }),
  });
}

function applyReleaseTypeFilter<T extends { type: string; secondaryTypes?: string[] }>(
  albums: T[],
  releaseTypes: string[] | string = [],
): T[] {
  const normalizedSet = new Set(
    (Array.isArray(releaseTypes)
      ? releaseTypes
      : String(releaseTypes || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
    ).map((value) => String(value)),
  );
  if (normalizedSet.size === 0) return albums;
  return albums.filter((album) => {
    if (normalizedSet.has(album.type)) return true;
    return (album.secondaryTypes || []).some((entry) => normalizedSet.has(entry));
  });
}

function toMusicbrainzGenres(genres: v.InferOutput<typeof musicbrainzGenreSchema>[] | undefined) {
  return [...(genres ?? [])]
    .sort((left, right) => (right.count ?? 0) - (left.count ?? 0))
    .map((genre) => String(genre.name || "").trim())
    .filter(Boolean);
}

function toMusicbrainzLinks(
  relations: v.InferOutput<typeof musicbrainzRelationSchema>[] | undefined,
) {
  return (relations ?? []).flatMap((relation) => {
    const target = String(relation.url?.resource || "").trim();
    return target ? [{ type: String(relation.type || "").trim() || "external", target }] : [];
  });
}

function toMusicbrainzRating(rating: v.InferOutput<typeof musicbrainzRatingSchema>) {
  return rating?.value != null
    ? { count: rating["votes-count"] ?? 0, value: Math.round(rating.value * 20) / 10 }
    : null;
}

function toMusicbrainzArtist(
  raw: v.InferOutput<typeof musicbrainzArtistDetailSchema>,
): NormalizedArtist {
  const name = String(raw.name || "").trim();
  return {
    id: raw.id,
    name,
    sortName: String(raw["sort-name"] || "").trim() || name,
    type: String(raw.type || "").trim() || null,
    status: null,
    disambiguation: String(raw.disambiguation || "").trim(),
    overview: "",
    genres: toMusicbrainzGenres(raw.genres),
    aliases: [
      ...new Set(
        (raw.aliases ?? []).map((alias) => String(alias.name || "").trim()).filter(Boolean),
      ),
    ],
    images: [],
    links: toMusicbrainzLinks(raw.relations),
    rating: toMusicbrainzRating(raw.rating),
    listeners: 0,
    albums: (raw["release-groups"] ?? []).map((rg): NormalizedArtistAlbum => ({
      id: rg.id,
      title: String(rg.title || "").trim(),
      type: String(rg["primary-type"] || "").trim() || "Album",
      secondaryTypes: (rg["secondary-types"] ?? []).map((entry) => entry.trim()).filter(Boolean),
      releaseStatuses: [],
      firstReleaseDate: String(rg["first-release-date"] || "").trim() || null,
      rating: null,
      cover: null,
      trackCount: null,
      listeners: 0,
    })),
    appearsOn: [],
    topTracks: [],
    similar: [],
  };
}

async function getMusicbrainzArtistFallback(
  mbid: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  const cached = musicbrainzArtistFallbackCache.get(mbid);
  if (cached !== undefined) return cached;
  try {
    const artist = await runSharedInflight(
      providerInflightRequests,
      `musicbrainz:artist:${mbid}`,
      async (sharedSignal: AbortSignal) => {
        const raw = await musicbrainzGet(
          musicbrainzArtistDetailSchema,
          `/artist/${mbid}`,
          { inc: "aliases+genres+url-rels+ratings+release-groups" },
          { signal: sharedSignal },
        );
        return toMusicbrainzArtist(raw);
      },
      { signal },
    );
    musicbrainzArtistFallbackCache.set(mbid, artist);
    return artist;
  } catch (error) {
    signal?.throwIfAborted();
    if (asAppError(error)?.response?.status === 404) {
      musicbrainzArtistFallbackCache.set(mbid, null, METADATA_NOT_FOUND_CACHE_TTL_SECONDS);
      return null;
    }
    logger.info("metadata", "MusicBrainz could not fill a missing artist", {
      mbid,
      reason: safeLogDiagnostic(error),
    });
    musicbrainzArtistFallbackCache.set(mbid, null, MUSICBRAINZ_FALLBACK_RETRY_SECONDS);
    return null;
  }
}

export async function getArtistByMbid(
  mbid: string,
  { signal, forceRefresh = false }: MetadataRequestOptions = {},
) {
  const cacheKey = `${getMetadataBaseUrl()}/v1/artist/${mbid}:{}`;
  try {
    const data = await request(
      artistDetailSchema,
      `/v1/artist/${mbid}`,
      {},
      { signal, forceRefresh, cacheNotFound: !UUID_REGEX.test(mbid) },
    );
    return toNormalizedArtist(data);
  } catch (error) {
    if (!isMetadataNotFoundError(error) || !UUID_REGEX.test(mbid)) throw error;
    const fallback = await getMusicbrainzArtistFallback(mbid, { signal });
    if (fallback) return fallback;
    if (musicbrainzArtistFallbackCache.get(mbid) === null) {
      metadataNotFoundCache.set(cacheKey, true, MUSICBRAINZ_FALLBACK_RETRY_SECONDS);
    }
    throw error;
  }
}

export async function getCachedArtistByMbid(mbid: string) {
  const cached = await readCachedMetadata(
    `${getMetadataBaseUrl()}/v1/artist/${mbid}:{}`,
    artistDetailSchema,
  );
  if (cached) return toNormalizedArtist(cached.value);
  return musicbrainzArtistFallbackCache.get(mbid) ?? null;
}

function toNormalizedMusicbrainzRelease(raw: v.InferOutput<typeof musicbrainzReleaseSchema>) {
  const media = raw.media ?? [];
  return {
    id: raw.id,
    title: String(raw.title || "").trim(),
    status: String(raw.status || "").trim() || null,
    country: raw.country ? [raw.country] : [],
    label: [
      ...new Set(
        (raw["label-info"] ?? [])
          .map((entry) => String(entry.label?.name || "").trim())
          .filter(Boolean),
      ),
    ],
    media: media.map((medium, index) => ({
      format: String(medium.format || "").trim(),
      name: String(medium.title || "").trim(),
      position: medium.position ?? index + 1,
    })),
    trackCount: media.reduce(
      (count, medium) => count + (medium.tracks?.length ?? medium["track-count"] ?? 0),
      0,
    ),
    tracks: media.flatMap((medium, mediumIndex) =>
      (medium.tracks ?? []).map((track, trackIndex) => {
        const credit = track["artist-credit"] ?? track.recording?.["artist-credit"];
        return {
          id: String(track.id || "").trim(),
          recordingId: String(track.recording?.id || "").trim(),
          oldRecordingIds: [],
          title: String(track.title || track.recording?.title || "").trim(),
          trackNumber: track.position ?? trackIndex + 1,
          trackPosition: track.position ?? trackIndex + 1,
          mediumNumber: medium.position ?? mediumIndex + 1,
          durationMs: track.length ?? track.recording?.length ?? null,
          artistId: credit?.[0]?.artist?.id || null,
          credits: (credit ?? []).flatMap((entry) => {
            const name = String(entry.name || entry.artist?.name || "").trim();
            return name
              ? [{ name, mbid: entry.artist?.id || null, joinPhrase: entry.joinphrase ?? "" }]
              : [];
          }),
        };
      }),
    ),
    releaseDate: String(raw.date || "").trim() || null,
    disambiguation: "",
  } satisfies NormalizedRelease;
}

async function getMusicbrainzAlbumReleases(
  albumMbid: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  const cached = musicbrainzAlbumReleasesCache.get(albumMbid);
  if (cached !== undefined) return cached;
  try {
    const releases = await runSharedInflight(
      providerInflightRequests,
      `musicbrainz:album-releases:${albumMbid}`,
      async (sharedSignal: AbortSignal) => {
        const data = await musicbrainzGet(
          musicbrainzReleaseBrowseSchema,
          "/release",
          {
            "release-group": albumMbid,
            inc: "recordings+artist-credits+labels",
            limit: 100,
          },
          { signal: sharedSignal },
        );
        return readMany(musicbrainzReleaseSchema, data.releases, {
          service: "MusicBrainz",
          endpoint: "/release",
        }).map(toNormalizedMusicbrainzRelease);
      },
      { signal },
    );
    musicbrainzAlbumReleasesCache.set(albumMbid, releases);
    return releases;
  } catch (error) {
    signal?.throwIfAborted();
    logger.info("metadata", "MusicBrainz could not fill an incomplete album", {
      albumMbid,
      reason: safeLogDiagnostic(error),
    });
    musicbrainzAlbumReleasesCache.set(albumMbid, [], MUSICBRAINZ_FALLBACK_RETRY_SECONDS);
    return [];
  }
}

async function getMusicbrainzAlbumFallback(
  albumMbid: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  const cached = musicbrainzAlbumFallbackCache.get(albumMbid);
  if (cached !== undefined) return cached;
  try {
    const album = await runSharedInflight(
      providerInflightRequests,
      `musicbrainz:album:${albumMbid}`,
      async (sharedSignal: AbortSignal) => {
        const raw = await musicbrainzGet(
          musicbrainzReleaseGroupDetailSchema,
          `/release-group/${albumMbid}`,
          { inc: "artists+genres+url-rels+ratings" },
          { signal: sharedSignal },
        );
        const artists: NormalizedArtist[] = (raw["artist-credit"] ?? []).flatMap((credit) => {
          const id = String(credit.artist?.id || "").trim();
          const name = String(credit.artist?.name || credit.name || "").trim();
          if (!id || !name) return [];
          return [
            toNormalizedArtist({
              id,
              name,
              sortName: name,
            }),
          ];
        });
        return {
          id: raw.id,
          title: String(raw.title || "").trim(),
          artistId: artists[0]?.id || null,
          artists,
          type: String(raw["primary-type"] || "").trim() || "Album",
          secondaryTypes: (raw["secondary-types"] ?? [])
            .map((entry) => entry.trim())
            .filter(Boolean),
          releaseDate: String(raw["first-release-date"] || "").trim() || null,
          disambiguation: String(raw.disambiguation || "").trim(),
          genres: toMusicbrainzGenres(raw.genres),
          aliases: [],
          overview: "",
          images: [],
          cover: null,
          links: toMusicbrainzLinks(raw.relations),
          releases: [],
          rating: toMusicbrainzRating(raw.rating),
          listeners: 0,
        } satisfies NormalizedAlbum;
      },
      { signal },
    );
    musicbrainzAlbumFallbackCache.set(albumMbid, album);
    return album;
  } catch (error) {
    signal?.throwIfAborted();
    if (asAppError(error)?.response?.status === 404) {
      musicbrainzAlbumFallbackCache.set(albumMbid, null, METADATA_NOT_FOUND_CACHE_TTL_SECONDS);
      return null;
    }
    logger.info("metadata", "MusicBrainz could not fill a missing album", {
      albumMbid,
      reason: safeLogDiagnostic(error),
    });
    musicbrainzAlbumFallbackCache.set(albumMbid, null, MUSICBRAINZ_FALLBACK_RETRY_SECONDS);
    return null;
  }
}

export async function getAlbumByMbid(
  albumMbid: string,
  { signal, forceRefresh = false, withFallbackReleases = false }: MetadataRequestOptions = {},
) {
  const cacheKey = `${getMetadataBaseUrl()}/v1/album/${albumMbid}:{}`;
  let album: NormalizedAlbum;
  try {
    const data = await request(
      albumSchema,
      `/v1/album/${albumMbid}`,
      {},
      { signal, forceRefresh, cacheNotFound: !UUID_REGEX.test(albumMbid) },
    );
    album = toNormalizedAlbum(data);
  } catch (error) {
    if (!isMetadataNotFoundError(error) || !UUID_REGEX.test(albumMbid)) throw error;
    const fallback = await getMusicbrainzAlbumFallback(albumMbid, { signal });
    if (!fallback) {
      if (musicbrainzAlbumFallbackCache.get(albumMbid) === null) {
        metadataNotFoundCache.set(cacheKey, true, MUSICBRAINZ_FALLBACK_RETRY_SECONDS);
      }
      throw error;
    }
    album = fallback;
  }
  if (!withFallbackReleases || album.releases.length > 0 || !UUID_REGEX.test(albumMbid))
    return album;
  const releases = await getMusicbrainzAlbumReleases(albumMbid, { signal });
  return releases.length ? { ...album, releases } : album;
}

export async function getCachedAlbumByMbid(albumMbid: string) {
  const cached = await readCachedMetadata(
    `${getMetadataBaseUrl()}/v1/album/${albumMbid}:{}`,
    albumSchema,
  );
  if (cached) return toNormalizedAlbum(cached.value);
  return musicbrainzAlbumFallbackCache.get(albumMbid) ?? null;
}

export async function getGenreBySlug(slug: string, { signal }: MetadataRequestOptions = {}) {
  const normalized = String(slug || "").trim();
  if (!normalized) return null;
  try {
    const data = await request(
      genreSchema,
      `/v1/genre/${encodeURIComponent(normalized)}`,
      {},
      { signal },
    );
    return toNormalizedGenre(data);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMetadataNotFoundError(error)) return null;
    throw error;
  }
}

export async function getGenresIndex({ signal }: MetadataRequestOptions = {}) {
  const data = await request(genresIndexSchema, "/v1/genres", {}, { signal });
  return (data.genres ?? []).map((genre) => ({
    key: genre.key,
    name: String(genre.name || "").trim() || genre.key,
    artists: genre.artists ?? 0,
  }));
}

export async function getAlbumTracksByAlbumMbid(
  albumMbid: string,
  {
    chooseRelease = selectAlbumRelease,
  }: { chooseRelease?: (album: NormalizedAlbum) => NormalizedRelease | null | undefined } = {},
) {
  const album = await getAlbumByMbid(albumMbid, { withFallbackReleases: true });
  const release = chooseRelease(album);
  if (!Array.isArray(release?.tracks)) return [];
  const discNames = new Map(release.media.map((medium) => [medium.position, medium.name]));
  const artistsById = new Map(album.artists.map((artist) => [artist.id, artist]));
  return release.tracks
    .filter((track) => !isSilenceTrack(track.title))
    .map((track) => {
      const creditArtist =
        !track.credits?.length && track.artistId ? artistsById.get(track.artistId) : null;
      const credits = track.credits?.length
        ? track.credits
        : creditArtist
          ? [{ name: creditArtist.name, mbid: creditArtist.id, joinPhrase: "" }]
          : undefined;
      return {
        ...track,
        ...(credits && { credits }),
        releaseMbid: release.id || null,
        discTitle: discNames.get(track.mediumNumber || 1) || null,
      };
    });
}

export async function searchArtists(
  query: string,
  {
    limit = 24,
    offset = 0,
    signal,
    throwOnFailure = false,
  }: { limit?: number; offset?: number; signal?: AbortSignal; throwOnFailure?: boolean } = {},
) {
  let items: NormalizedArtist[] = [];
  try {
    const data = await request(searchResultsSchema, "/search/artist", { query, limit }, { signal });
    items = readMany(searchArtistSchema, data, {
      service: "Metadata",
      endpoint: "/search/artist",
    }).map(toNormalizedSearchArtist);
  } catch (error) {
    signal?.throwIfAborted();
    if (throwOnFailure) throw error;
  }
  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

export async function searchAlbums(
  query: string,
  {
    artistName = "",
    limit = 24,
    offset = 0,
    releaseTypes = [],
    sort = "relevance",
    signal,
    throwOnFailure = false,
    musicbrainzFallback = true,
  }: {
    artistName?: string;
    limit?: number;
    offset?: number;
    releaseTypes?: string[] | string;
    sort?: string;
    signal?: AbortSignal;
    throwOnFailure?: boolean;
    musicbrainzFallback?: boolean;
  } = {},
) {
  // Relevance ranking reorders what the provider returns, so a short list
  // still looks at enough results to find the album. One more than the page
  // shows whether another page exists.
  const requestedLimit = Math.max(limit + offset + 1, MIN_ALBUM_SEARCH_WINDOW);
  let items: AlbumSearchItem[] = [];
  let failure: unknown = null;

  try {
    const data = await request(
      searchResultsSchema,
      "/search/album",
      {
        query,
        limit: requestedLimit,
        ...(artistName && { artist: artistName }),
      },
      { signal },
    );
    const albums = readMany(searchAlbumSchema, data, {
      service: "Metadata",
      endpoint: "/search/album",
    });
    items = albums.map((entry, index) => {
      const artists = entry.artists ?? [];
      const artistId = entry.artistId ?? entry.artistid ?? null;
      const credited = artists.find((artist) => artist.id === artistId) || artists[0];
      const primaryArtist = credited ? toNormalizedSearchArtist(credited) : null;
      const images: MetadataImage[] = (entry.images ?? []).flatMap((image) => {
        const url = String(image.url ?? image.Url ?? "").trim();
        return url
          ? [{ kind: String(image.kind ?? image.CoverType ?? "").trim() || "Cover", url }]
          : [];
      });
      const coverImage = selectAlbumCover(images);
      const coverUrl = String(entry.cover || coverImage?.url || "").trim() || null;
      return {
        id: entry.id,
        title: entry.title || "Untitled Release",
        artistName: primaryArtist?.name || artistName || "Unknown Artist",
        artistId: artistId || primaryArtist?.id || null,
        type: entry.type || "Album",
        secondaryTypes: entry.secondaryTypes ?? entry.secondarytypes ?? [],
        releaseDate: entry.releaseDate || entry.releasedate || null,
        coverUrl,
        images,
        inLibrary: false,
        score: Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  } catch (error) {
    signal?.throwIfAborted();
    failure = error;
  }

  if (items.length === 0 && musicbrainzFallback) {
    failure = null;
    const escapeLucenePhrase = (value: string) =>
      String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    const mbQuery = artistName
      ? `artist:"${escapeLucenePhrase(artistName)}" AND releasegroup:"${escapeLucenePhrase(query)}"`
      : String(query || "").trim();
    const data = await musicbrainzGet(
      releaseGroupSearchSchema,
      "/release-group",
      { query: mbQuery, limit: requestedLimit },
      { signal },
    ).catch((error) => {
      signal?.throwIfAborted();
      failure = error;
      return null;
    });
    const hits = data
      ? readMany(releaseGroupHitSchema, data["release-groups"], {
          service: "MusicBrainz",
          endpoint: "/release-group",
        })
      : [];
    items = hits.map((entry, index) => {
      const primaryCredit = entry["artist-credit"]?.[0];
      return {
        id: entry.id,
        title: entry.title || "Untitled Release",
        artistName:
          primaryCredit?.name || primaryCredit?.artist?.name || artistName || "Unknown Artist",
        artistId: primaryCredit?.artist?.id || null,
        type: entry["primary-type"] || "Album",
        secondaryTypes: entry["secondary-types"] ?? [],
        releaseDate: entry["first-release-date"] || null,
        coverUrl: null,
        images: [],
        inLibrary: false,
        score: entry.score || Math.max(0, 100 - index),
        releaseStatuses: [],
      };
    });
  }

  if (failure && throwOnFailure) throw failure;
  items = applyReleaseTypeFilter(items, releaseTypes);

  if (sort === "match") {
    items = rankAlbumCandidates(query, items, { artistName });
  } else if (sort === "relevance") {
    const studioFirst = items.toSorted(
      (left, right) =>
        Number(left.secondaryTypes.length > 0) - Number(right.secondaryTypes.length > 0),
    );
    items = rankByMatch(parseSearchQuery(query), studioFirst, albumSearchTexts);
  } else if (sort === "artistAsc") {
    items.sort(
      (left, right) =>
        String(left.artistName || "").localeCompare(String(right.artistName || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  } else if (sort === "titleAsc") {
    items.sort(
      (left, right) =>
        String(left.title || "").localeCompare(String(right.title || "")) ||
        String(left.artistName || "").localeCompare(String(right.artistName || "")),
    );
  } else if (sort === "dateDesc") {
    items.sort(
      (left, right) =>
        String(right.releaseDate || "").localeCompare(String(left.releaseDate || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")),
    );
  }

  return {
    query,
    count: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  };
}

type ArtistLike = { id?: string | null; name?: string; aliases?: string[] } | null | undefined;

function artistNameForms(name: unknown) {
  const value = String(name || "")
    .trim()
    .replace(/&/g, " and ");
  const parts = value.split(",").map((part) => part.trim());
  const variants =
    parts.length === 2 && parts.every(Boolean) ? [value, `${parts[1]} ${parts[0]}`] : [value];
  return variants
    .map((variant) => getNormalizedText(variant).replace(/^the /, "") || variant.toLowerCase())
    .filter(Boolean);
}

export const hasArtistName = (name: unknown, artist: ArtistLike) => {
  const forms = new Set(artistNameForms(name));
  return [artist?.name, ...(artist?.aliases || [])].some((candidate) =>
    artistNameForms(candidate).some((form) => forms.has(form)),
  );
};

// An artist is the one a credit names when the credit, or its lead artist as
// in "Koyo feat. DRAIN", is the artist's name or one of its aliases.
export function isCreditedArtist(credit: string | null | undefined, artist: ArtistLike) {
  return hasArtistName(credit, artist) || hasArtistName(withoutFeaturedArtists(credit), artist);
}

// A search the provider could not answer throws, so a caller can tell an
// outage from an album MusicBrainz does not have. A match has the title and
// credits the artist by ID or by name. The search without the artist finds an
// artist written another way, such as in another script, and also other
// artists' albums with the same title. A title that names an edition, such as
// "Nevermind (Remastered)", also matches the album without it. `holds` checks
// a match further, such as that it lists the song being downloaded.
export async function resolveAlbumByArtistAndTitle({
  artistName = "",
  artistMbid = "",
  albumTitle = "",
  releaseYear = null,
  holds = null,
}: {
  artistName?: string;
  artistMbid?: string;
  albumTitle?: string;
  releaseYear?: string | number | null;
  holds?: ((albumId: string) => boolean | Promise<boolean>) | null;
}) {
  const albumOrNone = (mbid: string) =>
    getAlbumByMbid(mbid).catch((error) => {
      if (isMetadataNotFoundError(error)) return null;
      throw error;
    });
  const byArtist = (album: NormalizedAlbum | null) =>
    [{ id: album?.artistId }, ...(album?.artists || [])].some(
      (artist) => (artistMbid && artist.id === artistMbid) || isCreditedArtist(artistName, artist),
    );
  const core = coreAlbumTitle(albumTitle);
  const titled = (title: string) =>
    scoreTextMatch(title, albumTitle) >= 85 || scoreTextMatch(coreAlbumTitle(title), core) >= 85;
  const tried = new Set();
  for (const searchTitle of new Set([albumTitle, core])) {
    for (const searchArtist of new Set([artistName, ""])) {
      const result = await searchAlbums(searchTitle, {
        artistName: searchArtist,
        limit: 10,
        offset: 0,
        sort: "match",
        throwOnFailure: true,
      });
      const ranked = rankAlbumCandidates(albumTitle, result.items, { artistName, releaseYear });
      for (const candidate of ranked) {
        if (!candidate?.id || tried.has(candidate.id) || !titled(candidate.title)) continue;
        tried.add(candidate.id);
        if ((artistName || artistMbid) && !byArtist(await albumOrNone(candidate.id))) continue;
        if (!holds || (await holds(candidate.id))) return candidate.id;
      }
    }
  }
  return null;
}

export async function listArtistAlbums(
  artistMbid: string,
  {
    releaseTypes = [],
    only,
    signal,
    forceRefresh = false,
  }: {
    releaseTypes?: string[] | string;
    only?: (album: NormalizedArtistAlbum) => boolean;
    signal?: AbortSignal;
    forceRefresh?: boolean;
  } = {},
) {
  const artist = await getArtistByMbid(artistMbid, { signal, forceRefresh });
  let albums = applyReleaseTypeFilter(artist.albums, releaseTypes);
  if (only) albums = albums.filter(only);
  albums = [...albums].sort((left, right) => {
    const leftBootleg = (left.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    const rightBootleg = (right.releaseStatuses || []).includes("Bootleg") ? 1 : 0;
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;
    const typeOrder = { Album: 0, EP: 1, Single: 2 };
    const leftType = (isOwnKey(typeOrder, left.type) ? typeOrder[left.type] : undefined) ?? 9;
    const rightType = (isOwnKey(typeOrder, right.type) ? typeOrder[right.type] : undefined) ?? 9;
    if (leftType !== rightType) return leftType - rightType;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });

  return albums.map((album) => ({
    ...album,
    artistName: artist.name,
    artistId: artist.id,
  }));
}

export async function getArtistNameByMbid(
  artistMbid: string,
  { signal }: MetadataRequestOptions = {},
) {
  const artist = await getArtistByMbid(artistMbid, { signal });
  return artist.name || null;
}

export function getMetadataProviderHealthSnapshot() {
  return {
    metadata: {
      configuredProvider: healthState.configuredProvider,
      activeBaseUrl: getMetadataBaseUrl(),
      failoverActive: healthState.failoverActive,
      lastCheckedAt: healthState.lastCheckedAt,
      lastSuccessAt: healthState.lastSuccessAt,
      lastFailureAt: healthState.lastFailureAt,
      lastFailureReason: healthState.lastFailureReason,
    },
  };
}
