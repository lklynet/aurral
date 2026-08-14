import {
  getData,
  postData,
  putData,
  fetchCoverWithMemo,
  getCoverCacheEntry,
  setCoverCacheEntry,
  coverInflightRequests,
} from "../core.js";

export const getArtistDetails = async (
  mbid,
  artistName,
  { mode = "", releaseTypes = [], appearsOnLimit = null } = {},
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
  });
};

export const getReleaseGroupDetails = (mbid) =>
  getData(`/artists/release-group/${mbid}`);

export const getArtistAppearsOnPage = (
  mbid,
  { offset = 0, limit = 24, excludeIds = [] } = {},
) =>
  postData(`/artists/${mbid}/appears-on`, {
    offset,
    limit,
    excludeIds: Array.isArray(excludeIds) ? excludeIds : [],
  });

export const getReleaseGroupRatingsBatch = (ids = []) =>
  postData("/artists/release-groups/ratings", { ids });

const RELEASE_GROUP_COVER_BATCH_SIZE = 24;

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
    const covers = {};
    for (let index = 0; index < normalizedItems.length; index += RELEASE_GROUP_COVER_BATCH_SIZE) {
      const data = await postData("/artists/release-groups/covers", {
        items: normalizedItems.slice(index, index + RELEASE_GROUP_COVER_BATCH_SIZE),
      });
      Object.assign(covers, data?.covers || {});
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
  const normalizedArtistName =
    typeof artistName === "string" ? artistName.trim().toLowerCase() : "";
  const normalizedAlbumTitle =
    typeof albumTitle === "string" ? albumTitle.trim().toLowerCase() : "";
  const cacheKey = `release-group:${mbid}:${normalizedArtistName}:${normalizedAlbumTitle}`;
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

export const getSimilarArtistsForArtist = (
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

export const getArtistOverrides = (mbid) =>
  getData(`/artists/${mbid}/overrides`);

export const updateArtistOverrides = (
  mbid,
  { musicbrainzId = null, deezerArtistId = null } = {},
) =>
  putData(`/artists/${mbid}/overrides`, {
    musicbrainzId,
    deezerArtistId,
  });
