import { QueryClient, type QueryKey } from "@tanstack/react-query";

type MaybeId = string | number | null | undefined;
type MaybeText = string | null | undefined;
type LibraryViewOptions = {
  preview?: boolean;
  section?: string;
  pageIndex?: number;
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
  albumId?: MaybeId;
  artistId?: MaybeId;
};

const LIBRARY_PAGE_QUERY_KEY: QueryKey = ["library", "page"];
const LIBRARY_VIEW_QUERY_KEY = ["library", "view"] as const;
const LIBRARY_ALBUM_TRACKS_QUERY_KEY = ["library", "tracks"];
let libraryPageGeneration = 0;

export const bumpLibraryPageGeneration = () => {
  libraryPageGeneration += 1;
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
  discovery: (userId: MaybeId): QueryKey => ["discovery", "home", userId || null],
  discoveryStatusPrefix: ["discovery", "status"],
  discoveryStatus: (userId: MaybeId): QueryKey => ["discovery", "status", userId || null],
  editorialShelf: (userId: MaybeId): QueryKey => [
    "discovery",
    "editorial",
    "shelf",
    userId || null,
  ],
  editorialPlaylist: (userId: MaybeId, playlistId: MaybeId): QueryKey => [
    "discovery",
    "editorial",
    "playlist",
    userId || null,
    playlistId,
  ],
  trendingPrefix: ["discovery", "trending"],
  trendingCharts: (userId: MaybeId): QueryKey => [
    "discovery",
    "trending",
    "charts",
    userId || null,
  ],
  trendingGenre: (genreId: MaybeId): QueryKey => ["discovery", "trending", "genre", genreId],
  appHealth: ["app", "health"],
  appSettings: ["settings", "app"],
  playbackSettings: ["settings", "playback"],
  downloadClientSettings: ["settings", "download-clients"],
  lidarrRootFolders: (url: MaybeText, credentialsRevision = 0): QueryKey => [
    "settings",
    "lidarr",
    "root-folders",
    url || "",
    credentialsRevision,
  ],
  lidarrProfiles: (url: MaybeText, credentialsRevision = 0): QueryKey => [
    "settings",
    "lidarr",
    "profiles",
    url || "",
    credentialsRevision,
  ],
  lidarrMetadataProfiles: (url: MaybeText, credentialsRevision = 0): QueryKey => [
    "settings",
    "lidarr",
    "metadata-profiles",
    url || "",
    credentialsRevision,
  ],
  lidarrTags: (url: MaybeText, credentialsRevision = 0): QueryKey => [
    "settings",
    "lidarr",
    "tags",
    url || "",
    credentialsRevision,
  ],
  activityRequests: (userId: MaybeId): QueryKey => ["activity", "requests", userId || null],
  libraryActivityRequests: (userId: MaybeId): QueryKey => [
    "library",
    "activity-requests",
    userId || null,
  ],
  inbox: (userId: MaybeId): QueryKey => ["inbox", userId || null],
  shareLinks: (userId: MaybeId): QueryKey => ["share-links", userId || null],
  listeningHistory: (userId: MaybeId): QueryKey => ["auth", "listening-history", userId || null],
  lidarrPreferences: (userId: MaybeId): QueryKey => ["auth", "lidarr-preferences", userId || null],
  libraryPrefix: ["library"],
  libraryFavorites: ["library", "favorites"],
  libraryAlbums: (artistId: MaybeId): QueryKey => ["library", "albums", artistId || null],
  libraryAlbumsPrefix: ["library", "albums"],
  libraryArtist: (mbid: MaybeText): QueryKey => ["library", "artist", mbid || null],
  artistMonitoring: (mbid: MaybeText): QueryKey => [
    "library",
    "artist",
    mbid || null,
    "monitoring",
  ],
  monitoringDefaults: ["library", "monitoring", "defaults"],
  monitoringExclusionsPrefix: ["library", "monitoring", "exclusions"],
  monitoringExclusions: (artistMbid: MaybeText): QueryKey => [
    "library",
    "monitoring",
    "exclusions",
    artistMbid || null,
  ],
  libraryLookupDetails: (mbid: MaybeText): QueryKey => ["library", "lookup-details", mbid || null],
  libraryView: (
    options: LibraryViewOptions,
  ): readonly [...typeof LIBRARY_VIEW_QUERY_KEY, LibraryViewOptions] => [
    ...LIBRARY_VIEW_QUERY_KEY,
    options,
  ],
  libraryLookup: (id: string): QueryKey => ["library", "lookup", id],
  libraryLookupBatch: (ids: string[]): QueryKey => ["library", "lookup-batch", [...ids].sort()],
  libraryViewPrefix: LIBRARY_VIEW_QUERY_KEY,
  libraryPagePrefix: LIBRARY_PAGE_QUERY_KEY,
  libraryPage: (options: unknown): QueryKey => [
    ...LIBRARY_PAGE_QUERY_KEY,
    libraryPageGeneration,
    options,
  ],
  libraryAlbumLookup: (ids: MaybeText[]): QueryKey => ["library", "album-lookup", [...ids].sort()],
  libraryAlbumLookupPrefix: ["library", "album-lookup"],
  libraryAlbumTracksPrefix: LIBRARY_ALBUM_TRACKS_QUERY_KEY,
  libraryAlbumTracks: (albumId: string, releaseGroupMbid: MaybeText): QueryKey => [
    ...LIBRARY_ALBUM_TRACKS_QUERY_KEY,
    albumId,
    releaseGroupMbid || null,
  ],
  nearbyShows: (zip: MaybeText, country: MaybeText): QueryKey => [
    "shows",
    "nearby",
    zip || null,
    country || null,
  ],
  recentlyAdded: (userId: MaybeId): QueryKey => ["library", "recently-added", userId || null],
  recentReleases: (userId: MaybeId): QueryKey => ["library", "recent-releases", userId || null],
  news: (userId: MaybeId, mode: string, limit: number): QueryKey => [
    "news",
    "library",
    userId || null,
    mode,
    limit,
  ],
  playlistStatus: ["playlists", "status"],
  flowTemplates: (userId: MaybeId): QueryKey => ["playlists", "flow-templates", userId || null],
  playlistJobs: (flowId?: MaybeId): QueryKey => ["playlists", "jobs", flowId || "all"],
  playlistArtworkRevisions: ["playlists", "artwork-revisions"],
  playlistImportPrefix: (source: string): QueryKey => ["playlists", "import", source],
  spotifyImportStatus: ["playlists", "spotify-import-status"],
  playlistImportList: (source: string, username?: MaybeText): QueryKey => [
    "playlists",
    "import",
    source,
    "playlists",
    username || null,
  ],
  playlistImportPreview: (source: string, playlistId: MaybeId, options: unknown): QueryKey => [
    "playlists",
    "import",
    source,
    "preview",
    playlistId || null,
    options,
  ],
  artistCover: (mbid: MaybeText): QueryKey => ["artists", "cover", mbid || null],
  releaseGroupDetails: (id: MaybeText): QueryKey => ["artists", "release-group", id],
  releaseGroupTracks: (id: MaybeText, context: unknown): QueryKey => [
    "artists",
    "release-group-tracks",
    id,
    context,
  ],
  releaseGroupRatings: (ids: string[]): QueryKey => [
    "artists",
    "release-group-ratings",
    [...ids].sort(),
  ],
  artistDetails: (
    mbid: MaybeText,
    options: {
      artistName?: string;
      mode?: string;
      releaseTypes?: string[];
      appearsOnLimit?: number;
    } = {},
  ): QueryKey => [
    "artists",
    "details",
    mbid || null,
    options.artistName || "",
    options.mode || "",
    Array.isArray(options.releaseTypes) ? options.releaseTypes : [],
    options.appearsOnLimit || null,
  ],
  artistDetailsPrefix: ["artists", "details"],
  artistOverrides: (mbid: MaybeText): QueryKey => ["artists", "overrides", mbid || null],
  artistSimilar: (mbid: MaybeText, artistName: MaybeText, limit: number): QueryKey => [
    "artists",
    "similar",
    mbid || null,
    artistName || "",
    limit,
  ],
  artistSimilarPrefix: ["artists", "similar"],
  artistAppearsOn: (mbid: MaybeText): QueryKey => ["artists", "appears-on", mbid || null],
  activeDownloads: ["downloads", "active"],
  downloadStatus: (ids: MaybeId[]): QueryKey => ["library", "download-status", [...ids].sort()],
  aurralAlbumStatus: (canonicalId: MaybeId): QueryKey => [
    "library",
    "aurral-album-status",
    String(canonicalId),
  ],
  searchCatalog: (query: string, scope: string, options: unknown): QueryKey => [
    "search",
    scope,
    query,
    options,
  ],
  searchUnified: (query: string, mode: string, limit?: number): QueryKey => [
    "search",
    "unified",
    query,
    mode,
    limit,
  ],
  searchLibrary: (query: string, limit: number): QueryKey => ["search", "library", query, limit],
  storageHealth: ["settings", "storage-health"],
  settingsTasks: ["settings", "tasks"],
  prowlarrIndexers: ["settings", "prowlarr-indexers"],
  tasteFeedback: (userId: MaybeId): QueryKey => ["discovery", "feedback", userId],
  blockedTags: (userId: MaybeId): QueryKey => ["discovery", "blocked-tags", userId],
  scrobbleStatus: ["scrobbling", "status"],
  apiKey: ["auth", "api-key"],
  myPlexLinkStatus: (userId: MaybeId): QueryKey => ["auth", "plex-link", userId || null],
  myIdentities: (userId: MaybeId): QueryKey => ["auth", "identities", userId || null],
  plexHomeUsers: ["auth", "plex-home-users"],
  manualMissingSearchSources: (jobId: MaybeId, mode: string, playlistId: MaybeId): QueryKey => [
    "playlists",
    "manual-search-sources",
    jobId || null,
    mode,
    playlistId || null,
  ],
  users: ["auth", "users"],
};
