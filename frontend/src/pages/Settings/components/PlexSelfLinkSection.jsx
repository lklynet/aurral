import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyPlexLinkStatus,
  startMyPlexLinkPin,
  completeMyPlexLink,
  disconnectMyPlex,
} from "../../../utils/api/endpoints/auth.js";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.js";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient.js";

const EMPTY_STATUS = {
  connected: false,
  linkType: null,
  plexUsername: null,
  connectedAt: null,
  lastError: null,
  globalAccount: null,
  isGlobalAccountOwner: false,
};

export function PlexSelfLinkSection({ showSuccess, showError, className = "" }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const statusQueryKey = queryKeys.myPlexLinkStatus(user?.id);
  const statusQuery = useQuery({
    queryKey: statusQueryKey,
    queryFn: ({ signal }) => getMyPlexLinkStatus({ signal }),
  });
  const status = statusQuery.data ?? EMPTY_STATUS;
  const updateStatus = (update) =>
    queryClient.setQueryData(statusQueryKey, (prev) => update(prev ?? EMPTY_STATUS));
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
      const { pinId, code, clientId, authUrl } = await startMyPlexLinkPin();
      const popup = window.open(authUrl, "plex-self-link", "width=600,height=700");
      const deadline = Date.now() + 3 * 60 * 1000;
      let linked = null;
      let reauthPrompted = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await completeMyPlexLink(pinId, code, clientId);
          if (res.pending) continue;
          linked = res;
          break;
        } catch (pollErr) {
          if (isReauthRequiredError(pollErr) && !reauthPrompted) {
            reauthPrompted = true;
            const shouldRetry = await promptReauth();
            if (shouldRetry) continue;
          }
          if (popup && !popup.closed) popup.close();
          const message =
            pollErr.response?.data?.message || pollErr.response?.data?.error || pollErr.message;
          showError?.(`Plex sign-in failed: ${message}`);
          return;
        }
      }
      if (popup && !popup.closed) popup.close();
      if (!linked) {
        showError?.("Plex sign-in timed out. Try again.");
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
      showSuccess?.(`Connected to Plex as "${linked.plexUsername || "your account"}".`);
    } catch (err) {
      const message = err.response?.data?.message || err.response?.data?.error || err.message;
      showError?.(`Plex sign-in failed: ${message}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectMyPlex();
      updateStatus((prev) => ({
        ...EMPTY_STATUS,
        globalAccount: prev.globalAccount,
        isGlobalAccountOwner: prev.isGlobalAccountOwner,
      }));
      showSuccess?.("Disconnected your Plex account.");
    } catch (err) {
      if (isReauthRequiredError(err)) {
        const shouldRetry = await promptReauth();
        if (shouldRetry) {
          try {
            await disconnectMyPlex();
            updateStatus((prev) => ({
              ...EMPTY_STATUS,
              globalAccount: prev.globalAccount,
              isGlobalAccountOwner: prev.isGlobalAccountOwner,
            }));
            showSuccess?.("Disconnected your Plex account.");
          } catch (retryErr) {
            showError?.(retryErr.response?.data?.message || "Failed to disconnect Plex");
          }
        }
      } else {
        showError?.(err.response?.data?.message || "Failed to disconnect Plex");
      }
    } finally {
      setDisconnecting(false);
    }
  };

  if (statusQuery.isPending) return null;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Plex account</h3>
        <p className="settings-page__section-note">
          Use your Plex account for flows and playlists.
        </p>
      </div>

      {status.connected ? (
        <>
          <p className="settings-page__muted-copy">
            {status.linkType === "managed" ? "Managed by an admin as" : "Connected as"}{" "}
            <strong>{status.plexUsername || "your Plex account"}</strong>.
          </p>
          {status.lastError && (
            <p className="settings-page__hint settings-page__hint--warning">
              Reconnect needed: {status.lastError.message}
              {status.linkType === "managed"
                ? "Ask an admin to relink this in Settings → Users, or connect your Plex account below."
                : ""}
            </p>
          )}
          <div className="settings-page__inline-row">
            {status.linkType === "self" ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleConnect}
                disabled={connecting}
              >
                {connecting ? "Reconnecting..." : "Reconnect"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleConnect}
                disabled={connecting}
              >
                {connecting ? "Connecting..." : "Connect your own Plex account instead"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-page__callout">
            {status.isGlobalAccountOwner ? (
              status.globalAccount?.configured ? (
                status.globalAccount.plexUsername ? (
                  <>
                    Your flows and playlists sync through Aurral&apos;s global Plex
                    connection: <strong>{status.globalAccount.plexUsername}</strong>.
                  </>
                ) : (
                  "Your flows and playlists sync through Aurral’s global Plex connection."
                )
              ) : (
                "Set up Plex as a playback source to sync flows and playlists."
              )
            ) : (
              "Connect your Plex account to sync flows and playlists."
            )}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? "Connecting..." : "Connect Plex account"}
          </button>
        </>
      )}
    </div>
  );
}
