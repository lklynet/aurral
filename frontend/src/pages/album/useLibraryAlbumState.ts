import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAurralAlbumMonitoring } from "../../components/AurralAlbumMonitoring";
import { requestsClient } from "../../utils/api/clients/requests.ts";
import type { AurralMonitoringResult } from "../../utils/api/endpoints/library.ts";
import { firstAvailableFile, type LibraryAlbum } from "../../utils/libraryPageData.ts";
import { canDownloadAurralAlbum } from "../../utils/aurralMonitoring.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import type { ActivityRequest } from "../../../../lib/activity.ts";
import type { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  activityDownloadStatus,
  invalidateLibraryViews,
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
  const {
    getAlbumTracks,
    loadAlbumTracks,
    getArtistForAlbum,
    setLibrary,
    canAddTracks,
    canChangeMonitoring,
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

  const patchAlbum = useCallback(
    (albumId: string | number, patch: Partial<LibraryAlbum>) => {
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(albumId) ? { ...entry, ...patch } : entry,
        ),
      }));
      void invalidateLibraryViews();
      refreshLibraryActivity();
    },
    [refreshLibraryActivity, setLibrary],
  );
  const updateAlbumMonitoringState = useCallback(
    (albumId: string | number, result: AurralMonitoringResult) => {
      const monitored = result?.monitored === true;
      patchAlbum(albumId, { monitored, monitorMode: monitored ? "monitored" : "unmonitored" });
    },
    [patchAlbum],
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

  const markAlbumRequested = async () => {
    if (!libraryAlbum) return;
    patchAlbum(libraryAlbum.id, {
      managedBy: "aurral",
      monitored: true,
      monitorMode: "monitored",
    });
    await reloadLibraryAlbumTracks();
  };

  const managed = libraryAlbum?.managedBy === "aurral";
  const albumMonitored = managed ? albumMonitoring.monitored : null;
  const libraryAlbumDownloading = isAlbumDownloading(
    libraryAlbum?.releaseGroupMbid || libraryAlbum?.mbid,
  );
  const canDownloadLibraryAlbum = (hasMissingTracks: boolean) => {
    if (!canAddTracks || isPreviewLibrary || !libraryAlbum || !hasMissingTracks) return false;
    if (!(libraryAlbum.releaseGroupMbid || libraryAlbum.mbid)) return false;
    return !managed || canDownloadAurralAlbum(libraryAlbum, { hasMissingTracks: true });
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
    albumMonitoring,
    albumMonitored,
    libraryAlbumDownloading,
    canDownloadLibraryAlbum,
    reloadLibraryAlbumTracks,
    markAlbumRequested,
  };
}
