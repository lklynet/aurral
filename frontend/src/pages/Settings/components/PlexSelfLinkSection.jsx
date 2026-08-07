import { useEffect, useState } from "react";
import {
  getMyPlexLinkStatus,
  startMyPlexLinkPin,
  completeMyPlexLink,
  disconnectMyPlex,
} from "../../../utils/api/endpoints/auth.js";

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
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyPlexLinkStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = async () => {
    if (status.connected && status.linkType === "managed") {
      const confirmed = window.confirm(
        "This account is currently linked as a Plex Home managed user (set up by an admin). " +
          "Connecting your own Plex account will replace that managed link. Continue?",
      );
      if (!confirmed) return;
    }
    setConnecting(true);
    try {
      const { pinId, code, clientId, authUrl } = await startMyPlexLinkPin();
      const popup = window.open(authUrl, "plex-self-link", "width=600,height=700");
      const deadline = Date.now() + 3 * 60 * 1000;
      let linked = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await completeMyPlexLink(pinId, code, clientId);
          if (res.pending) continue;
          linked = res;
          break;
        } catch {}
      }
      if (popup && !popup.closed) popup.close();
      if (!linked) {
        showError?.("Plex authentication timed out. Please try again.");
        return;
      }
      setStatus((prev) => ({
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
      setStatus((prev) => ({
        ...EMPTY_STATUS,
        globalAccount: prev.globalAccount,
        isGlobalAccountOwner: prev.isGlobalAccountOwner,
      }));
      showSuccess?.("Disconnected your Plex account.");
    } catch (err) {
      showError?.(err.response?.data?.message || "Failed to disconnect Plex");
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) return null;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Plex Account</h3>
        <p className="settings-page__section-note">
          Link your own Plex.tv account (e.g. if an admin invited you as a friend to their Plex
          server) so your flow and shared playlists are created under your own Plex login.
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
                ? " An admin can relink this from Settings → Users, or you can connect your own Plex account below instead."
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
                    Your flow and shared playlists sync through Aurral&apos;s global Plex
                    connection: <strong>{status.globalAccount.plexUsername}</strong>.
                  </>
                ) : (
                  "Your flow and shared playlists sync through Aurral’s global Plex connection."
                )
              ) : (
                "Plex is not configured yet. Your flow and shared playlists won’t sync to Plex until it’s configured as a playback source."
              )
            ) : (
              "Not linked. Your flow and shared playlists won’t sync to Plex until you connect your own account below."
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
