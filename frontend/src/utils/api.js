import axios from "axios";

const normalizeBasePath = (baseUrl) => {
  const raw = (baseUrl || "/").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
};

const getDefaultApiBaseUrl = () => {
  if (import.meta.env.DEV) return "/api";
  const basePath = normalizeBasePath(
    import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL,
  );
  if (basePath === "/") return "/api";
  return `${basePath}/api`;
};

const API_BASE_URL = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

export const AUTH_INVALID_EVENT = "aurral:auth-invalid";

const AUTH_TOKEN_KEY = "auth_token";
const AUTH_PASSWORD_KEY = "auth_password";
const AUTH_USER_KEY = "auth_user";

function readAuthFromStorage(storage) {
  if (!storage) return { token: "" };
  return {
    token: storage.getItem(AUTH_TOKEN_KEY) || "",
  };
}

export const getStoredAuth = () => {
  const localAuth = readAuthFromStorage(globalThis?.localStorage);
  if (localAuth.token) return localAuth;
  const sessionAuth = readAuthFromStorage(globalThis?.sessionStorage);
  if (sessionAuth.token && globalThis?.localStorage) {
    globalThis.localStorage.setItem(AUTH_TOKEN_KEY, sessionAuth.token);
    return sessionAuth;
  }
  return sessionAuth;
};

export const setStoredAuth = ({ token = "" } = {}) => {
  if (!token) {
    globalThis?.sessionStorage?.removeItem(AUTH_TOKEN_KEY);
    globalThis?.localStorage?.removeItem(AUTH_TOKEN_KEY);
    return;
  }
  globalThis?.sessionStorage?.setItem(AUTH_TOKEN_KEY, token);
  globalThis?.localStorage?.setItem(AUTH_TOKEN_KEY, token);
  globalThis.localStorage?.removeItem(AUTH_PASSWORD_KEY);
  globalThis.localStorage?.removeItem(AUTH_USER_KEY);
};

export const clearAuthStorage = () => {
  globalThis?.sessionStorage?.removeItem(AUTH_TOKEN_KEY);
  globalThis?.localStorage?.removeItem(AUTH_TOKEN_KEY);
  globalThis?.sessionStorage?.removeItem(AUTH_PASSWORD_KEY);
  globalThis?.sessionStorage?.removeItem(AUTH_USER_KEY);
  globalThis?.localStorage?.removeItem(AUTH_PASSWORD_KEY);
  globalThis?.localStorage?.removeItem(AUTH_USER_KEY);
};

const libraryLookupCache = new Map();
const MAX_LIBRARY_LOOKUP_CACHE_SIZE = 1000;
const coverResponseCache = new Map();
const coverInflightRequests = new Map();
const MAX_COVER_CACHE_SIZE = 1000;
const COVER_CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY_COVER_CACHE_TTL_MS = 60 * 1000;
const searchInflightRequests = new Map();

const setLibraryLookupCacheEntry = (id, value) => {
  if (id == null) return;
  if (libraryLookupCache.has(id)) {
    libraryLookupCache.delete(id);
  }
  libraryLookupCache.set(id, value);
  if (libraryLookupCache.size > MAX_LIBRARY_LOOKUP_CACHE_SIZE) {
    const oldestKey = libraryLookupCache.keys().next().value;
    if (oldestKey !== undefined) {
      libraryLookupCache.delete(oldestKey);
    }
  }
};

const setCoverCacheEntry = (key, value) => {
  if (!key) return;
  const images = Array.isArray(value?.images) ? value.images : [];
  const ttlMs = images.length > 0 ? COVER_CACHE_TTL_MS : EMPTY_COVER_CACHE_TTL_MS;
  if (coverResponseCache.has(key)) {
    coverResponseCache.delete(key);
  }
  coverResponseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  if (coverResponseCache.size > MAX_COVER_CACHE_SIZE) {
    const oldestKey = coverResponseCache.keys().next().value;
    if (oldestKey !== undefined) {
      coverResponseCache.delete(oldestKey);
    }
  }
};

const getCoverCacheEntry = (key) => {
  const entry = coverResponseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= Number(entry.expiresAt || 0)) {
    coverResponseCache.delete(key);
    return null;
  }
  return entry.value;
};

const fetchCoverWithMemo = async (key, requestFactory, { bypassCache = false } = {}) => {
  if (!bypassCache) {
    const cached = getCoverCacheEntry(key);
    if (cached) {
      return cached;
    }
  }

  if (coverInflightRequests.has(key)) {
    return coverInflightRequests.get(key);
  }

  const request = requestFactory()
    .then((response) => {
      setCoverCacheEntry(key, response);
      return response;
    })
    .finally(() => {
      coverInflightRequests.delete(key);
    });

  coverInflightRequests.set(key, request);
  return request;
};

const fetchInflightOnce = async (store, key, requestFactory) => {
  if (store.has(key)) {
    return store.get(key);
  }

  const request = requestFactory().finally(() => {
    store.delete(key);
  });
  store.set(key, request);
  return request;
};

api.interceptors.request.use(
  (config) => {
    const { token } = getStoredAuth();
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    const code = error?.response?.data?.code;
    if (status === 401 && code === "SESSION_INVALID") {
      clearAuthStorage();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_INVALID_EVENT));
      }
    }
    return Promise.reject(error);
  },
);

export const checkHealth = async () => {
  const response = await api.get("/health");
  return response.data;
};

export const getBootstrapStatus = async () => {
  const response = await api.get("/health/bootstrap");
  return response.data;
};

export const browseFilesystem = async (pathValue) => {
  const response = await api.get("/filesystem/browse", {
    params: pathValue ? { path: pathValue } : undefined,
  });
  return response.data;
};

export const ensureFilesystemPath = async (pathValue) => {
  const response = await api.post("/filesystem/ensure", {
    path: pathValue,
  });
  return response.data;
};

export const loginApi = async (username, password) => {
  const response = await api.post("/auth/login", { username, password });
  return response.data;
};

export const logoutApi = async () => {
  const response = await api.post("/auth/logout");
  return response.data;
};

export const getMe = async () => {
  const response = await api.get("/auth/me");
  return response.data;
};

export const completeOnboarding = async (payload) => {
  const response = await api.post("/onboarding/complete", payload);
  return response.data;
};

export const testLidarrOnboarding = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url.replace(/\/+$/, ""));
  if (apiKey) params.append("apiKey", apiKey);
  const response = await api.get(
    `/onboarding/lidarr/test${params.toString() ? `?${params.toString()}` : ""}`,
  );
  return response.data;
};

export const testNavidromeOnboarding = async (url, username, password) => {
  const response = await api.post("/onboarding/navidrome/test", {
    url: url?.replace(/\/+$/, ""),
    username,
    password,
  });
  return response.data;
};

export const startPlexAuth = async (forwardUrl) => {
  const response = await api.post("/settings/plex/auth/pin", { forwardUrl });
  return response.data;
};

export const checkPlexAuth = async (pinId, code) => {
  const response = await api.post("/settings/plex/auth/check", { pinId, code });
  return response.data;
};

export const getPlexResources = async (token) => {
  const response = await api.post("/settings/plex/resources", { token });
  return response.data;
};

export const testPlexConnection = async (url, token) => {
  const response = await api.post("/settings/plex/test", {
    url: url?.replace(/\/+$/, ""),
    token,
  });
  return response.data;
};

export const syncPlexNow = async () => {
  const response = await api.post("/settings/plex/sync");
  return response.data;
};

export const browsePaths = async (path) => {
  const response = await api.get("/settings/browse", {
    params: path ? { path } : {},
  });
  return response.data;
};

export const searchUnified = async (
  query,
  { mode = "suggest", limit } = {},
) => {
  const params = { q: query, mode };
  if (limit != null) {
    params.limit = limit;
  }
  const key = `search-unified:${JSON.stringify(params)}`;
  const timeoutMs = mode === "full" ? 30000 : 12000;
  return fetchInflightOnce(searchInflightRequests, key, async () => {
    const response = await api.get("/search/unified", {
      params,
      timeout: timeoutMs,
    });
    return response.data;
  });
};

export const searchCatalog = async (
  query,
  scope = "artist",
  {
    limit = 24,
    offset = 0,
    releaseTypes = [],
    sort,
  } = {},
) => {
  const params = { q: query, scope, limit, offset };
  if (scope === "album") {
    if (Array.isArray(releaseTypes) && releaseTypes.length) {
      params.releaseTypes = releaseTypes.join(",");
    }
    if (sort) {
      params.sort = sort;
    }
  }
  const key = `search:${JSON.stringify(params)}`;
  return fetchInflightOnce(searchInflightRequests, key, async () => {
    const response = await api.get("/search", { params });
    return response.data;
  });
};

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
  const response = await api.get(`/artists/${mbid}`, {
    params,
  });
  return response.data;
};

export const getReleaseGroupDetails = async (mbid) => {
  const response = await api.get(`/artists/release-group/${mbid}`);
  return response.data;
};

export const getReleaseGroupTracks = async (mbid, context = {}) => {
  const params = {};
  if (context.artistMbid) params.artistMbid = context.artistMbid;
  if (context.artistName) params.artistName = context.artistName;
  if (context.albumTitle) params.albumTitle = context.albumTitle;
  if (context.releaseType) params.releaseType = context.releaseType;
  if (context.releaseDate) params.releaseDate = context.releaseDate;
  if (context.deezerAlbumId) params.deezerAlbumId = context.deezerAlbumId;
  const response = await api.get(`/artists/release-group/${mbid}/tracks`, {
    params,
  });
  return response.data;
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
    async () => {
      const response = await api.get(`/artists/${mbid}/cover`, {
        params,
        timeout: 4000,
      });
      return response.data;
    },
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
  const request = api
    .post("/artists/release-groups/covers", { items: normalizedItems })
    .then((response) => response.data?.covers || {})
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
    const response = await api.get(`/artists/release-group/${mbid}/cover`, {
      params,
    });
    if (!response.data?.transientError) {
      setCoverCacheEntry(cacheKey, response.data);
    }
    return response.data;
  })().finally(() => {
    coverInflightRequests.delete(cacheKey);
  });
  coverInflightRequests.set(cacheKey, request);
  return request;
};

export const getSimilarArtistsForArtist = async (
  mbid,
  artistName = "",
  limit = 20,
) => {
  const response = await api.get(`/artists/${mbid}/similar`, {
    params: {
      limit,
      ...(artistName && typeof artistName === "string" && artistName.trim()
        ? { artistName: artistName.trim() }
        : {}),
    },
  });
  return response.data;
};

export const getArtistPreview = async (mbid, artistName) => {
  const response = await api.get(`/artists/${mbid}/preview`, {
    params: artistName ? { artistName } : {},
  });
  return response.data;
};

export const getArtistTopSongVideo = async (
  mbid,
  artistName,
  trackTitle,
  options = {},
) => {
  const response = await api.get(`/artists/${mbid}/video`, {
    params: { artistName, trackTitle },
    signal: options.signal,
  });
  return response.data;
};

export const getArtistOverrides = async (mbid) => {
  const response = await api.get(`/artists/${mbid}/overrides`);
  return response.data;
};

export const updateArtistOverrides = async (
  mbid,
  { musicbrainzId = null, deezerArtistId = null } = {},
) => {
  const response = await api.put(`/artists/${mbid}/overrides`, {
    musicbrainzId,
    deezerArtistId,
  });
  return response.data;
};

const buildStreamUrl = async (path) => {
  const base = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();
  let relativePath = String(path || "");
  if (!relativePath.startsWith("/")) {
    relativePath = `/${relativePath}`;
  }
  const { token } = getStoredAuth();
  const url = `${base}${relativePath}`;
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
};

export const getFlowTrackStreamUrl = (jobId) => {
  const base = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();
  const { token } = getStoredAuth();
  let url = `${base}/playlists/stream/${encodeURIComponent(jobId)}`;
  if (token) {
    url += `?token=${encodeURIComponent(token)}`;
  }
  return url;
};

export const getFlowArtworkUrl = (playlistId, version) => {
  const base = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();
  const { token } = getStoredAuth();
  const params = new URLSearchParams();
  if (token) {
    params.set("token", token);
  }
  if (version != null && version !== "") {
    params.set("v", String(version));
  }
  const query = params.toString();
  let url = `${base}/playlists/artwork/${encodeURIComponent(playlistId)}`;
  if (query) {
    url += `?${query}`;
  }
  return url;
};

export const uploadFlowArtwork = async (playlistId, file) => {
  const response = await api.put(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    file,
    {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
    },
  );
  return response.data;
};

export const deleteFlowArtwork = async (playlistId) => {
  const response = await api.delete(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
  );
  return response.data;
};

export const generateFlowArtwork = async (playlistId) => {
  const response = await api.post(
    `/playlists/artwork/${encodeURIComponent(playlistId)}/generate`,
  );
  return response.data;
};

export const getLibraryArtists = async (options = {}) => {
  const response = await api.get("/library/artists", options);
  return response.data;
};

export const getLibraryArtist = async (mbid) => {
  const response = await api.get(`/library/artists/${mbid}`);
  const artist = response.data;
  if (artist && !artist.foreignArtistId) {
    artist.foreignArtistId = artist.mbid;
  }
  return artist;
};

export const lookupArtistInLibrary = async (mbid) => {
  const response = await api.get(`/library/lookup/${mbid}`);
  return response.data;
};

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
  const response = await api.post("/library/lookup/batch", { mbids });
  const data = response.data;
  writeLibraryLookupCache(data);
  return data;
};

export const lookupAlbumsInLibraryBatch = async (mbids) => {
  const response = await api.post("/library/albums/lookup/batch", { mbids });
  return response.data;
};

export const addArtistToLibrary = async (artistData) => {
  const response = await api.post("/library/artists", artistData);
  return response.data;
};

export const deleteArtistFromLibrary = async (mbid, deleteFiles = false) => {
  const response = await api.delete(`/library/artists/${mbid}`, {
    params: { deleteFiles },
  });
  return response.data;
};

export const deleteAlbumFromLibrary = async (id, deleteFiles = false) => {
  const response = await api.delete(`/library/albums/${id}`, {
    params: { deleteFiles },
  });
  return response.data;
};

export const getLibraryAlbums = async (artistId) => {
  const response = await api.get("/library/albums", {
    params: { artistId },
  });
  return response.data.map((album) => ({
    ...album,
    foreignAlbumId: album.foreignAlbumId || album.mbid,
  }));
};

export const addLibraryAlbum = async (
  artistId,
  releaseGroupMbid,
  albumName,
) => {
  const response = await api.post("/library/albums", {
    artistId,
    releaseGroupMbid,
    albumName,
  });
  return response.data;
};

export const requestAlbumFromSearch = async (payload) => {
  const response = await api.post("/library/albums/request", payload);
  return response.data;
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
  const response = await api.get("/library/tracks", { params });
  const tracks = Array.isArray(response.data) ? response.data : [];
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

export const updateLibraryAlbum = async (id, data) => {
  const response = await api.put(`/library/albums/${id}`, data);
  return response.data;
};

export const updateLibraryArtist = async (mbid, data) => {
  const response = await api.put(`/library/artists/${mbid}`, data);
  return response.data;
};

export const downloadAlbum = async (artistId, albumId, options = {}) => {
  const response = await api.post("/library/downloads/album", {
    artistId,
    albumId,
    artistMbid: options.artistMbid,
    artistName: options.artistName,
  });
  return response.data;
};

export const triggerAlbumSearch = async (albumId) => {
  const response = await api.post("/library/downloads/album/search", {
    albumId,
  });
  return response.data;
};

export const getDownloadStatus = async (albumIds) => {
  const ids = Array.isArray(albumIds) ? albumIds.join(",") : albumIds;
  const response = await api.get(`/library/downloads/status?albumIds=${ids}`);
  return response.data;
};

export const refreshLibraryArtist = async (mbid) => {
  const response = await api.post(`/library/artists/${mbid}/refresh`);
  return response.data;
};

export const getRequests = async () => {
  const response = await api.get("/requests");
  return response.data;
};

export const getRecentlyAdded = async () => {
  const response = await api.get("/library/recent");
  return response.data;
};

export const getRecentReleases = async () => {
  const response = await api.get("/library/recent-releases");
  return response.data;
};

export const getDiscovery = async (cacheBust = false) => {
  const params = cacheBust ? { _: Date.now() } : {};
  const response = await api.get("/discover", { params });
  return response.data;
};

export const adoptDiscoverPlaylistAsFlow = async (presetId) => {
  const response = await api.post("/discover/playlists/adopt", { presetId });
  return response.data;
};

export const adoptDiscoverPlaylistAsStatic = async (presetId) => {
  const response = await api.post("/discover/playlists/adopt-playlist", {
    presetId,
  });
  return response.data;
};

export const getDiscoverArtworkUrl = (presetId, version) => {
  const base = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();
  const { token } = getStoredAuth();
  const params = new URLSearchParams();
  if (token) {
    params.set("token", token);
  }
  if (version != null && version !== "") {
    params.set("v", String(version));
  }
  const query = params.toString();
  let url = `${base}/discover/artwork/${encodeURIComponent(presetId)}`;
  if (query) {
    url += `?${query}`;
  }
  return url;
};

export const getNearbyShows = async (zipCode = "", limit, options = {}) => {
  const params = { _: Date.now() };
  if (typeof zipCode === "string" && zipCode.trim()) {
    params.zip = zipCode.trim();
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.limit = Math.floor(limit);
  }
  const response = await api.get("/discover/nearby-shows", {
    ...options,
    params: {
      ...(options.params || {}),
      ...params,
    },
  });
  return response.data;
};

export const getDiscoveryFeedback = async () => {
  const response = await api.get("/discover/feedback");
  return response.data;
};

export const addDiscoveryFeedback = async (payload) => {
  const response = await api.post("/discover/feedback", payload);
  return response.data;
};

export const removeDiscoveryFeedback = async (id) => {
  const response = await api.delete(`/discover/feedback/${encodeURIComponent(id)}`);
  return response.data;
};

export const resetDiscoveryFeedback = async () => {
  const response = await api.post("/discover/feedback/reset");
  return response.data;
};

export const getTagSuggestions = async (q, limit = 10) => {
  const response = await api.get("/discover/tags", {
    params: { q: q.trim(), limit },
  });
  return response.data;
};

export const getUsers = async () => {
  const response = await api.get("/users");
  return response.data;
};

export const createUser = async (username, password, role, permissions) => {
  const response = await api.post("/users", {
    username,
    password,
    role,
    permissions,
  });
  return response.data;
};

export const updateUser = async (id, data) => {
  const response = await api.patch(`/users/${id}`, data);
  return response.data;
};

export const deleteUser = async (id) => {
  await api.delete(`/users/${id}`);
};

export const changeMyPassword = async (currentPassword, newPassword) => {
  await api.post("/users/me/password", { currentPassword, newPassword });
};

export const getMyListeningHistory = async () => {
  const response = await api.get("/users/me/listening-history");
  return response.data;
};

export const getMyLidarrPreferences = async () => {
  const response = await api.get("/users/me/lidarr-preferences");
  return response.data;
};

export const getMyDiscoverLayout = async () => {
  const response = await api.get("/users/me/discover-layout");
  return response.data;
};

export const updateMyListeningHistory = async (userId, payload) => {
  const response = await api.patch(`/users/${userId}`, payload);
  return response.data;
};

export const updateMyLidarrPreferences = async (payload) => {
  const response = await api.patch("/users/me/lidarr-preferences", payload);
  return response.data;
};

export const updateMyDiscoverLayout = async (layout) => {
  const response = await api.patch("/users/me/discover-layout", { layout });
  return response.data;
};

export const getAppSettings = async () => {
  const response = await api.get("/settings");
  return response.data;
};

export const updateAppSettings = async (settings) => {
  const response = await api.post("/settings", settings);
  return response.data;
};

export const getLidarrProfiles = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/settings/lidarr/profiles${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const getLidarrMetadataProfiles = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/settings/lidarr/metadata-profiles${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const getLidarrTags = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/settings/lidarr/tags${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const testSlskdConnection = async () => {
  const response = await api.post("/settings/slskd/test");
  return response.data;
};

export const testLidarrConnection = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/settings/lidarr/test${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const detectPathMappings = async () => {
  const response = await api.post("/settings/path-mappings/detect");
  return response.data;
};

export const testLidarrLibraryAccess = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/settings/lidarr/test-library-access${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const testLidarrLibraryAccessOnboarding = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/onboarding/lidarr/test-library-access${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const getLidarrProfilesOnboarding = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/onboarding/lidarr/profiles${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const getLidarrMetadataProfilesOnboarding = async (url, apiKey) => {
  const params = new URLSearchParams();
  if (url) params.append("url", url);
  if (apiKey) params.append("apiKey", apiKey);
  const queryString = params.toString();
  const endpoint = `/onboarding/lidarr/metadata-profiles${
    queryString ? `?${queryString}` : ""
  }`;
  const response = await api.get(endpoint);
  return response.data;
};

export const applyLidarrCommunityGuideOnboarding = async (url, apiKey) => {
  const response = await api.post("/onboarding/lidarr/apply-community-guide", {
    url: url?.replace(/\/+$/, ""),
    apiKey,
  });
  return response.data;
};

export const testSlskdOnboarding = async (url, apiKey) => {
  const response = await api.post("/onboarding/slskd/test", {
    url: url?.replace(/\/+$/, ""),
    apiKey,
  });
  return response.data;
};

export const testGotifyConnection = async (url, token) => {
  const response = await api.post("/settings/gotify/test", { url, token });
  return response.data;
};

export const applyLidarrCommunityGuide = async () => {
  const response = await api.post("/settings/lidarr/apply-community-guide");
  return response.data;
};

export const getFlowStatus = async ({
  includeJobs = false,
  flowId,
  jobsLimit,
  signal,
} = {}) => {
  const params = {};
  if (includeJobs) {
    params.includeJobs = "1";
  }
  if (flowId) {
    params.flowId = flowId;
  }
  if (jobsLimit != null) {
    params.jobsLimit = jobsLimit;
  }
  const response = await api.get("/playlists/status", { params, signal });
  return response.data;
};

export const getFlowJobs = async (flowId, limit = 200, options = {}) => {
  const response = await api.get(`/playlists/jobs/${flowId}`, {
    ...options,
    params: {
      ...(options.params || {}),
      limit,
    },
  });
  return response.data;
};

export const createFlow = async (payload) => {
  const response = await api.post("/playlists/flows", payload);
  return response.data;
};

export const updateFlow = async (flowId, payload) => {
  const response = await api.put(`/playlists/flows/${flowId}`, payload);
  return response.data;
};

export const deleteFlow = async (flowId) => {
  const response = await api.delete(`/playlists/flows/${flowId}`);
  return response.data;
};

export const convertFlowToStaticPlaylist = async (flowId, payload = {}) => {
  const response = await api.post(
    `/playlists/flows/${flowId}/static-playlist`,
    payload,
  );
  return response.data;
};

export const createSharedPlaylist = async (payload) => {
  const response = await api.post("/playlists/shared-playlists", payload);
  return response.data;
};

export const setFlowEnabled = async (flowId, enabled) => {
  const response = await api.put(`/playlists/flows/${flowId}/enabled`, {
    enabled,
  });
  return response.data;
};

export const importSharedPlaylist = async (payload) => {
  const response = await api.post(
    "/playlists/shared-playlists/import",
    payload,
  );
  return response.data;
};

export const updateSharedPlaylist = async (playlistId, payload) => {
  const response = await api.put(
    `/playlists/shared-playlists/${playlistId}`,
    payload,
  );
  return response.data;
};

export const addSharedPlaylistTracks = async (playlistId, payload) => {
  const response = await api.post(
    `/playlists/shared-playlists/${playlistId}/tracks`,
    payload,
  );
  return response.data;
};

export const deleteSharedPlaylist = async (playlistId) => {
  const response = await api.delete(
    `/playlists/shared-playlists/${playlistId}`,
  );
  return response.data;
};

export const deleteSharedPlaylistTrack = async (playlistId, jobId) => {
  const response = await api.delete(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}`,
  );
  return response.data;
};

export const reSearchSharedPlaylistTrack = async (playlistId, jobId) => {
  const response = await api.post(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}/research`,
  );
  return response.data;
};

export const startFlowPlaylist = async (flowId, limit = 30) => {
  const response = await api.post(`/playlists/start/${flowId}`, {
    limit,
  });
  return response.data;
};

export default api;
