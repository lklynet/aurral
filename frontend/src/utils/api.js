import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

api.interceptors.request.use(
  (config) => {
    const password = localStorage.getItem("auth_password");
    const username = localStorage.getItem("auth_user") || "admin";
    if (password) {
      const token = btoa(`${username}:${password}`);
      config.headers["Authorization"] = `Basic ${token}`;
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
    const message =
      error.response?.data?.message || error.message || "An error occurred";
    console.error("API Error:", message);
    return Promise.reject(error);
  },
);

export const checkHealth = async () => {
  const response = await api.get("/health");
  return response.data;
};

export const getAuthConfig = async () => {
  const response = await api.get("/auth/config");
  return response.data;
};

export const searchArtists = async (query, limit = 20, offset = 0) => {
  const response = await api.get("/search/artists", {
    params: { query, limit, offset },
  });
  return response.data;
};

export const getArtistDetails = async (mbid) => {
  const response = await api.get(`/artists/${mbid}`);
  return response.data;
};

export const getArtistCover = async (mbid) => {
  const response = await api.get(`/artists/${mbid}/cover`);
  return response.data;
};

export const getSimilarArtistsForArtist = async (mbid, limit = 20) => {
  const response = await api.get(`/artists/${mbid}/similar`, {
    params: { limit },
  });
  return response.data;
};

export const getLidarrArtists = async () => {
  const response = await api.get("/lidarr/artists");
  return response.data;
};

export const getLidarrArtist = async (id) => {
  const response = await api.get(`/lidarr/artists/${id}`);
  return response.data;
};

export const lookupArtistInLidarr = async (mbid) => {
  const response = await api.get(`/lidarr/lookup/${mbid}`);
  return response.data;
};

export const lookupArtistsInLidarrBatch = async (mbids) => {
  const response = await api.post("/lidarr/lookup/batch", { mbids });
  return response.data;
};

export const addArtistToLidarr = async (artistData) => {
  const response = await api.post("/lidarr/artists", artistData);
  return response.data;
};

export const deleteArtistFromLidarr = async (id, deleteFiles = false) => {
  const response = await api.delete(`/lidarr/artists/${id}`, {
    params: { deleteFiles },
  });
  return response.data;
};

export const getLidarrRootFolders = async () => {
  const response = await api.get("/lidarr/rootfolder");
  return response.data;
};

export const getLidarrQualityProfiles = async () => {
  const response = await api.get("/lidarr/qualityprofile");
  return response.data;
};

export const getLidarrMetadataProfiles = async () => {
  const response = await api.get("/lidarr/metadataprofile");
  return response.data;
};

export const getLidarrAlbums = async (artistId) => {
  const response = await api.get("/lidarr/albums", {
    params: { artistId },
  });
  return response.data;
};

export const updateLidarrAlbum = async (id, data) => {
  const response = await api.put(`/lidarr/albums/${id}`, data);
  return response.data;
};

export const searchLidarrAlbum = async (albumIds) => {
  const response = await api.post("/lidarr/command/albumsearch", { albumIds });
  return response.data;
};

export const bulkUpdateAlbumMonitoring = async (artistId, albumIds, monitored, searchAfter = false) => {
  const response = await api.post("/lidarr/albums/bulk-monitor", {
    artistId,
    albumIds,
    monitored,
    searchAfter,
  });
  return response.data;
};

export const getRequests = async () => {
  const response = await api.get("/requests");
  return response.data;
};

export const deleteRequest = async (mbid) => {
  const response = await api.delete(`/requests/${mbid}`);
  return response.data;
};

export const getRecentlyAdded = async () => {
  const response = await api.get("/lidarr/recent");
  return response.data;
};

export const getDiscovery = async () => {
  const response = await api.get("/discover");
  return response.data;
};

export const getRelatedArtists = async (limit = 20) => {
  const response = await api.get("/discover/related", {
    params: { limit },
  });
  return response.data;
};

export const getSimilarArtists = async (limit = 20) => {
  const response = await api.get("/discover/similar", {
    params: { limit },
  });
  return response.data;
};

export const searchArtistsByTag = async (tag, limit = 20) => {
  const response = await api.get("/discover/by-tag", {
    params: { tag, limit },
  });
  return response.data;
};

export const verifyCredentials = async (password, username = "admin") => {
  const token = btoa(`${username}:${password}`);
  try {
    await api.get("/settings", {
      headers: {
        Authorization: `Basic ${token}`,
      },
    });
    return true;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      return false;
    }
    throw error;
  }
};

export const getAppSettings = async () => {
  const response = await api.get("/settings");
  return response.data;
};

export const updateAppSettings = async (settings) => {
  const response = await api.post("/settings", settings);
  return response.data;
};

export default api;

