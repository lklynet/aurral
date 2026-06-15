import { dbOps } from "../config/db-helpers.js";
import { buildImageProxyUrl, warmImageProxy } from "./imageProxyService.js";
import {
  getAlbumByMbid,
  resolveAlbumByArtistAndTitle,
} from "./metadataProvider.js";

const RG_CACHE_PREFIX = "rg:";
const LEGACY_COVER_HOST_PATTERN =
  /https?:\/\/(?:caa\.lkly\.net|coverartarchive\.org|archive\.org|[\w-]+\.ca\.archive\.org)\//i;

const getImageUrl = (image) => image?.url || image?.Url || null;

const pickAlbumCoverUrl = (images = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  const ranked = images
    .map((image) => ({
      url: getImageUrl(image),
      kind: String(image?.kind || image?.CoverType || "").trim().toLowerCase(),
    }))
    .filter((entry) => entry.url);
  const preferred = ranked.find((entry) =>
    ["front", "cover", "albumcover"].includes(entry.kind),
  );
  return (preferred || ranked[0])?.url || null;
};

const toPublicCoverUrl = (imageUrl) => {
  if (!imageUrl || imageUrl === "NOT_FOUND") return null;
  return buildImageProxyUrl(imageUrl) || imageUrl;
};

const getCachedUrl = (cacheKey) => {
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
    return cached.imageUrl;
  }
  if (cached?.imageUrl === "NOT_FOUND") {
    return null;
  }
  return undefined;
};

const warmAndPersistCover = (cacheKey, sourceUrl, proxiedUrl) => {
  warmImageProxy(sourceUrl)
    .then((cached) => {
      if (cached?.localUrl) {
        dbOps.setImage(cacheKey, cached.localUrl);
      }
    })
    .catch(() => {});
  dbOps.setImage(cacheKey, proxiedUrl);
};

const buildReleaseGroupCoverResult = (cacheKey, album) => {
  const imageUrl = pickAlbumCoverUrl(album?.images);
  if (!imageUrl) {
    return { imageUrl: null, types: [], notFound: true, transientError: false };
  }
  const proxiedUrl = toPublicCoverUrl(imageUrl);
  if (!proxiedUrl) {
    return { imageUrl: null, types: [], notFound: true, transientError: false };
  }
  warmAndPersistCover(cacheKey, imageUrl, proxiedUrl);
  return {
    imageUrl: proxiedUrl,
    types: ["Front"],
    notFound: false,
    transientError: false,
  };
};

export const fetchReleaseGroupCoverUrl = async (
  releaseGroupMbid,
  { artistName = "", albumTitle = "" } = {},
) => {
  const cacheKey = `${RG_CACHE_PREFIX}${releaseGroupMbid}`;
  const cached = getCachedUrl(cacheKey);
  if (cached !== undefined) {
    const imageUrl = cached === null ? null : toPublicCoverUrl(cached);
    return {
      imageUrl,
      notFound: cached === null,
      transientError: false,
    };
  }
  const normalizedArtistName =
    typeof artistName === "string" ? artistName.trim() : "";
  const normalizedAlbumTitle =
    typeof albumTitle === "string" ? albumTitle.trim() : "";
  let sawTransientError = false;
  try {
    const album = await getAlbumByMbid(releaseGroupMbid);
    const result = buildReleaseGroupCoverResult(cacheKey, album);
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
        const result = buildReleaseGroupCoverResult(cacheKey, resolvedAlbum);
        if (result.imageUrl) {
          return result;
        }
      }
    } catch {
      sawTransientError = true;
    }
  }
  if (sawTransientError) {
    return { imageUrl: null, types: [], notFound: false, transientError: true };
  }
  dbOps.setImage(cacheKey, "NOT_FOUND");
  return { imageUrl: null, types: [], notFound: true, transientError: false };
};

const normalizeBatchItem = (item) => {
  const mbid = String(item?.mbid || item?.id || "").trim();
  if (!mbid) return null;
  return {
    mbid,
    artistName: typeof item?.artistName === "string" ? item.artistName.trim() : "",
    albumTitle: typeof item?.albumTitle === "string" ? item.albumTitle.trim() : "",
  };
};

export const attachCachedCoverUrls = (releaseGroups = [], limit = null) => {
  if (!Array.isArray(releaseGroups) || releaseGroups.length === 0) {
    return releaseGroups;
  }
  const targets =
    typeof limit === "number" && limit > 0
      ? releaseGroups.slice(0, limit)
      : releaseGroups;
  const targetIds = new Set(
    targets.map((releaseGroup) => releaseGroup?.id).filter(Boolean),
  );
  if (targetIds.size === 0) {
    return releaseGroups;
  }
  const cachedEntries = dbOps.getImages(
    [...targetIds].map((id) => `${RG_CACHE_PREFIX}${id}`),
  );
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
  items = [],
  { concurrency = 6 } = {},
) => {
  const seen = new Set();
  const normalized = items
    .map(normalizeBatchItem)
    .filter((item) => {
      if (!item || seen.has(item.mbid)) return false;
      seen.add(item.mbid);
      return true;
    })
    .slice(0, 24);
  if (!normalized.length) {
    return {};
  }

  const covers = {};
  const cachedEntries = dbOps.getImages(
    normalized.map((item) => `${RG_CACHE_PREFIX}${item.mbid}`),
  );
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
    }
    if (cached?.imageUrl === "NOT_FOUND") {
      covers[item.mbid] = { image: null, notFound: true };
      continue;
    }
    missing.push(item);
  }

  const safeConcurrency = Math.min(
    12,
    Math.max(1, Number.parseInt(concurrency, 10) || 6),
  );

  for (let index = 0; index < missing.length; index += safeConcurrency) {
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
