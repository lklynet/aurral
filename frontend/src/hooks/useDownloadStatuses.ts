import { useQuery } from "@tanstack/react-query";
import { queryClient, queryKeys } from "../queryClient.ts";
import { getDownloadStatus } from "../utils/api/endpoints/library.ts";
import { useWebSocketChannel } from "./useWebSocket";
import type { DownloadStatusEntry } from "../../../backend/services/websocketService.ts";

export type DownloadStatus = Partial<DownloadStatusEntry> & Pick<DownloadStatusEntry, "status">;
export type DownloadStatuses = Record<string, DownloadStatus>;

export function useDownloadStatuses(
  ids: string[],
  {
    enabled = true,
    pollWhile,
    onPush,
  }: {
    enabled?: boolean;
    pollWhile: (status: string) => boolean;
    onPush?: (pushed: DownloadStatuses) => void;
  },
) {
  const active = enabled && ids.length > 0;
  const { isConnected } = useWebSocketChannel(
    "downloads",
    (message) => {
      if (message?.type !== "download_statuses") return;
      const pushed: DownloadStatuses = {};
      for (const id of ids) if (message.statuses?.[id]) pushed[id] = message.statuses[id];
      if (!Object.keys(pushed).length) return;
      queryClient.setQueryData(queryKeys.downloadStatus(ids), (current: DownloadStatuses = {}) => ({
        ...current,
        ...pushed,
      }));
      onPush?.(pushed);
    },
    { enabled: active },
  );
  return useQuery<DownloadStatuses>({
    queryKey: queryKeys.downloadStatus(ids),
    queryFn: ({ signal }) => getDownloadStatus(ids, { signal, bypassCache: true }),
    enabled: active,
    staleTime: 4_000,
    refetchInterval: (query) =>
      !isConnected &&
      Object.values(query.state.data || {}).some((status) => pollWhile(String(status?.status)))
        ? 15_000
        : false,
  });
}
