import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { getStorageHealth } from "../utils/api/endpoints/settings.js";
import { queryClient, queryKeys } from "../queryClient.js";

const toSnapshot = (result, dataUpdatedAt = 0) => ({
  ok: result?.ok !== false,
  hasFailure: result?.ok === false,
  checkedAt: result?.checkedAt || (dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null),
  result: result || null,
});

export function getStorageHealthCache() {
  const state = queryClient.getQueryState(queryKeys.storageHealth);
  return toSnapshot(queryClient.getQueryData(queryKeys.storageHealth), state?.dataUpdatedAt);
}

export function subscribeStorageHealth(listener) {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.query?.queryKey?.[0] !== queryKeys.storageHealth[0]) return;
    listener(getStorageHealthCache());
  });
}

export function setStorageHealthResult(result) {
  queryClient.setQueryData(queryKeys.storageHealth, result || null);
}

export function refreshStorageHealth({ force = false } = {}) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.storageHealth,
    queryFn: ({ signal }) => getStorageHealth({ force, signal }),
    staleTime: force ? 0 : 120_000,
  });
}

export function useStorageHealth({ enabled = true, pollMs = 120000 } = {}) {
  const query = useQuery({
    queryKey: queryKeys.storageHealth,
    queryFn: ({ signal }) => getStorageHealth({ signal }),
    enabled,
    refetchInterval: enabled && pollMs > 0 ? pollMs : false,
    staleTime: pollMs > 0 ? pollMs : 120_000,
  });

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    return refreshStorageHealth({ force: true });
  }, [enabled]);

  return {
    ...toSnapshot(query.data, query.dataUpdatedAt),
    loading: query.isPending || query.isFetching,
    error: query.error,
    refresh,
  };
}
