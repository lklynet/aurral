import type { CachedArtistImage } from "../db/helpers/cache.ts";
import { dbOps } from "../db/helpers/index.ts";
import { buildStableImageProxyUrl } from "./imageProxyService.ts";
import { getArtistImageKindRank, getImageUrl, type ImageList } from "./imageRanking.ts";
import { getArtistByMbid } from "./providers/metadataProvider.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { LEGACY_COVER_HOST_PATTERN } from "./releaseGroupCoverService.ts";

const DEEZER_ARTIST_IMAGE_PATTERN = /https?:\/\/(?:[\w-]+\.)?dzcdn\.net\/images\/artist\//i;

type ArtistImageResult = {
  url: string | null;
  images: CachedArtistImage[];
  notFound?: boolean;
  transientError?: boolean;
};

const MAX_NEGATIVE_CACHE = 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const negativeImageCache = new Map<string, number>();
const pendingImageRequests = new Map<string, Promise<ArtistImageResult>>();

const toPublicImageUrl = (imageUrl: string | null | undefined) =>
  buildStableImageProxyUrl(imageUrl);

const sortArtistImages = (images: ImageList = []) => {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => getImageUrl(image))
    .map((image, index) => ({ image, index }))
    .sort((a, b) => {
      const rankDiff = getArtistImageKindRank(a.image) - getArtistImageKindRank(b.image);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.image!);
};

const buildCachedArtistImagePayload = (
  cachedImageUrl: string | null,
  cachedImages: CachedArtistImage[] | null = [],
) => {
  const persistedImages = Array.isArray(cachedImages)
    ? (cachedImages
        .map((image) => {
          const publicUrl = toPublicImageUrl(image?.image);
          return publicUrl ? { ...image, image: publicUrl } : null;
        })
        .filter(Boolean) as CachedArtistImage[])
    : [];
  if (persistedImages.length > 0) return persistedImages;

  const publicUrl = toPublicImageUrl(cachedImageUrl);
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

const buildDirectArtistImagePayload = (directImages: ImageList = []) => {
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

export const getDirectOrCachedArtistImages = (
  mbid: string,
  directImages: ImageList = [],
): CachedArtistImage[] => {
  const direct = buildDirectArtistImagePayload(directImages);
  if (direct.length > 0) return direct;
  const cached = dbOps.getImage(mbid);
  if (
    cached?.imageUrl &&
    cached.imageUrl !== "NOT_FOUND" &&
    !LEGACY_COVER_HOST_PATTERN.test(cached.imageUrl) &&
    !DEEZER_ARTIST_IMAGE_PATTERN.test(cached.imageUrl)
  ) {
    return buildCachedArtistImagePayload(buildStableImageProxyUrl(cached.imageUrl), cached.images);
  }
  return [];
};

const addToNegativeCache = (mbid: string) => {
  if (negativeImageCache.size >= MAX_NEGATIVE_CACHE) {
    const firstKey = negativeImageCache.keys().next().value;
    negativeImageCache.delete(firstKey!);
  }
  negativeImageCache.set(mbid, Date.now());
};

const hasFreshNegativeCache = (mbid: string) => {
  const cachedAt = negativeImageCache.get(mbid);
  if (!cachedAt) return false;
  if (Date.now() - cachedAt > NEGATIVE_CACHE_TTL_MS) {
    negativeImageCache.delete(mbid);
    return false;
  }
  return true;
};

export const invalidateArtistImage = (mbid: string) => {
  pendingImageRequests.delete(mbid);
  negativeImageCache.delete(mbid);
  dbOps.deleteImage(mbid);
};

export const getArtistImage = async (
  mbid: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<ArtistImageResult> => {
  if (!mbid) return { url: null, images: [] };

  const cachedImage = dbOps.getImage(mbid);
  if (
    !forceRefresh &&
    cachedImage &&
    cachedImage.imageUrl &&
    cachedImage.imageUrl !== "NOT_FOUND" &&
    !LEGACY_COVER_HOST_PATTERN.test(cachedImage.imageUrl) &&
    !DEEZER_ARTIST_IMAGE_PATTERN.test(cachedImage.imageUrl)
  ) {
    const cachedUrl = buildStableImageProxyUrl(cachedImage.imageUrl);
    const images = buildCachedArtistImagePayload(cachedUrl, cachedImage.images);
    if (images.length > 0 || cachedUrl) {
      return {
        url: images[0]?.image || cachedUrl,
        images,
      };
    }
    dbOps.deleteImage(mbid);
  }

  const pending = pendingImageRequests.get(mbid);
  if (pending) return pending;

  if (!forceRefresh && (cachedImage?.imageUrl === "NOT_FOUND" || hasFreshNegativeCache(mbid))) {
    return { url: null, images: [], notFound: true };
  }

  const isCurrentRequest = () => pendingImageRequests.get(mbid) === fetchPromise;
  const fetchPromise: Promise<ArtistImageResult> = (async () => {
    try {
      const override = dbOps.getArtistOverride(mbid);
      const artist = await getArtistByMbid(override?.musicbrainzId || mbid).catch(() => null);
      if (!artist) return { url: null, images: [], transientError: true };

      const images = buildDirectArtistImagePayload(artist.images);
      const albumCover = buildStableImageProxyUrl(
        artist.albums.find((album) => album.cover)?.cover,
      );
      const found = images[0]
        ? { url: images[0].image, images }
        : albumCover
          ? { url: albumCover, images: [{ image: albumCover, front: true, types: ["Front"] }] }
          : null;
      if (isCurrentRequest()) {
        if (found) {
          negativeImageCache.delete(mbid);
          dbOps.setImage(mbid, found.url, found.images);
        } else {
          addToNegativeCache(mbid);
          dbOps.setImage(mbid, "NOT_FOUND");
        }
      }
      return found ?? { url: null, images: [], notFound: true };
    } catch (e) {
      logger.warn("images", "Artist image lookup failed", { mbid, reason: safeLogDiagnostic(e) });
      return { url: null, images: [], transientError: true };
    }
  })();

  pendingImageRequests.set(mbid, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (isCurrentRequest()) pendingImageRequests.delete(mbid);
  }
};
