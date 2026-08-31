import { dbOps } from "../db/helpers/index.js";
import { buildStableImageProxyUrl } from "./imageProxyService.js";
import { getArtistByMbid, listArtistAlbums, searchArtists } from "./providers/brainzmashProvider.js";
import {
  fetchDeezerArtistImageUrl,
  fetchReleaseGroupCoverUrl,
  LEGACY_COVER_HOST_PATTERN,
} from "./releaseGroupCoverService.js";

const MAX_NEGATIVE_CACHE = 1000;
const MAX_PENDING_REQUESTS = 100;
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const RELEASE_GROUP_CONCURRENCY = 4;
const negativeImageCache = new Map();
const pendingImageRequests = new Map();

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
  const kind = String(image?.kind || image?.CoverType || "")
    .trim()
    .toLowerCase();
  return ARTIST_IMAGE_KIND_RANK[kind] ?? 5;
};

const getAlbumImageKindRank = (image) => {
  const kind = String(image?.kind || image?.CoverType || "")
    .trim()
    .toLowerCase();
  return ALBUM_IMAGE_KIND_RANK[kind] ?? 3;
};

const getImageUrl = (image) => image?.url || image?.Url || null;

const toPublicImageUrl = (imageUrl) => buildStableImageProxyUrl(imageUrl);

const selectBestImageByKind = (images = [], getKindRank) => {
  if (!Array.isArray(images)) return null;
  return (
    images
      .filter((image) => getImageUrl(image))
      .map((image, index) => ({ image, index }))
      .sort((a, b) => {
        const rankDiff = getKindRank(a.image) - getKindRank(b.image);
        if (rankDiff !== 0) return rankDiff;
        return a.index - b.index;
      })[0]?.image || null
  );
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

const buildCachedArtistImagePayload = (cachedImageUrl, cachedImages = []) => {
  const persistedImages = Array.isArray(cachedImages)
    ? cachedImages
        .map((image) => {
          const publicUrl = toPublicImageUrl(image?.image) || image?.image;
          return publicUrl ? { ...image, image: publicUrl } : null;
        })
        .filter(Boolean)
    : [];
  if (persistedImages.length > 0) return persistedImages;

  const publicUrl = toPublicImageUrl(cachedImageUrl) || cachedImageUrl;
  return publicUrl
    ? [
        {
          image: publicUrl,
          front: true,
          types: ["Artist"],
        },
      ]
    : [];
};

const buildDirectArtistImagePayload = (directImages = []) => {
  const sorted = sortArtistImages(directImages);
  const images = [];
  const seen = new Set();

  for (const image of sorted) {
    const publicUrl = toPublicImageUrl(getImageUrl(image));
    if (!publicUrl || seen.has(publicUrl)) continue;
    seen.add(publicUrl);
    images.push({
      image: publicUrl,
      front: images.length === 0,
      types: [image.kind || image.CoverType || "Artist"],
    });
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
    return buildStableImageProxyUrl(cached.imageUrl) || cached.imageUrl;
  }
  if (cached?.imageUrl === "NOT_FOUND") {
    return null;
  }
  return undefined;
};

const typeRank = (primaryType) => {
  if (primaryType === "Album") return 0;
  if (primaryType === "EP") return 1;
  if (primaryType === "Single") return 2;
  return 3;
};

const buildArtistCoverFromUrl = (imageUrl, types = ["Front"]) => ({
  url: imageUrl,
  images: [
    {
      image: imageUrl,
      front: true,
      types,
    },
  ],
});

const recoverArtistCoverFromCachedReleaseGroups = async (resolvedMbid) => {
  const rgCacheKey = `artist_rg:${resolvedMbid}`;
  const cachedRgId = dbOps.getDeezerMbidCache(rgCacheKey);
  if (cachedRgId && cachedRgId !== "NOT_FOUND") {
    const cachedUrl = getCachedUrl(`rg:${cachedRgId}`);
    if (cachedUrl) {
      return buildArtistCoverFromUrl(cachedUrl);
    }
  }

  const albums = await listArtistAlbums(resolvedMbid, {
    includeTrackCounts: false,
    hydrateLimit: 30,
  }).catch(() => []);
  const ordered = albums
    .filter((rg) => rg?.id)
    .sort((a, b) => {
      const rankDiff = typeRank(a.type) - typeRank(b.type);
      if (rankDiff !== 0) return rankDiff;
      const dateA = a.firstReleaseDate || "";
      const dateB = b.firstReleaseDate || "";
      return dateB.localeCompare(dateA);
    });

  for (const rg of ordered) {
    const cachedUrl = getCachedUrl(`rg:${rg.id}`);
    if (cachedUrl) {
      dbOps.setDeezerMbidCache(rgCacheKey, rg.id);
      return buildArtistCoverFromUrl(cachedUrl);
    }
  }

  return null;
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
      typeof artistNameHint === "string" && artistNameHint.trim() ? artistNameHint.trim() : null,
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
    const cachedUrl = buildStableImageProxyUrl(cachedImage.imageUrl) || cachedImage.imageUrl;
    const images = buildCachedArtistImagePayload(cachedUrl, cachedImage.images);
    return {
      url: images[0]?.image || cachedUrl,
      images,
    };
  }

  if (
    !forceRefresh &&
    ((cachedImage && cachedImage.imageUrl === "NOT_FOUND") || hasFreshNegativeCache(mbid))
  ) {
    const override = dbOps.getArtistOverride(mbid);
    const resolvedMbid = override?.musicbrainzId || mbid;
    const recovered = await recoverArtistCoverFromCachedReleaseGroups(resolvedMbid);
    if (recovered?.url) {
      negativeImageCache.delete(mbid);
      dbOps.setImage(mbid, recovered.url, recovered.images);
      return recovered;
    }
    return { url: null, images: [], notFound: true };
  }

  if (pendingImageRequests.has(mbid)) {
    return pendingImageRequests.get(mbid);
  }

  const fetchPromise = (async () => {
    let metadataArtist = null;
    let resolvedMbid = mbid;
    let override = null;
    try {
      override = dbOps.getArtistOverride(mbid);
      resolvedMbid = override?.musicbrainzId || mbid;
      metadataArtist = await getArtistByMbid(resolvedMbid).catch(() => null);
      const directArtistImages = sortArtistImages(metadataArtist?.images);
      const images = buildDirectArtistImagePayload(directArtistImages);
      const primaryImage = images.find((image) => image.front) || images[0];
      if (primaryImage?.image) {
        negativeImageCache.delete(mbid);
        dbOps.setImage(mbid, primaryImage.image, images);
        return {
          url: primaryImage.image,
          images,
        };
      }

      const resolvedArtistName = metadataArtist?.name || artistName || null;
      const deezerImage = await fetchDeezerArtistImageUrl({
        artistName: resolvedArtistName || "",
        deezerArtistId: override?.deezerArtistId || null,
      });
      if (deezerImage) {
        negativeImageCache.delete(mbid);
        const result = buildArtistCoverFromUrl(
          buildStableImageProxyUrl(deezerImage) || deezerImage,
          ["Artist"],
        );
        dbOps.setImage(mbid, result.url, result.images);
        return result;
      }

      const rgCacheKey = `artist_rg:${resolvedMbid}`;
      const cachedRg = forceRefresh ? null : dbOps.getDeezerMbidCache(rgCacheKey);
      const albums = cachedRg
        ? cachedRg === "NOT_FOUND"
          ? []
          : [{ id: cachedRg, type: "Album", firstReleaseDate: null }]
        : await listArtistAlbums(resolvedMbid, {
            includeTrackCounts: false,
            hydrateLimit: 30,
          });

      const ordered = albums
        .filter((rg) => rg?.id)
        .sort((a, b) => {
          const rankDiff = typeRank(a.type) - typeRank(b.type);
          if (rankDiff !== 0) return rankDiff;
          const dateA = a.firstReleaseDate || "";
          const dateB = b.firstReleaseDate || "";
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
        const artistImageUrl =
          buildStableImageProxyUrl(foundCover.imageUrl) || foundCover.imageUrl;
        const result = {
          url: artistImageUrl,
          images: [
            {
              image: artistImageUrl,
              front: true,
              types: foundCover.types,
            },
          ],
        };
        negativeImageCache.delete(mbid);
        dbOps.setImage(mbid, artistImageUrl, result.images);
        if (!cachedRg || forceRefresh) {
          dbOps.setDeezerMbidCache(rgCacheKey, foundCover.releaseGroupId);
        }
        return result;
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

    const fallbackArtistName = metadataArtist?.name;
    if (fallbackArtistName) {
      try {
        const searchResults = await searchArtists(fallbackArtistName, { limit: 20 });
        const siblings = searchResults.items.filter(
          (a) => a.id !== resolvedMbid && a.images?.length > 0 && a.name === fallbackArtistName,
        );
        if (siblings.length > 0) {
          siblings.sort((a, b) => b.images.length - a.images.length);
          const sibling = siblings[0];
          dbOps.setArtistOverride(mbid, {
            musicbrainzId: sibling.id,
            deezerArtistId: override?.deezerArtistId || null,
          });
          const siblingResult = await getArtistImage(sibling.id, {
            forceRefresh: false,
            artistName: null,
          });
          if (siblingResult?.url) {
            negativeImageCache.delete(mbid);
            dbOps.setImage(mbid, siblingResult.url, siblingResult.images);
            return siblingResult;
          }
        }
      } catch {}
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
