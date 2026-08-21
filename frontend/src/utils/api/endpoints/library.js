import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

const buildStreamUrl = (path) => buildAuthenticatedApiUrl(path);
const SLOW_LIBRARY_REQUEST_TIMEOUT_MS = 90000;

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
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryCanonical(params),
    queryFn: ({ signal }) => getData("/library/canonical", { params, signal }),
    staleTime: 15_000,
  });
};

export const clearCanonicalLibraryPageCache = () => {
  queryClient.removeQueries({ queryKey: ["library", "canonical"] });
};

export const requestLibraryRefresh = () => postData("/library/refresh", {});

export const getLibraryRefreshStatus = (jobId) =>
  getData(`/library/refresh/${encodeURIComponent(jobId)}`);

let libraryFavoritesGeneration = 0;
let latestLibraryFavorites = null;

export const getLibraryFavorites = () => {
  const generation = libraryFavoritesGeneration;
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryFavorites,
    queryFn: ({ signal }) => getData("/library/favorites", { signal }),
    staleTime: 30_000,
  }).then((data) => {
    if (generation !== libraryFavoritesGeneration && latestLibraryFavorites) {
      queryClient.setQueryData(queryKeys.libraryFavorites, latestLibraryFavorites);
    }
    return data;
  });
};

export const updateLibraryFavorites = async (ids, starred) => {
  const generation = ++libraryFavoritesGeneration;
  const data = await postData("/library/favorites", { ids, starred });
  if (generation === libraryFavoritesGeneration) {
    latestLibraryFavorites = data;
    queryClient.setQueryData(queryKeys.libraryFavorites, data);
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
    const value = queryClient.getQueryData(queryKeys.libraryLookup(id));
    if (value !== undefined) result[id] = value;
  });
  return result;
};

const writeLibraryLookupCache = (lookup) => {
  if (!lookup || typeof lookup !== "object") return;
  Object.entries(lookup).forEach(([id, value]) => {
    queryClient.setQueryData(queryKeys.libraryLookup(id), value);
  });
};

export const lookupArtistsInLibraryBatch = async (mbids) => {
  const ids = [...new Set((Array.isArray(mbids) ? mbids : []).filter(Boolean))];
  if (!ids.length) return {};
  const data = await queryClient.fetchQuery({
    queryKey: queryKeys.libraryLookupBatch(ids),
    queryFn: ({ signal }) => postData("/library/lookup/batch", { mbids: ids }, { signal }),
    staleTime: 60_000,
  });
  writeLibraryLookupCache(data);
  return data;
};

export const lookupAlbumsInLibraryBatch = (mbids, { signal, bypassCache = false } = {}) => {
  const ids = [...new Set((Array.isArray(mbids) ? mbids : []).filter(Boolean))];
  if (!ids.length) return Promise.resolve({});
  if (bypassCache) {
    return postData("/library/albums/lookup/batch", { mbids: ids }, { signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryAlbumLookup(ids),
    queryFn: ({ signal: querySignal }) =>
      postData("/library/albums/lookup/batch", { mbids: ids }, { signal: signal || querySignal }),
    staleTime: 15_000,
  });
};

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

export const getDownloadStatus = async (albumIds, { signal, bypassCache = false } = {}) => {
  const ids = Array.isArray(albumIds) ? albumIds.filter(Boolean) : [albumIds];
  if (!ids.length) return {};
  if (bypassCache) {
    return getData(`/library/downloads/status?albumIds=${ids.join(",")}`, { signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.downloadStatus(ids),
    queryFn: ({ signal: querySignal }) =>
      getData(`/library/downloads/status?albumIds=${ids.join(",")}`, {
        signal: signal || querySignal,
      }),
    staleTime: 4_000,
  });
};

export const refreshLibraryArtist = (mbid) =>
  postData(`/library/artists/${mbid}/refresh`);

export const getRequests = ({ refresh = false, signal } = {}) =>
  getData("/requests", { params: refresh ? { refresh: 1 } : {}, signal });

export const getRecentlyAdded = ({ signal } = {}) => getData("/library/recent", { signal });

export const getRecentReleases = ({ signal } = {}) => getData("/library/recent-releases", { signal });
