import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPlaylistStatus } from "../utils/api/endpoints/playlists.js";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";

export function useStaticPlaylists() {
  const { showError } = useToast();
  const [playlistsError, setPlaylistsError] = useState("");
  const query = useQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal }) => getPlaylistStatus({ signal, bypassCache: true }),
    staleTime: 4_000,
  });
  const staticPlaylists = Array.isArray(query.data?.staticPlaylists)
    ? query.data.staticPlaylists
    : [];
  const { refetch } = query;
  const setStaticPlaylists = useCallback((next) => {
    queryClient.setQueryData(queryKeys.playlistStatus, (current) => ({
      ...(current || {}),
      staticPlaylists: typeof next === "function" ? next(current?.staticPlaylists || []) : next,
    }));
  }, []);

  const loadStaticPlaylists = useCallback(async () => {
    setPlaylistsError("");
    try {
      const { data } = await refetch({ throwOnError: true });
      const playlists = Array.isArray(data?.staticPlaylists) ? data.staticPlaylists : [];
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
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: query.isLoading,
    playlistsError: playlistsError || query.error?.response?.data?.message || query.error?.message || "",
    setPlaylistsError,
    loadStaticPlaylists,
  };
}
