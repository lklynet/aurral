import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import api from "../../../utils/api/core.ts";
import type { useToast } from "../../../contexts/ToastContext";
import type { useSettingsTabs } from "./useSettingsTabs";
import { checkHealth, fetchHealth } from "../../../utils/api/endpoints/auth.ts";
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
} from "../../../utils/api/endpoints/settings.ts";
import { refetchDiscoveryStatus } from "../../../hooks/useDiscoveryStatus";
import { refreshDiscovery } from "../../../utils/api/endpoints/discovery.ts";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "../../../utils/discoverRecentNavigation.ts";
import { allReleaseTypes } from "../constants";
import {
  DEFAULT_METADATA_BASE_URL,
  checkForChanges,
  normalizeSettings,
  type SettingsState,
} from "../utils";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { readApiError } from "../utils/apiError.ts";

type Toast = ReturnType<typeof useToast>["showSuccess"];
type LidarrResourceConfig = { url: string; apiKey: string; credentialsRevision: number };

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
      "flac-hires",
      "flac-standard",
      "mp3-320",
      "m4a-320",
      "mp3-256",
      "m4a-256",
      "mp3-192",
      "m4a-192",
      "mp3-128",
      "m4a-128",
    ],
    enabled: [
      "flac-hires",
      "flac-standard",
      "mp3-320",
      "m4a-320",
      "mp3-256",
      "m4a-256",
      "mp3-192",
      "m4a-192",
      "mp3-128",
      "m4a-128",
    ],
    cutoff: "flac-standard",
    automaticUpgrades: false,
    intervalDays: 2,
  },
  missingTrackSearch: {
    enabled: false,
    intervalDays: 1,
  },
  reviewTimeoutHours: 0,
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
      deleteLeftovers: true,
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
const SETTINGS_SAVE_KEY = ["settings", "save"];

const getLidarrResourceConfig = (settings: SettingsState) => {
  const lidarr = settings?.integrations?.lidarr || {};
  return {
    url: lidarr.url || "",
    apiKey: lidarr.apiKey || "",
  };
};

const buildLidarrQueries = (
  { url, apiKey, credentialsRevision }: LidarrResourceConfig,
  enabled?: boolean,
) =>
  [
    {
      queryKey: queryKeys.lidarrRootFolders(url, credentialsRevision),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getLidarrRootFolders(url, apiKey, { signal }),
      enabled: enabled && Boolean(url && apiKey),
      staleTime: 60_000,
    },
    {
      queryKey: queryKeys.lidarrProfiles(url, credentialsRevision),
      queryFn: ({ signal }: { signal: AbortSignal }) => getLidarrProfiles(url, apiKey, { signal }),
      enabled: enabled && Boolean(url && apiKey),
      staleTime: 60_000,
    },
    {
      queryKey: queryKeys.lidarrMetadataProfiles(url, credentialsRevision),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getLidarrMetadataProfiles(url, apiKey, { signal }),
      enabled: enabled && Boolean(url && apiKey),
      staleTime: 60_000,
    },
    {
      queryKey: queryKeys.lidarrTags(url, credentialsRevision),
      queryFn: ({ signal }: { signal: AbortSignal }) => getLidarrTags(url, apiKey, { signal }),
      enabled: enabled && Boolean(url && apiKey),
      staleTime: 60_000,
    },
  ] as const;

export function useSettingsData(
  showSuccess: Toast,
  showError: Toast,
  showInfo: Toast,
  activeTab: ReturnType<typeof useSettingsTabs>["activeTab"],
) {
  const [settings, setSettingsState] = useState<SettingsState>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [originalSettings, setOriginalSettings] = useState<SettingsState | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [testingGotify, setTestingGotify] = useState(false);
  const [showCommunityGuideModal, setShowCommunityGuideModal] = useState(false);
  const comparisonEnabledRef = useRef(false);
  const settingsRef = useRef<SettingsState>(defaultSettings);
  const originalSettingsRef = useRef<SettingsState | null>(null);
  const hasUnsavedChangesRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistSettingsRef = useRef<((settingsToSave: SettingsState) => Promise<boolean>) | null>(
    null,
  );
  const settingsActivationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const lidarrResourceConfigRef = useRef({ url: "", apiKey: "", credentialsRevision: 0 });
  const [lidarrResourceConfig, setLidarrResourceConfig] = useState(lidarrResourceConfigRef.current);

  const updateLidarrResourceConfig = useCallback((config: { url: string; apiKey: string }) => {
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
  const healthQuery = useQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal }) => fetchHealth({ signal }),
    staleTime: 30_000,
  });
  const health = healthQuery.data ?? null;
  const settingsSaveMutation = useMutation({
    mutationKey: SETTINGS_SAVE_KEY,
    mutationFn: updateAppSettings,
    scope: { id: "app-settings" },
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
  const [
    lidarrRootFoldersQuery,
    lidarrProfilesQuery,
    lidarrMetadataProfilesQuery,
    lidarrTagsQuery,
  ] = lidarrQueries;
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
      return await checkHealth({ force: true });
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
      const savedSettings = settingsResult.data!;
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

  const refreshLidarrResources = useCallback(
    async (config: { url: string; apiKey: string } | null = null) => {
      const nextConfig = updateLidarrResourceConfig(
        config || getLidarrResourceConfig(settingsRef.current),
      );
      if (!nextConfig.url || !nextConfig.apiKey) return [];
      const [rootFolders, profiles, metadataProfiles, tags] = buildLidarrQueries(nextConfig);
      return Promise.all([
        queryClient.fetchQuery({
          queryKey: rootFolders.queryKey,
          queryFn: rootFolders.queryFn,
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: profiles.queryKey,
          queryFn: profiles.queryFn,
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: metadataProfiles.queryKey,
          queryFn: metadataProfiles.queryFn,
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: tags.queryKey,
          queryFn: tags.queryFn,
          staleTime: 0,
        }),
      ]);
    },
    [updateLidarrResourceConfig],
  );

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
    async (settingsToSave: SettingsState) => {
      if (!settingsToSave) return false;
      try {
        const savedSettings = await saveSettings(settingsToSave);
        const normalizedSettings = normalizeSettings(savedSettings);
        const savedSnapshot = structuredClone(normalizedSettings);
        updateLidarrResourceConfig(getLidarrResourceConfig(normalizedSettings));

        originalSettingsRef.current = savedSnapshot;
        if (mountedRef.current) setOriginalSettings(savedSnapshot);

        if (settingsRef.current === settingsToSave) {
          settingsRef.current = normalizedSettings;
          if (mountedRef.current) setSettingsState(normalizedSettings);
          hasUnsavedChangesRef.current = false;
          if (mountedRef.current) setHasUnsavedChanges(false);
        } else {
          const stillDirty = checkForChanges(settingsRef.current, normalizedSettings);
          hasUnsavedChangesRef.current = stillDirty;
          if (mountedRef.current) setHasUnsavedChanges(stillDirty);
          if (
            stillDirty &&
            !saveTimerRef.current &&
            queryClient.isMutating({ mutationKey: SETTINGS_SAVE_KEY }) === 0
          ) {
            saveTimerRef.current = setTimeout(() => {
              saveTimerRef.current = null;
              persistSettingsRef.current?.(settingsRef.current);
            }, 0);
          }
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("aurral:settings-updated", {
              detail: { inboxEnabled: normalizedSettings.inbox?.enabled !== false },
            }),
          );
        }
        return true;
      } catch (err) {
        if (mountedRef.current) {
          showError("Failed to save settings: " + readApiError(err).text);
        }
        return false;
      }
    },
    [saveSettings, showError, updateLidarrResourceConfig],
  );

  persistSettingsRef.current = persistSettings;

  const updateSettings = useCallback((newSettings: SettingsState) => {
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
    (e?: FormEvent<HTMLFormElement> | null, settingsOverride?: SettingsState) => {
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

  const discoveryRefreshMutation = useMutation({
    mutationFn: () => refreshDiscovery(),
    onSuccess: () => {
      localStorage.setItem(DISCOVERY_MANUAL_REFRESH_KEY, "1");
    },
    onError: (err) => {
      const failure = readApiError(err);
      showError("Failed to start refresh: " + (failure.message || failure.error || failure.text));
    },
    onSettled: () => refetchDiscoveryStatus(),
  });
  const requestingDiscoveryRefresh = discoveryRefreshMutation.isPending;
  const { mutate: requestDiscoveryRefresh } = discoveryRefreshMutation;

  const handleRefreshDiscovery = useCallback(() => {
    if (requestingDiscoveryRefresh) return;
    requestDiscoveryRefresh();
  }, [requestDiscoveryRefresh, requestingDiscoveryRefresh]);

  const clearCacheMutation = useMutation({
    mutationFn: () => api.post("/discover/clear"),
    onSuccess: async () => {
      showSuccess("Artwork cache cleared.");
      await refreshHealth();
    },
    onError: (err) => {
      const failure = readApiError(err);
      showError("Failed to clear cache: " + (failure.message || failure.error || failure.text));
    },
  });
  const clearingCache = clearCacheMutation.isPending;
  const { mutate: clearCache } = clearCacheMutation;

  const handleClearCache = useCallback(() => {
    if (!window.confirm("Clear cached artwork? It will reload as needed. Recommendations stay."))
      return;
    clearCache();
  }, [clearCache]);

  const communityGuideMutation = useMutation({
    mutationFn: () => applyLidarrCommunityGuide(),
    onError: (err) => {
      const failure = readApiError(err);
      const errorMsg = failure.message || failure.error || failure.text;
      showError(`Failed to apply community guide: ${errorMsg}`);
    },
  });
  const applyingCommunityGuide = communityGuideMutation.isPending;
  const { mutateAsync: applyCommunityGuide } = communityGuideMutation;

  const handleApplyCommunityGuide = useCallback(async () => {
    setShowCommunityGuideModal(false);
    let result;
    try {
      result = await applyCommunityGuide();
    } catch {
      return;
    }
    showSuccess("Guide settings applied.");

    let nextSettings = settingsRef.current;
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
    if (nextSettings !== settingsRef.current) updateSettings(nextSettings);
    if (qualityProfile || metadataProfile) {
      try {
        await refreshLidarrResources();
      } catch (err) {
        const failure = readApiError(err);
        const errorMsg = failure.message || failure.error || failure.text;
        showError(`Failed to apply community guide: ${errorMsg}`);
      }
    }
  }, [
    applyCommunityGuide,
    refreshLidarrResources,
    updateSettings,
    showSuccess,
    showError,
    showInfo,
  ]);

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
