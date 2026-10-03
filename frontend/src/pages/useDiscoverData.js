import { describeAlbumRequestResult } from "../utils/albumAddAction";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getRecentlyAdded,
  getRecentReleases,
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
} from "../utils/api/endpoints/library.js";
import {
  buildAlbumRequestPayload,
} from "../utils/libraryDestination";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { getDiscovery } from "../utils/api/endpoints/discovery.js";
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
  getStoredRecentlyAddedAt,
  getStoredRecentReleasesAt,
  getLibraryArtistImage,
} from "./discoverUtils";

import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useDiscoveryStatus } from "../hooks/useDiscoveryStatus";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.js";

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
    queryFn: async ({ signal }) => normalizeDiscoveryData(await getDiscovery({ signal })),
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
  const [libraryLookup, setLibraryLookup] = useState({});
  const { lookup: artistFeedbackLookup, submitFeedback } =
    useArtistTasteFeedback();
  const { status: discoveryStatus } = useDiscoveryStatus();
  const previousDiscoveryStatusRef = useRef(null);
  const canAddAlbum = hasPermission("addAlbum");

  useEffect(() => {
    if (recentlyAddedQuery.data) writeStoredRecentlyAdded(recentlyAddedQuery.data, authUser?.id);
  }, [authUser?.id, recentlyAddedQuery.data]);

  useEffect(() => {
    if (recentReleasesQuery.data) writeStoredRecentReleases(recentReleasesQuery.data, authUser?.id);
  }, [authUser?.id, recentReleasesQuery.data]);

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

  const error = discoveryQuery.error
    ? discoveryQuery.error?.response?.data?.message || "Failed to load discovery data"
    : null;

  useEffect(() => {
    const previous = previousDiscoveryStatusRef.current;
    previousDiscoveryStatusRef.current = discoveryStatus;
    if (!previous || !discoveryStatus) return;
    const finished = previous.isUpdating && !discoveryStatus.isUpdating;
    if (finished || previous.lastUpdated !== discoveryStatus.lastUpdated) {
      queryClient.invalidateQueries({ queryKey: discoveryQueryKey });
    }
  }, [discoveryQueryKey, discoveryStatus]);

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
        showError(`Could not download the album: ${
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
    canAddAlbum,
    discoveryStatus,
    getLibraryArtistImage,
    getRecentReleaseKey,
    libraryDestination,
    handleRecentReleaseAlbumAction,
    handleDiscoveryFeedback,
  };
}
