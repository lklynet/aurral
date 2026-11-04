import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferRequestType } from "hono/client";
import type { LibraryMenuItem } from "../components/LibraryItemMenu";
import { Puzzle } from "../components/icons";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryKeys } from "../queryClient.ts";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { readApiError } from "../pages/Settings/utils/apiError.ts";
import { useWebSocketChannel } from "./useWebSocket";

const ACTIONS_STALE_MS = 5 * 60_000;

const runAction = pluginsClient[":id"].actions[":action"].$post;
type ActionTargetInput = InferRequestType<typeof runAction>["json"];
type ActionTarget = "playlist" | "album" | "artist" | "track";

export function usePluginActions() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const actions = useQuery({
    queryKey: queryKeys.pluginActions(user?.id),
    queryFn: ({ signal }) => parseResponse(pluginsClient.actions.$get({}, { init: { signal } })),
    enabled: Boolean(user),
    staleTime: ACTIONS_STALE_MS,
  });
  return (target: ActionTarget, json: ActionTargetInput): LibraryMenuItem[] =>
    (actions.data?.actions ?? [])
      .filter((action) => action.target === target)
      .map((action, index) => ({
        id: `plugin-${action.pluginId}-${action.id}`,
        label: action.label,
        icon: Puzzle,
        separatorBefore: index === 0,
        onSelect: async () => {
          try {
            const result = await parseResponse(
              runAction({ param: { id: action.pluginId, action: action.id }, json }),
            );
            showSuccess(result.message);
          } catch (error) {
            const failure = readApiError(error);
            showError(failure.error || failure.text || `${action.pluginName} failed`);
          }
        },
      }));
}

export function usePlaylistPluginActions(playlistId: string) {
  return usePluginActions()("playlist", { playlistId });
}

export function usePluginActionResults() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  useWebSocketChannel(
    "plugins",
    (message) => {
      if (message?.type !== "plugin_action_finished") return;
      if (message.ok) showSuccess(message.message);
      else showError(message.message);
    },
    { enabled: Boolean(user) },
  );
}
