import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { userPlexLinkClient } from "../../../utils/api/clients/userPlexLink.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { readApiError } from "../utils/apiError.ts";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient.ts";
import { useToast } from "../../../contexts/ToastContext";
import { SettingsActions, SettingsGroup, SettingsNote } from "../SettingsLayout";
type PlexLinkStatusResponse = InferResponseType<
  (typeof userPlexLinkClient.me)["plex-link"]["status"]["$get"],
  200
>;
type PlexLinkStatus = Omit<PlexLinkStatusResponse, "globalAccount"> & {
  globalAccount: PlexLinkStatusResponse["globalAccount"] | null;
};

const EMPTY_STATUS: PlexLinkStatus = {
  connected: false,
  linkType: null,
  plexUsername: null,
  connectedAt: null,
  lastError: null,
  globalAccount: null,
  isGlobalAccountOwner: false,
};

export function PlexSelfLinkSection() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const statusQueryKey = queryKeys.myPlexLinkStatus(user?.id);
  const statusQuery = useQuery({
    queryKey: statusQueryKey,
    queryFn: ({ signal }) =>
      parseResponse(userPlexLinkClient.me["plex-link"].status.$get({}, { init: { signal } })),
  });
  const status = statusQuery.data ?? EMPTY_STATUS;
  const updateStatus = (update: (prev: PlexLinkStatus) => PlexLinkStatus) =>
    queryClient.setQueryData<PlexLinkStatus>(statusQueryKey, (prev) =>
      update(prev ?? EMPTY_STATUS),
    );
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleConnect = async () => {
    if (status.connected && status.linkType === "managed") {
      const confirmed = window.confirm(
        "Replace your managed Plex link with your own Plex account?",
      );
      if (!confirmed) return;
    }
    setConnecting(true);
    try {
      const { pinId, code, clientId, authUrl } = await parseResponse(
        userPlexLinkClient.me["plex-link"].oauth.pin.$post({ json: {} }),
      );
      const popup = window.open(authUrl, "plex-self-link", "width=600,height=700");
      const deadline = Date.now() + 3 * 60 * 1000;
      let linked = null;
      let reauthPrompted = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await parseResponse(
            userPlexLinkClient.me["plex-link"].oauth.complete.$post({
              json: { pinId, code, clientId },
            }),
          );
          if ("pending" in res) continue;
          linked = res;
          break;
        } catch (pollErr) {
          if (isReauthRequiredError(pollErr) && !reauthPrompted) {
            reauthPrompted = true;
            const shouldRetry = await promptReauth();
            if (shouldRetry) continue;
          }
          if (popup && !popup.closed) popup.close();
          const failure = readApiError(pollErr);
          const message = failure.message || failure.error || failure.text;
          showError(`Plex sign-in failed: ${message}`);
          return;
        }
      }
      if (popup && !popup.closed) popup.close();
      if (!linked) {
        showError("Plex sign-in timed out. Try again.");
        return;
      }
      updateStatus((prev) => ({
        ...prev,
        connected: true,
        linkType: linked.linkType,
        plexUsername: linked.plexUsername,
        connectedAt: linked.connectedAt,
        lastError: null,
      }));
      showSuccess(`Connected to Plex as "${linked.plexUsername || "your account"}".`);
    } catch (err) {
      const failure = readApiError(err);
      const message = failure.message || failure.error || failure.text;
      showError(`Plex sign-in failed: ${message}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await parseResponse(userPlexLinkClient.me["plex-link"].$delete());
      updateStatus((prev) => ({
        ...EMPTY_STATUS,
        globalAccount: prev.globalAccount,
        isGlobalAccountOwner: prev.isGlobalAccountOwner,
      }));
      showSuccess("Disconnected your Plex account.");
    } catch (err) {
      if (isReauthRequiredError(err)) {
        const shouldRetry = await promptReauth();
        if (shouldRetry) {
          try {
            await parseResponse(userPlexLinkClient.me["plex-link"].$delete());
            updateStatus((prev) => ({
              ...EMPTY_STATUS,
              globalAccount: prev.globalAccount,
              isGlobalAccountOwner: prev.isGlobalAccountOwner,
            }));
            showSuccess("Disconnected your Plex account.");
          } catch (retryErr) {
            showError(readApiError(retryErr).message || "Failed to disconnect Plex");
          }
        }
      } else {
        showError(readApiError(err).message || "Failed to disconnect Plex");
      }
    } finally {
      setDisconnecting(false);
    }
  };

  if (statusQuery.isPending) return null;

  const linkedAs = String(status.plexUsername || "your Plex account");
  const globalAccountNote = status.isGlobalAccountOwner
    ? status.globalAccount?.configured
      ? `Your flows and playlists sync through Aurral's Plex connection${
          status.globalAccount.plexUsername ? `, ${status.globalAccount.plexUsername}` : ""
        }.`
      : "Set up Plex in Playback to sync flows and playlists."
    : "Connect your Plex account to sync flows and playlists.";

  return (
    <SettingsGroup
      title="Plex account"
      note={
        status.connected
          ? `${status.linkType === "managed" ? "Managed by an admin as" : "Connected as"} ${linkedAs}.`
          : globalAccountNote
      }
    >
      {status.connected && status.lastError ? (
        <SettingsNote tone="warning">
          Reconnect needed: {status.lastError.message}
          {status.linkType === "managed"
            ? " Ask an admin to relink it, or connect your own Plex account."
            : ""}
        </SettingsNote>
      ) : null}
      <SettingsActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting
            ? "Connecting…"
            : !status.connected
              ? "Connect Plex account"
              : status.linkType === "self"
                ? "Reconnect"
                : "Use my own Plex account"}
        </button>
        {status.connected ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : null}
      </SettingsActions>
    </SettingsGroup>
  );
}
