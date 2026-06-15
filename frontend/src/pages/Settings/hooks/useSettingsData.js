import { useState, useEffect, useRef, useCallback } from "react";
import api, {
  checkHealth,
  getAppSettings,
  updateAppSettings,
  getLidarrProfiles,
  getLidarrMetadataProfiles,
  getLidarrTags,
  testLidarrConnection,
  testGotifyConnection,
  applyLidarrCommunityGuide,
} from "../../../utils/api";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";
import { allReleaseTypes } from "../constants";
import {
  DEFAULT_METADATA_BASE_URL,
  DEFAULT_SEARCH_URL,
  checkForChanges,
  normalizeSettings,
} from "../utils";

const DISCOVERY_MANUAL_REFRESH_KEY = "aurral.discovery.manualRefreshPending";

const defaultSettings = {
  rootFolderPath: "",
  downloadFolderPath: "",
  pathMappings: [],
  quality: "standard",
  releaseTypes: allReleaseTypes,
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
      cleanupAfterRuns: false,
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
  playlistArtwork: {
    style: "photo",
  },
  security: {
    localNetworkBypass: {
      enabled: false,
    },
  },
};

export function useSettingsData(showSuccess, showError, showInfo) {
  const [health, setHealth] = useState(null);
  const [settings, setSettingsState] = useState(defaultSettings);
  const [originalSettings, setOriginalSettings] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingDiscovery, setRefreshingDiscovery] = useState(false);
  const [discoveryProgressMessage, setDiscoveryProgressMessage] = useState("");
  const [discoveryProgress, setDiscoveryProgress] = useState(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [lidarrProfiles, setLidarrProfiles] = useState([]);
  const [loadingLidarrProfiles, setLoadingLidarrProfiles] = useState(false);
  const [lidarrMetadataProfiles, setLidarrMetadataProfiles] = useState([]);
  const [loadingLidarrMetadataProfiles, setLoadingLidarrMetadataProfiles] =
    useState(false);
  const [lidarrTags, setLidarrTags] = useState([]);
  const [loadingLidarrTags, setLoadingLidarrTags] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [testingGotify, setTestingGotify] = useState(false);
  const [applyingCommunityGuide, setApplyingCommunityGuide] = useState(false);
  const [showCommunityGuideModal, setShowCommunityGuideModal] = useState(false);
  const comparisonEnabledRef = useRef(false);

  const applyHealthUpdate = useCallback((healthData) => {
    setHealth(healthData);
    if (healthData?.discovery?.isUpdating) {
      setRefreshingDiscovery(true);
      setDiscoveryProgressMessage(
        healthData.discovery.updateProgressMessage ||
          "Discovery refresh is running",
      );
      if (typeof healthData.discovery.updateProgress === "number") {
        setDiscoveryProgress(healthData.discovery.updateProgress);
      }
    } else {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const healthData = await checkHealth();
      applyHealthUpdate(healthData);
      return healthData;
    } catch {
      return null;
    }
  }, [applyHealthUpdate]);

  useWebSocketChannel("discovery", (msg) => {
    if (msg.type !== "discovery_update") return;

    if (msg.phase === "error") {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
      setDiscoveryProgressMessage(
        msg.progressMessage || "Discovery refresh failed",
      );
      return;
    }

    if (msg.isUpdating) {
      setRefreshingDiscovery(true);
      if (msg.progressMessage) {
        setDiscoveryProgressMessage(msg.progressMessage);
      }
      if (typeof msg.progress === "number") {
        setDiscoveryProgress(msg.progress);
      }
      return;
    }

    if (msg.phase === "completed" || Array.isArray(msg.recommendations)) {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(100);
      setDiscoveryProgressMessage(
        msg.progressMessage || "Discovery refresh completed",
      );
      refreshHealth();
      return;
    }
  });

  const fetchSettings = useCallback(async () => {
    comparisonEnabledRef.current = false;
    try {
      const [, savedSettings] = await Promise.all([
        refreshHealth(),
        getAppSettings(),
      ]);
      const updatedSettings = normalizeSettings(savedSettings);
      setSettingsState(updatedSettings);
      setOriginalSettings(JSON.parse(JSON.stringify(updatedSettings)));
      setHasUnsavedChanges(false);
      setTimeout(() => {
        comparisonEnabledRef.current = true;
      }, 600);

      const lidarr = updatedSettings.integrations?.lidarr || {};
      if (lidarr.url && lidarr.apiKey) {
        setLoadingLidarrProfiles(true);
        setLoadingLidarrMetadataProfiles(true);
        setLoadingLidarrTags(true);
        try {
          const [profiles, metadataProfiles, tags] = await Promise.all([
            getLidarrProfiles(lidarr.url, lidarr.apiKey),
            getLidarrMetadataProfiles(lidarr.url, lidarr.apiKey),
            getLidarrTags(lidarr.url, lidarr.apiKey),
          ]);
          setLidarrProfiles(profiles);
          setLidarrMetadataProfiles(metadataProfiles);
          setLidarrTags(Array.isArray(tags) ? tags : []);
        } catch {
        } finally {
          setLoadingLidarrProfiles(false);
          setLoadingLidarrMetadataProfiles(false);
          setLoadingLidarrTags(false);
        }
      }
    } catch {}
  }, [refreshHealth]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!refreshingDiscovery) return;

    const pollHealth = async () => {
      try {
        const healthData = await refreshHealth();
        if (!healthData?.discovery?.isUpdating) {
          setDiscoveryProgressMessage(
            (current) => current || "Discovery refresh completed",
          );
        }
      } catch {}
    };

    pollHealth();
    const intervalId = setInterval(pollHealth, 3000);
    return () => clearInterval(intervalId);
  }, [refreshingDiscovery, refreshHealth]);

  const updateSettings = useCallback(
    (newSettings) => {
      setSettingsState(newSettings);
      if (comparisonEnabledRef.current && originalSettings) {
        setHasUnsavedChanges(checkForChanges(newSettings, originalSettings));
      }
    },
    [originalSettings],
  );

  const handleSaveSettings = useCallback(
    async (e, settingsOverride) => {
      e?.preventDefault();
      const toSave = settingsOverride ?? settings;
      setSaving(true);
      try {
        const savedSettings = await updateAppSettings(toSave);
        const normalizedSettings = normalizeSettings(savedSettings);
        setSettingsState(normalizedSettings);
        setOriginalSettings(JSON.parse(JSON.stringify(normalizedSettings)));
        setHasUnsavedChanges(false);
        showSuccess("Settings saved successfully!");
        await refreshHealth();
      } catch (err) {
        await fetchSettings();
        showError("Failed to save settings: " + err.message);
      } finally {
        setSaving(false);
      }
    },
    [settings, showSuccess, showError, refreshHealth, fetchSettings],
  );

  const handleRefreshDiscovery = useCallback(async () => {
    if (refreshingDiscovery) return;
    setRefreshingDiscovery(true);
    setDiscoveryProgressMessage("Submitting discovery refresh request");
    try {
      await api.post("/discover/refresh");
      localStorage.setItem(DISCOVERY_MANUAL_REFRESH_KEY, "1");
      showInfo(
        "Discovery refresh started in background. This may take a few minutes to fully hydrate images.",
      );
      await refreshHealth();
    } catch (err) {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
      setDiscoveryProgressMessage("");
      showError(
        "Failed to start refresh: " +
          (err.response?.data?.message ||
            err.response?.data?.error ||
            err.message),
      );
    }
  }, [refreshingDiscovery, showInfo, showError, refreshHealth]);

  const handleClearCache = useCallback(async () => {
    if (
      !window.confirm(
        "Are you sure you want to clear the image cache? Discovery recommendations will stay intact.",
      )
    )
      return;
    setClearingCache(true);
    try {
      await api.post("/discover/clear");
      showSuccess("Image cache cleared successfully.");
      await refreshHealth();
    } catch (err) {
      showError(
        "Failed to clear cache: " +
          (err.response?.data?.message ||
            err.response?.data?.error ||
            err.message),
      );
    } finally {
      setClearingCache(false);
    }
  }, [showSuccess, showError, refreshHealth]);

  const handleApplyCommunityGuide = useCallback(async () => {
    setShowCommunityGuideModal(false);
    setApplyingCommunityGuide(true);
    try {
      const result = await applyLidarrCommunityGuide();
      showSuccess("Community guide settings applied successfully!");

      if (result.results?.qualityProfile) {
        const url = settings.integrations?.lidarr?.url;
        const apiKey = settings.integrations?.lidarr?.apiKey;
        setLoadingLidarrProfiles(true);
        try {
          const profiles = await getLidarrProfiles(url, apiKey);
          setLidarrProfiles(profiles);
          if (result.results.qualityProfile.id) {
            updateSettings({
              ...settings,
              integrations: {
                ...settings.integrations,
                lidarr: {
                  ...(settings.integrations?.lidarr || {}),
                  qualityProfileId: result.results.qualityProfile.id,
                },
              },
            });
            showInfo(
              `Default quality profile set to '${result.results.qualityProfile.name}'`,
            );
          }
        } catch {
        } finally {
          setLoadingLidarrProfiles(false);
        }
      }
      if (result.results?.metadataProfile) {
        const url = settings.integrations?.lidarr?.url;
        const apiKey = settings.integrations?.lidarr?.apiKey;
        setLoadingLidarrMetadataProfiles(true);
        try {
          const profiles = await getLidarrMetadataProfiles(url, apiKey);
          setLidarrMetadataProfiles(profiles);
          if (result.results.metadataProfile.id) {
            updateSettings({
              ...settings,
              integrations: {
                ...settings.integrations,
                lidarr: {
                  ...(settings.integrations?.lidarr || {}),
                  metadataProfileId: result.results.metadataProfile.id,
                },
              },
            });
            showInfo(
              `Default metadata profile set to '${result.results.metadataProfile.name}'`,
            );
          }
        } catch {
        } finally {
          setLoadingLidarrMetadataProfiles(false);
        }
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Failed to apply community guide: ${errorMsg}`);
    } finally {
      setApplyingCommunityGuide(false);
    }
  }, [settings, updateSettings, showSuccess, showError, showInfo]);

  return {
    health,
    settings,
    updateSettings,
    originalSettings,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    saving,
    handleSaveSettings,
    fetchSettings,
    refreshHealth,
    refreshingDiscovery,
    discoveryProgress,
    discoveryProgressMessage,
    clearingCache,
    handleRefreshDiscovery,
    handleClearCache,
    lidarrProfiles,
    setLidarrProfiles,
    loadingLidarrProfiles,
    setLoadingLidarrProfiles,
    lidarrMetadataProfiles,
    setLidarrMetadataProfiles,
    loadingLidarrMetadataProfiles,
    setLoadingLidarrMetadataProfiles,
    lidarrTags,
    setLidarrTags,
    loadingLidarrTags,
    setLoadingLidarrTags,
    testingLidarr,
    setTestingLidarr,
    testingGotify,
    setTestingGotify,
    applyingCommunityGuide,
    showCommunityGuideModal,
    setShowCommunityGuideModal,
    handleApplyCommunityGuide,
    getLidarrProfiles,
    testLidarrConnection,
    testGotifyConnection,
  };
}
