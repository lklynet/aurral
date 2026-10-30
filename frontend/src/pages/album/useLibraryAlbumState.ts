import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Eye, EyeOff } from "../../components/icons";
import { useAurralAlbumMonitoring } from "../../components/AurralAlbumMonitoring";
import { useToast } from "../../contexts/ToastContext";
import { libraryAlbumsClient } from "../../utils/api/clients/libraryAlbums.ts";
import { requestsClient } from "../../utils/api/clients/requests.ts";
import {
  clearLibraryPageCache,
  type AurralMonitoringResult,
} from "../../utils/api/endpoints/library.ts";
import { firstAvailableFile, type LibraryAlbum } from "../../utils/libraryPageData.ts";
import { resolveAlbumManager } from "../../utils/libraryDestination.ts";
import { canDownloadAurralAlbum, getMonitoringMenuAction } from "../../utils/aurralMonitoring.ts";
import { getApiErrorMessage } from "../ArtistDetails/utils";
import { queryClient, queryKeys } from "../../queryClient.ts";
import type { ActivityRequest } from "../activity/activityListUtils.ts";
import type { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  activityDownloadStatus,
  sameTrackText,
  TRACK_DOWNLOAD_ACTIVE_STATUSES,
  trackDownloadIdentity,
  type TrackDownloadState,
} from "../library/libraryShared.tsx";

type LibraryActions = ReturnType<typeof useLibraryActions>;

export function useLibraryAlbumState({
  libraryAlbum,
  actions,
  isPreviewLibrary,
}: {
  libraryAlbum: LibraryAlbum | null;
  actions: LibraryActions;
  isPreviewLibrary: boolean;
}) {
  const { showError, showSuccess } = useToast();
  const {
    getAlbumTracks,
    loadAlbumTracks,
    getArtistForAlbum,
    setLibrary,
    canAddTracks,
    canChangeMonitoring,
    libraryDestination,
    isAlbumDownloading,
    trackDownloadStates,
    setTrackDownloadStates,
    activityQueryKey,
    refreshLibraryActivity,
  } = actions;

  const albumTracks = getAlbumTracks(libraryAlbum);
  const hasMissingAlbumTracks = Boolean(
    libraryAlbum && albumTracks.some((track) => !firstAvailableFile(track)),
  );
  const hasTrackDownloadPolling = Object.values(trackDownloadStates).some(
    (state) =>
      state?.jobId &&
      state.status !== "completed" &&
      TRACK_DOWNLOAD_ACTIVE_STATUSES.has(state.status),
  );
  const activityQuery = useQuery({
    queryKey: activityQueryKey,
    queryFn: ({ signal }): Promise<ActivityRequest[]> =>
      parseResponse(requestsClient.$get({ query: { refresh: "1" } }, { init: { signal } })),
    enabled: Boolean(libraryAlbum && !isPreviewLibrary && hasMissingAlbumTracks),
    staleTime: 0,
    refetchInterval: hasTrackDownloadPolling ? 4000 : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!libraryAlbum || isPreviewLibrary) return;
    loadAlbumTracks(libraryAlbum).catch(() => {});
  }, [isPreviewLibrary, libraryAlbum, loadAlbumTracks]);

  const updateAlbumMonitoringState = useCallback(
    (albumId: string | number, result: AurralMonitoringResult) => {
      const monitored = result?.monitored === true;
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(albumId)
            ? { ...entry, monitored, monitorMode: monitored ? "monitored" : "unmonitored" }
            : entry,
        ),
      }));
      clearLibraryPageCache();
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
      refreshLibraryActivity();
    },
    [refreshLibraryActivity, setLibrary],
  );
  const albumMonitoring = useAurralAlbumMonitoring({
    album: libraryAlbum,
    enabled: Boolean(libraryAlbum) && !isPreviewLibrary,
    canChange: canChangeMonitoring,
    hasMissingTracks: hasMissingAlbumTracks,
    onChanged: updateAlbumMonitoringState,
  });

  const reloadLibraryAlbumTracks = useCallback(async () => {
    if (!libraryAlbum) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.libraryAlbumTracks(
        String(libraryAlbum.id),
        libraryAlbum.releaseGroupMbid || null,
      ),
    });
    await loadAlbumTracks(libraryAlbum).catch(() => {});
  }, [libraryAlbum, loadAlbumTracks]);

  const albumManager = resolveAlbumManager(libraryAlbum);
  const activeManager = libraryDestination.primary;
  const lidarrAlbumId =
    albumManager === "lidarr" && /^\d+$/.test(String(libraryAlbum?.providerId ?? ""))
      ? libraryAlbum!.providerId
      : null;
  const [lidarrMonitoredOverride, setLidarrMonitoredOverride] = useState<{
    albumId: string | number;
    monitored: boolean;
  } | null>(null);
  const albumMonitored =
    albumManager === "aurral"
      ? albumMonitoring.monitored
      : lidarrAlbumId
        ? lidarrMonitoredOverride?.albumId === lidarrAlbumId
          ? lidarrMonitoredOverride!.monitored
          : libraryAlbum!.monitored === true
        : null;
  const libraryAlbumDownloading = isAlbumDownloading(
    libraryAlbum?.releaseGroupMbid || libraryAlbum?.mbid,
  );
  const canDownloadLibraryAlbum = (() => {
    if (!canAddTracks || isPreviewLibrary || !libraryAlbum || !hasMissingAlbumTracks) return false;
    if (!libraryDestination.ready || !(libraryAlbum.releaseGroupMbid || libraryAlbum.mbid))
      return false;
    if (activeManager === "lidarr") return true;
    if (albumManager === "aurral")
      return canDownloadAurralAlbum(libraryAlbum, { hasMissingTracks: true });
    return albumManager !== "lidarr";
  })();

  const setLidarrAlbumMonitored = useCallback(
    async (monitored: boolean) => {
      if (!lidarrAlbumId || lidarrMonitoredOverride) return;
      const title = libraryAlbum!.title || "Album";
      setLidarrMonitoredOverride({ albumId: lidarrAlbumId, monitored });
      try {
        await parseResponse(
          libraryAlbumsClient.albums[":id"].$put({
            param: { id: encodeURIComponent(lidarrAlbumId) },
            json: { monitored },
          }),
        );
        updateAlbumMonitoringState(libraryAlbum!.id, { monitored });
        showSuccess(monitored ? `${title} monitored in Lidarr` : `${title} unmonitored in Lidarr`);
      } catch (requestError) {
        showError(
          `Could not ${monitored ? "monitor" : "unmonitor"} ${title} in Lidarr. Nothing changed. ${
            getApiErrorMessage(requestError) || "Try again."
          }`,
        );
      } finally {
        setLidarrMonitoredOverride(null);
      }
    },
    [
      libraryAlbum,
      lidarrAlbumId,
      lidarrMonitoredOverride,
      showError,
      showSuccess,
      updateAlbumMonitoringState,
    ],
  );
  const lidarrAlbumAction =
    activeManager === "lidarr" && lidarrAlbumId && canChangeMonitoring
      ? getMonitoringMenuAction({ monitored: albumMonitored, hasMissing: hasMissingAlbumTracks })
      : null;
  const getAlbumMonitoringMenuItem = (downloadAlbum: () => unknown) =>
    albumManager === "lidarr"
      ? lidarrAlbumAction && {
          id: "monitoring",
          label: lidarrAlbumAction === "stop" ? "Stop monitoring album" : "Monitor album",
          icon: lidarrAlbumAction === "stop" ? EyeOff : Eye,
          separatorBefore: true,
          closeBeforeSelect: true,
          onSelect: () => setLidarrAlbumMonitored(lidarrAlbumAction !== "stop"),
        }
      : activeManager === "aurral" || albumMonitoring.monitored
        ? albumMonitoring.menuItem
        : albumMonitoring.menuItem && {
            ...albumMonitoring.menuItem,
            onSelect: downloadAlbum,
          };

  useEffect(() => {
    if (!libraryAlbum || isPreviewLibrary) return undefined;
    const tracks = getAlbumTracks(libraryAlbum);
    if (!tracks.length) return undefined;
    if (!Array.isArray(activityQuery.data)) return undefined;
    const requests = activityQuery.data;
    const activeRequests = requests.filter(
      (request) =>
        request?.kind === "track_download" &&
        request?.playlistId === "library" &&
        ["pending", "processing", "blocked"].includes(request?.status),
    );
    const nextStates: Record<string, TrackDownloadState> = {};
    const requestsByJobId = new Map(
      requests
        .filter((request) => request?.jobId)
        .map((request) => [String(request.jobId), request]),
    );
    for (const track of tracks) {
      if (firstAvailableFile(track)) continue;
      const request = activeRequests.find(
        (candidate) =>
          sameTrackText(candidate.trackName, track.title) &&
          sameTrackText(
            candidate.artistName,
            getArtistForAlbum(libraryAlbum)?.name || libraryAlbum.albumArtist || track.artistName,
          ) &&
          (!candidate.albumName || sameTrackText(candidate.albumName, libraryAlbum.title)),
      );
      if (request?.jobId) {
        nextStates[trackDownloadIdentity(track)] = {
          jobId: request.jobId,
          status: activityDownloadStatus(request),
        };
      }
    }
    setTrackDownloadStates((current) => {
      const next = { ...current };
      for (const track of tracks) {
        const key = trackDownloadIdentity(track);
        if (nextStates[key]) next[key] = nextStates[key];
        else if (next[key]?.status !== "submitting") delete next[key];
      }
      Object.entries(current).forEach(([key, state]) => {
        const request = state?.jobId ? requestsByJobId.get(String(state.jobId)) : null;
        if (request && activityDownloadStatus(request) !== state.status) {
          next[key] = { ...state, status: activityDownloadStatus(request) };
        }
      });
      return next;
    });
  }, [
    activityQuery.data,
    getAlbumTracks,
    getArtistForAlbum,
    isPreviewLibrary,
    libraryAlbum,
    setTrackDownloadStates,
  ]);

  return {
    albumTracks,
    hasMissingAlbumTracks,
    albumMonitoring,
    albumManager,
    activeManager,
    albumMonitored,
    libraryAlbumDownloading,
    canDownloadLibraryAlbum,
    updateAlbumMonitoringState,
    reloadLibraryAlbumTracks,
    getAlbumMonitoringMenuItem,
  };
}
