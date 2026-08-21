import { QueryClient } from "@tanstack/react-query";

const LIBRARY_CANONICAL_QUERY_KEY = ["library", "canonical"];
const LIBRARY_VIEW_QUERY_KEY = ["library", "view"];
const LIBRARY_ALBUM_TRACKS_QUERY_KEY = ["library", "tracks"];
let libraryCanonicalGeneration = 0;

export const bumpLibraryCanonicalGeneration = () => {
  libraryCanonicalGeneration += 1;
};

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
  lidarrRootFolders: (url) => ["settings", "lidarr", "root-folders", url || ""],
  lidarrProfiles: (url) => ["settings", "lidarr", "profiles", url || ""],
  lidarrMetadataProfiles: (url) => ["settings", "lidarr", "metadata-profiles", url || ""],
  lidarrTags: (url) => ["settings", "lidarr", "tags", url || ""],
  activityRequests: (userId) => ["activity", "requests", userId || null],
  libraryActivityRequests: (userId) => ["library", "activity-requests", userId || null],
  inbox: (userId, zip, limit) => ["inbox", userId || null, zip || "", limit],
  listeningHistory: (userId) => ["auth", "listening-history", userId || null],
  lidarrPreferences: (userId) => ["auth", "lidarr-preferences", userId || null],
  libraryFavorites: ["library", "favorites"],
  libraryAlbums: (artistId) => ["library", "albums", artistId || null],
  libraryAlbumsPrefix: ["library", "albums"],
  libraryArtist: (mbid) => ["library", "artist", mbid || null],
  libraryLookupDetails: (mbid) => ["library", "lookup-details", mbid || null],
  libraryView: (options) => [...LIBRARY_VIEW_QUERY_KEY, options],
  libraryLookup: (id) => ["library", "lookup", id],
  libraryLookupBatch: (ids) => ["library", "lookup-batch", [...ids].sort()],
  libraryViewPrefix: LIBRARY_VIEW_QUERY_KEY,
  libraryCanonicalPrefix: LIBRARY_CANONICAL_QUERY_KEY,
  libraryCanonical: (options) => [
    ...LIBRARY_CANONICAL_QUERY_KEY,
    libraryCanonicalGeneration,
    options,
  ],
  libraryAlbumLookup: (ids) => ["library", "album-lookup", [...ids].sort()],
  libraryAlbumTracksPrefix: LIBRARY_ALBUM_TRACKS_QUERY_KEY,
  libraryAlbumTracks: (albumId, releaseGroupMbid) => [
    ...LIBRARY_ALBUM_TRACKS_QUERY_KEY,
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
  artistDetails: (mbid, options = {}) => [
    "artists",
    "details",
    mbid || null,
    options.artistName || "",
    options.mode || "",
    Array.isArray(options.releaseTypes) ? options.releaseTypes : [],
    options.appearsOnLimit || null,
  ],
  artistDetailsPrefix: ["artists", "details"],
  artistOverrides: (mbid) => ["artists", "overrides", mbid || null],
  artistSimilar: (mbid, artistName, limit) => [
    "artists",
    "similar",
    mbid || null,
    artistName || "",
    limit,
  ],
  artistSimilarPrefix: ["artists", "similar"],
  artistAppearsOn: (mbid) => ["artists", "appears-on", mbid || null],
  downloadStatus: (ids) => ["library", "download-status", [...ids].sort()],
  searchCatalog: (query, scope, options) => ["search", scope, query, options],
  searchDiscovery: (offset, limit) => ["search", "discovery", offset || 0, limit || null],
  searchUnified: (query, mode, limit) => ["search", "unified", query, mode, limit],
  storageHealth: ["settings", "storage-health"],
  settingsTasks: ["settings", "tasks"],
  prowlarrIndexers: ["settings", "prowlarr-indexers"],
  tasteFeedback: (userId) => ["discovery", "feedback", userId],
  users: ["auth", "users"],
};
