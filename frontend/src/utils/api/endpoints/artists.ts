import {
  getData,
  postData,
  putData,
  fetchCoverWithMemo,
  getCoverCacheEntry,
  setCoverCacheEntry,
  coverInflightRequests,
} from "../core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { deezerGetArtistTopTracksById } from "../../../../../backend/services/apiClients/index.ts";
import type { dbOps } from "../../../../../backend/db/helpers/index.ts";
import type { ArtistDetailsResponse } from "../../../../../backend/routes/artists/handlers/details.ts";
import type { ArtistCoverResponse } from "../../../../../backend/routes/artists/handlers/cover.ts";
import type {
  ReleaseGroupCoverEntry,
  ReleaseGroupCoverResponse,
  ReleaseGroupCoversResponse,
  ReleaseGroupDetailsResponse,
  ReleaseGroupRatingsResponse,
  ReleaseGroupTrack,
} from "../../../../../backend/routes/artists/handlers/releaseGroup.ts";
import type { SimilarArtistsResponse } from "../../../../../backend/routes/artists/handlers/similar.ts";
import type { ArtistAppearsOnResponse } from "../../../../../backend/routes/artists/handlers/appearsOn.ts";
import type { ArtistVideoResponse } from "../../../../../backend/routes/artists/handlers/video.ts";

type ArtistOverride = Pick<
  NonNullable<ReturnType<typeof dbOps.setArtistOverride>>,
  "mbid" | "musicbrainzId" | "deezerArtistId"
>;

type ArtistDetailsOptions = {
  mode?: string;
  releaseTypes?: string[];
  appearsOnLimit?: number;
  signal?: AbortSignal;
};

type ReleaseGroupCoverItem = { mbid: string; artistName: string; albumTitle: string };

type ArtistVideo = NonNullable<ArtistVideoResponse["video"]> & { trackTitle: string };

const fetchArtistDetails = async (
  mbid: string,
  artistName: string | undefined,
  {
    mode = "",
    releaseTypes = [],
    appearsOnLimit = null,
    signal,
  }: {
    mode?: string;
    releaseTypes?: string[];
    appearsOnLimit?: number | null;
    signal?: AbortSignal;
  } = {},
): Promise<ArtistDetailsResponse> => {
  const params: Record<string, string | number> = {};
  if (artistName) {
    params.artistName = artistName;
  }
  if (mode) {
    params.mode = mode;
  }
  if (Array.isArray(releaseTypes) && releaseTypes.length > 0) {
    params.releaseTypes = releaseTypes.join(",");
  }
  if (Number.isFinite(Number(appearsOnLimit)) && Number(appearsOnLimit) > 0) {
    params.appearsOnLimit = Number.parseInt(String(appearsOnLimit), 10);
  }
  return getData<ArtistDetailsResponse>(`/artists/${mbid}`, {
    params,
    signal,
  });
};

export const getArtistDetails = (
  mbid: string,
  artistName?: string,
  options: ArtistDetailsOptions = {},
): Promise<ArtistDetailsResponse> =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistDetails(mbid, {
      artistName,
      mode: options.mode,
      releaseTypes: options.releaseTypes,
      appearsOnLimit: options.appearsOnLimit,
    }),
    queryFn: ({ signal }) => fetchArtistDetails(mbid, artistName, { ...options, signal }),
    staleTime: 60_000,
  });

export const getReleaseGroupDetails = (
  mbid: string | null | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ReleaseGroupDetailsResponse> =>
  getData<ReleaseGroupDetailsResponse>(`/artists/release-group/${mbid}`, { signal });

export const getArtistAppearsOnPage = (
  mbid: string | undefined,
  {
    offset = 0,
    limit = 24,
    excludeIds = [],
    signal,
  }: { offset?: number; limit?: number; excludeIds?: string[]; signal?: AbortSignal } = {},
): Promise<ArtistAppearsOnResponse> =>
  postData<ArtistAppearsOnResponse>(
    `/artists/${mbid}/appears-on`,
    {
      offset,
      limit,
      excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
    },
    { signal },
  );

export const getReleaseGroupRatingsBatch = (
  ids: string[] = [],
): Promise<ReleaseGroupRatingsResponse> => {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (!normalizedIds.length) return Promise.resolve({ ratings: {} });
  return queryClient.fetchQuery({
    queryKey: queryKeys.releaseGroupRatings(normalizedIds),
    queryFn: () =>
      postData<ReleaseGroupRatingsResponse>("/artists/release-groups/ratings", {
        ids: normalizedIds,
      }),
    staleTime: 5 * 60 * 1000,
  });
};

const RELEASE_GROUP_COVER_BATCH_SIZE = 24;

const normalizeCoverPart = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

const releaseGroupCoverCacheKey = (
  mbid: string,
  artistName: string | null | undefined = "",
  albumTitle: string | null | undefined = "",
) => `release-group:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

const releaseGroupBatchCoverCacheKey = (
  mbid: string,
  artistName: string | null | undefined = "",
  albumTitle: string | null | undefined = "",
) =>
  `release-group-batch:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

export const getReleaseGroupTracks = async (
  mbid: string | undefined,
  context: {
    artistMbid?: string;
    artistName?: string;
    albumTitle?: string;
    releaseType?: string;
    releaseDate?: string;
    deezerAlbumId?: string | number;
    signal?: AbortSignal;
  } = {},
): Promise<ReleaseGroupTrack[]> => {
  const params: Record<string, string | number> = {};
  if (context.artistMbid) params.artistMbid = context.artistMbid;
  if (context.artistName) params.artistName = context.artistName;
  if (context.albumTitle) params.albumTitle = context.albumTitle;
  if (context.releaseType) params.releaseType = context.releaseType;
  if (context.releaseDate) params.releaseDate = context.releaseDate;
  if (context.deezerAlbumId) params.deezerAlbumId = context.deezerAlbumId;
  return getData<ReleaseGroupTrack[]>(`/artists/release-group/${mbid}/tracks`, {
    params,
    signal: context.signal,
  });
};

export const getArtistCover = async (
  mbid: string | number,
  artistName?: string | null,
  refresh = false,
): Promise<ArtistCoverResponse> => {
  const params: Record<string, string | boolean> = {};
  if (artistName && typeof artistName === "string" && artistName.trim()) {
    params.artistName = artistName.trim();
  }
  if (refresh) {
    params.refresh = true;
  }
  const cacheKey = `artist:${mbid}`;
  return fetchCoverWithMemo(
    cacheKey,
    () =>
      getData<ArtistCoverResponse>(`/artists/${mbid}/cover`, {
        params,
        timeout: 4000,
      }),
    { bypassCache: refresh },
  );
};

export const getReleaseGroupCoversBatch = async (
  items: {
    mbid?: string | null;
    id?: string;
    artistName?: string | null;
    albumTitle?: string | null;
  }[] = [],
): Promise<Record<string, ReleaseGroupCoverEntry>> => {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      mbid: String(item?.mbid || item?.id || "").trim(),
      artistName: typeof item?.artistName === "string" ? item.artistName.trim() : "",
      albumTitle: typeof item?.albumTitle === "string" ? item.albumTitle.trim() : "",
    }))
    .filter((item) => item.mbid);
  if (!normalizedItems.length) {
    return {};
  }
  const covers: Record<string, ReleaseGroupCoverEntry> = {};
  const uncachedItems: ReleaseGroupCoverItem[] = [];
  normalizedItems.forEach((item) => {
    const cached = getCoverCacheEntry<ReleaseGroupCoverEntry | ReleaseGroupCoverResponse>(
      releaseGroupBatchCoverCacheKey(item.mbid, item.artistName, item.albumTitle),
    );
    if (cached) covers[item.mbid] = cached;
    else uncachedItems.push(item);
  });
  if (!uncachedItems.length) return covers;
  const batchKey = normalizedItems
    .map((item) => `${item.mbid}:${item.artistName.toLowerCase()}:${item.albumTitle.toLowerCase()}`)
    .sort()
    .join("\0");
  if (coverInflightRequests.has(batchKey)) {
    return coverInflightRequests.get(batchKey) as Promise<Record<string, ReleaseGroupCoverEntry>>;
  }
  const request = (async () => {
    for (let index = 0; index < uncachedItems.length; index += RELEASE_GROUP_COVER_BATCH_SIZE) {
      const batch = uncachedItems.slice(index, index + RELEASE_GROUP_COVER_BATCH_SIZE);
      const data = await postData<ReleaseGroupCoversResponse>("/artists/release-groups/covers", {
        items: batch,
      });
      const batchCovers = data?.covers || {};
      Object.assign(covers, batchCovers);
      Object.entries(batchCovers).forEach(([mbid, cover]) => {
        const item = batch.find((candidate) => candidate.mbid === mbid);
        if (item && !cover?.transientError) {
          setCoverCacheEntry(
            releaseGroupBatchCoverCacheKey(mbid, item.artistName, item.albumTitle),
            cover,
          );
        }
      });
    }
    return covers;
  })().finally(() => {
    coverInflightRequests.delete(batchKey);
  });
  coverInflightRequests.set(batchKey, request);
  return request;
};

export const getReleaseGroupCover = async (
  mbid: string,
  {
    artistName = "",
    albumTitle = "",
    bypassCache = false,
  }: { artistName?: string; albumTitle?: string; bypassCache?: boolean } = {},
): Promise<ReleaseGroupCoverResponse | ReleaseGroupCoverEntry> => {
  const cacheKey = releaseGroupCoverCacheKey(mbid, artistName, albumTitle);
  const refreshKey = `${cacheKey}:refresh`;
  if (!bypassCache) {
    const refresh = coverInflightRequests.get(refreshKey);
    if (refresh) return refresh as Promise<ReleaseGroupCoverResponse>;
    const cached = getCoverCacheEntry<ReleaseGroupCoverResponse | ReleaseGroupCoverEntry>(cacheKey);
    if (cached) {
      return cached;
    }
  } else {
    const normal = coverInflightRequests.get(cacheKey);
    if (normal) await normal.catch(() => undefined);
  }
  const inflightKey = bypassCache ? refreshKey : cacheKey;
  if (coverInflightRequests.has(inflightKey)) {
    return coverInflightRequests.get(inflightKey) as Promise<ReleaseGroupCoverResponse>;
  }
  const request = (async () => {
    const params: Record<string, string | boolean> = {};
    if (typeof artistName === "string" && artistName.trim()) {
      params.artistName = artistName.trim();
    }
    if (typeof albumTitle === "string" && albumTitle.trim()) {
      params.albumTitle = albumTitle.trim();
    }
    if (bypassCache) {
      params.refresh = true;
    }
    const data = await getData<ReleaseGroupCoverResponse>(`/artists/release-group/${mbid}/cover`, {
      params,
    });
    if (!data?.transientError) {
      setCoverCacheEntry(cacheKey, data);
    }
    return data;
  })().finally(() => {
    coverInflightRequests.delete(inflightKey);
  });
  coverInflightRequests.set(inflightKey, request);
  return request;
};

const fetchSimilarArtistsForArtist = (
  mbid: string,
  artistName = "",
  limit = 20,
): Promise<SimilarArtistsResponse> =>
  getData<SimilarArtistsResponse>(`/artists/${mbid}/similar`, {
    params: {
      limit,
      ...(artistName && typeof artistName === "string" && artistName.trim()
        ? { artistName: artistName.trim() }
        : {}),
    },
  });

export const getSimilarArtistsForArtist = (
  mbid: string,
  artistName = "",
  limit = 20,
): Promise<SimilarArtistsResponse> =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistSimilar(mbid, artistName, limit),
    queryFn: () => fetchSimilarArtistsForArtist(mbid, artistName, limit),
    staleTime: 5 * 60 * 1000,
  });

export const getArtistPreview = (
  mbid: string | number | null | undefined,
  artistName?: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<{ tracks: Awaited<ReturnType<typeof deezerGetArtistTopTracksById>> }> =>
  getData(`/artists/${mbid}/preview`, {
    params: artistName ? { artistName } : {},
    signal: options.signal,
  });

const getArtistTopSongVideo = (
  mbid: string,
  artistName: string,
  trackTitle: string,
  options: { signal?: AbortSignal } = {},
): Promise<ArtistVideoResponse> =>
  getData<ArtistVideoResponse>(`/artists/${mbid}/video`, {
    params: { artistName, trackTitle },
    signal: options.signal,
  });

export async function getArtistVideos(
  mbid: string,
  artistName: string,
  tracks: { title: string }[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ videos: ArtistVideo[]; failed: boolean }> {
  const popularTracks = tracks.slice(0, 6);
  const videos: ArtistVideo[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (let index = 0; index < popularTracks.length && videos.length < 3;) {
    signal?.throwIfAborted();
    const batch: { title: string }[] = popularTracks.slice(index, index + 3 - videos.length);
    index += batch.length;
    const results: (ArtistVideo | null)[] = await Promise.all(
      batch.map(async (track) => {
        try {
          const data = await getArtistTopSongVideo(mbid, artistName, track.title, { signal });
          return data?.video ? { ...data.video, trackTitle: track.title } : null;
        } catch {
          signal?.throwIfAborted();
          failed = true;
          return null;
        }
      }),
    );
    signal?.throwIfAborted();
    for (const video of results) {
      if (!video?.videoId || seen.has(video.videoId)) continue;
      seen.add(video.videoId);
      videos.push(video);
    }
  }
  return { videos, failed };
}

export const fetchArtistOverrides = (
  mbid: string | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ArtistOverride> => getData<ArtistOverride>(`/artists/${mbid}/overrides`, { signal });

export const getArtistOverrides = (mbid: string | undefined) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistOverrides(mbid),
    queryFn: ({ signal }) => fetchArtistOverrides(mbid, { signal }),
    staleTime: 30_000,
  });

export const updateArtistOverrides = async (
  mbid: string,
  {
    musicbrainzId = null,
    deezerArtistId = null,
  }: { musicbrainzId?: string | null; deezerArtistId?: string | null } = {},
): Promise<ArtistOverride> => {
  const result = await putData<ArtistOverride>(`/artists/${mbid}/overrides`, {
    musicbrainzId,
    deezerArtistId,
  });
  queryClient.setQueryData(queryKeys.artistOverrides(mbid), result);
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistDetailsPrefix });
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistSimilarPrefix });
  return result;
};
