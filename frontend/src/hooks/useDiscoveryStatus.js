import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDiscoveryStatus } from "../utils/api/endpoints/discovery.js";
import { useAuth } from "../contexts/AuthContext";
import { queryClient, queryKeys } from "../queryClient.js";
import { useWebSocketChannel } from "./useWebSocket";

const UPDATING_POLL_MS = 5000;

export const refetchDiscoveryStatus = () =>
  queryClient.invalidateQueries(
    { queryKey: queryKeys.discoveryStatusPrefix },
    { cancelRefetch: false },
  );

export function useDiscoveryStatus({ enabled = true } = {}) {
  const { user } = useAuth();
  const userId = user?.id;
  const query = useQuery({
    queryKey: queryKeys.discoveryStatus(userId),
    queryFn: ({ signal }) => getDiscoveryStatus({ signal }),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (current) => (current.state.data?.isUpdating ? UPDATING_POLL_MS : false),
  });

  const { isConnected } = useWebSocketChannel(
    "discovery",
    (message) => {
      if (message.type === "discovery_update") refetchDiscoveryStatus();
    },
    { enabled },
  );

  useEffect(() => {
    if (enabled && isConnected) refetchDiscoveryStatus();
  }, [enabled, isConnected]);

  return { status: query.data || null, isConnected };
}
