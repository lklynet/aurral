import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
} from "../core.js";
import {
  bumpLibraryPageGeneration,
  queryClient,
  queryKeys,
} from "../../../queryClient.js";
import { getLibraryOwnerConflict } from "../../libraryDestination.js";
import { addActiveDownload, normalizeActiveDownloads } from "../../activeDownloads.js";

const buildStreamUrl = (path) => buildAuthenticatedApiUrl(path);
const SLOW_LIBRARY_REQUEST_TIMEOUT_MS = 90000;

const mergeSignals = (callerSignal, querySignal) => {
  if (callerSignal && querySignal) return AbortSignal.any([callerSignal, querySignal]);
  return callerSignal || querySignal;
};

export const getLibraryArtists = (options = {}) =>
  getData("/library/artists", options);

const libraryPageParams = (options = {}) => Object.fromEntries(
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
    // Tri-state: an explicit boolean forces the filter, while `undefined` omits
    // the param so the backend applies the Lidarr "available only" setting.
    availableOnly: options.availableOnly === undefined || options.availableOnly === null
      ? undefined
      : options.availableOnly === true ? "true" : "false",
  }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
);

export const fetchLibraryPage = (options = {}, { signal } = {}) =>
  getData("/library/canonical", { params: libraryPageParams(options), signal });

export const getLibraryPage = (options = {}, { signal } = {}) => {
  const params = libraryPageParams(options);
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryPage(params),
    queryFn: ({ signal: querySignal }) => fetchLibraryPage(
      options,
      { signal: mergeSignals(signal, querySignal) },
    ),
    staleTime: 15_000,
  });
};

export const clearLibraryPageCache = () => {
  bumpLibraryPageGeneration();
  return queryClient.removeQueries({
    queryKey: queryKeys.libraryPagePrefix,
    predicate: (query) => query.state.fetchStatus !== "fetching",
  });
};

export const settleLibraryOwnerConflict = (error) => {
  const conflict = getLibraryOwnerConflict(error);
  if (!conflict) return null;
  clearLibraryPageCache();
  queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  return conflict;
};

export const requestLibraryRefresh = (mode = "quick") =>
  postData("/library/refresh", { mode });

export const updateLibraryArtistMbid = async (artistId, mbid) => {
  const result = await putData(
    `/library/canonical/artists/${encodeURIComponent(artistId)}/mbid`,
    { mbid },
  );
  clearLibraryPageCache();
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  return result;
};

export const getLibraryTrackFiles = (trackId, options = {}) =>
  getData(`/library/tracks/${encodeURIComponent(trackId)}/files`, options);

export const getActiveLibraryRefresh = () => getData("/library/refresh");

export const getLibraryRefreshStatus = (jobId) =>
  getData(`/library/refresh/${encodeURIComponent(jobId)}`);

let libraryFavoritesGeneration = 0;
let latestLibraryFavorites = null;
let libraryFavoritesRefresh = null;
let libraryFavoritesWrite = Promise.resolve();

export const fetchLibraryFavorites = ({ signal } = {}) =>
  getData("/library/favorites", { signal });

const waitForLibraryFavoritesRefresh = async () => {
  let waited = false;
  while (libraryFavoritesRefresh) {
    waited = true;
    const pending = libraryFavoritesRefresh;
    await pending;
  }
  return waited;
};

export const getLibraryFavorites = async ({ signal } = {}) => {
  const generation = libraryFavoritesGeneration;
  const data = await queryClient.fetchQuery({
    queryKey: queryKeys.libraryFavorites,
    queryFn: ({ signal: querySignal }) => fetchLibraryFavorites({ signal: mergeSignals(signal, querySignal) }),
    staleTime: 30_000,
  });
  const waitedForRefresh = await waitForLibraryFavoritesRefresh();
  if (generation === libraryFavoritesGeneration && !waitedForRefresh) return data;
  const repaired = latestLibraryFavorites || queryClient.getQueryData(queryKeys.libraryFavorites) || data;
  queryClient.setQueryData(queryKeys.libraryFavorites, repaired);
  return repaired;
};

export const clearLibraryFavoritesCache = () => {
  libraryFavoritesGeneration += 1;
  latestLibraryFavorites = null;
};

const writeLibraryFavorites = (send) => {
  const generation = ++libraryFavoritesGeneration;
  const write = libraryFavoritesWrite.then(async () => {
    try {
      const data = await send();
      if (generation !== libraryFavoritesGeneration) return data;
      try {
        const refreshed = await fetchLibraryFavorites();
        if (generation !== libraryFavoritesGeneration) return data;
        latestLibraryFavorites = refreshed;
        queryClient.setQueryData(queryKeys.libraryFavorites, refreshed);
      } catch {
        if (generation === libraryFavoritesGeneration) {
          latestLibraryFavorites = null;
          queryClient.invalidateQueries({ queryKey: queryKeys.libraryFavorites });
        }
      }
      return data;
    } finally {
      clearLibraryPageCache();
    }
  });
  const pending = write.catch(() => {});
  libraryFavoritesWrite = pending;
  libraryFavoritesRefresh = pending;
  pending.then(() => {
    if (libraryFavoritesRefresh === pending) libraryFavoritesRefresh = null;
  });
  return write;
};

export const updateLibraryFavorites = (ids, starred) =>
  writeLibraryFavorites(() => postData("/library/favorites", { ids, starred }));

export const restoreLibraryFavorites = (favorites) =>
  writeLibraryFavorites(() => postData("/library/favorites/restore", { favorites }));

const normalizeLibraryArtist = (artist) =>
  artist && !artist.foreignArtistId
    ? { ...artist, foreignArtistId: artist.mbid }
    : artist;

const fetchLibraryArtist = async (mbid, { signal } = {}) =>
  normalizeLibraryArtist(await getData(`/library/artists/${mbid}`, { signal }));

export const getLibraryArtist = (mbid, { signal, bypassCache = false } = {}) => {
  if (signal && !bypassCache) return fetchLibraryArtist(mbid, { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryArtist(mbid),
    queryFn: ({ signal: querySignal }) => fetchLibraryArtist(mbid, { signal: querySignal }),
    staleTime: bypassCache ? 0 : 15_000,
  });
};

const fetchLibraryArtistLookup = (mbid, { signal } = {}) =>
  getData(`/library/lookup/${mbid}`, { signal });

export const lookupArtistInLibrary = (mbid, { signal, bypassCache = false } = {}) => {
  if (signal && !bypassCache) return fetchLibraryArtistLookup(mbid, { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryLookupDetails(mbid),
    queryFn: ({ signal: querySignal }) => fetchLibraryArtistLookup(mbid, { signal: querySignal }),
    staleTime: bypassCache ? 0 : 15_000,
  });
};

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
  const ids = [...new Set((Array.isArray(mbids) ? mbids : []).filter(Boolean))].sort();
  if (!ids.length) return {};
  const data = await queryClient.fetchQuery({
    queryKey: queryKeys.libraryLookupBatch(ids),
    queryFn: async ({ signal }) => {
      const lookup = {};
      for (let index = 0; index < ids.length; index += 100) {
        Object.assign(
          lookup,
          await postData("/library/lookup/batch", { mbids: ids.slice(index, index + 100) }, { signal }),
        );
      }
      return lookup;
    },
    staleTime: 60_000,
  });
  writeLibraryLookupCache(data);
  return data;
};

export const lookupAlbumsInLibraryBatch = (mbids, { signal, bypassCache = false } = {}) => {
  const ids = [...new Set((Array.isArray(mbids) ? mbids : []).filter(Boolean))].sort();
  if (!ids.length) return Promise.resolve({});
  if (bypassCache) {
    return postData("/library/albums/lookup/batch", { mbids: ids }, { signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryAlbumLookup(ids),
    queryFn: ({ signal: querySignal }) =>
      postData("/library/albums/lookup/batch", { mbids: ids }, { signal: querySignal }),
    staleTime: 15_000,
  });
};

export const getActiveDownloads = ({ signal } = {}) =>
  getData("/library/downloads/active", { signal });

export const refreshActiveDownloads = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.activeDownloads });

const markDownloadStarted = (started) => {
  queryClient.setQueryData(queryKeys.activeDownloads, (current) =>
    addActiveDownload(current, started));
  void refreshActiveDownloads();
};

const refreshActiveDownloadsAfter = async (request) => {
  try {
    return await request;
  } finally {
    void refreshActiveDownloads();
  }
};

export const addArtistToLibrary = async (artistData) => {
  const result = await refreshActiveDownloadsAfter(postData("/library/artists", artistData));
  const mbid =
    result?.artist?.mbid ||
    result?.artist?.foreignArtistId ||
    result?.foreignArtistId ||
    artistData?.foreignArtistId;
  if (mbid) queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
  return result;
};

export const deleteArtistFromLibrary = (mbid, deleteFiles = false, manager = null) =>
  deleteData(`/library/artists/${mbid}`, {
    params: { deleteFiles, ...(manager ? { manager } : {}) },
  });

export const getArtistMonitoring = (mbid, { signal } = {}) =>
  getData(`/library/artists/${encodeURIComponent(mbid)}/monitoring`, { signal });

export const deleteLidarrAlbumFromLibrary = (mbid, deleteFiles = false) =>
  deleteData(`/library/albums/lidarr/${encodeURIComponent(mbid)}`, {
    params: { deleteFiles },
  });

export const deleteAlbumFromLibrary = (id, deleteFiles = false) =>
  deleteData(`/library/albums/${id}`, {
    params: { deleteFiles },
  });

export const deleteAurralAlbumFromLibrary = (canonicalId, deleteFiles = false) =>
  deleteData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}`, {
    params: { deleteFiles },
  });

export const deleteTrackFromLibrary = (id) =>
  deleteData(`/library/tracks/${encodeURIComponent(id)}`);

const fetchLibraryAlbums = async (artistId, { signal, managedBy = null } = {}) => {
  const data = await getData("/library/albums", {
    params: { artistId, ...(managedBy ? { managedBy } : {}) },
    signal,
  });
  return data.map((album) => ({
    ...album,
    foreignAlbumId: album.foreignAlbumId || album.mbid,
  }));
};

export const getLibraryAlbums = (artistId, { signal, bypassCache = false, managedBy = null } = {}) => {
  if (signal && !bypassCache) return fetchLibraryAlbums(artistId, { signal, managedBy });
  return queryClient.fetchQuery({
    queryKey: [...queryKeys.libraryAlbums(artistId), managedBy],
    queryFn: ({ signal: querySignal }) => fetchLibraryAlbums(artistId, { signal: querySignal, managedBy }),
    staleTime: bypassCache ? 0 : 15_000,
  });
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

export const requestAlbumFromSearch = async (payload) => {
  const started = { albumMbid: payload?.albumMbid, artistMbid: payload?.artistMbid };
  const previous = queryClient.getQueryData(queryKeys.activeDownloads);
  const optimistic = queryClient.setQueryData(queryKeys.activeDownloads, (current) =>
    addActiveDownload(current, started));
  let result;
  try {
    result = await postData("/library/albums/request", payload, {
      timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (queryClient.getQueryData(queryKeys.activeDownloads) === optimistic) {
      queryClient.setQueryData(queryKeys.activeDownloads, previous ?? normalizeActiveDownloads(previous));
    }
    void refreshActiveDownloads();
    throw error;
  }
  if (result?.status === "available") {
    void refreshActiveDownloads();
  } else {
    markDownloadStarted(started);
  }
  return result;
};

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
  refreshActiveDownloadsAfter(putData(`/library/artists/${mbid}`, data));

export const downloadAlbum = (artistId, albumId, options = {}) =>
  refreshActiveDownloadsAfter(postData("/library/downloads/album", {
    artistId,
    albumId,
    artistMbid: options.artistMbid,
    artistName: options.artistName,
  }));

export const downloadTrackToLibrary = async (track) => {
  const result = await postData("/library/downloads/track", track);
  if (result?.queued) {
    markDownloadStarted({
      track: {
        mbid: track?.trackMbid || null,
        artistName: track?.artistName,
        trackName: track?.trackName,
      },
    });
  } else {
    void refreshActiveDownloads();
  }
  return result;
};

export const reSearchLibraryTrack = (trackId, { albumId } = {}) =>
  refreshActiveDownloadsAfter(postData(`/library/downloads/tracks/${encodeURIComponent(trackId)}/research`, {
    albumId,
  }));

export const triggerAlbumSearch = (albumId) =>
  refreshActiveDownloadsAfter(postData("/library/downloads/album/search", {
    albumId,
  }));

export const getDownloadStatus = async (albumIds, { signal, bypassCache = false } = {}) => {
  const ids = [...new Set((Array.isArray(albumIds) ? albumIds : [albumIds]).filter(Boolean))].sort();
  if (!ids.length) return {};
  if (bypassCache) {
    return getData(`/library/downloads/status?albumIds=${ids.join(",")}`, { signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.downloadStatus(ids),
    queryFn: ({ signal: querySignal }) =>
      getData(`/library/downloads/status?albumIds=${ids.join(",")}`, {
        signal: querySignal,
      }),
    staleTime: 4_000,
  });
};

export const getAurralAlbumStatus = (canonicalId, { signal } = {}) =>
  getData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}/status`, { signal });

export const cancelAurralAlbum = (canonicalId) =>
  refreshActiveDownloadsAfter(postData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}/cancel`));

export const setAurralAlbumMonitoring = (canonicalId, monitored) =>
  refreshActiveDownloadsAfter(putData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}`, { monitored }));

export const setAurralTrackMonitoring = (canonicalId, monitored) =>
  refreshActiveDownloadsAfter(putData(`/library/tracks/aurral/${encodeURIComponent(canonicalId)}`, { monitored }));

export const refreshLibraryArtist = (mbid) =>
  postData(`/library/artists/${mbid}/refresh`);

export const getRequests = ({ refresh = false, signal } = {}) =>
  getData("/requests", { params: refresh ? { refresh: 1 } : {}, signal });

export const getRecentlyAdded = ({ signal } = {}) => getData("/library/recent", { signal });

export const getRecentReleases = ({ signal } = {}) => getData("/library/recent-releases", { signal });
