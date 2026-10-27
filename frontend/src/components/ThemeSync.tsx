import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext.ts";
import { useToast } from "../contexts/ToastContext";
import { useThemeDocument } from "../hooks/useThemeDocument.ts";
import { parseResponse } from "hono/client";
import { usersClient } from "../utils/api/clients/users.ts";
import { extractArtworkAccent } from "../utils/imageColors.ts";
import { setArtworkColor, startThemeAccountSync } from "../utils/theme.ts";

export default function ThemeSync() {
  const { isAuthenticated, user } = useAuth();
  const { currentTrack } = useAudioQueue();
  const { showError } = useToast();
  const { matchArtwork } = useThemeDocument();
  const userId =
    isAuthenticated && Number.isSafeInteger(Number(user?.id)) && Number(user!.id) > 0
      ? Number(user!.id)
      : null;
  const artwork = matchArtwork ? currentTrack?.artwork || null : null;

  useEffect(() => {
    if (!userId) return undefined;
    const sync = startThemeAccountSync({
      userId,
      loadAccountTheme: () => parseResponse(usersClient.me.theme.$get()),
      saveAccountTheme: (theme) => parseResponse(usersClient.me.theme.$put({ json: { theme } })),
      onSaveError: () =>
        showError("Theme applies on this device but could not sync to your account."),
    });
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void sync.refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      sync.stop();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [showError, userId]);

  useEffect(() => {
    if (!artwork) {
      setArtworkColor(null);
      return undefined;
    }
    let cancelled = false;
    extractArtworkAccent(artwork).then((color) => {
      if (!cancelled) setArtworkColor(color);
    });
    return () => {
      cancelled = true;
    };
  }, [artwork]);

  return null;
}
