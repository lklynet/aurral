import { getData, postData, deleteData } from "../core.js";

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

export const getDiscoveryStatus = ({ signal } = {}) =>
  getData("/discover/status", { signal });

export const refreshDiscovery = () => postData("/discover/refresh");

export const getEditorialShelf = (options = {}) => getData("/discover/editorial", options);

export const getEditorialPlaylist = (playlistId, options = {}) =>
  getData(`/discover/editorial/${encodeURIComponent(playlistId)}`, options);

export const addEditorialPlaylistToLibrary = (playlistId) =>
  postData(`/discover/editorial/${encodeURIComponent(playlistId)}/library`);

export const resolveEditorialTrackLinks = ({ artistName, albumName, deezerAlbumId }, options = {}) =>
  getData("/discover/editorial/links", {
    ...options,
    params: { artist: artistName, album: albumName || undefined, albumId: deezerAlbumId || undefined },
  });

export const getNearbyShows = ({ zip, country, signal } = {}) =>
  getData("/discover/nearby-shows", {
    signal,
    params: {
      ...(zip ? { zip } : {}),
      ...(country ? { country } : {}),
    },
  });

export const getDiscoveryFeedback = () => getData("/discover/feedback");

export const addDiscoveryFeedback = (payload) =>
  postData("/discover/feedback", payload);

export const removeDiscoveryFeedback = (id) =>
  deleteData(`/discover/feedback/${encodeURIComponent(id)}`);

export const restoreDiscoveryFeedback = ({ removeIds = [], entries = [] }) =>
  postData("/discover/feedback/restore", { removeIds, entries });

export const resetDiscoveryFeedback = () => postData("/discover/feedback/reset");

export const getTagSuggestions = (q, limit = 10) =>
  getData("/discover/tags", {
    params: { q: q.trim(), limit },
  });
