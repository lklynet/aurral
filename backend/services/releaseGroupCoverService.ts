import { dbOps } from "../db/helpers/index.ts";
import { buildStableImageProxyUrl, warmPublicImageUrl } from "./imageProxyService.ts";
import {
  getDeezerArtist,
  getDeezerArtistById,
  resolveDeezerAlbumForPreview,
} from "./apiClients/deezer.ts";
import {
  getAlbumByMbid,
  isMetadataCircuitError,
  isMetadataNotFoundError,
  resolveAlbumByArtistAndTitle,
} from "./providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "./providers/brainzmashMappers.ts";
import type { NormalizedAlbum } from "./providers/brainzmashMappers.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

export const LEGACY_COVER_HOST_PATTERN = /https?:\/\/(?:archive\.org|[\w-]+\.ca\.archive\.org)\//i;

type DeezerArtistId = Parameters<typeof getDeezerArtistById>[0];
type CoverWriteOptions = { persist?: boolean };
type ReleaseGroupCoverOptions = {
  artistName?: string;
  albumTitle?: string;
  bypassCache?: boolean;
};
const RG_CACHE_PREFIX = "rg:";
const releaseGroupCoverRequests = new Map<
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

export const releaseGroupCoverImageUrl = (releaseGroupMbid: string) =>
  `/api/artists/release-group/${encodeURIComponent(releaseGroupMbid)}/cover/image`;

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
  let deezerArtistName = normalizedArtistName;
  let deezerAlbumTitle = normalizedAlbumTitle;
  try {
    const album = await getAlbumByMbid(releaseGroupMbid);
    deezerArtistId = getLinkedDeezerArtistId(album?.artists?.[0]?.links);
    deezerArtistName ||= album?.artists?.[0]?.name || "";
    deezerAlbumTitle ||= album?.title || "";
    const result = await buildReleaseGroupCoverResult(cacheKey, album);
    if (result.imageUrl) {
      return result;
    }
  } catch (error) {
    if (!isMetadataNotFoundError(error)) {
      sawTransientError = true;
      if (!isMetadataCircuitError(error))
        logger.warn("images", "Release-group cover metadata lookup failed", {
          releaseGroupMbid,
          reason: safeLogDiagnostic(error),
        });
    }
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
    } catch (error) {
      sawTransientError = true;
      if (!isMetadataCircuitError(error))
        logger.warn("images", "Release-group cover artist/title lookup failed", {
          releaseGroupMbid,
          artistName: normalizedArtistName,
          albumTitle: normalizedAlbumTitle,
          reason: safeLogDiagnostic(error),
        });
    }
  }
  const deezerCover = await fetchDeezerAlbumCover(
    cacheKey,
    {
      artistName: deezerArtistName,
      deezerArtistId,
      albumTitle: deezerAlbumTitle,
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

export const fetchReleaseGroupCoverUrl = (
  releaseGroupMbid: string,
  options: ReleaseGroupCoverOptions = {},
) => {
  const key = JSON.stringify([
    options.bypassCache === true,
    String(releaseGroupMbid || "").trim(),
    options.artistName?.trim() || "",
    options.albumTitle?.trim() || "",
  ]);
  const existing = releaseGroupCoverRequests.get(key);
  if (existing) return existing;
  const request = fetchReleaseGroupCoverUncached(releaseGroupMbid, options).finally(() => {
    if (releaseGroupCoverRequests.get(key) === request) releaseGroupCoverRequests.delete(key);
  });
  releaseGroupCoverRequests.set(key, request);
  return request;
};

export const withCoverUrls = <T extends { id?: string | null; coverUrl?: string | null }>(
  releaseGroups: T[],
) => {
  if (!releaseGroups.length) return [];
  const cached = dbOps.getImages(
    releaseGroups.flatMap(({ id, coverUrl }) =>
      id && !coverUrl ? [`${RG_CACHE_PREFIX}${id}`] : [],
    ),
  );
  return releaseGroups.map((releaseGroup) => {
    const { id, coverUrl } = releaseGroup;
    if (coverUrl || !id) return { ...releaseGroup, coverUrl: coverUrl || null };
    const imageUrl = cached[`${RG_CACHE_PREFIX}${id}`]?.imageUrl ?? null;
    return {
      ...releaseGroup,
      coverUrl:
        imageUrl === "NOT_FOUND"
          ? null
          : toPublicCoverUrl(imageUrl) || releaseGroupCoverImageUrl(id),
    };
  });
};
