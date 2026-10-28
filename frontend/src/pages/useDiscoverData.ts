import { describeAlbumRequestResult } from "../utils/albumAddAction";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { libraryMiscClient } from "../utils/api/clients/libraryMisc.ts";
import {
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
  type ArtistsInLibrary,
} from "../utils/api/endpoints/library.ts";
import { buildAlbumRequestPayload } from "../utils/libraryDestination";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useNearbyShows } from "../hooks/useNearbyShows";
import {
  readStoredRecentlyAdded,
  writeStoredRecentlyAdded,
  readStoredRecentReleases,
  writeStoredRecentReleases,
  getStoredRecentlyAddedAt,
  getStoredRecentReleasesAt,
  getLibraryArtistImage,
} from "./discoverUtils";
import { useDiscoveryRecommendations } from "./useDiscoveryRecommendations";

import { useWebSocketChannel } from "../hooks/useWebSocket";
import { asApiError } from "../utils/api/core.ts";
import { getApiErrorText } from "./onboardingUtils";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.ts";

type RecentlyAdded = InferResponseType<typeof libraryMiscClient.recent.$get, 200>;
type RecentReleases = InferResponseType<(typeof libraryMiscClient)["recent-releases"]["$get"], 200>;

export type RecentRelease = RecentReleases[number];

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

  const { data, error, discoveryStatus, artistFeedbackLookup, handleDiscoveryFeedback } =
    useDiscoveryRecommendations();
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
    queryFn: ({ signal }) =>
      parseResponse(libraryMiscClient.recent.$get(undefined, { init: { signal } })),
    initialData: recentlyAddedInitial,
    initialDataUpdatedAt: recentlyAddedInitial ? getStoredRecentlyAddedAt(authUser?.id) : undefined,
    staleTime: 5 * 60 * 1000,
  });
  const recentReleasesQuery = useQuery({
    queryKey: queryKeys.recentReleases(authUser?.id),
    queryFn: ({ signal }) =>
      parseResponse(libraryMiscClient["recent-releases"].$get(undefined, { init: { signal } })),
    initialData: recentReleasesInitial,
    initialDataUpdatedAt: recentReleasesInitial
      ? getStoredRecentReleasesAt(authUser?.id)
      : undefined,
    staleTime: 5 * 60 * 1000,
  });
  const recentlyAdded: RecentlyAdded = recentlyAddedQuery.data || [];
  const recentReleases: RecentRelease[] = recentReleasesQuery.data || [];
  const [pendingRecentReleaseIds, setPendingRecentReleaseIds] = useState<Record<string, boolean>>(
    {},
  );
  const [libraryLookup, setLibraryLookup] = useState<ArtistsInLibrary>({});
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
    if (recentlyAddedQuery.error)
      showError(recentlyAddedQuery.error?.message || "Failed to load recently added");
  }, [recentlyAddedQuery.error, showError]);

  useEffect(() => {
    if (recentReleasesQuery.error)
      showError(recentReleasesQuery.error?.message || "Failed to load recent releases");
  }, [recentReleasesQuery.error, showError]);

  useEffect(() => {
    if (bootstrap) {
      setTicketmasterConfigured(!!bootstrap.ticketmasterConfigured);
    }
  }, [bootstrap]);

  const getRecentReleaseKey = useCallback(
    (album: RecentRelease) => album.mbid || album.foreignAlbumId || album.id,
    [],
  );

  const handleRecentReleaseAlbumAction = useCallback(
    async (album: RecentRelease, managedBy = libraryDestination.primary) => {
      const albumKey = getRecentReleaseKey(album);
      const albumMbid = album?.mbid || album?.foreignAlbumId;
      const artistMbid = album?.artistMbid || album?.foreignArtistId;
      if (!albumMbid || !artistMbid || !albumKey) return;
      setPendingRecentReleaseIds((prev) => ({ ...prev, [albumKey]: true }));
      try {
        const result = await requestAlbumFromSearch(
          buildAlbumRequestPayload({
            albumMbid,
            albumName: album.albumName || album.title,
            artistMbid,
            artistName: album.artistName,
            managedBy,
            triggerSearch: true,
          }),
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.recentReleases(authUser?.id),
        });
        const outcome = describeAlbumRequestResult(
          result,
          album.albumName || album.title || "album",
        );
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      } catch (err) {
        const conflict = settleLibraryOwnerConflict(err);
        if (conflict) {
          showInfo(`${album.albumName || "Album"}: ${conflict.message}`);
          return;
        }
        showError(
          `Could not download the album: ${
            getApiErrorText(err, "message") ||
            getApiErrorText(err, "error") ||
            asApiError(err)?.message
          }`,
        );
      } finally {
        setPendingRecentReleaseIds(({ [albumKey]: _, ...prev }) => prev);
      }
    },
    [authUser?.id, getRecentReleaseKey, libraryDestination, showError, showInfo, showSuccess],
  );

  return {
    authUser,
    data,
    recentlyAdded,
    recentlyAddedPending: recentlyAddedQuery.isPending,
    recentReleases,
    recentReleasesPending: recentReleasesQuery.isPending,
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
