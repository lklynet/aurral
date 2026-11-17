import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ConfirmModal } from "../../components/ConfirmModal";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useSettingsRoute } from "../../navigation/settingsRoute.tsx";
import { queryKeys } from "../../queryClient.ts";
import { hubLinkClient } from "../../utils/api/clients/hubLink.ts";
import { readApiError } from "../../utils/api/errors.ts";
import type { StaticPlaylist } from "../../utils/playlistStats.ts";
import { optionMenuItem } from "./playlistPageUtils";

const REPUBLISH_BLOCKED = new Set(["aurral-community", "aurral-share"]);

export function usePublicPlaylist(playlist: StaticPlaylist, onEditDetails: () => void) {
  const { user } = useAuth();
  const { showError, showSuccess } = useToast();
  const settings = useSettingsRoute();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<{ message: string; rename: boolean } | null>(null);
  const queryKey = queryKeys.publicPlaylists(user?.id);
  const eligible =
    playlist.ownerUserId === user?.id &&
    !REPUBLISH_BLOCKED.has(playlist.importSource?.provider ?? "");
  const state = useQuery({
    queryKey,
    queryFn: () => parseResponse(hubLinkClient["public-playlists"].$get()),
    enabled: eligible,
  });
  const param = { param: { playlistId: encodeURIComponent(playlist.id) } };
  const settle = (next: NonNullable<typeof state.data>) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.communityPlaylists(user?.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubLink(user?.id), exact: true });
  };
  const publish = useMutation({
    mutationFn: () => parseResponse(hubLinkClient["public-playlists"][":playlistId"].$put(param)),
    onSuccess: (next) => {
      settle(next);
      setConfirming(false);
      showSuccess(`${playlist.name} is public.`);
    },
    onError: (error) => {
      const { status, error: message } = readApiError(error);
      setProblem({
        message: message || "Couldn't reach aurral.org. Try again.",
        rename: status === 422,
      });
    },
  });
  const hide = useMutation({
    mutationFn: () =>
      parseResponse(hubLinkClient["public-playlists"][":playlistId"].$delete(param)),
    onSuccess: (next) => {
      settle(next);
      showSuccess(`${playlist.name} is private.`);
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't reach aurral.org."),
  });

  const isPublic = Boolean(state.data?.playlistIds.includes(playlist.id));
  const shown = eligible && state.data && (state.data.available || isPublic);
  const handle = state.data?.handle ?? null;
  const close = () => {
    setConfirming(false);
    setProblem(null);
  };

  return {
    isPublic,
    menuItem: shown
      ? optionMenuItem({
          id: "public",
          label: "Public",
          checked: isPublic,
          onSelect: () => {
            if (isPublic) return hide.mutate();
            setConfirming(true);
            void state.refetch();
          },
        })
      : null,
    modal: (
      <ConfirmModal
        open={confirming}
        title={handle ? `Make ${playlist.name} public?` : "Link aurral.org first"}
        body={
          handle
            ? `Anyone using Aurral can find it on Discover and add it. It shows as @${handle}, with its title and tracks. No files are shared.`
            : "Public playlists show your aurral.org handle. Link an account in Profile, then try again."
        }
        confirmLabel={handle ? "Make public" : "Open Profile"}
        cancelLabel={problem?.rename ? "Edit details" : "Cancel"}
        busyLabel="Publishing…"
        tone="primary"
        busy={publish.isPending}
        error={problem?.message}
        onCancel={() => {
          const rename = problem?.rename;
          close();
          if (rename) onEditDetails();
        }}
        onConfirm={() => {
          if (!handle) {
            close();
            settings.open("profile");
            return;
          }
          setProblem(null);
          publish.mutate();
        }}
      />
    ),
  };
}
