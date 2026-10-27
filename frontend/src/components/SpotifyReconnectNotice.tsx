import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { parseResponse } from "hono/client";
import { playlistImportsClient } from "../utils/api/clients/playlistImports.ts";

const NOTICE_KEY_PREFIX = "aurral-spotify-reconnect-notice:";

export default function SpotifyReconnectNotice() {
  const { isAuthenticated, user, hasPermission } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const canImport = isAuthenticated && hasPermission("accessFlow");
  const noticeKey = `${NOTICE_KEY_PREFIX}${user?.id ?? "local"}`;

  useEffect(() => {
    if (!canImport || sessionStorage.getItem(noticeKey)) return undefined;
    let cancelled = false;
    parseResponse(playlistImportsClient.import.spotify.status.$get())
      .then((status) => {
        if (cancelled || !status?.reconnectRequired) return;
        sessionStorage.setItem(noticeKey, "1");
        addToast(
          {
            title: "Spotify disconnected",
            message: "Synced Spotify playlists are paused until you connect Spotify again.",
            action: {
              label: "Reconnect",
              onClick: () => navigate("/library/playlists", { state: { openImport: true } }),
            },
          },
          "warning",
          15000,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [addToast, canImport, navigate, noticeKey]);

  return null;
}
