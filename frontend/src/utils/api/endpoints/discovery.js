import { getData, postData, deleteData, buildAuthenticatedApiUrl } from "../core.js";

export const getDiscovery = (options = false) => {
  const params = {};
  let signal;
  if (typeof options === "boolean") {
    if (options) params._ = Date.now();
  } else if (options && typeof options === "object") {
    const { offset, limit, cacheBust } = options;
    signal = options.signal;
    if (cacheBust) params._ = Date.now();
    if (typeof offset === "number") params.offset = offset;
    if (typeof limit === "number") params.limit = limit;
  }
  return getData("/discover", { params, signal });
};

export const adoptDiscoverPlaylistAsFlow = (presetId) =>
  postData("/discover/playlists/adopt", { presetId });

export const adoptDiscoverPlaylistAsStatic = (presetId) =>
  postData("/discover/playlists/adopt-playlist", {
    presetId,
  });

export const getDiscoverPlaylistPreviews = (presetId, options = {}) =>
  getData(`/discover/playlists/${encodeURIComponent(presetId)}/previews`, options);

export const getDiscoverArtworkUrl = (presetId, version) =>
  buildAuthenticatedApiUrl(
    `/discover/artwork/${encodeURIComponent(presetId)}`,
    { v: version },
  );

export const getNearbyShows = async (zipCode = "", limit, options = {}) => {
  const params = {};
  if (options.cacheBust) params._ = Date.now();
  if (typeof zipCode === "string" && zipCode.trim()) {
    params.zip = zipCode.trim();
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.limit = Math.floor(limit);
  }
  return getData("/discover/nearby-shows", {
    ...options,
    params: {
      ...(options.params || {}),
      ...params,
    },
  });
};

export const getDiscoveryFeedback = () => getData("/discover/feedback");

export const addDiscoveryFeedback = (payload) =>
  postData("/discover/feedback", payload);

export const removeDiscoveryFeedback = (id) =>
  deleteData(`/discover/feedback/${encodeURIComponent(id)}`);

export const resetDiscoveryFeedback = () => postData("/discover/feedback/reset");

export const getTagSuggestions = (q, limit = 10) =>
  getData("/discover/tags", {
    params: { q: q.trim(), limit },
  });
