import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { useAuth } from "../../../contexts/AuthContext";

type AuthUser = NonNullable<ReturnType<typeof useAuth>>["user"];
type LidarrDefaults = { rootFolderPath: string; qualityProfileId: string };

export function useAccountSettings(authUser: AuthUser, showError: (message: string) => void) {
  const queryKey = queryKeys.lidarrPreferences(authUser?.id);
  const { data } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["lidarr-preferences"].$get({}, { init: { signal } })),
    enabled: authUser?.id != null,
    staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: ({ rootFolderPath, qualityProfileId }: LidarrDefaults) =>
      parseResponse(
        usersClient.me["lidarr-preferences"].$patch({
          json: {
            rootFolderPath: rootFolderPath || null,
            qualityProfileId: qualityProfileId ? Number(qualityProfileId) : null,
          },
        }),
      ),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onError: () => showError("Failed to save account settings"),
  });

  const saved = data?.savedDefaults;
  const defaults: LidarrDefaults = (save.isPending && save.variables) || {
    rootFolderPath: saved?.rootFolderPath || "",
    qualityProfileId: saved?.qualityProfileId != null ? String(saved.qualityProfileId) : "",
  };

  return {
    lidarrConfigured: data?.configured === true,
    lidarrRootFolders: data?.rootFolders ?? [],
    lidarrQualityProfiles: data?.qualityProfiles ?? [],
    lidarrRootFolderPath: defaults.rootFolderPath,
    setLidarrRootFolderPath: (rootFolderPath: string) =>
      save.mutate({ ...defaults, rootFolderPath }),
    lidarrQualityProfileId: defaults.qualityProfileId,
    setLidarrQualityProfileId: (qualityProfileId: string) =>
      save.mutate({ ...defaults, qualityProfileId }),
    saving: save.isPending,
  };
}
