import { QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ShelfScope } from "../../backend/services/importLists/deezerPlaylists.ts";

type MaybeId = string | number | null | undefined;
type MaybeText = string | null | undefined;
type LibraryViewOptions = {
  preview?: boolean;
  section?: string;
  pageIndex?: number;
  query?: string;
  genre?: string;
  artist?: string;
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
  playlistShelf: (userId: MaybeId, scope?: ShelfScope): QueryKey =>
    scope
      ? ["discovery", "playlists", "shelf", userId || null, scope]
      : ["discovery", "playlists", "shelf", userId || null],
  madeForYou: (userId: MaybeId): QueryKey => [
    "discovery",
    "playlists",
    "made-for-you",
    userId || null,
  ],
  browsePlaylist: (userId: MaybeId, provider: string, playlistId: MaybeId): QueryKey => [
    "discovery",
    "playlists",
    "playlist",
    userId || null,
    provider,
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
  playlistFileSettings: ["settings", "playlist-files"],
  downloadClientSettings: ["settings", "download-clients"],
  activityRequests: (userId: MaybeId): QueryKey => ["activity", "requests", userId || null],
  libraryActivityRequests: (userId: MaybeId): QueryKey => [
    "library",
    "activity-requests",
    userId || null,
  ],
  inbox: (userId: MaybeId): QueryKey => ["inbox", userId || null],
  shareLinks: (userId: MaybeId): QueryKey => ["share-links", userId || null],
  lyrics: (track: Record<string, string | undefined>): QueryKey => ["lyrics", track],
  trackPulse: (albumId: MaybeId, trackId: MaybeId): QueryKey => ["track-pulse", albumId, trackId],
  listeningHistory: (userId: MaybeId): QueryKey => ["auth", "listening-history", userId || null],
  libraryPrefix: ["library"],
  libraryFavorites: ["library", "favorites"],
  libraryAlbums: (artistId: MaybeId): QueryKey => ["library", "albums", artistId || null],
  libraryAlbumsPrefix: ["library", "albums"],
  libraryArtist: (mbid: MaybeText): QueryKey => ["library", "artist", mbid || null],
  libraryMatches: (
    kind: "artist" | "album" | "track",
    id: string | number,
    query: string,
  ): QueryKey => ["library", "matches", kind, id, query],
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
  libraryArtistPlays: (artistId: string): QueryKey => ["library", "artist-plays", artistId],
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
  playlistsContaining: (track: object | null): QueryKey => ["playlists", "containing", track],
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
  releaseTrackCredits: (id: MaybeText): QueryKey => ["artists", "release-track-credits", id],
  releaseGroupTracks: (id: MaybeText): QueryKey => ["artists", "release-group-tracks", id],
  releaseGroupPreviews: (id: MaybeText, hints: unknown): QueryKey => [
    "artists",
    "release-group-previews",
    id,
    hints,
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
  artistPlaylists: (mbid: MaybeText, artistName: MaybeText): QueryKey => [
    "artists",
    "playlists",
    mbid || null,
    artistName || "",
  ],
  artistPlaylistsPrefix: ["artists", "playlists"],
  artistShows: (mbid: MaybeText, artistName: MaybeText): QueryKey => [
    "artists",
    "shows",
    mbid || null,
    artistName || "",
  ],
  artistListening: (mbid: MaybeText, artistName: MaybeText): QueryKey => [
    "artists",
    "listening",
    mbid || null,
    artistName || "",
  ],
  activeDownloads: ["downloads", "active"],
  downloadStatus: (ids: MaybeId[]): QueryKey => ["library", "download-status", [...ids].sort()],
  albumStatus: (albumId: MaybeId): QueryKey => ["library", "aurral-album-status", String(albumId)],
  searchCatalog: (query: string, scope: string, options: unknown): QueryKey => [
    "search",
    scope,
    query,
    options,
  ],
  searchUnified: (query: string, limit: number): QueryKey => ["search", "unified", query, limit],
  searchLibrary: (query: string, limit: number): QueryKey => ["search", "library", query, limit],
  searchPlaylists: (query: string): QueryKey => ["search", "playlists", query],
  storageHealth: ["settings", "storage-health"],
  settingsTasks: ["settings", "tasks"],
  logsRoot: ["settings", "logs"],
  logProblems: ["settings", "logs", "problems"],
  logs: (filters: Record<string, string>): QueryKey => ["settings", "logs", "lines", filters],
  prowlarrIndexers: ["settings", "prowlarr-indexers"],
  tasteFeedback: (userId: MaybeId): QueryKey => ["discovery", "feedback", userId],
  blockedTags: (userId: MaybeId): QueryKey => ["discovery", "blocked-tags", userId],
  spotifyHistory: (userId: MaybeId): QueryKey => ["discovery", "spotify-history", userId],
  scrobbleStatus: ["scrobbling", "status"],
  historyServers: (userId: MaybeId): QueryKey => ["history-servers", userId || null],
  plex: (userId: MaybeId): QueryKey => ["plex", userId || null],
  plugins: ["settings", "plugins"],
  pluginDevKeys: ["settings", "plugins", "dev-keys"],
  pluginImportLists: ["plugins", "import-lists"],
  pluginActions: (userId: MaybeId): QueryKey => ["plugins", "actions", userId || null],
  apiKey: ["auth", "api-key"],
  myApiKey: (userId: MaybeId): QueryKey => ["users", "me", "api-key", userId || null],
  myIdentities: (userId: MaybeId): QueryKey => ["auth", "identities", userId || null],
  manualMissingSearchSources: (jobId: MaybeId, mode: string, playlistId: MaybeId): QueryKey => [
    "playlists",
    "manual-search-sources",
    jobId || null,
    mode,
    playlistId || null,
  ],
  users: ["auth", "users"],
};
