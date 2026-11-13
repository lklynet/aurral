import { dbOps } from "../db/helpers/index.ts";
import {
  buildStableImageProxyUrl,
  fetchRemoteImage,
  warmPublicImageUrl,
} from "./imageProxyService.ts";
import {
  getDeezerArtist,
  getDeezerArtistById,
  resolveDeezerAlbumForPreview,
} from "./apiClients/deezer.ts";
import {
  getAlbumByMbid,
  isMetadataCircuitError,
  isMetadataNotFoundError,
} from "./providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "./providers/brainzmashMappers.ts";
import { selectAlbumCover } from "./imageRanking.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

export const LEGACY_COVER_HOST_PATTERN = /https?:\/\/(?:archive\.org|[\w-]+\.ca\.archive\.org)\//i;

type DeezerArtistId = Parameters<typeof getDeezerArtistById>[0];
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

export const savedReleaseGroupCoverUrl = (releaseGroupMbid: string) =>
  getCachedUrl(`${RG_CACHE_PREFIX}${releaseGroupMbid}`) || null;

const foundCover = (imageUrl: string | null | undefined) => {
  const proxiedUrl = toPublicCoverUrl(imageUrl ?? null);
  return proxiedUrl
    ? { imageUrl: proxiedUrl, types: ["Front"], notFound: false, transientError: false }
    : null;
};

const isDeadLink = (imageUrl: string) =>
  fetchRemoteImage(imageUrl).then(
    () => false,
    () => true,
  );

const fetchDeezerAlbumCover = async ({
  artistName = "",
  deezerArtistId = null,
  albumTitle = "",
}: { artistName?: string; deezerArtistId?: DeezerArtistId; albumTitle?: string } = {}) => {
  if (!albumTitle) return null;
  try {
    const album = await resolveDeezerAlbumForPreview({
      artistName,
      deezerArtistId,
      albumTitle,
    });
    return foundCover(album?._coverUrl);
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
  let sawTransientError = false;
  let deadCover: ReturnType<typeof foundCover> = null;
  let deezerArtistId = null;
  let deezerArtistName = artistName.trim();
  let deezerAlbumTitle = albumTitle.trim();
  try {
    const album = await getAlbumByMbid(releaseGroupMbid);
    deezerArtistId = getLinkedDeezerArtistId(album.artists[0]?.links);
    deezerArtistName ||= album.artists[0]?.name || "";
    deezerAlbumTitle ||= album.title;
    const cover = foundCover(selectAlbumCover(album.images)?.url);
    if (cover && bypassCache && (await isDeadLink(cover.imageUrl))) {
      deadCover = cover;
    } else if (cover) {
      dbOps.setImage(cacheKey, cover.imageUrl);
      return cover;
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
  const deezerCover = await fetchDeezerAlbumCover({
    artistName: deezerArtistName,
    deezerArtistId,
    albumTitle: deezerAlbumTitle,
  });
  if (deezerCover) {
    if (deadCover) dbOps.setImage(cacheKey, deezerCover.imageUrl);
    return deezerCover;
  }
  if (deadCover) return deadCover;
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
