import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { ConfirmModal } from "../../../components/ConfirmModal";
import PillToggle from "../../../components/PillToggle";
import { FriendsDialog } from "../../../components/PlayerFriends";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { hubLinkClient } from "../../../utils/api/clients/hubLink.ts";
import { readApiError } from "../../../utils/api/errors.ts";
import { SettingsGroup, SettingsRow } from "../SettingsLayout";

type HubLink = InferResponseType<typeof hubLinkClient.$get, 200>;

const POLL_MS = 5000;

const clockTime = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function HubLinkGroup() {
  const { user } = useAuth();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [managingFriends, setManagingFriends] = useState(false);
  const queryKey = queryKeys.hubLink(user?.id);
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => parseResponse(hubLinkClient.$get({}, { init: { signal } })),
    refetchInterval: (query) => (query.state.data?.state === "pending" ? POLL_MS : false),
  });
  const settle = (next: HubLink) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.friends(user?.id) });
  };
  const start = useMutation({
    mutationFn: () => parseResponse(hubLinkClient.$post()),
    onSuccess: settle,
    onError: (error) => showError(readApiError(error).error || "Couldn't reach aurral.org."),
  });
  const share = useMutation({
    mutationFn: (shared: boolean) =>
      parseResponse(hubLinkClient.sharing.$put({ json: { shared } })),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onError: (error) => showError(readApiError(error).error || "Couldn't reach aurral.org."),
  });
  const unlink = useMutation({
    mutationFn: (_handle: string | null) => parseResponse(hubLinkClient.$delete()),
    onSuccess: (next, handle) => {
      settle(next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.publicPlaylists(user?.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.communityPlaylists(user?.id) });
      setConfirmUnlink(false);
      if (handle) showSuccess(`Unlinked @${handle}.`);
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't unlink."),
  });

  const link = status.data;
  if (!link) return null;
  const linked = link.state === "linked" || link.state === "broken";
  if (!link.available && !linked) return null;
  const host = new URL(link.origin).host;

  return (
    <SettingsGroup title="aurral.org account">
      {link.state === "none" ? (
        <SettingsRow
          label="Not linked"
          help="Link to add friends and publish playlists for everyone."
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            Link
          </button>
        </SettingsRow>
      ) : null}
      {link.state === "pending" ? (
        <SettingsRow
          label={link.code}
          help={`Enter this at ${host}/link. Expires at ${clockTime(link.expiresAt)}.`}
        >
          <>
            <a
              className="btn btn-primary btn-sm"
              href={`${link.origin}/link?code=${link.code}`}
              target="_blank"
              rel="noreferrer"
            >
              Open {host}
            </a>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate(null)}
            >
              Cancel
            </button>
          </>
        </SettingsRow>
      ) : null}
      {linked ? (
        <SettingsRow
          label={`@${link.handle}`}
          help={
            link.state === "broken" ? (
              `${host} no longer accepts this link.`
            ) : (
              <>
                Linked {shortDate(link.linkedAt)} ·{" "}
                <a href={`${link.origin}/account`} target="_blank" rel="noreferrer">
                  Manage on {host}
                </a>
              </>
            )
          }
          tone={link.state === "broken" ? "error" : undefined}
        >
          <>
            {link.state === "broken" && link.available ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={start.isPending}
                onClick={() => start.mutate()}
              >
                Relink
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmUnlink(true)}
            >
              Unlink
            </button>
          </>
        </SettingsRow>
      ) : null}
      {link.state === "linked" && link.available ? (
        <SettingsRow label="Friends" help="Add friends and answer requests.">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setManagingFriends(true)}
          >
            Manage
          </button>
        </SettingsRow>
      ) : null}
      {linked ? (
        <SettingsRow
          label="Share with friends"
          help="What you're playing and your top 100 tracks from the last 30 days, for your profile and Blends."
        >
          <PillToggle
            id="hub-share-listening"
            checked={share.isPending ? share.variables : link.sharing}
            disabled={share.isPending}
            aria-label="Share with friends"
            onChange={(event) => share.mutate(event.target.checked)}
          />
        </SettingsRow>
      ) : null}
      <FriendsDialog open={managingFriends} onClose={() => setManagingFriends(false)} />
      <ConfirmModal
        open={confirmUnlink}
        title={linked ? `Unlink @${link.handle}?` : "Unlink?"}
        body={`This server can no longer publish as you on aurral.org.${
          link.publicPlaylists
            ? ` ${link.publicPlaylists === 1 ? "Your public playlist stops" : `Your ${link.publicPlaylists} public playlists stop`} being public.`
            : ""
        } You can link again anytime.`}
        confirmLabel="Unlink"
        busyLabel="Unlinking…"
        tone="danger"
        busy={unlink.isPending}
        onCancel={() => setConfirmUnlink(false)}
        onConfirm={() => unlink.mutate(linked ? link.handle : null)}
      />
    </SettingsGroup>
  );
}
