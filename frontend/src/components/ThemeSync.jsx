import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext.js";
import { useToast } from "../contexts/ToastContext";
import { useThemeDocument } from "../hooks/useThemeDocument.js";
import { getMyTheme, saveMyTheme } from "../utils/api/endpoints/auth.js";
import { extractArtworkAccent } from "../utils/imageColors.js";
import { setArtworkColor, setThemeAccountSaver, syncThemeWithAccount } from "../utils/theme.js";

export default function ThemeSync() {
  const { isAuthenticated, user } = useAuth();
  const { currentTrack } = useAudioQueue();
  const { showError } = useToast();
  const { matchArtwork } = useThemeDocument();
  const userId = isAuthenticated && Number.isSafeInteger(Number(user?.id)) && Number(user.id) > 0 ? Number(user.id) : null;
  const artwork = matchArtwork ? currentTrack?.artwork || null : null;

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    let pending = Promise.resolve();
    const save = (document) => {
      pending = pending
        .then(() => saveMyTheme(document))
        .catch(() => {
          if (!cancelled) showError("Your theme couldn't be saved to your account. It still applies on this device.");
        });
    };
    const load = () =>
      getMyTheme()
        .then((response) => {
          if (cancelled) return;
          const upload = syncThemeWithAccount(userId, response?.theme || null);
          setThemeAccountSaver(save);
          if (upload) save(upload);
        })
        .catch(() => {});
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      cancelled = true;
      setThemeAccountSaver(null);
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
