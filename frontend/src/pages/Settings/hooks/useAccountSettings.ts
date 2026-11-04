import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { queryClient } from "../../../queryClient.ts";
import { lidarrPreferencesQueryOptions } from "../../../queryOptions.ts";
import type { useAuth } from "../../../contexts/AuthContext";

type AuthUser = NonNullable<ReturnType<typeof useAuth>>["user"];
type LidarrDefaults = { rootFolderPath: string; qualityProfileId: string };

export function useAccountSettings(authUser: AuthUser, showError: (message: string) => void) {
  const preferences = lidarrPreferencesQueryOptions(authUser?.id);
  const { data } = useQuery(preferences);
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
    onSuccess: (next) => queryClient.setQueryData(preferences.queryKey, next),
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
