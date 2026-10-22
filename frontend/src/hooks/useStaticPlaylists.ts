import { useCallback, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { playlistStatusQueryOptions } from "../queryOptions.ts";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import type { PlaylistStatus, StaticPlaylist } from "../pages/playlists/playlistStats.ts";
import { asApiError, type ApiError } from "../utils/api/core.ts";

export function useStaticPlaylists() {
  const { showError } = useToast();
  const [playlistsError, setPlaylistsError] = useState("");
  const query: UseQueryResult<PlaylistStatus, ApiError> = useQuery(playlistStatusQueryOptions());
  const staticPlaylists: StaticPlaylist[] = Array.isArray(query.data?.sharedPlaylists)
    ? query.data.sharedPlaylists
    : [];
  const { refetch } = query;
  const setStaticPlaylists = useCallback(
    (next: StaticPlaylist[] | ((current: StaticPlaylist[]) => StaticPlaylist[])) => {
      queryClient.setQueryData<Partial<PlaylistStatus>>(queryKeys.playlistStatus, (current) => ({
        ...(current || {}),
        sharedPlaylists: typeof next === "function" ? next(current?.sharedPlaylists || []) : next,
      }));
    },
    [],
  );

  const loadStaticPlaylists = useCallback(async () => {
    setPlaylistsError("");
    try {
      const { data } = await refetch({ throwOnError: true });
      const playlists = Array.isArray(data?.sharedPlaylists) ? data.sharedPlaylists : [];
      return playlists;
    } catch (err) {
      const failure = asApiError(err);
      const data = failure?.response?.data;
      const body = typeof data === "object" && data ? data : undefined;
      const bodyError = typeof body?.error === "string" ? body.error : undefined;
      const message = body?.message || bodyError || failure?.message || "Failed to load playlists";
      setPlaylistsError(message);
      showError(message);
      return null;
    }
  }, [refetch, showError]);

  const queryErrorData = query.error?.response?.data;
  const queryErrorMessage =
    typeof queryErrorData === "object" && queryErrorData ? queryErrorData.message : undefined;
  return {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: query.isLoading,
    playlistsError: playlistsError || queryErrorMessage || query.error?.message || "",
    setPlaylistsError,
    loadStaticPlaylists,
  };
}
