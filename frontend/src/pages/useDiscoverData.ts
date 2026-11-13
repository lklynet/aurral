import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { libraryMiscClient } from "../utils/api/clients/libraryMisc.ts";
import type { ArtistsInLibrary } from "../utils/api/endpoints/library.ts";
import { useNearbyShows } from "../hooks/useNearbyShows";
import {
  readStoredRecentlyAdded,
  writeStoredRecentlyAdded,
  readStoredRecentReleases,
  writeStoredRecentReleases,
  getStoredRecentlyAddedAt,
  getStoredRecentReleasesAt,
} from "../utils/discoverUtils";
import { useDiscoveryRecommendations } from "./useDiscoveryRecommendations";

import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import type { RecentRelease } from "./useReleaseAlbumAction.ts";

type RecentlyAdded = InferResponseType<typeof libraryMiscClient.recent.$get, 200>;

export function useDiscoverData() {
  const { user: authUser, bootstrap } = useAuth();
  const { showError } = useToast();
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
  const [libraryLookup, setLibraryLookup] = useState<ArtistsInLibrary>({});

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
    queryClient.invalidateQueries({ queryKey: queryKeys.releases() });
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

  return {
    authUser,
    data,
    recentlyAdded,
    recentlyAddedPending: recentlyAddedQuery.isPending,
    recentReleases,
    recentReleasesPending: recentReleasesQuery.isPending,
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
    discoveryStatus,
    handleDiscoveryFeedback,
  };
}
