import {
  getData,
  postData,
  putData,
  fetchCoverWithMemo,
  getCoverCacheEntry,
  setCoverCacheEntry,
  coverInflightRequests,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

const fetchArtistDetails = async (
  mbid,
  artistName,
  { mode = "", releaseTypes = [], appearsOnLimit = null, signal } = {},
) => {
  const params = {};
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
    params.appearsOnLimit = Number.parseInt(appearsOnLimit, 10);
  }
  return getData(`/artists/${mbid}`, {
    params,
    signal,
  });
};

export const getArtistDetails = (mbid, artistName, options = {}) =>
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

export const getReleaseGroupDetails = (mbid, { signal } = {}) =>
  getData(`/artists/release-group/${mbid}`, { signal });

export const getArtistAppearsOnPage = (
  mbid,
  { offset = 0, limit = 24, excludeIds = [], signal } = {},
) =>
  postData(`/artists/${mbid}/appears-on`, {
    offset,
    limit,
    excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
  }, { signal });

export const getReleaseGroupRatingsBatch = (ids = []) => {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (!normalizedIds.length) return Promise.resolve({ ratings: {} });
  return queryClient.fetchQuery({
    queryKey: queryKeys.releaseGroupRatings(normalizedIds),
    queryFn: () => postData("/artists/release-groups/ratings", { ids: normalizedIds }),
    staleTime: 5 * 60 * 1000,
  });
};

const RELEASE_GROUP_COVER_BATCH_SIZE = 24;

const normalizeCoverPart = (value) => String(value || "").trim().toLowerCase();

const releaseGroupCoverCacheKey = (mbid, artistName = "", albumTitle = "") =>
  `release-group:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

export const getReleaseGroupTracks = async (mbid, context = {}) => {
  const params = {};
  if (context.artistMbid) params.artistMbid = context.artistMbid;
  if (context.artistName) params.artistName = context.artistName;
  if (context.albumTitle) params.albumTitle = context.albumTitle;
  if (context.releaseType) params.releaseType = context.releaseType;
  if (context.releaseDate) params.releaseDate = context.releaseDate;
  if (context.deezerAlbumId) params.deezerAlbumId = context.deezerAlbumId;
  return getData(`/artists/release-group/${mbid}/tracks`, {
    params,
    signal: context.signal,
  });
};

export const getArtistCover = async (mbid, artistName, refresh = false) => {
  const params = {};
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
      getData(`/artists/${mbid}/cover`, {
        params,
        timeout: 4000,
      }),
    { bypassCache: refresh },
  );
};

export const getReleaseGroupCoversBatch = async (items = []) => {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      mbid: String(item?.mbid || item?.id || "").trim(),
      artistName:
        typeof item?.artistName === "string" ? item.artistName.trim() : "",
      albumTitle:
        typeof item?.albumTitle === "string" ? item.albumTitle.trim() : "",
    }))
    .filter((item) => item.mbid);
  if (!normalizedItems.length) {
    return {};
  }
  const covers = {};
  const uncachedItems = [];
  normalizedItems.forEach((item) => {
    const cached = getCoverCacheEntry(
      releaseGroupCoverCacheKey(item.mbid, item.artistName, item.albumTitle),
    );
    if (cached) covers[item.mbid] = cached;
    else uncachedItems.push(item);
  });
  if (!uncachedItems.length) return covers;
  const batchKey = normalizedItems
    .map(
      (item) =>
        `${item.mbid}:${item.artistName.toLowerCase()}:${item.albumTitle.toLowerCase()}`,
    )
    .sort()
    .join("\0");
  if (coverInflightRequests.has(batchKey)) {
    return coverInflightRequests.get(batchKey);
  }
  const request = (async () => {
    for (let index = 0; index < uncachedItems.length; index += RELEASE_GROUP_COVER_BATCH_SIZE) {
      const batch = uncachedItems.slice(index, index + RELEASE_GROUP_COVER_BATCH_SIZE);
      const data = await postData("/artists/release-groups/covers", {
        items: batch,
      });
      const batchCovers = data?.covers || {};
      Object.assign(covers, batchCovers);
      Object.entries(batchCovers).forEach(([mbid, cover]) => {
        const item = batch.find((candidate) => candidate.mbid === mbid);
        if (item && !cover?.transientError) {
          setCoverCacheEntry(
            releaseGroupCoverCacheKey(mbid, item.artistName, item.albumTitle),
            cover,
          );
        }
      });
    }
    return covers;
  })()
    .finally(() => {
      coverInflightRequests.delete(batchKey);
    });
  coverInflightRequests.set(batchKey, request);
  return request;
};

export const getReleaseGroupCover = async (
  mbid,
  { artistName = "", albumTitle = "", bypassCache = false } = {},
) => {
  const cacheKey = releaseGroupCoverCacheKey(mbid, artistName, albumTitle);
  if (!bypassCache) {
    const cached = getCoverCacheEntry(cacheKey);
    if (cached) {
      return cached;
    }
  }
  if (coverInflightRequests.has(cacheKey)) {
    return coverInflightRequests.get(cacheKey);
  }
  const request = (async () => {
    const params = {};
    if (typeof artistName === "string" && artistName.trim()) {
      params.artistName = artistName.trim();
    }
    if (typeof albumTitle === "string" && albumTitle.trim()) {
      params.albumTitle = albumTitle.trim();
    }
    const data = await getData(`/artists/release-group/${mbid}/cover`, {
      params,
    });
    if (!data?.transientError) {
      setCoverCacheEntry(cacheKey, data);
    }
    return data;
  })().finally(() => {
    coverInflightRequests.delete(cacheKey);
  });
  coverInflightRequests.set(cacheKey, request);
  return request;
};

const fetchSimilarArtistsForArtist = (
  mbid,
  artistName = "",
  limit = 20,
) =>
  getData(`/artists/${mbid}/similar`, {
    params: {
      limit,
      ...(artistName && typeof artistName === "string" && artistName.trim()
        ? { artistName: artistName.trim() }
        : {}),
    },
  });

export const getSimilarArtistsForArtist = (mbid, artistName = "", limit = 20) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistSimilar(mbid, artistName, limit),
    queryFn: () => fetchSimilarArtistsForArtist(mbid, artistName, limit),
    staleTime: 5 * 60 * 1000,
  });

export const getArtistPreview = (mbid, artistName, options = {}) =>
  getData(`/artists/${mbid}/preview`, {
    params: artistName ? { artistName } : {},
    signal: options.signal,
  });

export const getArtistTopSongVideo = (
  mbid,
  artistName,
  trackTitle,
  options = {},
) =>
  getData(`/artists/${mbid}/video`, {
    params: { artistName, trackTitle },
    signal: options.signal,
  });

export const fetchArtistOverrides = (mbid, { signal } = {}) =>
  getData(`/artists/${mbid}/overrides`, { signal });

export const getArtistOverrides = (mbid) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistOverrides(mbid),
    queryFn: ({ signal }) => fetchArtistOverrides(mbid, { signal }),
    staleTime: 30_000,
  });

export const updateArtistOverrides = async (
  mbid,
  { musicbrainzId = null, deezerArtistId = null } = {},
) => {
  const result = await putData(`/artists/${mbid}/overrides`, {
    musicbrainzId,
    deezerArtistId,
  });
  queryClient.setQueryData(queryKeys.artistOverrides(mbid), result);
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistDetailsPrefix });
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistSimilarPrefix });
  return result;
};
