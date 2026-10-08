import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext.js";
import { useToast } from "../contexts/ToastContext";
import { useThemeDocument } from "../hooks/useThemeDocument.js";
import { getMyTheme, saveMyTheme } from "../utils/api/endpoints/auth.js";
import { extractArtworkAccent } from "../utils/imageColors.js";
import { setArtworkColor, startThemeAccountSync } from "../utils/theme.js";

export default function ThemeSync() {
  const { isAuthenticated, user } = useAuth();
  const { currentTrack } = useAudioQueue();
  const { showError } = useToast();
  const { matchArtwork } = useThemeDocument();
  const userId = isAuthenticated && Number.isSafeInteger(Number(user?.id)) && Number(user.id) > 0 ? Number(user.id) : null;
  const artwork = matchArtwork ? currentTrack?.artwork || null : null;

  useEffect(() => {
    if (!userId) return undefined;
    const sync = startThemeAccountSync({
      userId,
      loadAccountTheme: getMyTheme,
      saveAccountTheme: saveMyTheme,
      onSaveError: () => showError("Your theme couldn't be saved to your account. It still applies on this device."),
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
