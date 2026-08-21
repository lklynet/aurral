import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: typeof window === "undefined" ? Infinity : 5 * 60 * 1000,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: 0,
      staleTime: 30 * 1000,
    },
  },
});

export const queryKeys = {
  authBootstrap: ["auth", "bootstrap"],
  discovery: (userId) => ["discovery", "home", userId || null],
  appHealth: ["app", "health"],
  appSettings: ["settings", "app"],
  playbackSettings: ["settings", "playback"],
  activityRequests: (userId) => ["activity", "requests", userId || null],
  inbox: (userId, zip, limit) => ["inbox", userId || null, zip || "", limit],
  listeningHistory: (userId) => ["auth", "listening-history", userId || null],
  lidarrPreferences: (userId) => ["auth", "lidarr-preferences", userId || null],
  libraryFavorites: ["library", "favorites"],
  libraryLookup: (id) => ["library", "lookup", id],
  libraryLookupBatch: (ids) => ["library", "lookup-batch", [...ids].sort()],
  libraryCanonical: (options) => ["library", "canonical", options],
  libraryAlbumLookup: (ids) => ["library", "album-lookup", [...ids].sort()],
  libraryAlbumTracks: (albumId, releaseGroupMbid) => [
    "library",
    "tracks",
    albumId,
    releaseGroupMbid || null,
  ],
  nearbyShows: (mode, zip, limit) => ["shows", "nearby", mode, zip || null, limit],
  recentlyAdded: (userId) => ["library", "recently-added", userId || null],
  recentReleases: (userId) => ["library", "recent-releases", userId || null],
  news: (userId, mode, limit) => ["news", "library", userId || null, mode, limit],
  playlistStatus: ["playlists", "status"],
  playlistJobs: (flowId) => ["playlists", "jobs", flowId || "all"],
  releaseGroupDetails: (id) => ["artists", "release-group", id],
  releaseGroupTracks: (id, context) => ["artists", "release-group-tracks", id, context],
  releaseGroupRatings: (ids) => ["artists", "release-group-ratings", [...ids].sort()],
  downloadStatus: (ids) => ["library", "download-status", [...ids].sort()],
  searchCatalog: (query, scope, options) => ["search", scope, query, options],
  searchDiscovery: (type, offset, limit) => ["search", "discovery", type, offset || 0, limit || null],
  searchUnified: (query, mode, limit) => ["search", "unified", query, mode, limit],
  storageHealth: ["settings", "storage-health"],
  settingsTasks: ["settings", "tasks"],
  prowlarrIndexers: ["settings", "prowlarr-indexers"],
  tasteFeedback: (userId) => ["discovery", "feedback", userId],
  users: ["auth", "users"],
};
