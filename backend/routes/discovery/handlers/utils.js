import { lastfmRequest } from "../../../services/apiClients/index.js";

export const SLSKD_NOT_CONFIGURED_MESSAGE =
  "slskd is not configured. Enable slskd and add its Server URL in Settings > Download clients to enable Soulseek downloads for flows and playlists.";

export const DISCOVERY_REVALIDATE_COOLDOWN_MS = 60 * 1000;
let lastDiscoveryRevalidateAt = 0;

export const getDiscoveryRevalidateAt = () => lastDiscoveryRevalidateAt;
export const setDiscoveryRevalidateAt = (value) => {
  lastDiscoveryRevalidateAt = value;
};

export async function getDiscoveryStaleMs() {
  const { getDiscoveryAutoRefreshHours } = await import("../../../services/discovery/index.js");
  return getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;
}

const pendingTagRequests = new Map();
const pendingTagSuggestRequest = { promise: null, expiry: 0 };

export { pendingTagRequests, pendingTagSuggestRequest };

export const fetchLastfmTopTagNames = async () => {
  const now = Date.now();
  let data;
  if (
    pendingTagSuggestRequest.promise &&
    pendingTagSuggestRequest.expiry > now
  ) {
    data = await pendingTagSuggestRequest.promise;
  } else {
    const fetchPromise = lastfmRequest("chart.getTopTags", { limit: 100 });
    pendingTagSuggestRequest.promise = fetchPromise;
    pendingTagSuggestRequest.expiry = now + 60000;
    data = await fetchPromise;
  }
  if (!data?.tags?.tag) return [];
  const tags = Array.isArray(data.tags.tag) ? data.tags.tag : [data.tags.tag];
  return tags
    .map((tag) => (tag.name != null ? String(tag.name).trim() : ""))
    .filter(Boolean);
};

export const buildArtistKeySet = (artists) => {
  const set = new Set();
  for (const artist of Array.isArray(artists) ? artists : []) {
    [
      artist?.id,
      artist?.mbid,
      artist?.foreignArtistId,
      artist?.name,
      artist?.artistName,
    ].forEach((value) => {
      const key = String(value || "").trim().toLowerCase();
      if (key) set.add(key);
    });
  }
  return set;
};

export const isLibraryArtist = (artist, existingArtistKeys) => {
  if (!artist || !existingArtistKeys?.size) return false;
  return [
    artist.id,
    artist.mbid,
    artist.foreignArtistId,
    artist.name,
    artist.artistName,
  ].some((value) => {
    const key = String(value || "").trim().toLowerCase();
    return key && existingArtistKeys.has(key);
  });
};

export const handleDiscoverAdoptError = (res, error, fallbackError) => {
  if (error?.statusCode === 400) {
    return res.status(400).json({
      error: error.error || "Bad Request",
      message: error.message,
    });
  }
  if (error?.statusCode === 404) {
    return res.status(404).json({
      error: error.error || "Playlist preview not available",
      message: error.message,
    });
  }
  if (error?.code === "FLOW_NAME_CONFLICT") {
    return res.status(400).json({
      error: "Flow name already exists",
      message: error.message,
    });
  }
  if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
    return res.status(400).json({
      error: "Shared playlist name already exists",
      message: error.message,
    });
  }
  return res.status(500).json({
    error: fallbackError,
    message: error.message,
  });
};
