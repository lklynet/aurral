import { allReleaseTypes } from "./constants";

export const LEGACY_METADATA_BASE_URL = "https://brainzmash.kell.ly";
export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";

export const normalizeMetadataBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  return trimmed === LEGACY_METADATA_BASE_URL ? DEFAULT_METADATA_BASE_URL : trimmed;
};

export const normalizeSettings = (savedSettings) => {
  const lidarr = savedSettings.integrations?.lidarr || {};
  const lastfm = savedSettings.integrations?.lastfm || {};
  const legacyMusicbrainz = savedSettings.integrations?.musicbrainz || {};
  const metadata = savedSettings.integrations?.metadata || {};
  const parsedAutoRefreshHours = parseInt(lastfm.discoveryAutoRefreshHours, 10);
  const normalizedAutoRefreshHours = [24, 168, 720].includes(
    parsedAutoRefreshHours,
  )
    ? parsedAutoRefreshHours
    : 168;
  return {
    ...savedSettings,
    releaseTypes: savedSettings.releaseTypes || allReleaseTypes,
    quality: savedSettings.quality || "standard",
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
          lidarr.qualityProfileId != null
            ? parseInt(lidarr.qualityProfileId, 10)
            : null,
        metadataProfileId:
          lidarr.metadataProfileId != null
            ? parseInt(lidarr.metadataProfileId, 10)
            : null,
        tagId:
          lidarr.tagId != null ? parseInt(lidarr.tagId, 10) : null,
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
        ...(savedSettings.integrations?.plex || {}),
      },
      lastfm: {
        apiKey: "",
        username: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: normalizedAutoRefreshHours,
        discoveryRecommendationsPerRefresh: 200,
        discoveryMode:
          lastfm.discoveryMode === "safer" || lastfm.discoveryMode === "deeper"
            ? lastfm.discoveryMode
            : "balanced",
        ...lastfm,
      },
      slskd: {
        url: "",
        apiKey: "",
        ...(savedSettings.integrations?.slskd || {}),
      },
      ticketmaster: {
        apiKey: "",
        searchRadiusMiles: 50,
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
        ...(savedSettings.integrations?.gotify || {}),
      },
      webhooks: savedSettings.integrations?.webhooks || [],
      webhookEvents: {
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        ...(savedSettings.integrations?.webhookEvents || {}),
      },
    },
  };
};

export const checkForChanges = (newSettings, originalSettings) => {
  if (!originalSettings) return false;
  return JSON.stringify(newSettings) !== JSON.stringify(originalSettings);
};
