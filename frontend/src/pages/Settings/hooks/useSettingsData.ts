import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { useToast } from "../../../contexts/ToastContext";
import { fetchHealth, refetchHealth } from "../../../utils/appHealth.ts";
import { parseResponse } from "hono/client";
import { settingsClient } from "../../../utils/api/clients/settings.ts";
import { downloadClientSettingsClient } from "../../../utils/api/clients/downloadClientSettings.ts";
import { refetchDiscoveryStatus } from "../../../hooks/useDiscoveryStatus";
import { discoveryClient } from "../../../utils/api/clients/discovery.ts";
import { DISCOVERY_MANUAL_REFRESH_KEY } from "../../../utils/discoverRecentNavigation.ts";
import { allReleaseTypes } from "../constants";
import { checkForChanges, normalizeSettings, type SettingsState } from "../utils";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { appSettingsQueryOptions } from "../../../queryOptions.ts";
import { afterTextEntry } from "../../../utils/afterTextEntry.ts";
import { readApiError } from "../../../utils/api/errors.ts";

type Toast = ReturnType<typeof useToast>["showSuccess"];

const defaultSettings = {
  dateTimeFormat: "browser",
  subsonic: {
    favoriteAutoKeep: true,
  },
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
    tidarr: {
      enabled: false,
      url: "",
      apiKey: "",
      priority: 20,
    },
    qbittorrent: {
      enabled: false,
      url: "",
      username: "",
      password: "",
      category: "aurral",
      priority: 30,
    },
    ytdlp: {
      enabled: true,
      priority: 50,
      stagingPath: "",
      cookiesPath: "",
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
    metadata: {
      provider: "brainzmash",
      baseUrl: "",
      userAgentSuffix: "",
      enableNarrowFallbacks: true,
    },
    general: {},
    gotify: {
      url: "",
      token: "",
      notifyDiscoveryUpdated: false,
      notifyFlowDone: false,
      notifyRequestMade: false,
      notifyRequestAvailable: false,
      notifyArtistAdded: false,
      notifyTrackAdded: false,
    },
    webhooks: [],
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

const SETTINGS_SAVE_KEY = ["settings", "save"];

const settingsSaveSettled = () =>
  new Promise<void>((resolve) => {
    const idle = () => queryClient.isMutating({ mutationKey: SETTINGS_SAVE_KEY }) === 0;
    if (idle()) {
      resolve();
      return;
    }
    const unsubscribe = queryClient.getMutationCache().subscribe(() => {
      if (!idle()) return;
      unsubscribe();
      resolve();
    });
  });

export function useSettingsData(showSuccess: Toast, showError: Toast) {
  const [settings, setSettingsState] = useState<SettingsState>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [originalSettings, setOriginalSettings] = useState<SettingsState | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
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
  const settingsQuery = useQuery({ ...appSettingsQueryOptions(), enabled: false });
  const downloadClientQuery = useQuery({
    queryKey: queryKeys.downloadClientSettings,
    queryFn: ({ signal }) =>
      parseResponse(
        downloadClientSettingsClient["download-clients"].$get({}, { init: { signal } }),
      ),
    enabled: false,
    staleTime: 30_000,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 30_000,
  });
  const health = healthQuery.data ?? null;
  const settingsSaveMutation = useMutation({
    mutationKey: SETTINGS_SAVE_KEY,
    mutationFn: (json: SettingsState) => parseResponse(settingsClient.$post({ json })),
    scope: { id: "app-settings" },
    onSuccess: (savedSettings) => {
      queryClient.setQueryData(queryKeys.appSettings, savedSettings);
      queryClient.invalidateQueries({ queryKey: queryKeys.appHealth });
      // Some settings change what the Library endpoints return without changing
      // the query key, so mark the Library views stale on save.
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
    },
  });
  const downloadClientSettings = downloadClientQuery.data?.clients || null;
  const saving = settingsSaveMutation.isPending;
  const { mutateAsync: saveSettings } = settingsSaveMutation;
  const { refetch: refetchSettings } = settingsQuery;
  const { refetch: refetchDownloadClients } = downloadClientQuery;

  const refreshHealth = useCallback(async () => {
    try {
      return await refetchHealth();
    } catch {
      return null;
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    comparisonEnabledRef.current = false;
    if (settingsActivationTimerRef.current) clearTimeout(settingsActivationTimerRef.current);
    try {
      void refreshHealth();
      await settingsSaveSettled();
      const [settingsResult] = await Promise.all([
        refetchSettings({ throwOnError: true }),
        refetchDownloadClients({ throwOnError: false }),
      ]);
      const savedSettings = settingsResult.data!;
      const updatedSettings = normalizeSettings(savedSettings);
      const savedSnapshot = structuredClone(updatedSettings);
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
  }, [refetchDownloadClients, refetchSettings, refreshHealth]);

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
        const failure = readApiError(err);
        showError(failure.error || "Failed to save settings: " + failure.text);
        return false;
      }
    },
    [saveSettings, showError],
  );

  persistSettingsRef.current = persistSettings;

  const flushSettings = useCallback(() => {
    if (hasUnsavedChangesRef.current) void persistSettingsRef.current?.(settingsRef.current);
  }, []);

  const updateSettings = useCallback(
    (newSettings: SettingsState) => {
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
      if (changed) afterTextEntry(flushSettings);
    },
    [flushSettings],
  );

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
    mutationFn: () => parseResponse(discoveryClient.refresh.$post()),
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
    mutationFn: () => parseResponse(discoveryClient.clear.$post()),
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

  return {
    health,
    settings,
    settingsLoaded,
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
  };
}
