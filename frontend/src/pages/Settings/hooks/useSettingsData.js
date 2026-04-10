import { useState, useEffect, useRef, useCallback } from "react";
import api, {
  checkHealth,
  getAppSettings,
  updateAppSettings,
  getLidarrProfiles,
  getLidarrMetadataProfiles,
  testLidarrConnection,
  testGotifyConnection,
  applyLidarrCommunityGuide,
} from "../../../utils/api";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";
import { allReleaseTypes } from "../constants";
import { normalizeSettings, checkForChanges } from "../utils";

const DISCOVERY_MANUAL_REFRESH_KEY = "aurral.discovery.manualRefreshPending";

const defaultSettings = {
  rootFolderPath: "",
  quality: "standard",
  releaseTypes: allReleaseTypes,
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
};

export function useSettingsData(showSuccess, showError, showInfo) {
  const [health, setHealth] = useState(null);
  const [settings, setSettingsState] = useState(defaultSettings);
  const [originalSettings, setOriginalSettings] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingDiscovery, setRefreshingDiscovery] = useState(false);
  const [discoveryProgressMessage, setDiscoveryProgressMessage] = useState("");
  const [clearingCache, setClearingCache] = useState(false);
  const [lidarrProfiles, setLidarrProfiles] = useState([]);
  const [loadingLidarrProfiles, setLoadingLidarrProfiles] = useState(false);
  const [lidarrMetadataProfiles, setLidarrMetadataProfiles] = useState([]);
  const [loadingLidarrMetadataProfiles, setLoadingLidarrMetadataProfiles] =
    useState(false);
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
        (current) => current || "Discovery refresh is running",
      );
    } else {
      setRefreshingDiscovery(false);
    }
  }, []);

  useWebSocketChannel("discovery", (msg) => {
    if (msg.type !== "discovery_update") return;

    if (msg.phase === "error") {
      setRefreshingDiscovery(false);
      setDiscoveryProgressMessage(
        msg.progressMessage || "Discovery refresh failed",
      );
      return;
    }

    if (msg.isUpdating) {
      setRefreshingDiscovery(true);
      setDiscoveryProgressMessage(
        msg.progressMessage || "Discovery refresh is running",
      );
      return;
    }

    if (msg.phase === "completed" || Array.isArray(msg.recommendations)) {
      setRefreshingDiscovery(false);
      setDiscoveryProgressMessage(
        msg.progressMessage || "Discovery refresh completed",
      );
      checkHealth()
        .then((healthData) => {
          applyHealthUpdate(healthData);
        })
        .catch(() => {});
      return;
    }
  });

  const fetchSettings = useCallback(async () => {
    comparisonEnabledRef.current = false;
    try {
      const [healthData, savedSettings] = await Promise.all([
        checkHealth(),
        getAppSettings(),
      ]);
      applyHealthUpdate(healthData);
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
        try {
          const [profiles, metadataProfiles] = await Promise.all([
            getLidarrProfiles(lidarr.url, lidarr.apiKey),
            getLidarrMetadataProfiles(lidarr.url, lidarr.apiKey),
          ]);
          setLidarrProfiles(profiles);
          setLidarrMetadataProfiles(metadataProfiles);
        } catch {
        } finally {
          setLoadingLidarrProfiles(false);
          setLoadingLidarrMetadataProfiles(false);
        }
      }
    } catch {}
  }, [applyHealthUpdate]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!refreshingDiscovery) return;

    const pollHealth = async () => {
      try {
        const healthData = await checkHealth();
        applyHealthUpdate(healthData);
        if (!healthData?.discovery?.isUpdating) {
          setDiscoveryProgressMessage(
            (current) => current || "Discovery refresh completed",
          );
        }
      } catch {}
    };

    pollHealth();
    const intervalId = setInterval(pollHealth, 8000);
    return () => clearInterval(intervalId);
  }, [refreshingDiscovery, applyHealthUpdate]);

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
        await updateAppSettings(toSave);
        setOriginalSettings(JSON.parse(JSON.stringify(toSave)));
        setHasUnsavedChanges(false);
        showSuccess("Settings saved successfully!");
      } catch (err) {
        showError("Failed to save settings: " + err.message);
      } finally {
        setSaving(false);
      }
    },
    [settings, showSuccess, showError],
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
      const healthData = await checkHealth();
      applyHealthUpdate(healthData);
    } catch (err) {
      setRefreshingDiscovery(false);
      setDiscoveryProgressMessage("");
      showError(
        "Failed to start refresh: " +
          (err.response?.data?.message ||
            err.response?.data?.error ||
            err.message),
      );
    }
  }, [refreshingDiscovery, showInfo, showError, applyHealthUpdate]);

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
      const healthData = await checkHealth();
      applyHealthUpdate(healthData);
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
  }, [showSuccess, showError, applyHealthUpdate]);

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

  const refreshHealth = useCallback(async () => {
    try {
      const healthData = await checkHealth();
      applyHealthUpdate(healthData);
    } catch {}
  }, [applyHealthUpdate]);

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
