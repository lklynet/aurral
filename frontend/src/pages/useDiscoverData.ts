import { describeAlbumRequestResult } from "../utils/albumAddAction";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
import { getDiscovery } from "../utils/api/endpoints/discovery.ts";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { artistsShareDiscoveryIdentity } from "../utils/discoveryFeedback";
import type { ArtistFeedbackSource } from "../utils/artistTaste.ts";
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
import { asApiError } from "../utils/api/core.ts";
import { getApiErrorText } from "./onboardingUtils";
import { useDiscoveryStatus } from "../hooks/useDiscoveryStatus";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import type { DiscoverArtist } from "../../../backend/routes/discovery/handlers/main.ts";

type RecentlyAdded = InferResponseType<typeof libraryMiscClient.recent.$get, 200>;
type RecentReleases = InferResponseType<(typeof libraryMiscClient)["recent-releases"]["$get"], 200>;

export type DiscoverData = Omit<
  NonNullable<ReturnType<typeof normalizeDiscoveryData>>,
  "recommendations" | "globalTop" | "topGenres" | "topTags"
> & {
  recommendations: DiscoverArtist[];
  globalTop: DiscoverArtist[];
  topGenres: string[];
  topTags: string[];
};

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

  const discoveryQueryKey = useMemo(() => queryKeys.discovery(authUser?.id), [authUser?.id]);
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
  const data = (discoveryQuery.data || null) as DiscoverData | null;
  const setData = useCallback(
    (updater: (current: DiscoverData | undefined) => DiscoverData | undefined) => {
      queryClient.setQueryData(discoveryQueryKey, updater);
    },
    [discoveryQueryKey],
  );
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
  const { lookup: artistFeedbackLookup, submitFeedback } = useArtistTasteFeedback();
  const { status: discoveryStatus } = useDiscoveryStatus();
  const previousDiscoveryStatusRef = useRef<typeof discoveryStatus>(null);
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
    ? getApiErrorText(discoveryQuery.error, "message") || "Failed to load discovery data"
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

  const handleDiscoveryFeedback = useCallback(
    async (
      artist: ArtistFeedbackSource,
      action: Parameters<ReturnType<typeof useArtistTasteFeedback>["submitFeedback"]>[1],
      options: Parameters<ReturnType<typeof useArtistTasteFeedback>["submitFeedback"]>[2] = {},
    ) => {
      if (action !== "block_artist" || options.isSelected) {
        return submitFeedback(artist, action, options);
      }
      const hidden: Partial<
        Record<"recommendations" | "globalTop", { candidate: DiscoverArtist; index: number }[]>
      > = {};
      setData((current) => {
        if (!current) return current;
        const next = { ...current };
        for (const key of ["recommendations", "globalTop"] as const) {
          const list = current[key] || [];
          hidden[key] = list
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) => artistsShareDiscoveryIdentity(candidate, artist));
          next[key] = list.filter((candidate) => !artistsShareDiscoveryIdentity(candidate, artist));
        }
        return next;
      });
      const restoreCards = () =>
        setData((current) => {
          if (!current) return current;
          const next = { ...current };
          for (const key of ["recommendations", "globalTop"] as const) {
            const entries = hidden[key];
            if (!entries) continue;
            const list = [...(current[key] || [])];
            for (const { candidate, index } of entries) {
              if (!list.some((existing) => artistsShareDiscoveryIdentity(existing, candidate))) {
                list.splice(Math.min(index, list.length), 0, candidate);
              }
            }
            next[key] = list;
          }
          return next;
        });
      return submitFeedback(artist, action, { ...options, onRevert: restoreCards });
    },
    [setData, submitFeedback],
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
