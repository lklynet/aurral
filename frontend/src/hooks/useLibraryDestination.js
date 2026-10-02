import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../utils/api/endpoints/auth.js";
import { queryKeys } from "../queryClient.js";
import { resolveLibraryDestination } from "../utils/libraryDestination.js";

export function useLibraryDestination() {
  const healthQuery = useQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal }) => fetchHealth({ signal }),
    staleTime: 30_000,
  });
  const lidarrConfigured = healthQuery.data?.lidarrConfigured;
  const ready = typeof lidarrConfigured === "boolean";
  const error = !ready && !healthQuery.isPending;
  const retry = healthQuery.refetch;

  return useMemo(
    () => ({
      ...resolveLibraryDestination({ lidarrConfigured }),
      ready,
      error,
      retry,
    }),
    [lidarrConfigured, ready, error, retry],
  );
}
