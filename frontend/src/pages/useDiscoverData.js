import { describeAlbumRequestResult } from "../utils/albumAddAction";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addArtistToLibrary,
  getRecentlyAdded,
  getRecentReleases,
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
} from "../utils/api/endpoints/library.js";
import {
  buildAlbumRequestPayload,
  buildArtistAddPayload,
  getManagerName,
} from "../utils/libraryDestination";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { getDiscovery } from "../utils/api/endpoints/discovery.js";
import { getArtistRecordId } from "../utils/artistTaste";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { artistsShareDiscoveryIdentity } from "../utils/discoveryFeedback";
import { useNearbyShows } from "../hooks/useNearbyShows";
import {
  readStoredRecentlyAdded,
  writeStoredRecentlyAdded,
  readStoredRecentReleases,
  writeStoredRecentReleases,
  readStoredDiscoveryData,
  writeStoredDiscoveryData,
  normalizeDiscoveryData,
  mergeDiscoveryHttp,
  getStoredRecentlyAddedAt,
  getStoredRecentReleasesAt,
  getLibraryArtistImage,
} from "./discoverUtils";

import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.js";
import { describeArtistAdd } from "../utils/artistMonitoring.js";
const getArtistId = (artist) => getArtistRecordId(artist);

export function useDiscoverData() {
  const { user: authUser, hasPermission, bootstrap } = useAuth();
  const { showSuccess, showError, showInfo } = useToast();
  const libraryDestination = useLibraryDestination();
  const [ticketmasterConfigured, setTicketmasterConfigured] = useState(true);
  const {
    data: nearbyShowsData,
    loading: nearbyShowsLoading,
    error: nearbyShowsError,
    locationMode: nearbyLocationMode,
    appliedZip: appliedNearbyZip,
    appliedCountry: appliedNearbyCountry,
    setLocationMode: setNearbyLocationMode,
    setAppliedZip: setAppliedNearbyZip,
  } = useNearbyShows({ enabled: ticketmasterConfigured });

  const discoveryQueryKey = useMemo(
    () => queryKeys.discovery(authUser?.id),
    [authUser?.id],
  );
  const discoveryInitial = useMemo(
    () => readStoredDiscoveryData(authUser?.id) || undefined,
    [authUser?.id],
  );
  const discoveryQuery = useQuery({
    queryKey: discoveryQueryKey,
    queryFn: async ({ signal }) => {
      const nextValue = await getDiscovery({ signal });
      return mergeDiscoveryHttp(queryClient.getQueryData(discoveryQueryKey), nextValue, {
        allowClearStatus: true,
      }) || nextValue;
    },
    initialData: discoveryInitial,
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
  });
  const data = discoveryQuery.data || null;
  const setData = useCallback((updater) => {
    queryClient.setQueryData(discoveryQueryKey, updater);
  }, [discoveryQueryKey]);
  const recentlyAddedInitial = useMemo(
    () => readStoredRecentlyAdded(authUser?.id) || undefined,
    [authUser?.id],
  );
  const recentReleasesInitial = useMemo(
    () => readStoredRecentReleases(authUser?.id) || undefined,
    [authUser?.id],
  );
  const recentlyAddedQuery = useQuery({
    queryKey: queryKeys.recentlyAdded(authUser?.id),
    queryFn: ({ signal }) => getRecentlyAdded({ signal }),
    initialData: recentlyAddedInitial,
    initialDataUpdatedAt: recentlyAddedInitial
      ? getStoredRecentlyAddedAt(authUser?.id)
      : undefined,
    staleTime: 5 * 60 * 1000,
  });
  const recentReleasesQuery = useQuery({
    queryKey: queryKeys.recentReleases(authUser?.id),
    queryFn: ({ signal }) => getRecentReleases({ signal }),
    initialData: recentReleasesInitial,
    initialDataUpdatedAt: recentReleasesInitial
      ? getStoredRecentReleasesAt(authUser?.id)
      : undefined,
    staleTime: 5 * 60 * 1000,
  });
  const recentlyAdded = recentlyAddedQuery.data || [];
  const recentReleases = recentReleasesQuery.data || [];
  const [pendingRecentReleaseIds, setPendingRecentReleaseIds] = useState({});
  const [error, setError] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const { lookup: artistFeedbackLookup, submitFeedback } =
    useArtistTasteFeedback();
  const lastDiscoveryWsMessageAtRef = useRef(0);
  const discoveryPollInFlightRef = useRef(false);
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");

  useEffect(() => {
    if (recentlyAddedQuery.data) writeStoredRecentlyAdded(recentlyAddedQuery.data, authUser?.id);
  }, [authUser?.id, recentlyAddedQuery.data]);

  useEffect(() => {
    if (recentReleasesQuery.data) writeStoredRecentReleases(recentReleasesQuery.data, authUser?.id);
  }, [authUser?.id, recentReleasesQuery.data]);

  const applyDiscoveryData = useCallback(
    (nextValue, { allowClearStatus = true } = {}) => {
      setData((prev) => {
        const normalizedData = mergeDiscoveryHttp(prev, nextValue, {
          allowClearStatus,
        });
        if (!normalizedData) return prev;
        return normalizedData;
      });
    },
    [setData],
  );

  const fetchAndApplyDiscovery = useCallback(
    (cacheBust = false, { allowClearStatus } = {}) => {
      const clearStatus =
        allowClearStatus ??
        Date.now() - lastDiscoveryWsMessageAtRef.current >= 20000;
      return queryClient.fetchQuery({
        queryKey: discoveryQueryKey,
        queryFn: ({ signal }) => getDiscovery({ cacheBust, signal }).then((discoveryData) =>
          mergeDiscoveryHttp(queryClient.getQueryData(discoveryQueryKey), discoveryData, {
            allowClearStatus: clearStatus,
          }) || discoveryData,
        ),
        staleTime: cacheBust ? 0 : 30_000,
      })
        .then(() => setError(null))
        .catch((err) => {
          console.warn(err);
          setError(
            err?.response?.data?.message ||
              err?.message ||
              "Failed to refresh discovery data",
          );
        });
    },
    [discoveryQueryKey, setError],
  );

  useWebSocketChannel("library", (msg) => {
    if (msg.type === "library_scan_completed") {
      queryClient.invalidateQueries({
        queryKey: queryKeys.recentlyAdded(authUser?.id),
      });
    }
    if (msg.type !== "release_metadata_refreshed") return;
    queryClient.invalidateQueries({
      queryKey: queryKeys.recentReleases(authUser?.id),
    });
  });

  useEffect(() => {
    if (data) writeStoredDiscoveryData(data, authUser?.id);
  }, [authUser?.id, data]);

  useEffect(() => {
    if (!discoveryQuery.error) return;
    setError(discoveryQuery.error?.response?.data?.message || "Failed to load discovery data");
  }, [discoveryQuery.error]);

  const { isConnected: isDiscoverySocketConnected } = useWebSocketChannel(
    "discovery",
    (msg) => {
      if (msg.type !== "discovery_update") return;

      if (msg.phase === "error") {
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            isUpdating: false,
            updatePhase: "error",
            updateProgress: null,
            updateProgressMessage:
              msg.progressMessage || "Discovery refresh failed",
          }),
        );
        return;
      }

      if (msg.isUpdating) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            isUpdating: true,
            updatePhase: msg.phase || prev?.updatePhase || null,
            updateProgress:
              typeof msg.progress === "number"
                ? msg.progress
                : prev?.updateProgress ?? null,
            updateProgressMessage:
              msg.progressMessage || prev?.updateProgressMessage || null,
            provider: msg.provider || prev?.provider || "lastfm",
            capabilities: msg.capabilities || prev?.capabilities || null,
            configured: true,
            stale: false,
          }),
        );
        return;
      }

      if (msg.phase === "completed" || Array.isArray(msg.recommendations)) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        if (Array.isArray(msg.recommendations)) {
          setData((prev) => {
            const normalized = normalizeDiscoveryData({
              recommendations: msg.recommendations || [],
              globalTop: msg.globalTop || [],
              basedOn: msg.basedOn || [],
              topTags: msg.topTags || [],
              topGenres: msg.topGenres || [],
              fallbackGenres: msg.fallbackGenres || [],
              provider: msg.provider || "lastfm",
              capabilities: msg.capabilities || null,
              lastUpdated: msg.lastUpdated || null,
              isUpdating: false,
              updatePhase: null,
              updateProgress: null,
              updateProgressMessage: null,
              recommendationQuality:
                msg.recommendationQuality || prev?.recommendationQuality || null,
              isEnriching:
                typeof msg.isEnriching === "boolean"
                  ? msg.isEnriching
                  : prev?.isEnriching === true,
              discoveryRunId: msg.discoveryRunId || prev?.discoveryRunId || null,
              enrichmentStartedAt:
                msg.enrichmentStartedAt || prev?.enrichmentStartedAt || null,
              enrichmentCompletedAt:
                msg.enrichmentCompletedAt || prev?.enrichmentCompletedAt || null,
              enrichmentProgressMessage:
                msg.enrichmentProgressMessage ??
                prev?.enrichmentProgressMessage ??
                null,
              stale: false,
              discoveryMode:
                msg.discoveryMode === "safer" || msg.discoveryMode === "deeper"
                  ? msg.discoveryMode
                  : "balanced",
              configured: true,
            });
            return normalized;
          });
        } else {
          setData((prev) =>
            normalizeDiscoveryData({
              ...(prev || {}),
              isUpdating: false,
              updatePhase: null,
              updateProgress: null,
              updateProgressMessage: null,
              recommendationQuality:
                msg.recommendationQuality || prev?.recommendationQuality || null,
              isEnriching:
                typeof msg.isEnriching === "boolean"
                  ? msg.isEnriching
                  : prev?.isEnriching === true,
              discoveryRunId: msg.discoveryRunId || prev?.discoveryRunId || null,
              enrichmentStartedAt:
                msg.enrichmentStartedAt || prev?.enrichmentStartedAt || null,
              enrichmentCompletedAt:
                msg.enrichmentCompletedAt || prev?.enrichmentCompletedAt || null,
              enrichmentProgressMessage:
                msg.enrichmentProgressMessage ??
                prev?.enrichmentProgressMessage ??
                null,
              stale: false,
            }),
          );
        }
        fetchAndApplyDiscovery(true);
      }
    },
  );

  useEffect(() => {
    if (!data?.isUpdating && !data?.isEnriching) {
      return;
    }
    const pollDiscovery = () => {
      if (discoveryPollInFlightRef.current) return;
      const hasRecentWsUpdate =
        Date.now() - lastDiscoveryWsMessageAtRef.current < 20000;
      if (isDiscoverySocketConnected && hasRecentWsUpdate) return;
      discoveryPollInFlightRef.current = true;
      fetchAndApplyDiscovery(true, { allowClearStatus: true })
        .finally(() => {
          discoveryPollInFlightRef.current = false;
        });
    };
    pollDiscovery();
    const id = setInterval(pollDiscovery, 10000);
    return () => clearInterval(id);
  }, [
    authUser?.id,
    data?.isUpdating,
    data?.isEnriching,
    isDiscoverySocketConnected,
    fetchAndApplyDiscovery,
  ]);

  useEffect(() => {
    if (!data?.stale || data?.isUpdating || data?.isEnriching) return;
    if (isDiscoverySocketConnected) return;
    const id = setTimeout(() => {
      fetchAndApplyDiscovery(true, { allowClearStatus: true });
    }, 15000);
    return () => clearTimeout(id);
  }, [
    authUser?.id,
    data?.stale,
    data?.isUpdating,
    data?.isEnriching,
    isDiscoverySocketConnected,
    fetchAndApplyDiscovery,
  ]);

  useEffect(() => {
    if (recentlyAddedQuery.error) showError(recentlyAddedQuery.error?.message || "Failed to load recently added");
  }, [recentlyAddedQuery.error, showError]);

  useEffect(() => {
    if (recentReleasesQuery.error) showError(recentReleasesQuery.error?.message || "Failed to load recent releases");
  }, [recentReleasesQuery.error, showError]);

  useEffect(() => {
    if (bootstrap) {
      setTicketmasterConfigured(!!bootstrap.ticketmasterConfigured);
    }
  }, [bootstrap]);

  const getRecentReleaseKey = useCallback(
    (album) => album.mbid || album.foreignAlbumId || album.id,
    [],
  );

  const handleAddArtistToLibrary = useCallback(
    async (artist, managedBy = libraryDestination.primary, monitorOption = null) => {
      const artistId = getArtistId(artist);
      if (!artist?.name || !artistId || !libraryDestination.ready) return false;
      try {
        const response = await addArtistToLibrary(buildArtistAddPayload({
          artistMbid: artistId,
          artistName: artist.name,
          managedBy,
          ...(monitorOption ? { monitorOption } : {}),
        }));
        setLibraryLookup((prev) => ({
          ...prev,
          [artistId]: true,
        }));
        showSuccess(describeArtistAdd({ name: artist.name, manager: managedBy, monitorOption, response }));
        return true;
      } catch (err) {
        const conflict = settleLibraryOwnerConflict(err);
        if (conflict) {
          setLibraryLookup((previous) => ({ ...previous, [artistId]: true }));
          showInfo(`${artist.name}: ${conflict.message}`);
          return false;
        }
        showError(`Failed to add artist to ${getManagerName(managedBy)}: ${
          err.response?.data?.message || err.response?.data?.error || err.message
        }`);
        return false;
      }
    },
    [libraryDestination.primary, libraryDestination.ready, showError, showInfo, showSuccess],
  );

  const handleRecentReleaseAlbumAction = useCallback(
    async (album, managedBy = libraryDestination.primary) => {
      const albumKey = getRecentReleaseKey(album);
      const albumMbid = album?.mbid || album?.foreignAlbumId;
      const artistMbid = album?.artistMbid || album?.foreignArtistId;
      if (!albumMbid || !artistMbid || !albumKey) return;
      setPendingRecentReleaseIds((prev) => ({ ...prev, [albumKey]: true }));
      try {
        const result = await requestAlbumFromSearch(buildAlbumRequestPayload({
          albumMbid,
          albumName: album.albumName || album.title,
          artistMbid,
          artistName: album.artistName,
          managedBy,
          triggerSearch: true,
        }));
        queryClient.invalidateQueries({
          queryKey: queryKeys.recentReleases(authUser?.id),
        });
        const outcome = describeAlbumRequestResult(result, album.albumName || album.title || "album", managedBy);
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      } catch (err) {
        const conflict = settleLibraryOwnerConflict(err);
        if (conflict) {
          showInfo(`${album.albumName || "Album"}: ${conflict.message}`);
          return;
        }
        showError(`Failed to add album to ${getManagerName(managedBy)}: ${
          err.response?.data?.message || err.response?.data?.error || err.message
        }`);
      } finally {
        setPendingRecentReleaseIds(({ [albumKey]: _, ...prev }) => prev);
      }
    },
    [authUser?.id, getRecentReleaseKey, libraryDestination, showError, showInfo, showSuccess],
  );

  const handleDiscoveryFeedback = useCallback(
    async (artist, action, options = {}) => {
      const saved = await submitFeedback(artist, action, options);
      if (saved && action === "block_artist" && !options.isSelected) {
        setData((current) => {
          if (!current) return current;
          const keepArtist = (candidate) => !artistsShareDiscoveryIdentity(candidate, artist);
          const next = {
            ...current,
            recommendations: (current.recommendations || []).filter(keepArtist),
            globalTop: (current.globalTop || []).filter(keepArtist),
            fallbackGenres: (current.fallbackGenres || []).map((section) => ({
              ...section,
              artists: (section?.artists || []).filter(keepArtist),
            })),
          };
          return next;
        });
      }
      return saved;
    },
    [setData, submitFeedback],
  );

  return {
    authUser,
    data,
    recentlyAdded,
    recentReleases,
    pendingRecentReleaseIds,
    error,
    libraryLookup,
    setLibraryLookup,
    artistFeedbackLookup,
    nearbyShowsData,
    ticketmasterConfigured,
    nearbyShowsLoading,
    nearbyShowsError,
    nearbyLocationMode,
    appliedNearbyCountry,
    setNearbyLocationMode,
    appliedNearbyZip,
    setAppliedNearbyZip,
    canAddArtist,
    canAddAlbum,
    isDiscoverySocketConnected,
    applyDiscoveryData,
    fetchAndApplyDiscovery,
    getLibraryArtistImage,
    getRecentReleaseKey,
    libraryDestination,
    handleAddArtistToLibrary,
    handleRecentReleaseAlbumAction,
    handleDiscoveryFeedback,
    lastDiscoveryWsMessageAtRef,
  };
}
