import {
  getData,
  postData,
  putData,
  deleteData,
  libraryLookupCache,
  setLibraryLookupCacheEntry,
  buildAuthenticatedApiUrl,
  getRequestToken,
} from "../core.js";

const buildStreamUrl = (path) => buildAuthenticatedApiUrl(path);
const SLOW_LIBRARY_REQUEST_TIMEOUT_MS = 90000;
const LIBRARY_FAVORITES_CACHE_TTL_MS = 30000;
const LIBRARY_PAGE_CACHE_TTL_MS = 15000;
const MAX_LIBRARY_PAGE_CACHE_SIZE = 100;
const libraryPageCache = new Map();
const libraryPageRequests = new Map();

export const getLibraryArtists = (options = {}) =>
  getData("/library/artists", options);

export const getCanonicalLibrary = (options = {}) =>
  getData("/library/canonical", {
    params: {
      source: options.source || "all",
      availableOnly: options.availableOnly === true ? "true" : "false",
    },
    signal: options.signal,
  });

export const getCanonicalLibraryPage = (options = {}) => {
  const params = Object.fromEntries(
    Object.entries({
      kind: options.kind,
      page: options.page,
      pageSize: options.pageSize,
      query: options.query,
      genre: options.genre,
      sort: options.sort,
      direction: options.direction,
      artistId: options.artistId,
      albumId: options.albumId,
      source: options.source || "all",
      availableOnly: options.availableOnly === true ? "true" : "false",
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  const cacheKey = `${getRequestToken()}:${JSON.stringify(params)}`;
  const cached = libraryPageCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.data);
  if (cached) libraryPageCache.delete(cacheKey);
  if (libraryPageRequests.has(cacheKey)) return libraryPageRequests.get(cacheKey);
  const request = getData("/library/canonical", { params })
    .then((data) => {
      libraryPageCache.delete(cacheKey);
      libraryPageCache.set(cacheKey, { data, expiresAt: Date.now() + LIBRARY_PAGE_CACHE_TTL_MS });
      if (libraryPageCache.size > MAX_LIBRARY_PAGE_CACHE_SIZE) {
        libraryPageCache.delete(libraryPageCache.keys().next().value);
      }
      return data;
    })
    .finally(() => libraryPageRequests.delete(cacheKey));
  libraryPageRequests.set(cacheKey, request);
  return request;
};

export const clearCanonicalLibraryPageCache = () => libraryPageCache.clear();

export const requestLibraryRefresh = () => postData("/library/refresh", {});

export const getLibraryRefreshStatus = (jobId) =>
  getData(`/library/refresh/${encodeURIComponent(jobId)}`);

let libraryFavoritesCache = null;
let libraryFavoritesRequest = null;
let libraryFavoritesGeneration = 0;

export const getLibraryFavorites = () => {
  const token = getRequestToken();
  const generation = libraryFavoritesGeneration;
  if (
    libraryFavoritesCache?.token === token &&
    libraryFavoritesCache?.generation === generation &&
    Date.now() < libraryFavoritesCache.expiresAt
  ) {
    return Promise.resolve(libraryFavoritesCache.data);
  }
  if (
    libraryFavoritesRequest?.token === token &&
    libraryFavoritesRequest?.generation === generation
  ) return libraryFavoritesRequest.promise;
  let promise;
  promise = getData("/library/favorites")
    .then((data) => {
      if (getRequestToken() === token && libraryFavoritesGeneration === generation) {
        libraryFavoritesCache = {
          token,
          generation,
          data,
          expiresAt: Date.now() + LIBRARY_FAVORITES_CACHE_TTL_MS,
        };
      }
      return data;
    })
    .finally(() => {
      if (libraryFavoritesRequest?.promise === promise) libraryFavoritesRequest = null;
    });
  libraryFavoritesRequest = { token, generation, promise };
  return promise;
};

export const updateLibraryFavorites = async (ids, starred) => {
  const token = getRequestToken();
  const generation = ++libraryFavoritesGeneration;
  const data = await postData("/library/favorites", { ids, starred });
  if (libraryFavoritesGeneration === generation) {
    libraryFavoritesGeneration += 1;
    libraryFavoritesCache = getRequestToken() === token
      ? {
        token,
        generation: libraryFavoritesGeneration,
        data,
        expiresAt: Date.now() + LIBRARY_FAVORITES_CACHE_TTL_MS,
      }
      : null;
  }
  clearCanonicalLibraryPageCache();
  return data;
};

export const getLibraryArtist = async (mbid) => {
  const artist = await getData(`/library/artists/${mbid}`);
  if (artist && !artist.foreignArtistId) {
    artist.foreignArtistId = artist.mbid;
  }
  return artist;
};

export const lookupArtistInLibrary = (mbid) => getData(`/library/lookup/${mbid}`);

export const readLibraryLookupCache = (mbids) => {
  const result = {};
  if (!Array.isArray(mbids)) return result;
  mbids.forEach((id) => {
    if (libraryLookupCache.has(id)) {
      result[id] = libraryLookupCache.get(id);
    }
  });
  return result;
};

const writeLibraryLookupCache = (lookup) => {
  if (!lookup || typeof lookup !== "object") return;
  Object.entries(lookup).forEach(([id, value]) => {
    setLibraryLookupCacheEntry(id, value);
  });
};

export const lookupArtistsInLibraryBatch = async (mbids) => {
  const data = await postData("/library/lookup/batch", { mbids });
  writeLibraryLookupCache(data);
  return data;
};

export const lookupAlbumsInLibraryBatch = (mbids) =>
  postData("/library/albums/lookup/batch", { mbids });

export const addArtistToLibrary = (artistData) =>
  postData("/library/artists", artistData);

export const deleteArtistFromLibrary = (mbid, deleteFiles = false) =>
  deleteData(`/library/artists/${mbid}`, {
    params: { deleteFiles },
  });

export const deleteAlbumFromLibrary = (id, deleteFiles = false) =>
  deleteData(`/library/albums/${id}`, {
    params: { deleteFiles },
  });

export const deleteTrackFromLibrary = (id) =>
  deleteData(`/library/tracks/${encodeURIComponent(id)}`);

export const getLibraryAlbums = async (artistId) => {
  const data = await getData("/library/albums", {
    params: { artistId },
  });
  return data.map((album) => ({
    ...album,
    foreignAlbumId: album.foreignAlbumId || album.mbid,
  }));
};

export const addLibraryAlbum = async (
  artistId,
  releaseGroupMbid,
  albumName,
) =>
  postData("/library/albums", {
    artistId,
    releaseGroupMbid,
    albumName,
  }, {
    timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
  });

export const requestAlbumFromSearch = (payload) =>
  postData("/library/albums/request", payload, {
    timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
  });

export const getLibraryTracks = async (
  albumId,
  releaseGroupMbid = null,
  context = {},
) => {
  const params = { albumId };
  if (releaseGroupMbid) {
    params.releaseGroupMbid = releaseGroupMbid;
  }
  if (context.artistName) params.artistName = context.artistName;
  if (context.albumTitle) params.albumTitle = context.albumTitle;
  if (context.releaseType) params.releaseType = context.releaseType;
  if (context.releaseDate) params.releaseDate = context.releaseDate;
  if (context.deezerAlbumId) params.deezerAlbumId = context.deezerAlbumId;
  if (context.readPath) params.readPath = context.readPath;
  if (context.readPath === "canonical") params.source = context.source || "all";
  const data = await getData("/library/tracks", { params });
  const tracks = Array.isArray(data) ? data : [];
  return Promise.all(
    tracks.map(async (track) => {
      if (!track?.streamPath) return track;
      return {
        ...track,
        preview_url: await buildStreamUrl(track.streamPath),
        previewProvider: "lidarr",
      };
    }),
  );
};

export const updateLibraryAlbum = (id, data) =>
  putData(`/library/albums/${id}`, data);

export const updateLibraryArtist = (mbid, data) =>
  putData(`/library/artists/${mbid}`, data);

export const downloadAlbum = (artistId, albumId, options = {}) =>
  postData("/library/downloads/album", {
    artistId,
    albumId,
    artistMbid: options.artistMbid,
    artistName: options.artistName,
  });

export const downloadTrackToLibrary = (track) =>
  postData("/library/downloads/track", track);

export const triggerAlbumSearch = (albumId) =>
  postData("/library/downloads/album/search", {
    albumId,
  });

export const getDownloadStatus = async (albumIds) => {
  const ids = Array.isArray(albumIds) ? albumIds.join(",") : albumIds;
  return getData(`/library/downloads/status?albumIds=${ids}`);
};

export const refreshLibraryArtist = (mbid) =>
  postData(`/library/artists/${mbid}/refresh`);

export const getRequests = ({ refresh = false } = {}) =>
  getData("/requests", { params: refresh ? { refresh: 1 } : {} });

export const getRecentlyAdded = () => getData("/library/recent");

export const getRecentReleases = () => getData("/library/recent-releases");
