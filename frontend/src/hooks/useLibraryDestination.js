import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { fetchHealth, getMyLibraryOwner } from "../utils/api/endpoints/auth.js";
import { queryKeys } from "../queryClient.js";
import { resolveLibraryDestination } from "../utils/libraryDestination.js";

export function useLibraryDestination() {
  const { user, bootstrap } = useAuth();
  const ownerQuery = useQuery({
    queryKey: queryKeys.libraryOwner(user?.id),
    queryFn: ({ signal }) => getMyLibraryOwner({ signal }),
    staleTime: 60_000,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal }) => fetchHealth({ signal }),
    staleTime: 30_000,
  });
  const lidarrConfigured = healthQuery.data?.lidarrConfigured ?? bootstrap?.lidarrConfigured;
  const libraryOwner = ownerQuery.data?.storedDefaultLibraryOwner ?? null;
  const ready = lidarrConfigured !== undefined && !ownerQuery.isPending;

  return useMemo(
    () => ({
      ...resolveLibraryDestination({ libraryOwner, lidarrConfigured: lidarrConfigured === true }),
      ready,
    }),
    [libraryOwner, lidarrConfigured, ready],
  );
}
