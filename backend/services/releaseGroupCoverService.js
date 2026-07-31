import { dbOps } from "../db/helpers/index.js";
import {
  isImageProxyLocalUrl,
  resolveImageProxyLocalUrl,
  warmPublicImageUrl,
} from "./imageProxyService.js";
import {
  getDeezerArtist,
  getDeezerArtistById,
  resolveDeezerAlbumForPreview,
} from "./apiClients/deezer.js";
import { getAlbumByMbid, resolveAlbumByArtistAndTitle } from "./providers/brainzmashProvider.js";

export const LEGACY_COVER_HOST_PATTERN =
  /https?:\/\/(?:caa\.lkly\.net|coverartarchive\.org|archive\.org|[\w-]+\.ca\.archive\.org)\//i;

const RG_CACHE_PREFIX = "rg:";

const getImageUrl = (image) => image?.url || image?.Url || null;

const pickAlbumCoverUrl = (images = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  const ranked = images
    .map((image) => ({
      url: getImageUrl(image),
      kind: String(image?.kind || image?.CoverType || "")
        .trim()
        .toLowerCase(),
    }))
    .filter((entry) => entry.url);
  const preferred = ranked.find((entry) => ["front", "cover", "albumcover"].includes(entry.kind));
  return (preferred || ranked[0])?.url || null;
};

const coverArtArchiveFrontUrl = (releaseGroupMbid) =>
  `https://coverartarchive.org/release-group/${releaseGroupMbid}/front`;

export { warmPublicImageUrl };

const toPublicCoverUrl = (imageUrl) => {
  if (!imageUrl || imageUrl === "NOT_FOUND") return null;
  if (isImageProxyLocalUrl(imageUrl)) {
    return resolveImageProxyLocalUrl(imageUrl) || null;
  }
  return null;
};

const getCachedUrl = async (cacheKey) => {
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
    if (isImageProxyLocalUrl(cached.imageUrl) && !resolveImageProxyLocalUrl(cached.imageUrl)) {
      dbOps.deleteImage(cacheKey);
      return undefined;
    }
    const warmed = await warmPublicImageUrl(cached.imageUrl);
    if (warmed) {
      if (warmed !== cached.imageUrl) dbOps.setImage(cacheKey, warmed);
      return warmed;
    }
    dbOps.deleteImage(cacheKey);
    return undefined;
  }
  if (cached?.imageUrl === "NOT_FOUND") {
    return null;
  }
  return undefined;
};

const persistCover = (cacheKey, proxiedUrl) => {
  dbOps.setImage(cacheKey, proxiedUrl);
};

const acceptCoverUrl = async (cacheKey, imageUrl) => {
  const proxiedUrl = await warmPublicImageUrl(imageUrl);
  if (!proxiedUrl) return null;
  persistCover(cacheKey, proxiedUrl);
  return {
    imageUrl: proxiedUrl,
    types: ["Front"],
    notFound: false,
    transientError: false,
  };
};

const buildReleaseGroupCoverResult = async (cacheKey, album) => {
  const imageUrl = pickAlbumCoverUrl(album?.images);
  if (!imageUrl) {
    return { imageUrl: null, types: [], notFound: true, transientError: false };
  }
  return (
    (await acceptCoverUrl(cacheKey, imageUrl)) || {
      imageUrl: null,
      types: [],
      notFound: true,
      transientError: false,
    }
  );
};

const fetchCoverArtArchiveCover = async (cacheKey, releaseGroupMbid) => {
  if (!releaseGroupMbid) return null;
  return acceptCoverUrl(cacheKey, coverArtArchiveFrontUrl(releaseGroupMbid));
};

const fetchDeezerAlbumCover = async (cacheKey, { artistName = "", albumTitle = "" } = {}) => {
  if (!albumTitle) return null;
  try {
    const album = await resolveDeezerAlbumForPreview({ artistName, albumTitle });
    if (!album?._coverUrl) return null;
    return acceptCoverUrl(cacheKey, album._coverUrl);
  } catch {
    return null;
  }
};

export const fetchDeezerArtistImageUrl = async ({
  artistName = "",
  deezerArtistId = null,
} = {}) => {
  try {
    const artist = deezerArtistId
      ? await getDeezerArtistById(deezerArtistId)
      : artistName
        ? await getDeezerArtist(artistName)
        : null;
    if (!artist?.imageUrl) return null;
    return warmPublicImageUrl(artist.imageUrl);
  } catch {
    return null;
  }
};

export const fetchReleaseGroupCoverUrl = async (
  releaseGroupMbid,
  { artistName = "", albumTitle = "" } = {},
) => {
  const cacheKey = `${RG_CACHE_PREFIX}${releaseGroupMbid}`;
  const cached = await getCachedUrl(cacheKey);
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
  try {
    const album = await getAlbumByMbid(releaseGroupMbid);
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
        const result = await buildReleaseGroupCoverResult(cacheKey, resolvedAlbum);
        if (result.imageUrl) {
          return result;
        }
      }
    } catch {
      sawTransientError = true;
    }
  }
  const caaCover = await fetchCoverArtArchiveCover(cacheKey, releaseGroupMbid);
  if (caaCover?.imageUrl) return caaCover;
  const deezerCover = await fetchDeezerAlbumCover(cacheKey, {
    artistName: normalizedArtistName,
    albumTitle: normalizedAlbumTitle,
  });
  if (deezerCover?.imageUrl) return deezerCover;
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
  items = [],
  { concurrency = 6, signal } = {},
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

  const safeConcurrency = Math.min(12, Math.max(1, Number.parseInt(concurrency, 10) || 6));

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
