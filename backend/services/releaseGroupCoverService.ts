import { dbOps } from "../db/helpers/index.ts";
import { buildStableImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.ts";
import {
  getDeezerArtist,
  getDeezerArtistById,
  resolveDeezerAlbumForPreview,
} from "./apiClients/deezer.ts";
import { getAlbumByMbid, resolveAlbumByArtistAndTitle } from "./providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "./providers/brainzmashMappers.ts";
import type { NormalizedAlbum } from "./providers/brainzmashMappers.ts";

export const LEGACY_COVER_HOST_PATTERN = /https?:\/\/(?:archive\.org|[\w-]+\.ca\.archive\.org)\//i;

type DeezerArtistId = Parameters<typeof getDeezerArtistById>[0];
type CoverWriteOptions = { persist?: boolean };
type ReleaseGroupCoverOptions = {
  artistName?: string;
  albumTitle?: string;
  bypassCache?: boolean;
};
type BatchItemInput =
  | {
      mbid?: unknown;
      id?: unknown;
      artistName?: unknown;
      albumTitle?: unknown;
    }
  | null
  | undefined;
type ReleaseGroupCoverBatchEntry = {
  image: string | null;
  notFound: boolean;
  transientError?: boolean;
};

const RG_CACHE_PREFIX = "rg:";
const releaseGroupRefreshRequests = new Map<
  string,
  ReturnType<typeof fetchReleaseGroupCoverUncached>
>();

const getImageUrl = (image: NormalizedAlbum["images"][number]) => image?.url || null;

const pickAlbumCoverUrl = (images: NormalizedAlbum["images"] = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  const ranked = images
    .map((image) => ({
      url: getImageUrl(image),
      kind: String(image?.kind || "")
        .trim()
        .toLowerCase(),
    }))
    .filter((entry) => entry.url);
  const preferred = ranked.find((entry) => ["front", "cover", "albumcover"].includes(entry.kind));
  return (preferred || ranked[0])?.url || null;
};

export { warmPublicImageUrl };

const toPublicCoverUrl = (imageUrl: string | null) => {
  if (!imageUrl || imageUrl === "NOT_FOUND") return null;
  return buildStableImageProxyUrl(imageUrl);
};

const getCachedUrl = (cacheKey: string) => {
  const cached = dbOps.getImage(cacheKey);
  if (
    cached?.imageUrl &&
    cached.imageUrl !== "NOT_FOUND" &&
    LEGACY_COVER_HOST_PATTERN.test(cached.imageUrl)
  ) {
    dbOps.deleteImage(cacheKey);
    return undefined;
  }
  if (cached?.imageUrl && cached.imageUrl !== "NOT_FOUND") {
    const imageUrl = toPublicCoverUrl(cached.imageUrl);
    if (imageUrl) return imageUrl;
    dbOps.deleteImage(cacheKey);
  }
  if (cached?.imageUrl === "NOT_FOUND") {
    return null;
  }
  return undefined;
};

const persistCover = (cacheKey: string, proxiedUrl: string) => {
  dbOps.setImage(cacheKey, proxiedUrl);
};

const acceptCoverUrl = async (
  cacheKey: string,
  imageUrl: string | null,
  { persist = true }: CoverWriteOptions = {},
) => {
  const proxiedUrl = toPublicCoverUrl(imageUrl);
  if (!proxiedUrl) return null;
  if (persist) persistCover(cacheKey, proxiedUrl);
  return {
    imageUrl: proxiedUrl,
    types: ["Front"],
    notFound: false,
    transientError: false,
  };
};

const buildReleaseGroupCoverResult = async (
  cacheKey: string,
  album: NormalizedAlbum,
  { persist = true }: CoverWriteOptions = {},
) => {
  const imageUrl = pickAlbumCoverUrl(album?.images);
  if (!imageUrl) {
    return { imageUrl: null, types: [], notFound: true, transientError: false };
  }
  return (
    (await acceptCoverUrl(cacheKey, imageUrl, { persist })) || {
      imageUrl: null,
      types: [],
      notFound: true,
      transientError: false,
    }
  );
};

const fetchDeezerAlbumCover = async (
  cacheKey: string,
  {
    artistName = "",
    deezerArtistId = null,
    albumTitle = "",
  }: { artistName?: string; deezerArtistId?: DeezerArtistId; albumTitle?: string } = {},
  { persist = true }: CoverWriteOptions = {},
) => {
  if (!albumTitle) return null;
  try {
    const album = await resolveDeezerAlbumForPreview({
      artistName,
      deezerArtistId,
      albumTitle,
    });
    if (!album?._coverUrl) return null;
    return acceptCoverUrl(cacheKey, album._coverUrl, { persist });
  } catch {
    return null;
  }
};

export const fetchDeezerArtistImageUrl = async ({
  artistName = "",
  deezerArtistId = null,
  throwOnError = false,
}: {
  artistName?: string;
  deezerArtistId?: DeezerArtistId;
  throwOnError?: boolean;
} = {}) => {
  try {
    const artist = deezerArtistId
      ? await getDeezerArtistById(deezerArtistId, { throwOnError })
      : artistName
        ? await getDeezerArtist(artistName, { throwOnError })
        : null;
    if (!artist?.imageUrl) return null;
    return toPublicCoverUrl(artist.imageUrl);
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
};

const fetchReleaseGroupCoverUncached = async (
  releaseGroupMbid: string,
  { artistName = "", albumTitle = "", bypassCache = false }: ReleaseGroupCoverOptions = {},
) => {
  const cacheKey = `${RG_CACHE_PREFIX}${releaseGroupMbid}`;
  const cached = bypassCache ? undefined : getCachedUrl(cacheKey);
  if (cached !== undefined) {
    return {
      imageUrl: cached,
      notFound: cached === null,
      transientError: false,
    };
  }
  const normalizedArtistName = typeof artistName === "string" ? artistName.trim() : "";
  const normalizedAlbumTitle = typeof albumTitle === "string" ? albumTitle.trim() : "";
  let sawTransientError = false;
  let deezerArtistId = null;
  try {
    const album = await getAlbumByMbid(releaseGroupMbid);
    deezerArtistId = getLinkedDeezerArtistId(album?.artists?.[0]?.links);
    const result = await buildReleaseGroupCoverResult(cacheKey, album);
    if (result.imageUrl) {
      return result;
    }
  } catch {
    sawTransientError = true;
  }
  if (normalizedAlbumTitle) {
    try {
      const resolvedAlbumMbid = await resolveAlbumByArtistAndTitle({
        artistName: normalizedArtistName,
        albumTitle: normalizedAlbumTitle,
      });
      if (resolvedAlbumMbid && resolvedAlbumMbid !== releaseGroupMbid) {
        const resolvedAlbum = await getAlbumByMbid(resolvedAlbumMbid);
        const result = await buildReleaseGroupCoverResult(cacheKey, resolvedAlbum, {
          persist: false,
        });
        if (result.imageUrl) {
          return result;
        }
      }
    } catch {
      sawTransientError = true;
    }
  }
  const deezerCover = await fetchDeezerAlbumCover(
    cacheKey,
    {
      artistName: normalizedArtistName,
      deezerArtistId,
      albumTitle: normalizedAlbumTitle,
    },
    { persist: false },
  );
  if (deezerCover?.imageUrl) return deezerCover;
  if (sawTransientError) {
    return { imageUrl: null, types: [], notFound: false, transientError: true };
  }
  dbOps.setImage(cacheKey, "NOT_FOUND");
  return { imageUrl: null, types: [], notFound: true, transientError: false };
};

export const fetchReleaseGroupCoverUrl = async (
  releaseGroupMbid: string,
  options: ReleaseGroupCoverOptions = {},
) => {
  if (options?.bypassCache !== true) {
    return fetchReleaseGroupCoverUncached(releaseGroupMbid, options);
  }

  const refreshKey = String(releaseGroupMbid || "").trim();
  const existing = releaseGroupRefreshRequests.get(refreshKey);
  if (existing) return existing;

  const request = fetchReleaseGroupCoverUncached(releaseGroupMbid, options);
  releaseGroupRefreshRequests.set(refreshKey, request);
  request.then(
    () => {
      if (releaseGroupRefreshRequests.get(refreshKey) === request) {
        releaseGroupRefreshRequests.delete(refreshKey);
      }
    },
    () => {
      if (releaseGroupRefreshRequests.get(refreshKey) === request) {
        releaseGroupRefreshRequests.delete(refreshKey);
      }
    },
  );
  return request;
};

const normalizeBatchItem = (item: BatchItemInput) => {
  const mbid = String(item?.mbid || item?.id || "").trim();
  if (!mbid) return null;
  return {
    mbid,
    artistName: typeof item?.artistName === "string" ? item.artistName.trim() : "",
    albumTitle: typeof item?.albumTitle === "string" ? item.albumTitle.trim() : "",
  };
};

type BatchItem = NonNullable<ReturnType<typeof normalizeBatchItem>>;

export const attachCachedCoverUrls = <T extends { id?: string | null }>(
  releaseGroups: T[] = [],
  limit: number | null = null,
) => {
  if (!Array.isArray(releaseGroups) || releaseGroups.length === 0) {
    return releaseGroups;
  }
  const targets =
    typeof limit === "number" && limit > 0 ? releaseGroups.slice(0, limit) : releaseGroups;
  const targetIds = new Set(targets.map((releaseGroup) => releaseGroup?.id).filter(Boolean));
  if (targetIds.size === 0) {
    return releaseGroups;
  }
  const cachedEntries = dbOps.getImages([...targetIds].map((id) => `${RG_CACHE_PREFIX}${id}`));
  return releaseGroups.map((releaseGroup) => {
    if (!releaseGroup?.id || !targetIds.has(releaseGroup.id)) {
      return releaseGroup;
    }
    const cached = cachedEntries[`${RG_CACHE_PREFIX}${releaseGroup.id}`];
    if (!cached?.imageUrl || cached.imageUrl === "NOT_FOUND") {
      return releaseGroup;
    }
    const coverUrl = toPublicCoverUrl(cached.imageUrl);
    if (!coverUrl) {
      return releaseGroup;
    }
    return { ...releaseGroup, coverUrl };
  });
};

export const resolveReleaseGroupCoversBatch = async (
  items: BatchItemInput[] = [],
  { concurrency = 6, signal }: { concurrency?: number; signal?: AbortSignal } = {},
) => {
  const seen = new Set();
  const normalized = items
    .map(normalizeBatchItem)
    .filter((item): item is BatchItem => {
      if (!item || seen.has(item.mbid)) return false;
      seen.add(item.mbid);
      return true;
    })
    .slice(0, 24);
  const covers: Record<string, ReleaseGroupCoverBatchEntry> = {};
  if (!normalized.length) return covers;

  const cachedEntries = dbOps.getImages(normalized.map((item) => `${RG_CACHE_PREFIX}${item.mbid}`));
  const missing = [];

  for (const item of normalized) {
    const cacheKey = `${RG_CACHE_PREFIX}${item.mbid}`;
    const cached = cachedEntries[cacheKey];
    if (cached?.imageUrl && cached.imageUrl !== "NOT_FOUND") {
      const imageUrl = toPublicCoverUrl(cached.imageUrl);
      if (imageUrl) {
        covers[item.mbid] = { image: imageUrl, notFound: false };
        continue;
      }
      missing.push(item);
      continue;
    }
    if (cached?.imageUrl === "NOT_FOUND") {
      covers[item.mbid] = { image: null, notFound: true };
      continue;
    }
    missing.push(item);
  }

  const safeConcurrency = Math.min(12, Math.max(1, Number.parseInt(String(concurrency), 10) || 6));

  for (let index = 0; index < missing.length; index += safeConcurrency) {
    signal?.throwIfAborted?.();
    const batch = missing.slice(index, index + safeConcurrency);
    const results = await Promise.allSettled(
      batch.map((item) =>
        fetchReleaseGroupCoverUrl(item.mbid, {
          artistName: item.artistName,
          albumTitle: item.albumTitle,
        }),
      ),
    );
    batch.forEach((item, batchIndex) => {
      const entry = results[batchIndex];
      if (entry.status !== "fulfilled") {
        covers[item.mbid] = { image: null, notFound: false, transientError: true };
        return;
      }
      const value = entry.value;
      if (value?.imageUrl) {
        covers[item.mbid] = { image: value.imageUrl, notFound: false };
        return;
      }
      if (value?.notFound) {
        covers[item.mbid] = { image: null, notFound: true };
        return;
      }
      covers[item.mbid] = {
        image: null,
        notFound: false,
        transientError: !!value?.transientError,
      };
    });
  }

  return covers;
};
