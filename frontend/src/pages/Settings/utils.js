import { allReleaseTypes } from "./constants";

export const normalizeSettings = (savedSettings) => {
  const lidarr = savedSettings.integrations?.lidarr || {};
  const lastfm = savedSettings.integrations?.lastfm || {};
  const parsedAutoRefreshHours = parseInt(lastfm.discoveryAutoRefreshHours, 10);
  const parsedRecommendationLimit = parseInt(
    lastfm.discoveryRecommendationsPerRefresh,
    10,
  );
  return {
    ...savedSettings,
    releaseTypes: savedSettings.releaseTypes || allReleaseTypes,
    quality: savedSettings.quality || "standard",
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
      },
      navidrome: {
        url: "",
        username: "",
        password: "",
        ...(savedSettings.integrations?.navidrome || {}),
      },
      lastfm: {
        apiKey: "",
        username: "",
        discoveryPeriod: "1month",
        discoveryAutoRefreshHours:
          Number.isFinite(parsedAutoRefreshHours) && parsedAutoRefreshHours > 0
            ? parsedAutoRefreshHours
            : 168,
        discoveryRecommendationsPerRefresh:
          Number.isFinite(parsedRecommendationLimit) &&
          parsedRecommendationLimit > 0
            ? parsedRecommendationLimit
            : 100,
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
        ...(savedSettings.integrations?.ticketmaster || {}),
      },
      musicbrainz: {
        email: "",
        ...(savedSettings.integrations?.musicbrainz || {}),
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
