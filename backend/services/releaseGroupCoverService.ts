import { dbOps } from "../db/helpers/index.ts";
import {
  buildStableImageProxyUrl,
  fetchRemoteImage,
  warmPublicImageUrl,
} from "./imageProxyService.ts";
import { resolveDeezerAlbumForPreview } from "./apiClients/deezer.ts";
import { getAlbumByMbid, isMetadataNotFoundError } from "./providers/metadataProvider.ts";
import { getLinkedDeezerArtistId } from "./providers/metadataMappers.ts";
import { selectAlbumCover } from "./imageRanking.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

export const LEGACY_COVER_HOST_PATTERN = /https?:\/\/(?:archive\.org|[\w-]+\.ca\.archive\.org)\//i;

type DeezerArtistId = string | number | null;
type ListedAlbum = { artistName: string; albumTitle: string };
type ReleaseGroupCoverOptions = {
  artistName?: string;
  albumTitle?: string;
  bypassCache?: boolean;
  listedWithoutCover?: boolean;
};
const RG_CACHE_PREFIX = "rg:";
const releaseGroupCoverRequests = new Map<
  string,
  ReturnType<typeof fetchReleaseGroupCoverUncached>
>();

export { warmPublicImageUrl };

// An artist file and a search answer take each album's cover from the same
// build as its album file. A row they list without a cover names itself here,
// so the redirect can ask Deezer before loading that file to find none again.
// Only the album file can say an album has no cover at all.
export const releaseGroupCoverImageUrl = (releaseGroupMbid: string, listed?: ListedAlbum) => {
  const path = `/api/artists/release-group/${encodeURIComponent(releaseGroupMbid)}/cover/image`;
  return listed?.albumTitle
    ? `${path}?${new URLSearchParams({ artist: listed.artistName, title: listed.albumTitle })}`
    : path;
};

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
  const album = await resolveDeezerAlbumForPreview({
    artistName,
    deezerArtistId,
    albumTitle,
    throwOnError: true,
  });
  return foundCover(album?._coverUrl);
};

const fetchReleaseGroupCoverUncached = async (
  releaseGroupMbid: string,
  {
    artistName = "",
    albumTitle = "",
    bypassCache = false,
    listedWithoutCover = false,
  }: ReleaseGroupCoverOptions = {},
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
  const findDeezerCover = (options: Parameters<typeof fetchDeezerAlbumCover>[0]) =>
    fetchDeezerAlbumCover(options).catch(() => {
      sawTransientError = true;
      return null;
    });
  let deadCover: ReturnType<typeof foundCover> = null;
  let deezerArtistId = null;
  let deezerArtistName = artistName.trim();
  let deezerAlbumTitle = albumTitle.trim();
  if (listedWithoutCover) {
    const listedCover = await findDeezerCover({
      artistName: deezerArtistName,
      albumTitle: deezerAlbumTitle,
    });
    if (listedCover) return listedCover;
  }
  const album = await getAlbumByMbid(releaseGroupMbid).catch((error: unknown) => {
    if (!isMetadataNotFoundError(error)) {
      sawTransientError = true;
      logger.warn("images", "Release-group cover metadata lookup failed", {
        releaseGroupMbid,
        reason: safeLogDiagnostic(error),
      });
    }
    return null;
  });
  if (album) {
    deezerArtistId = getLinkedDeezerArtistId(album.artists[0]?.links);
    deezerArtistName ||= album.artists[0]?.name || "";
    deezerAlbumTitle ||= album.title;
    const cover = foundCover(album.cover || selectAlbumCover(album.images)?.url);
    if (cover && bypassCache && (await isDeadLink(cover.imageUrl))) {
      deadCover = cover;
    } else if (cover) {
      dbOps.setImage(cacheKey, cover.imageUrl);
      return cover;
    }
  }
  const deezerCover = await findDeezerCover({
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
    options.listedWithoutCover === true,
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
  listed?: (releaseGroup: T) => ListedAlbum,
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
          : toPublicCoverUrl(imageUrl) || releaseGroupCoverImageUrl(id, listed?.(releaseGroup)),
    };
  });
};
