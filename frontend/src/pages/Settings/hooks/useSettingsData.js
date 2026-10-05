import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import api from "../../../utils/api/core.js";
import { checkHealth } from "../../../utils/api/endpoints/auth.js";
import {
  fetchAppSettings,
  fetchPlaybackSettings,
  fetchDownloadClientSettings,
  updateAppSettings,
  getLidarrRootFolders,
  getLidarrProfiles,
  getLidarrMetadataProfiles,
  getLidarrTags,
  testLidarrConnection,
  testGotifyConnection,
  applyLidarrCommunityGuide,
} from "../../../utils/api/endpoints/settings.js";
import { refetchDiscoveryStatus } from "../../../hooks/useDiscoveryStatus";
import { refreshDiscovery } from "../../../utils/api/endpoints/discovery.js";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "../../../utils/discoverRecentNavigation.js";
import { allReleaseTypes } from "../constants";
import {
  DEFAULT_METADATA_BASE_URL,
  checkForChanges,
  normalizeSettings,
} from "../utils";
import { queryClient, queryKeys } from "../../../queryClient.js";

const defaultSettings = {
  dateTimeFormat: "browser",
  subsonic: {
    favoriteAutoKeep: true,
  },
  rootFolderPath: "",
  downloadFolderPath: "",
  pathMappings: [],
  quality: "standard",
  qualityProfile: {
    order: [
      "flac-hires", "flac-standard", "mp3-320", "m4a-320", "mp3-256",
      "m4a-256", "mp3-192", "m4a-192", "mp3-128", "m4a-128",
    ],
    enabled: [
      "flac-hires", "flac-standard", "mp3-320", "m4a-320", "mp3-256",
      "m4a-256", "mp3-192", "m4a-192", "mp3-128", "m4a-128",
    ],
    cutoff: "flac-standard",
    automaticUpgrades: false,
    intervalDays: 2,
  },
  missingTrackSearch: {
    enabled: false,
    intervalDays: 1,
  },
  releaseTypes: allReleaseTypes,
  integrations: {
    navidrome: {
      url: "",
      username: "",
      password: "",
      prefixOwnerUsername: true,
    },
    plex: {
      url: "",
      token: "",
      clientId: "",
      machineIdentifier: "",
      downloadsPath: "",
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
      deleteLeftovers: true,
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
    enabled: true,
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

const getLidarrResourceConfig = (settings) => {
  const lidarr = settings?.integrations?.lidarr || {};
  return {
    url: lidarr.url || "",
    apiKey: lidarr.apiKey || "",
  };
};

const buildLidarrQueries = ({ url, apiKey, credentialsRevision }, enabled) => [
  {
    queryKey: queryKeys.lidarrRootFolders(url, credentialsRevision),
    queryFn: ({ signal }) => getLidarrRootFolders(url, apiKey, { signal }),
    enabled: enabled && Boolean(url && apiKey),
    staleTime: 60_000,
  },
  {
    queryKey: queryKeys.lidarrProfiles(url, credentialsRevision),
    queryFn: ({ signal }) => getLidarrProfiles(url, apiKey, { signal }),
    enabled: enabled && Boolean(url && apiKey),
    staleTime: 60_000,
  },
  {
    queryKey: queryKeys.lidarrMetadataProfiles(url, credentialsRevision),
    queryFn: ({ signal }) => getLidarrMetadataProfiles(url, apiKey, { signal }),
    enabled: enabled && Boolean(url && apiKey),
    staleTime: 60_000,
  },
  {
    queryKey: queryKeys.lidarrTags(url, credentialsRevision),
    queryFn: ({ signal }) => getLidarrTags(url, apiKey, { signal }),
    enabled: enabled && Boolean(url && apiKey),
    staleTime: 60_000,
  },
];

export function useSettingsData(showSuccess, showError, showInfo, activeTab) {
  const [health, setHealth] = useState(null);
  const [settings, setSettingsState] = useState(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [originalSettings, setOriginalSettings] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [requestingDiscoveryRefresh, setRequestingDiscoveryRefresh] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
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
  const settingsActivationTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const lidarrResourceConfigRef = useRef({ url: "", apiKey: "", credentialsRevision: 0 });
  const [lidarrResourceConfig, setLidarrResourceConfig] = useState(
    lidarrResourceConfigRef.current,
  );

  const updateLidarrResourceConfig = useCallback((config) => {
    const previous = lidarrResourceConfigRef.current;
    const url = config.url || "";
    const apiKey = config.apiKey || "";
    if (previous.url === url && previous.apiKey === apiKey) return previous;
    const next = {
      url,
      apiKey,
      credentialsRevision: previous.credentialsRevision + 1,
    };
    lidarrResourceConfigRef.current = next;
    setLidarrResourceConfig(next);
    return next;
  }, []);

  const settingsQuery = useQuery({
    queryKey: queryKeys.appSettings,
    queryFn: ({ signal }) => fetchAppSettings({ signal }),
    enabled: false,
    staleTime: 30_000,
  });
  const playbackQuery = useQuery({
    queryKey: queryKeys.playbackSettings,
    queryFn: ({ signal }) => fetchPlaybackSettings({ signal }),
    enabled: false,
    staleTime: 30_000,
  });
  const downloadClientQuery = useQuery({
    queryKey: queryKeys.downloadClientSettings,
    queryFn: ({ signal }) => fetchDownloadClientSettings({ signal }),
    enabled: false,
    staleTime: 30_000,
  });
  const settingsSaveMutation = useMutation({
    mutationFn: updateAppSettings,
    onSuccess: (savedSettings) => {
      queryClient.setQueryData(queryKeys.appSettings, savedSettings);
      queryClient.invalidateQueries({ queryKey: queryKeys.appHealth });
      // Settings such as the Lidarr "available only" toggle change what the
      // Library endpoints return without changing the query key, so mark the
      // Library views stale on save to pick up the new filtering on next view.
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    },
  });
  const lidarrQueries = useQueries({
    queries: buildLidarrQueries(
      lidarrResourceConfig,
      activeTab === "lidarr" && settings.integrations?.lidarr?.enabled !== false,
    ),
  });
  const [lidarrRootFoldersQuery, lidarrProfilesQuery, lidarrMetadataProfilesQuery, lidarrTagsQuery] =
    lidarrQueries;
  const lidarrRootFolders = Array.isArray(lidarrRootFoldersQuery.data)
    ? lidarrRootFoldersQuery.data
    : [];
  const lidarrProfiles = Array.isArray(lidarrProfilesQuery.data) ? lidarrProfilesQuery.data : [];
  const lidarrMetadataProfiles = Array.isArray(lidarrMetadataProfilesQuery.data)
    ? lidarrMetadataProfilesQuery.data
    : [];
  const lidarrTags = Array.isArray(lidarrTagsQuery.data) ? lidarrTagsQuery.data : [];
  const loadingLidarrRootFolders = lidarrRootFoldersQuery.isFetching;
  const loadingLidarrProfiles = lidarrProfilesQuery.isFetching;
  const loadingLidarrMetadataProfiles = lidarrMetadataProfilesQuery.isFetching;
  const loadingLidarrTags = lidarrTagsQuery.isFetching;
  const playbackSettings = playbackQuery.data?.destinations || null;
  const downloadClientSettings = downloadClientQuery.data?.clients || null;
  const saving = settingsSaveMutation.isPending;
  const { mutateAsync: saveSettings } = settingsSaveMutation;
  const { refetch: refetchSettings } = settingsQuery;
  const { refetch: refetchPlayback } = playbackQuery;
  const { refetch: refetchDownloadClients } = downloadClientQuery;

  const refreshHealth = useCallback(async () => {
    try {
      const healthData = await checkHealth({ force: true });
      setHealth(healthData);
      return healthData;
    } catch {
      return null;
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    comparisonEnabledRef.current = false;
    if (settingsActivationTimerRef.current) clearTimeout(settingsActivationTimerRef.current);
    try {
      void refreshHealth();
      const [settingsResult] = await Promise.all([
        refetchSettings({ throwOnError: true }),
        refetchPlayback({ throwOnError: false }),
        refetchDownloadClients({ throwOnError: false }),
      ]);
      const savedSettings = settingsResult.data;
      const updatedSettings = normalizeSettings(savedSettings);
      const savedSnapshot = structuredClone(updatedSettings);
      updateLidarrResourceConfig(getLidarrResourceConfig(updatedSettings));
      settingsRef.current = updatedSettings;
      originalSettingsRef.current = savedSnapshot;
      setSettingsState(updatedSettings);
      setOriginalSettings(savedSnapshot);
      setSettingsLoaded(true);
      hasUnsavedChangesRef.current = false;
      setHasUnsavedChanges(false);
      settingsActivationTimerRef.current = setTimeout(() => {
        settingsActivationTimerRef.current = null;
        if (!mountedRef.current) return;
        comparisonEnabledRef.current = true;
        const changed = checkForChanges(settingsRef.current, originalSettingsRef.current);
        hasUnsavedChangesRef.current = changed;
        setHasUnsavedChanges(changed);
        if (changed) persistSettingsRef.current?.(settingsRef.current);
      }, 600);
    } catch {
      setSettingsLoaded(true);
    }
  }, [
    refetchDownloadClients,
    refetchPlayback,
    refetchSettings,
    refreshHealth,
    updateLidarrResourceConfig,
  ]);

  const refreshLidarrResources = useCallback(async (config = null) => {
    const nextConfig = updateLidarrResourceConfig(
      config || getLidarrResourceConfig(settingsRef.current),
    );
    if (!nextConfig.url || !nextConfig.apiKey) return [];
    return Promise.all(
      buildLidarrQueries(nextConfig).map(({ queryKey, queryFn }) =>
        queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 }),
      ),
    );
  }, [updateLidarrResourceConfig]);

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
      if (settingsActivationTimerRef.current) {
        clearTimeout(settingsActivationTimerRef.current);
        settingsActivationTimerRef.current = null;
      }
      if (hasUnsavedChangesRef.current) {
        persistSettingsRef.current?.(settingsRef.current);
      }
      mountedRef.current = false;
    };
  }, []);

  const persistSettings = useCallback(
    async (settingsToSave) => {
      if (!settingsToSave) return false;
      if (saveInFlightRef.current) {
        if (checkForChanges(settingsRef.current, originalSettingsRef.current)) {
          saveQueuedRef.current = true;
        }
        return saveInFlightRef.current;
      }

      let succeeded = false;
      const request = (async () => {
        try {
          const savedSettings = await saveSettings(settingsToSave);
          const normalizedSettings = normalizeSettings(savedSettings);
          const savedSnapshot = structuredClone(normalizedSettings);
          const isLatestSettings = settingsRef.current === settingsToSave;
          updateLidarrResourceConfig(getLidarrResourceConfig(normalizedSettings));

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
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("aurral:settings-updated", {
              detail: { inboxEnabled: normalizedSettings.inbox?.enabled !== false },
            }));
          }

          if (mountedRef.current) void refreshHealth();
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
    [refreshHealth, saveSettings, showError, updateLidarrResourceConfig],
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
    if (requestingDiscoveryRefresh) return;
    setRequestingDiscoveryRefresh(true);
    try {
      await refreshDiscovery();
      localStorage.setItem(DISCOVERY_MANUAL_REFRESH_KEY, "1");
    } catch (err) {
      showError(
        "Failed to start refresh: " +
          (err.response?.data?.message || err.response?.data?.error || err.message),
      );
    } finally {
      await refetchDiscoveryStatus();
      setRequestingDiscoveryRefresh(false);
    }
  }, [requestingDiscoveryRefresh, showError]);

  const handleClearCache = useCallback(async () => {
    if (
      !window.confirm(
        "Clear stored artwork links and native-library image files? Discovery recommendations will stay intact. Artwork will be fetched again as needed.",
      )
    )
      return;
    setClearingCache(true);
    try {
      await api.post("/discover/clear");
      showSuccess("Artwork cache cleared successfully.");
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

      let nextSettings = settings;
      const qualityProfile = result.results?.qualityProfile;
      const metadataProfile = result.results?.metadataProfile;
      if (qualityProfile?.id) {
        nextSettings = {
          ...nextSettings,
          integrations: {
            ...nextSettings.integrations,
            lidarr: {
              ...(nextSettings.integrations?.lidarr || {}),
              qualityProfileId: qualityProfile.id,
            },
          },
        };
        showInfo(`Default quality profile set to '${qualityProfile.name}'`);
      }
      if (metadataProfile?.id) {
        nextSettings = {
          ...nextSettings,
          integrations: {
            ...nextSettings.integrations,
            lidarr: {
              ...(nextSettings.integrations?.lidarr || {}),
              metadataProfileId: metadataProfile.id,
            },
          },
        };
        showInfo(`Default metadata profile set to '${metadataProfile.name}'`);
      }
      if (nextSettings !== settings) updateSettings(nextSettings);
      if (qualityProfile || metadataProfile) await refreshLidarrResources();
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Failed to apply community guide: ${errorMsg}`);
    } finally {
      setApplyingCommunityGuide(false);
    }
  }, [refreshLidarrResources, settings, updateSettings, showSuccess, showError, showInfo]);

  return {
    health,
    settings,
    settingsLoaded,
    playbackSettings,
    downloadClientSettings,
    updateSettings,
    originalSettings,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    saving,
    handleSaveSettings,
    fetchSettings,
    refreshHealth,
    requestingDiscoveryRefresh,
    clearingCache,
    handleRefreshDiscovery,
    handleClearCache,
    lidarrRootFolders,
    loadingLidarrRootFolders,
    lidarrProfiles,
    loadingLidarrProfiles,
    lidarrMetadataProfiles,
    loadingLidarrMetadataProfiles,
    lidarrTags,
    loadingLidarrTags,
    refreshLidarrResources,
    testingLidarr,
    setTestingLidarr,
    testingGotify,
    setTestingGotify,
    applyingCommunityGuide,
    showCommunityGuideModal,
    setShowCommunityGuideModal,
    handleApplyCommunityGuide,
    testLidarrConnection,
    testGotifyConnection,
  };
}
