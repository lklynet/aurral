import { allReleaseTypes } from "./constants";

export const LEGACY_METADATA_BASE_URL = "https://brainzmash.kell.ly";
export const DEFAULT_METADATA_BASE_URL = "https://lidarrapi.brainzmash.cc";
export const DEFAULT_SEARCH_URL = "https://search.aurral.org";

export const normalizeMetadataBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  return trimmed === LEGACY_METADATA_BASE_URL ? DEFAULT_METADATA_BASE_URL : trimmed;
};

export const normalizeSettings = (savedSettings) => {
  const lidarr = savedSettings.integrations?.lidarr || {};
  const lastfm = savedSettings.integrations?.lastfm || {};
  const legacyMusicbrainz = savedSettings.integrations?.musicbrainz || {};
  const metadata = savedSettings.integrations?.metadata || {};
  const search = savedSettings.integrations?.search || {};
  const parsedAutoRefreshHours = parseInt(lastfm.discoveryAutoRefreshHours, 10);
  const normalizedAutoRefreshHours = [24, 168, 720].includes(
    parsedAutoRefreshHours,
  )
    ? parsedAutoRefreshHours
    : 168;
  const parsedRecommendationsPerRefresh = parseInt(
    lastfm.discoveryRecommendationsPerRefresh,
    10,
  );
  const normalizedRecommendationsPerRefresh = Number.isFinite(
    parsedRecommendationsPerRefresh,
  )
    ? Math.min(500, Math.max(50, parsedRecommendationsPerRefresh))
    : 200;
  const parsedFlowsPerRefresh = parseInt(lastfm.discoveryFlowsPerRefresh, 10);
  const normalizedFlowsPerRefresh = Number.isFinite(parsedFlowsPerRefresh)
    ? Math.min(32, Math.max(5, parsedFlowsPerRefresh))
    : 9;
  const playlistArtwork = savedSettings.playlistArtwork || {};
  const playlistArtworkStyle =
    playlistArtwork.style === "aurral" || lastfm.discoverFlowArtworkStyle === "aurral"
      ? "aurral"
      : "photo";
  return {
    ...savedSettings,
    downloadFolderPath: String(savedSettings.downloadFolderPath || "").trim(),
    pathMappings: Array.isArray(savedSettings.pathMappings)
      ? savedSettings.pathMappings
      : [],
    playlistArtwork: {
      ...playlistArtwork,
      style: playlistArtworkStyle,
    },
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
        m3uPathMode:
          savedSettings.integrations?.navidrome?.m3uPathMode === "remote"
            ? "remote"
            : "local",
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
        username: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours: normalizedAutoRefreshHours,
        discoveryRecommendationsPerRefresh: normalizedRecommendationsPerRefresh,
        discoveryFlowsPerRefresh: normalizedFlowsPerRefresh,
        discoveryMode:
          lastfm.discoveryMode === "safer" || lastfm.discoveryMode === "deeper"
            ? lastfm.discoveryMode
            : "balanced",
        ...lastfm,
      },
      slskd: {
        url: "",
        apiKey: "",
        preferredFormat: "flac",
        preferredFormatStrict: false,
        cleanupAfterRuns: false,
        ...(savedSettings.integrations?.slskd || {}),
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
      search: {
        ...search,
        url: search.url ?? DEFAULT_SEARCH_URL,
        apiKey: search.apiKey || "",
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
