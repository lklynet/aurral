import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { LibraryMenuItem } from "../components/LibraryItemMenu";
import { Puzzle } from "../components/icons";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryKeys } from "../queryClient.ts";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { readApiError } from "../pages/Settings/utils/apiError.ts";

const ACTIONS_STALE_MS = 5 * 60_000;

export function usePlaylistPluginActions(playlistId: string): LibraryMenuItem[] {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const actions = useQuery({
    queryKey: queryKeys.pluginActions(user?.id),
    queryFn: ({ signal }) => parseResponse(pluginsClient.actions.$get({}, { init: { signal } })),
    enabled: Boolean(user),
    staleTime: ACTIONS_STALE_MS,
  });
  return (actions.data?.actions ?? [])
    .filter((action) => action.target === "playlist")
    .map((action, index) => ({
      id: `plugin-${action.pluginId}-${action.id}`,
      label: action.label,
      icon: Puzzle,
      separatorBefore: index === 0,
      onSelect: async () => {
        try {
          const result = await parseResponse(
            pluginsClient[":id"].actions[":action"].$post({
              param: { id: action.pluginId, action: action.id },
              json: { playlistId },
            }),
          );
          showSuccess(result.message);
        } catch (error) {
          const failure = readApiError(error);
          showError(failure.error || failure.text || `${action.pluginName} failed`);
        }
      },
    }));
}
