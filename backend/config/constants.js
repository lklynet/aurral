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
export const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
export const APP_NAME = "Aurral";
export const APP_VERSION = "1.0.0";

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
      navidrome: { url: "", username: "", password: "" },
      lastfm: {
        apiKey: "",
        username: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: 168,
        discoveryRecommendationsPerRefresh: 100,
      },
      slskd: { url: "", apiKey: "" },
      soulseek: { username: "", password: "" },
      ticketmaster: { apiKey: "", searchRadiusMiles: 50 },
      lidarr: {
        url: "",
        externalUrl: "",
        apiKey: "",
        qualityProfileId: null,
        metadataProfileId: null,
        defaultMonitorOption: "none",
        searchOnAdd: false,
      },
      musicbrainz: { email: "" },
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
    weeklyFlowWorker: {
      concurrency: 3,
      preferredFormat: "flac",
      preferredFormatStrict: false,
      seedDownloads: true,
    },
  },
  blocklist: [],
  activityLog: [],
};
