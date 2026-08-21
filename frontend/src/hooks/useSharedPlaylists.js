import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getFlowStatus } from "../utils/api/endpoints/playlists.js";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";

export function useSharedPlaylists() {
  const { showError } = useToast();
  const [playlistsError, setPlaylistsError] = useState("");
  const query = useQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal }) => getFlowStatus({ signal, bypassCache: true }),
    staleTime: 4_000,
  });
  const sharedPlaylists = Array.isArray(query.data?.sharedPlaylists)
    ? query.data.sharedPlaylists
    : [];
  const { refetch } = query;
  const setSharedPlaylists = useCallback((next) => {
    queryClient.setQueryData(queryKeys.playlistStatus, (current) => ({
      ...(current || {}),
      sharedPlaylists: typeof next === "function" ? next(current?.sharedPlaylists || []) : next,
    }));
  }, []);

  const loadSharedPlaylists = useCallback(async () => {
    setPlaylistsError("");
    try {
      const { data } = await refetch({ throwOnError: true });
      const playlists = Array.isArray(data?.sharedPlaylists) ? data.sharedPlaylists : [];
      return playlists;
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to load playlists";
      setPlaylistsError(message);
      showError(message);
      return null;
    }
  }, [refetch, showError]);

  return {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading: query.isLoading,
    playlistsError: playlistsError || query.error?.response?.data?.message || query.error?.message || "",
    setPlaylistsError,
    loadSharedPlaylists,
  };
}
