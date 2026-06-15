import { resolveAppVersion } from "../../lib/app-version.js";

export const DOWNLOAD_STATES = {
  REQUESTED: "requested",
  QUEUED: "queued",
  SEARCHING: "searching",
  DOWNLOADING: "downloading",
  PROCESSING: "processing",
  MOVING: "moving",
  COMPLETED: "completed",
  ADDED: "added",
  FAILED: "failed",
  STALLED: "stalled",
  DEAD_LETTER: "dead_letter",
  CANCELLED: "cancelled",
};

export const DOWNLOAD_STATE_TRANSITIONS = {
  [DOWNLOAD_STATES.REQUESTED]: [
    DOWNLOAD_STATES.QUEUED,
    DOWNLOAD_STATES.CANCELLED,
  ],
  [DOWNLOAD_STATES.QUEUED]: [
    DOWNLOAD_STATES.SEARCHING,
    DOWNLOAD_STATES.CANCELLED,
    DOWNLOAD_STATES.FAILED,
    DOWNLOAD_STATES.DEAD_LETTER,
  ],
  [DOWNLOAD_STATES.SEARCHING]: [
    DOWNLOAD_STATES.DOWNLOADING,
    DOWNLOAD_STATES.FAILED,
    DOWNLOAD_STATES.CANCELLED,
    DOWNLOAD_STATES.STALLED,
    DOWNLOAD_STATES.DEAD_LETTER,
  ],
  [DOWNLOAD_STATES.DOWNLOADING]: [
    DOWNLOAD_STATES.PROCESSING,
    DOWNLOAD_STATES.FAILED,
    DOWNLOAD_STATES.CANCELLED,
    DOWNLOAD_STATES.STALLED,
    DOWNLOAD_STATES.DEAD_LETTER,
  ],
  [DOWNLOAD_STATES.PROCESSING]: [
    DOWNLOAD_STATES.MOVING,
    DOWNLOAD_STATES.COMPLETED,
    DOWNLOAD_STATES.FAILED,
  ],
  [DOWNLOAD_STATES.MOVING]: [
    DOWNLOAD_STATES.COMPLETED,
    DOWNLOAD_STATES.ADDED,
    DOWNLOAD_STATES.FAILED,
  ],
  [DOWNLOAD_STATES.COMPLETED]: [DOWNLOAD_STATES.ADDED],
  [DOWNLOAD_STATES.ADDED]: [],
  [DOWNLOAD_STATES.FAILED]: [
    DOWNLOAD_STATES.QUEUED,
    DOWNLOAD_STATES.SEARCHING,
    DOWNLOAD_STATES.ADDED,
    DOWNLOAD_STATES.DEAD_LETTER,
  ],
  [DOWNLOAD_STATES.STALLED]: [
    DOWNLOAD_STATES.QUEUED,
    DOWNLOAD_STATES.FAILED,
    DOWNLOAD_STATES.DEAD_LETTER,
  ],
  [DOWNLOAD_STATES.DEAD_LETTER]: [DOWNLOAD_STATES.QUEUED],
  [DOWNLOAD_STATES.CANCELLED]: [],
};

export const STALLED_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_RETRY_COUNT = 5;
export const MAX_REQUEUE_COUNT = 3;
export const SLOW_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_TRANSFER_SPEED_BPS = 10 * 1024;

export const ERROR_TYPES = {
  RATE_LIMIT: "rate_limit",
  NETWORK: "network",
  SERVER_ERROR: "server_error",
  NOT_FOUND: "not_found",
  PERMANENT: "permanent",
  TIMEOUT: "timeout",
  SLOW_TRANSFER: "slow_transfer",
  NO_SOURCES: "no_sources",
  BAD_SOURCE: "bad_source",
  UNKNOWN: "unknown",
};

export const GENRE_KEYWORDS = [
  "rock",
  "pop",
  "electronic",
  "metal",
  "jazz",
  "hip-hop",
  "indie",
  "alternative",
  "punk",
  "soul",
  "r&b",
  "folk",
  "classical",
  "blues",
  "country",
  "reggae",
  "disco",
  "funk",
];

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
export const AURRAL_MUSICBRAINZ_API = "https://mb.lkly.net/ws/2";
export const OFFICIAL_COVER_ART_ARCHIVE_API = "https://coverartarchive.org";
export const LEGACY_METADATA_BASE_URL = "https://brainzmash.kell.ly";
export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";
export const DEFAULT_SEARCH_URL = "https://search.aurral.org";
export const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
export const LISTENBRAINZ_API = "https://api.listenbrainz.org";
export const APP_NAME = "Aurral";
export const APP_VERSION = resolveAppVersion({
  envValue: process.env.APP_VERSION,
  cwd: process.cwd(),
});

export const defaultDiscoveryPreferences = {
  excludedGenres: [],
  excludedTags: [],
  preferredDecades: [],
  excludedArtists: [],
  minPopularity: 0,
  maxRecommendations: 50,
  includeFromLastfm: true,
  includeFromLibrary: true,
  includeTrending: true,
};

export const defaultData = {
  discovery: {
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
    fallbackGenres: [],
    fallbackGenrePools: {},
    provider: "lastfm",
    lastUpdated: null,
  },
  images: {},
  requests: [],
  albumRequests: [],
  library: {
    artists: [],
    albums: [],
    tracks: [],
    rootFolder: null,
    lastScan: null,
  },
  qualityProfiles: [],
  customFormats: [],
  settings: {
    rootFolderPath: null,
    downloadFolderPath: null,
    pathMappings: [],
    quality: "standard",
    releaseTypes: [
      "Album",
      "EP",
      "Single",
      "Broadcast",
      "Soundtrack",
      "Spokenword",
      "Remix",
      "Live",
      "Compilation",
      "Demo",
    ],
    integrations: {
      navidrome: { url: "", username: "", password: "", m3uPathMode: "local" },
      plex: {
        url: "",
        token: "",
        clientId: "",
        machineIdentifier: "",
        downloadsPath: "",
      },
      lastfm: {
        apiKey: "",
        username: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: 168,
        discoveryRecommendationsPerRefresh: 200,
        discoveryFlowsPerRefresh: 9,
        discoveryMode: "balanced",
      },
      slskd: {
        url: "",
        apiKey: "",
        preferredFormat: "flac",
        preferredFormatStrict: false,
      },
      ticketmaster: {
        apiKey: "",
        searchRadiusMiles: 250,
        localDiscoveryIncludeRecommendations: true,
        localDiscoveryIncludeTrending: true,
      },
      lidarr: {
        url: "",
        externalUrl: "",
        apiKey: "",
        qualityProfileId: null,
        metadataProfileId: null,
        tagId: null,
        defaultMonitorOption: "none",
        searchOnAdd: false,
      },
      metadata: {
        provider: "brainzmash",
        baseUrl: DEFAULT_METADATA_BASE_URL,
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
      },
      search: {
        url: DEFAULT_SEARCH_URL,
        apiKey: "",
      },
      general: { authUser: "", authPassword: "" },
      gotify: {
        url: "",
        token: "",
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
      },
      webhooks: [],
      webhookEvents: {
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
      },
    },
    security: {
      localNetworkBypass: {
        enabled: false,
      },
    },
    queueCleaner: {
      enabled: true,
      blocklist: true,
      remove: false,
      rename: true,
      cleanImports: "missing",
      retryFindingRelease: true,
      retryDelayMinutes: 5,
      maxRetries: 3,
    },
    playlistWorker: {
      concurrency: 2,
      retryCycleMinutes: 360,
      existingFileMode: "reuse",
    },
    playlistArtwork: {
      style: "photo",
    },
  },
  blocklist: [],
  activityLog: [],
};
