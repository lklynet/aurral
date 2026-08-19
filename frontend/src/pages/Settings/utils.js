import { allReleaseTypes } from "./constants";
import { normalizeDateTimeFormat } from "../../utils/dateTime.js";

export const LEGACY_METADATA_BASE_URL = "https://brainzmash.kell.ly";
export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";

export const normalizeMetadataBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  return trimmed === LEGACY_METADATA_BASE_URL ? DEFAULT_METADATA_BASE_URL : trimmed;
};

export const normalizeSettings = (savedSettings) => {
  const lidarr = savedSettings.integrations?.lidarr || {};
  const lastfm = savedSettings.integrations?.lastfm || {};
  const legacyMusicbrainz = savedSettings.integrations?.musicbrainz || {};
  const metadata = savedSettings.integrations?.metadata || {};
  const news = savedSettings.integrations?.news || {};
  const parsedAutoRefreshHours = parseInt(lastfm.discoveryAutoRefreshHours, 10);
  const normalizedAutoRefreshHours = [24, 168, 720].includes(parsedAutoRefreshHours)
    ? parsedAutoRefreshHours
    : 168;
  const parsedRecommendationsPerRefresh = parseInt(lastfm.discoveryRecommendationsPerRefresh, 10);
  const normalizedRecommendationsPerRefresh = Number.isFinite(parsedRecommendationsPerRefresh)
    ? Math.min(500, Math.max(50, parsedRecommendationsPerRefresh))
    : 200;
  const personalizationEnabled = lastfm.discoveryPersonalizedEnabled;
  if (typeof personalizationEnabled !== "boolean") {
    lastfm.discoveryPersonalizedEnabled = true;
  }
  const playlistArtwork = savedSettings.playlistArtwork || {};
  const playlistArtworkStyle =
    playlistArtwork.style === "aurral" || lastfm.discoverFlowArtworkStyle === "aurral"
      ? "aurral"
      : "photo";
  return {
    ...savedSettings,
    dateTimeFormat: normalizeDateTimeFormat(savedSettings.dateTimeFormat),
    subsonic: {
      favoriteAutoKeep: savedSettings.subsonic?.favoriteAutoKeep !== false,
    },
    downloadFolderPath: String(savedSettings.downloadFolderPath || "").trim(),
    pathMappings: Array.isArray(savedSettings.pathMappings) ? savedSettings.pathMappings : [],
    playlistArtwork: {
      ...playlistArtwork,
      style: playlistArtworkStyle,
    },
    inbox: {
      enabled: savedSettings.inbox?.enabled !== false,
      releases: savedSettings.inbox?.releases !== false,
      shows: savedSettings.inbox?.shows !== false,
      news: savedSettings.inbox?.news !== false,
      recommendedNews: savedSettings.inbox?.recommendedNews === true,
      discoveries: savedSettings.inbox?.discoveries !== false,
    },
    releaseTypes: savedSettings.releaseTypes || allReleaseTypes,
    quality: savedSettings.quality || "standard",
    qualityProfile: savedSettings.qualityProfile,
    security: {
      ...(savedSettings.security || {}),
      localNetworkBypass: {
        enabled: savedSettings?.security?.localNetworkBypass?.enabled === true,
      },
    },
    integrations: {
      lidarr: {
        url: "",
        externalUrl: "",
        apiKey: "",
        searchOnAdd: false,
        defaultMonitorOption: "none",
        ...lidarr,
        qualityProfileId:
          lidarr.qualityProfileId != null ? parseInt(lidarr.qualityProfileId, 10) : null,
        metadataProfileId:
          lidarr.metadataProfileId != null ? parseInt(lidarr.metadataProfileId, 10) : null,
        tagId: lidarr.tagId != null ? parseInt(lidarr.tagId, 10) : null,
      },
      navidrome: {
        url: "",
        username: "",
        password: "",
        ...(savedSettings.integrations?.navidrome || {}),
      },
      plex: {
        url: "",
        token: "",
        clientId: "",
        machineIdentifier: "",
        downloadsPath: "",
        ...(savedSettings.integrations?.plex || {}),
      },
      lastfm: {
        apiKey: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: normalizedAutoRefreshHours,
        discoveryRecommendationsPerRefresh: normalizedRecommendationsPerRefresh,
        discoveryPersonalizedEnabled: lastfm.discoveryPersonalizedEnabled === false ? false : true,
        discoveryMode:
          lastfm.discoveryMode === "safer" || lastfm.discoveryMode === "deeper"
            ? lastfm.discoveryMode
            : "balanced",
        ...lastfm,
      },
      news: {
        enabled: news.enabled !== false,
        feeds: Array.isArray(news.feeds) ? news.feeds : [],
        groups: {
          major: news.groups?.major !== false,
          indie: news.groups?.indie !== false,
          discovery: news.groups?.discovery !== false,
          hiphop: news.groups?.hiphop !== false,
          pop: news.groups?.pop !== false,
          electronic: news.groups?.electronic !== false,
          metal: news.groups?.metal !== false,
          country: news.groups?.country !== false,
          jazz: news.groups?.jazz !== false,
          classical: news.groups?.classical !== false,
          specialty: news.groups?.specialty !== false,
          regional: news.groups?.regional !== false,
          concerts: news.groups?.concerts !== false,
        },
      },
      slskd: {
        enabled: false,
        url: "",
        apiKey: "",
        priority: 10,
        preferredFormat: "flac",
        preferredFormatStrict: false,
        cleanupAfterRuns: false,
        ...(savedSettings.integrations?.slskd || {}),
      },
      prowlarr: {
        enabled: false,
        url: "",
        apiKey: "",
        indexers: {},
        categories: [3000],
        maxResults: 60,
        ...(savedSettings.integrations?.prowlarr || {}),
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
        ...(savedSettings.integrations?.nzbget || {}),
      },
      sabnzbd: {
        enabled: false,
        url: "",
        apiKey: "",
        category: "aurral",
        priority: 20,
        addPaused: false,
        ...(savedSettings.integrations?.sabnzbd || {}),
      },
      ytdlp: {
        enabled: true,
        priority: 50,
        stagingPath: "",
        ...(savedSettings.integrations?.ytdlp || {}),
      },
      ticketmaster: {
        apiKey: "",
        searchRadiusMiles: 250,
        localDiscoveryIncludeRecommendations: true,
        localDiscoveryIncludeTrending: true,
        ...(savedSettings.integrations?.ticketmaster || {}),
      },
      metadata: {
        provider: "brainzmash",
        baseUrl: normalizeMetadataBaseUrl(
          metadata.baseUrl ||
            String(legacyMusicbrainz.customUrl || "")
              .trim()
              .replace(/\/ws\/2\/?$/, "") ||
            DEFAULT_METADATA_BASE_URL,
        ),
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
        ...metadata,
      },
      general: {
        authUser: "",
        authPassword: "",
        ...(savedSettings.integrations?.general || {}),
      },
      gotify: {
        url: "",
        token: "",
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        notifyRequestMade: false,
        notifyRequestAvailable: false,
        ...(savedSettings.integrations?.gotify || {}),
      },
      webhooks: savedSettings.integrations?.webhooks || [],
      webhookEvents: {
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        notifyRequestMade: false,
        notifyRequestAvailable: false,
        ...(savedSettings.integrations?.webhookEvents || {}),
      },
    },
  };
};

export const checkForChanges = (newSettings, originalSettings) => {
  if (!originalSettings) return false;
  return JSON.stringify(newSettings) !== JSON.stringify(originalSettings);
};
