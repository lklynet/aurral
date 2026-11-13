import { allReleaseTypes } from "./constants";
import { normalizeDateTimeFormat } from "../../utils/dateTime.ts";
import type {
  QualityProfile,
  StoredIntegrations,
} from "../../../../backend/db/helpers/settings.ts";
import type { InferResponseType } from "hono/client";
import type { settingsClient } from "../../utils/api/clients/settings.ts";

export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";

export type SavedSettings =
  | Partial<InferResponseType<typeof settingsClient.$get, 200>>
  | Partial<InferResponseType<typeof settingsClient.$post, 200>>;

export const normalizeSettings = (savedSettings: SavedSettings) => {
  const lastfm: NonNullable<StoredIntegrations["lastfm"]> =
    savedSettings.integrations?.lastfm || {};
  const metadata: NonNullable<StoredIntegrations["metadata"]> =
    savedSettings.integrations?.metadata || {};
  const news = savedSettings.integrations?.news;
  const qualityProfile: Partial<QualityProfile> | undefined = savedSettings.qualityProfile;
  return {
    ...savedSettings,
    dateTimeFormat: normalizeDateTimeFormat(savedSettings.dateTimeFormat),
    downloadFolderPath: String(savedSettings.downloadFolderPath || "").trim(),
    pathMappings: Array.isArray(savedSettings.pathMappings) ? savedSettings.pathMappings : [],
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
    qualityProfile,
    security: {
      ...(savedSettings.security || {}),
      localNetworkBypass: {
        enabled: savedSettings?.security?.localNetworkBypass?.enabled === true,
      },
    },
    integrations: {
      lastfm: {
        apiKey: "",
        discoveryPeriod: "1month",
        ...lastfm,
      },
      news: {
        enabled: news?.enabled !== false,
        feeds: news?.feeds ?? [],
        groups: {
          major: news?.groups?.major !== false,
          indie: news?.groups?.indie !== false,
          discovery: news?.groups?.discovery !== false,
          hiphop: news?.groups?.hiphop !== false,
          pop: news?.groups?.pop !== false,
          electronic: news?.groups?.electronic !== false,
          metal: news?.groups?.metal !== false,
          country: news?.groups?.country !== false,
          jazz: news?.groups?.jazz !== false,
          classical: news?.groups?.classical !== false,
          regional: news?.groups?.regional !== false,
          concerts: news?.groups?.concerts !== false,
        },
      },
      slskd: {
        enabled: false,
        url: "",
        apiKey: "",
        priority: 10,
        preferredFormat: "flac",
        preferredFormatStrict: false,
        ...(savedSettings.integrations?.slskd || {}),
      },
      prowlarr: {
        enabled: false,
        url: "",
        apiKey: "",
        indexers: {},
        ...(savedSettings.integrations?.prowlarr || {}),
      },
      nzbget: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        category: "aurral",
        priority: 20,
        completedPath: "",
        ...(savedSettings.integrations?.nzbget || {}),
      },
      sabnzbd: {
        enabled: false,
        url: "",
        apiKey: "",
        category: "aurral",
        priority: 20,
        ...(savedSettings.integrations?.sabnzbd || {}),
      },
      tidarr: {
        enabled: false,
        url: "",
        apiKey: "",
        priority: 20,
        ...(savedSettings.integrations?.tidarr || {}),
      },
      qbittorrent: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        category: "aurral",
        priority: 30,
        ...(savedSettings.integrations?.qbittorrent || {}),
      },
      ytdlp: {
        enabled: true,
        priority: 50,
        stagingPath: "",
        cookiesPath: "",
        ...(savedSettings.integrations?.ytdlp || {}),
      },
      deemix: {
        enabled: false,
        url: "",
        bitrate: 9,
        priority: 15,
        ...(savedSettings.integrations?.deemix || {}),
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
        baseUrl: "",
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
        ...metadata,
      },
      ...(savedSettings.integrations?.google && { google: savedSettings.integrations.google }),
      general: savedSettings.integrations?.general || {},
      gotify: {
        url: "",
        token: "",
        notifyDiscoveryUpdated: false,
        notifyFlowDone: false,
        notifyRequestMade: false,
        notifyRequestAvailable: false,
        notifyArtistAdded: false,
        notifyTrackAdded: false,
        ...(savedSettings.integrations?.gotify || {}),
      },
      webhooks: savedSettings.integrations?.webhooks || [],
    },
  };
};

export const checkForChanges = (newSettings: unknown, originalSettings: unknown) => {
  if (!originalSettings) return false;
  return JSON.stringify(newSettings) !== JSON.stringify(originalSettings);
};

export type SettingsState = ReturnType<typeof normalizeSettings>;
