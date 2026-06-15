import { getDiscoverArtworkUrl, getFlowArtworkUrl } from "./api.js";

export function getSearchPlaylistArtworkUrl(playlist) {
  if (!playlist) return null;
  if (playlist.coverUrl) return playlist.coverUrl;
  const presetId = String(playlist.discoverPresetId || "").trim();
  if (playlist.source === "discover" && presetId) {
    return getDiscoverArtworkUrl(presetId);
  }
  const playlistId = String(playlist.id || "").trim();
  if (playlistId && !playlistId.startsWith("discover:")) {
    return getFlowArtworkUrl(playlistId);
  }
  if (presetId) {
    return getDiscoverArtworkUrl(presetId);
  }
  return null;
}
