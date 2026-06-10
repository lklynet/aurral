import { dbOps } from "../config/db-helpers.js";
import {
  musicbrainzGetArtistNameByMbid,
  musicbrainzGetArtistReleaseGroupsPreview,
} from "./apiClients.js";
import { warmImageProxy } from "./imageProxyService.js";
import {
  getAlbumByMbid,
  getArtistByMbid,
  resolveAlbumByArtistAndTitle,
} from "./metadataProvider.js";

const MAX_NEGATIVE_CACHE = 1000;
const MAX_PENDING_REQUESTS = 100;
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const RELEASE_GROUP_CONCURRENCY = 4;
const negativeImageCache = new Map();
const pendingImageRequests = new Map();
const LEGACY_COVER_HOST_PATTERN =
  /https?:\/\/(?:caa\.lkly\.net|coverartarchive\.org|archive\.org|[\w-]+\.ca\.archive\.org)\//i;

const ARTIST_IMAGE_KIND_RANK = {
  poster: 0,
  artist: 1,
  thumb: 2,
  fanart: 3,
  background: 4,
  banner: 8,
  logo: 9,
  clearlogo: 9,
};

const ALBUM_IMAGE_KIND_RANK = {
  front: 0,
  cover: 0,
  albumcover: 0,
  back: 4,
  booklet: 5,
  medium: 6,
  tray: 6,
  spine: 7,
  disc: 8,
  logo: 9,
};

const getArtistImageKindRank = (image) => {
  const kind = String(image?.kind || image?.CoverType || "").trim().toLowerCase();
  return ARTIST_IMAGE_KIND_RANK[kind] ?? 5;
};

const getAlbumImageKindRank = (image) => {
  const kind = String(image?.kind || image?.CoverType || "").trim().toLowerCase();
  return ALBUM_IMAGE_KIND_RANK[kind] ?? 3;
};

const getImageUrl = (image) => image?.url || image?.Url || null;

const selectBestImageByKind = (images = [], getKindRank) => {
  if (!Array.isArray(images)) return null;
  return images
    .filter((image) => getImageUrl(image))
    .map((image, index) => ({ image, index }))
    .sort((a, b) => {
      const rankDiff = getKindRank(a.image) - getKindRank(b.image);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })[0]?.image || null;
};

export const selectBestArtistImage = (images = []) => {
  return selectBestImageByKind(images, getArtistImageKindRank);
};

export const selectBestAlbumImage = (images = []) => {
  return selectBestImageByKind(images, getAlbumImageKindRank);
};

const sortArtistImages = (images = []) => {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => getImageUrl(image))
    .map((image, index) => ({ image, index }))
    .sort((a, b) => {
      const rankDiff = getArtistImageKindRank(a.image) - getArtistImageKindRank(b.image);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.image);
};

const buildCachedArtistImagePayload = async (
  cachedImageUrl,
  metadataArtist = null,
) => {
  const images = [
    {
      image: cachedImageUrl,
      front: true,
      types: ["Artist"],
    },
  ];
  const seen = new Set([cachedImageUrl]);
  const directImages = sortArtistImages(metadataArtist?.images);

  for (const image of directImages) {
    try {
      const cached = await warmImageProxy(getImageUrl(image));
      if (!cached?.localUrl || seen.has(cached.localUrl)) continue;
      seen.add(cached.localUrl);
      images.push({
        image: cached.localUrl,
        front: false,
        types: [image.kind || image.CoverType || "Artist"],
      });
    } catch {}
  }

  return images;
};

const buildDirectArtistImagePayload = async (directImages = []) => {
  const sorted = sortArtistImages(directImages);
  const best = sorted[0] || null;
  const images = [];
  const seen = new Set();

  for (const image of sorted) {
    try {
      const cached = await warmImageProxy(getImageUrl(image));
      if (!cached?.localUrl || seen.has(cached.localUrl)) continue;
      seen.add(cached.localUrl);
      images.push({
        image: cached.localUrl,
        front: image === best,
        types: [image.kind || image.CoverType || "Artist"],
      });
    } catch {}
  }

  return images;
};

const addToNegativeCache = (mbid) => {
  if (negativeImageCache.size >= MAX_NEGATIVE_CACHE) {
    const firstKey = negativeImageCache.keys().next().value;
    negativeImageCache.delete(firstKey);
  }
  negativeImageCache.set(mbid, Date.now());
};

const hasFreshNegativeCache = (mbid) => {
  const cachedAt = negativeImageCache.get(mbid);
  if (!cachedAt) return false;
  if (Date.now() - cachedAt > NEGATIVE_CACHE_TTL_MS) {
    negativeImageCache.delete(mbid);
    return false;
  }
  return true;
};

const addToPendingRequests = (mbid, promise) => {
  if (pendingImageRequests.size >= MAX_PENDING_REQUESTS) {
    const firstKey = pendingImageRequests.keys().next().value;
    pendingImageRequests.delete(firstKey);
  }
  pendingImageRequests.set(mbid, promise);
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

const buildReleaseGroupCoverResult = async (cacheKey, album) => {
  const image = selectBestAlbumImage(album?.images);
  const imageUrl = getImageUrl(image);
  if (!imageUrl) {
    return { imageUrl: null, types: [], notFound: true, transientError: false };
  }
  const cachedImage = await warmImageProxy(imageUrl);
  dbOps.setImage(cacheKey, cachedImage.localUrl);
  return {
    imageUrl: cachedImage.localUrl,
    types: [image?.kind || image?.CoverType || "Front"],
    notFound: false,
    transientError: false,
  };
};

export const fetchReleaseGroupCoverUrl = async (
  releaseGroupMbid,
  { artistName = "", albumTitle = "" } = {},
) => {
  const cacheKey = `rg:${releaseGroupMbid}`;
  const cached = getCachedUrl(cacheKey);
  if (cached !== undefined) {
    return { imageUrl: cached, notFound: cached === null, transientError: false };
  }
  const normalizedArtistName =
    typeof artistName === "string" ? artistName.trim() : "";
  const normalizedAlbumTitle =
    typeof albumTitle === "string" ? albumTitle.trim() : "";
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
  if (sawTransientError) {
    return { imageUrl: null, types: [], notFound: false, transientError: true };
  }
  dbOps.setImage(cacheKey, "NOT_FOUND");
  return { imageUrl: null, types: [], notFound: true, transientError: false };
};

const typeRank = (primaryType) => {
  if (primaryType === "Album") return 0;
  if (primaryType === "EP") return 1;
  if (primaryType === "Single") return 2;
  return 3;
};

const normalizeGetArtistImageOptions = (forceRefreshOrOptions, artistNameHint) => {
  if (
    forceRefreshOrOptions &&
    typeof forceRefreshOrOptions === "object" &&
    !Array.isArray(forceRefreshOrOptions)
  ) {
    return {
      forceRefresh: !!forceRefreshOrOptions.forceRefresh,
      artistName:
        typeof forceRefreshOrOptions.artistName === "string" &&
        forceRefreshOrOptions.artistName.trim()
          ? forceRefreshOrOptions.artistName.trim()
          : null,
    };
  }

  return {
    forceRefresh: !!forceRefreshOrOptions,
    artistName:
      typeof artistNameHint === "string" && artistNameHint.trim()
        ? artistNameHint.trim()
        : null,
  };
};

export const getArtistImage = async (
  mbid,
  forceRefreshOrOptions = false,
  artistNameHint = null,
) => {
  if (!mbid) return { url: null, images: [] };
  const { forceRefresh, artistName } = normalizeGetArtistImageOptions(
    forceRefreshOrOptions,
    artistNameHint,
  );

  const cachedImage = dbOps.getImage(mbid);
  if (
    !forceRefresh &&
    cachedImage &&
    cachedImage.imageUrl &&
    cachedImage.imageUrl !== "NOT_FOUND" &&
    !LEGACY_COVER_HOST_PATTERN.test(cachedImage.imageUrl)
  ) {
    const override = dbOps.getArtistOverride(mbid);
    const resolvedMbid = override?.musicbrainzId || mbid;
    const metadataArtist = await getArtistByMbid(resolvedMbid).catch(() => null);
    return {
      url: cachedImage.imageUrl,
      images: await buildCachedArtistImagePayload(
        cachedImage.imageUrl,
        metadataArtist,
      ),
    };
  }

  if (
    !forceRefresh &&
    ((cachedImage && cachedImage.imageUrl === "NOT_FOUND") ||
      hasFreshNegativeCache(mbid))
  ) {
    return { url: null, images: [], notFound: true };
  }

  if (pendingImageRequests.has(mbid)) {
    return pendingImageRequests.get(mbid);
  }

  const fetchPromise = (async () => {
    try {
      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;
      const metadataArtist = await getArtistByMbid(resolvedMbid).catch(() => null);
      const directArtistImages = sortArtistImages(metadataArtist?.images);
      const directArtistImage = directArtistImages[0] || null;

      if (directArtistImage?.url) {
        const images = await buildDirectArtistImagePayload(directArtistImages);
        const primaryImage = images.find((image) => image.front) || images[0];
        if (!primaryImage?.image) {
          throw new Error("Artist images could not be proxied");
        }
        negativeImageCache.delete(mbid);
        dbOps.setImage(mbid, primaryImage.image);
        return {
          url: primaryImage.image,
          images,
        };
      }

      const resolvedArtistName =
        artistName ||
        (await musicbrainzGetArtistNameByMbid(resolvedMbid).catch(() => null));
      const rgCacheKey = `artist_rg:${resolvedMbid}`;
      const cachedRg = forceRefresh ? null : dbOps.getDeezerMbidCache(rgCacheKey);
      const releaseGroups = cachedRg
        ? cachedRg === "NOT_FOUND"
          ? []
          : [
              {
                id: cachedRg,
                title: "",
                "primary-type": "Album",
                "first-release-date": null,
              },
            ]
        : await musicbrainzGetArtistReleaseGroupsPreview(resolvedMbid, 30);

      const ordered = releaseGroups
        .filter((rg) => rg?.id)
        .sort((a, b) => {
          const rankDiff = typeRank(a["primary-type"]) - typeRank(b["primary-type"]);
          if (rankDiff !== 0) return rankDiff;
          const dateA = a["first-release-date"] || "";
          const dateB = b["first-release-date"] || "";
          return dateB.localeCompare(dateA);
        })
        .slice(0, 25);

      let nextIndex = 0;
      let foundCover = null;
      let sawTransientError = false;
      const workers = Array.from(
        { length: Math.min(RELEASE_GROUP_CONCURRENCY, ordered.length) },
        async () => {
          while (nextIndex < ordered.length && !foundCover) {
            const rg = ordered[nextIndex++];
            const cover = await fetchReleaseGroupCoverUrl(rg.id, {
              artistName: resolvedArtistName || "",
              albumTitle: rg.title || "",
            });
            if (cover?.imageUrl) {
              foundCover = {
                releaseGroupId: rg.id,
                imageUrl: cover.imageUrl,
                types: cover.types || ["Front"],
              };
              return;
            }
            if (cover?.transientError) {
              sawTransientError = true;
            }
          }
        },
      );

      await Promise.all(workers);

      if (foundCover) {
        negativeImageCache.delete(mbid);
        dbOps.setImage(mbid, foundCover.imageUrl);
        if (!cachedRg || forceRefresh) {
          dbOps.setDeezerMbidCache(rgCacheKey, foundCover.releaseGroupId);
        }
        return {
          url: foundCover.imageUrl,
          images: [
            {
              image: foundCover.imageUrl,
              front: true,
              types: foundCover.types,
            },
          ],
        };
      }

      if (sawTransientError) {
        return { url: null, images: [], transientError: true };
      }

      if (!cachedRg || forceRefresh) {
        dbOps.setDeezerMbidCache(rgCacheKey, "NOT_FOUND");
      }
    } catch (e) {
      console.warn(`Failed to fetch image for ${mbid}:`, e.message);
      return { url: null, images: [], transientError: true };
    }

    addToNegativeCache(mbid);
    dbOps.setImage(mbid, "NOT_FOUND");

    return { url: null, images: [], notFound: true };
  })();

  addToPendingRequests(mbid, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    pendingImageRequests.delete(mbid);
  }
};
