import { resolveAppVersion } from "../../lib/app-version.js";

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on", "verbose", "debug"]);

export const isVerboseConsoleEnabled = (env = process.env) =>
  TRUE_ENV_VALUES.has(
    String(env.AURRAL_VERBOSE_LOGS || "").trim().toLowerCase(),
  );

export const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";
export const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
export const LISTENBRAINZ_API = "https://api.listenbrainz.org";
export const APP_NAME = "Aurral";
export const APP_VERSION = resolveAppVersion({
  envValue: process.env.APP_VERSION,
  cwd: process.cwd(),
});
export const DATE_TIME_FORMATS = ["browser", "day-first", "year-first"];
export const normalizeDateTimeFormat = (value) =>
  DATE_TIME_FORMATS.includes(value) ? value : "browser";

export const defaultData = {
  settings: {
    dateTimeFormat: "browser",
    subsonic: {
      favoriteAutoKeep: true,
    },
    integrations: {
      navidrome: {
        url: "",
        username: "",
        password: "",
      },
      plex: {
        url: "",
        token: "",
        clientId: "",
        machineIdentifier: "",
        downloadsPath: "",
        plexUsername: "",
        mainLibrarySectionId: "",
      },
      jellyfin: {
        url: "",
        apiKey: "",
        userId: "",
      },
      lastfm: {
        apiKey: "",
        apiSecret: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: 168,
        discoveryRecommendationsPerRefresh: 200,
        discoveryPersonalizedEnabled: true,
        discoveryMode: "balanced",
      },
      slskd: {
        enabled: false,
        url: "",
        apiKey: "",
        priority: 10,
        preferredFormat: "flac",
        preferredFormatStrict: false,
      },
      prowlarr: {
        enabled: false,
        url: "",
        apiKey: "",
        indexers: {},
        categories: [3000],
        maxResults: 60,
      },
      nzbget: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        category: "aurral",
        priority: 20,
        nzbPriority: 0,
        addPaused: false,
        completedPath: "",
      },
      sabnzbd: {
        enabled: false,
        url: "",
        apiKey: "",
        category: "aurral",
        priority: 20,
        addPaused: false,
      },
      ytdlp: {
        enabled: true,
        priority: 50,
        stagingPath: "",
      },
      deemix: {
        enabled: false,
        url: "",
        bitrate: 9,
        priority: 15,
      },
      ticketmaster: {
        apiKey: "",
        searchRadiusMiles: 250,
        localDiscoveryIncludeRecommendations: true,
        localDiscoveryIncludeTrending: true,
      },
      news: {
        enabled: true,
        feeds: [],
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
        availableOnly: true,
      },
      metadata: {
        provider: "brainzmash",
        baseUrl: DEFAULT_METADATA_BASE_URL,
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
      },
      general: { authUser: "", authPassword: "" },
      gotify: {
        url: "",
        token: "",
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        notifyRequestMade: false,
        notifyRequestAvailable: false,
      },
      webhooks: [],
      webhookEvents: {
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        notifyRequestMade: false,
        notifyRequestAvailable: false,
      },
    },
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
    security: {
      localNetworkBypass: {
        enabled: false,
      },
    },
    playlistArtwork: {
      style: "photo",
    },
    inbox: {
      enabled: true,
      releases: true,
      shows: true,
      news: true,
      recommendedNews: false,
      discoveries: true,
    },
  },
};
