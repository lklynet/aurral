import { useState, useEffect, useRef, useCallback } from "react";
import api from "../../../utils/api/core.js";
import { checkHealth } from "../../../utils/api/endpoints/auth.js";
import {
  getAppSettings,
  updateAppSettings,
  getLidarrRootFolders,
  getLidarrProfiles,
  getLidarrMetadataProfiles,
  getLidarrTags,
  testLidarrConnection,
  testGotifyConnection,
  applyLidarrCommunityGuide,
} from "../../../utils/api/endpoints/settings.js";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "../../../utils/discoverRecentNavigation.js";
import { shouldPollDiscoveryHealth } from "../../../utils/requestScheduling.js";
import { allReleaseTypes } from "../constants";
import {
  DEFAULT_METADATA_BASE_URL,
  checkForChanges,
  normalizeSettings,
} from "../utils";

const defaultSettings = {
  rootFolderPath: "",
  downloadFolderPath: "",
  pathMappings: [],
  quality: "standard",
  releaseTypes: allReleaseTypes,
  integrations: {
    navidrome: {
      url: "",
      username: "",
      password: "",
      m3uPathMode: "local",
      pathMappings: [],
    },
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
      discoveryPersonalizedEnabled: true,
      discoveryMode: "balanced",
    },
    slskd: {
      enabled: true,
      url: "",
      apiKey: "",
      priority: 10,
      preferredFormat: "flac",
      preferredFormatStrict: false,
      cleanupAfterRuns: false,
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
    ticketmaster: {
      apiKey: "",
      searchRadiusMiles: 250,
      localDiscoveryIncludeRecommendations: true,
      localDiscoveryIncludeTrending: true,
    },
    news: {
      enabled: true,
      feeds: [],
      groups: {
        major: true,
        indie: true,
        discovery: true,
        hiphop: true,
        pop: true,
        electronic: true,
        metal: true,
        country: true,
        jazz: true,
        classical: true,
        specialty: true,
        regional: true,
        concerts: true,
      },
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
  playlistArtwork: {
    style: "photo",
  },
  inbox: {
    releases: true,
    shows: true,
    news: true,
    recommendedNews: false,
    discoveries: true,
  },
  security: {
    localNetworkBypass: {
      enabled: false,
    },
  },
};

const AUTOSAVE_DELAY_MS = 450;

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
  const [lidarrRootFolders, setLidarrRootFolders] = useState([]);
  const [loadingLidarrRootFolders, setLoadingLidarrRootFolders] = useState(false);
  const [lidarrProfiles, setLidarrProfiles] = useState([]);
  const [loadingLidarrProfiles, setLoadingLidarrProfiles] = useState(false);
  const [lidarrMetadataProfiles, setLidarrMetadataProfiles] = useState([]);
  const [loadingLidarrMetadataProfiles, setLoadingLidarrMetadataProfiles] = useState(false);
  const [lidarrTags, setLidarrTags] = useState([]);
  const [loadingLidarrTags, setLoadingLidarrTags] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [testingGotify, setTestingGotify] = useState(false);
  const [applyingCommunityGuide, setApplyingCommunityGuide] = useState(false);
  const [showCommunityGuideModal, setShowCommunityGuideModal] = useState(false);
  const comparisonEnabledRef = useRef(false);
  const settingsRef = useRef(defaultSettings);
  const originalSettingsRef = useRef(null);
  const hasUnsavedChangesRef = useRef(false);
  const saveTimerRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const saveQueuedRef = useRef(false);
  const persistSettingsRef = useRef(null);
  const mountedRef = useRef(true);

  const applyHealthUpdate = useCallback((healthData, { allowClearRefreshing = true } = {}) => {
    setHealth(healthData);
    if (healthData?.discovery?.isUpdating) {
      setRefreshingDiscovery(true);
      setDiscoveryProgressMessage(
        healthData.discovery.updateProgressMessage || "Discovery refresh is running",
      );
      if (typeof healthData.discovery.updateProgress === "number") {
        setDiscoveryProgress(healthData.discovery.updateProgress);
      }
    } else if (allowClearRefreshing) {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
    }
  }, []);

  const refreshHealth = useCallback(async (options) => {
    try {
      const healthData = await checkHealth();
      applyHealthUpdate(healthData, options);
      return healthData;
    } catch {
      return null;
    }
  }, [applyHealthUpdate]);

  const lastDiscoveryWsMessageAtRef = useRef(0);

  const { isConnected: discoveryWsConnected } = useWebSocketChannel("discovery", (msg) => {
    if (msg.type !== "discovery_update") return;

    if (msg.phase === "error") {
      lastDiscoveryWsMessageAtRef.current = Date.now();
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
      setDiscoveryProgressMessage(msg.progressMessage || "Discovery refresh failed");
      return;
    }

    if (msg.isUpdating) {
      lastDiscoveryWsMessageAtRef.current = Date.now();
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
      lastDiscoveryWsMessageAtRef.current = Date.now();
      setRefreshingDiscovery(false);
      setDiscoveryProgress(100);
      setDiscoveryProgressMessage(msg.progressMessage || "Discovery refresh completed");
      refreshHealth({ allowClearRefreshing: true });
      return;
    }
  });

  const fetchSettings = useCallback(async () => {
    comparisonEnabledRef.current = false;
    try {
      const [, savedSettings] = await Promise.all([refreshHealth(), getAppSettings()]);
      const updatedSettings = normalizeSettings(savedSettings);
      const savedSnapshot = structuredClone(updatedSettings);
      settingsRef.current = updatedSettings;
      originalSettingsRef.current = savedSnapshot;
      setSettingsState(updatedSettings);
      setOriginalSettings(savedSnapshot);
      hasUnsavedChangesRef.current = false;
      setHasUnsavedChanges(false);
      setTimeout(() => {
        comparisonEnabledRef.current = true;
      }, 600);

      const lidarr = updatedSettings.integrations?.lidarr || {};
      if (lidarr.url && lidarr.apiKey) {
        setLoadingLidarrRootFolders(true);
        setLoadingLidarrProfiles(true);
        setLoadingLidarrMetadataProfiles(true);
        setLoadingLidarrTags(true);
        try {
          const [rootFolders, profiles, metadataProfiles, tags] = await Promise.all([
            getLidarrRootFolders(lidarr.url, lidarr.apiKey),
            getLidarrProfiles(lidarr.url, lidarr.apiKey),
            getLidarrMetadataProfiles(lidarr.url, lidarr.apiKey),
            getLidarrTags(lidarr.url, lidarr.apiKey),
          ]);
          setLidarrRootFolders(Array.isArray(rootFolders) ? rootFolders : []);
          setLidarrProfiles(profiles);
          setLidarrMetadataProfiles(metadataProfiles);
          setLidarrTags(Array.isArray(tags) ? tags : []);
        } catch {
        } finally {
          setLoadingLidarrRootFolders(false);
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
    mountedRef.current = true;
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (hasUnsavedChangesRef.current) {
        persistSettingsRef.current?.(settingsRef.current);
      }
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      !refreshingDiscovery ||
      !shouldPollDiscoveryHealth({ isConnected: discoveryWsConnected })
    ) {
      return;
    }

    let stopped = false;
    let timeoutId = null;
    let startedAt = Date.now();

    const pollHealth = async () => {
      try {
        const allowClearRefreshing =
          Date.now() - lastDiscoveryWsMessageAtRef.current >= 20000;
        const healthData = await refreshHealth({ allowClearRefreshing });
        if (!healthData?.discovery?.isUpdating && allowClearRefreshing) {
          setDiscoveryProgressMessage((current) => current || "Discovery refresh completed");
        }
      } catch {}
      if (stopped) return;
      const delay = Date.now() - startedAt < 60000 ? 3000 : 10000;
      timeoutId = setTimeout(pollHealth, delay);
    };

    pollHealth();
    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [discoveryWsConnected, refreshingDiscovery, refreshHealth]);

  const persistSettings = useCallback(
    async (settingsToSave) => {
      if (!settingsToSave) return false;
      if (saveInFlightRef.current) {
        if (checkForChanges(settingsRef.current, originalSettingsRef.current)) {
          saveQueuedRef.current = true;
        }
        return saveInFlightRef.current;
      }

      if (mountedRef.current) setSaving(true);
      let succeeded = false;
      const request = (async () => {
        try {
          const savedSettings = await updateAppSettings(settingsToSave);
          const normalizedSettings = normalizeSettings(savedSettings);
          const savedSnapshot = structuredClone(normalizedSettings);
          const isLatestSettings = settingsRef.current === settingsToSave;

          originalSettingsRef.current = savedSnapshot;
          if (mountedRef.current) setOriginalSettings(savedSnapshot);

          if (isLatestSettings) {
            settingsRef.current = normalizedSettings;
            if (mountedRef.current) setSettingsState(normalizedSettings);
            hasUnsavedChangesRef.current = false;
            if (mountedRef.current) setHasUnsavedChanges(false);
          } else {
            const stillDirty = checkForChanges(settingsRef.current, normalizedSettings);
            hasUnsavedChangesRef.current = stillDirty;
            if (mountedRef.current) setHasUnsavedChanges(stillDirty);
          }

          if (mountedRef.current) await refreshHealth();
          succeeded = true;
          return true;
        } catch (err) {
          if (mountedRef.current) {
            showError("Failed to save settings: " + err.message);
          }
          return false;
        }
      })();

      saveInFlightRef.current = request;
      try {
        return await request;
      } finally {
        saveInFlightRef.current = null;
        if (mountedRef.current) setSaving(false);

        const shouldSaveLatest =
          succeeded &&
          (saveQueuedRef.current ||
            checkForChanges(settingsRef.current, originalSettingsRef.current));
        saveQueuedRef.current = false;
        if (shouldSaveLatest) {
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            persistSettingsRef.current?.(settingsRef.current);
          }, 0);
        }
      }
    },
    [refreshHealth, showError],
  );

  persistSettingsRef.current = persistSettings;

  const updateSettings = useCallback((newSettings) => {
    settingsRef.current = newSettings;
    setSettingsState(newSettings);
    if (!comparisonEnabledRef.current || !originalSettingsRef.current) return;

    const changed = checkForChanges(newSettings, originalSettingsRef.current);
    hasUnsavedChangesRef.current = changed;
    setHasUnsavedChanges(changed);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!changed) return;

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persistSettingsRef.current?.(settingsRef.current);
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const handleSaveSettings = useCallback(
    (e, settingsOverride) => {
      e?.preventDefault();
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      const toSave = settingsOverride ?? settingsRef.current;
      if (settingsOverride) {
        settingsRef.current = settingsOverride;
        setSettingsState(settingsOverride);
      }
      return persistSettings(toSave);
    },
    [persistSettings],
  );

  const handleRefreshDiscovery = useCallback(async () => {
    if (refreshingDiscovery) return;
    setRefreshingDiscovery(true);
    setDiscoveryProgressMessage("Submitting discovery refresh request");
    lastDiscoveryWsMessageAtRef.current = Date.now();
    try {
      await api.post("/discover/refresh");
      localStorage.setItem(DISCOVERY_MANUAL_REFRESH_KEY, "1");
      showInfo(
        "Discovery refresh started in background. This may take a few minutes to fully hydrate images.",
      );
      await refreshHealth({ allowClearRefreshing: false });
    } catch (err) {
      setRefreshingDiscovery(false);
      setDiscoveryProgress(null);
      setDiscoveryProgressMessage("");
      showError(
        "Failed to start refresh: " +
          (err.response?.data?.message || err.response?.data?.error || err.message),
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
          (err.response?.data?.message || err.response?.data?.error || err.message),
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
            showInfo(`Default quality profile set to '${result.results.qualityProfile.name}'`);
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
            showInfo(`Default metadata profile set to '${result.results.metadataProfile.name}'`);
          }
        } catch {
        } finally {
          setLoadingLidarrMetadataProfiles(false);
        }
      }
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
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
    lidarrRootFolders,
    setLidarrRootFolders,
    loadingLidarrRootFolders,
    setLoadingLidarrRootFolders,
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
