import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import { getFlowStatus } from "../../utils/api/endpoints/playlists.js";
import { queryClient, queryKeys } from "../../queryClient.js";

const ACTIVE_POLL_INTERVAL_MS = 4000;
const IDLE_POLL_INTERVAL_MS = 30000;

export function usePlaylistStatusQuery({ enabled = true } = {}) {
  const applyStatusMessage = useCallback((message) => {
    if (message?.type !== "playlist_status" || !message.status) return;
    queryClient.setQueryData(queryKeys.playlistStatus, message.status);
  }, []);
  const { isConnected: playlistsSocketConnected } = useWebSocketChannel(
    "playlists",
    applyStatusMessage,
    { enabled },
  );
  const { isConnected: weeklyFlowSocketConnected } = useWebSocketChannel(
    "weekly-flow",
    applyStatusMessage,
    { enabled },
  );
  const socketConnected = playlistsSocketConnected || weeklyFlowSocketConnected;
  const query = useQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal }) => getFlowStatus({ signal, bypassCache: true }),
    enabled,
    staleTime: ACTIVE_POLL_INTERVAL_MS,
    refetchInterval: (currentQuery) => {
      if (!enabled || socketConnected) return false;
      if (typeof document !== "undefined" && document.hidden) return false;
      const status = currentQuery.state.data;
      const active = status?.worker?.running === true ||
        status?.hint?.phase === "preparing" ||
        status?.hint?.phase === "downloading";
      return active ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
  const fetchStatus = useCallback(async () => {
    try {
      return (await query.refetch()).data || null;
    } catch {
      return null;
    }
  }, [query]);

  return { ...query, fetchStatus };
}
