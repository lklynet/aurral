import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { settingsClient } from "../utils/api/clients/settings.ts";
import { queryClient, queryKeys } from "../queryClient.ts";

type StorageHealthResult = InferResponseType<
  (typeof settingsClient)["storage-health"]["$get"],
  200
>;

const getStorageHealth = ({ signal }: { signal: AbortSignal }) =>
  parseResponse(settingsClient["storage-health"].$get({}, { init: { signal } }));

const toSnapshot = (result: StorageHealthResult | null | undefined, dataUpdatedAt = 0) => ({
  ok: result?.ok !== false,
  hasFailure: result?.ok === false,
  checkedAt: result?.checkedAt || (dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null),
  result: result || null,
});

type StorageHealthSnapshot = ReturnType<typeof toSnapshot>;

export function getStorageHealthCache() {
  const state = queryClient.getQueryState(queryKeys.storageHealth);
  return toSnapshot(
    queryClient.getQueryData<StorageHealthResult>(queryKeys.storageHealth),
    state?.dataUpdatedAt,
  );
}

export function subscribeStorageHealth(listener: (snapshot: StorageHealthSnapshot) => void) {
  return queryClient.getQueryCache().subscribe((event) => {
    const queryKey = event.query?.queryKey;
    if (
      !queryKey ||
      queryKey.length !== queryKeys.storageHealth.length ||
      queryKey.some((value: unknown, index: number) => value !== queryKeys.storageHealth[index])
    )
      return;
    listener(getStorageHealthCache());
  });
}

export function setStorageHealthResult(result: StorageHealthResult | null | undefined) {
  queryClient.setQueryData(queryKeys.storageHealth, result || null);
}

export function refreshStorageHealth({ force = false }: { force?: boolean } = {}) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.storageHealth,
    queryFn: ({ signal }) =>
      force
        ? parseResponse(settingsClient["storage-health"].check.$post({}, { init: { signal } }))
        : getStorageHealth({ signal }),
    staleTime: force ? 0 : 120_000,
  });
}

export function useStorageHealth({
  enabled = true,
  pollMs = 120000,
}: { enabled?: boolean; pollMs?: number } = {}) {
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
    loading: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    refresh,
  };
}
