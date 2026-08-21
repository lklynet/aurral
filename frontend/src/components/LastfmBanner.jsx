import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

import { useNavigate } from "react-router-dom";
const LEGACY_DISMISS_KEY = "lastfm_banner_dismissed";
const DISMISS_KEY_PREFIX = "aurral:lastfm-banner-dismissed";

const getDismissKey = (user) => {
  if (user?.id != null) return `${DISMISS_KEY_PREFIX}:${user.id}`;
  if (user?.username) return `${DISMISS_KEY_PREFIX}:${user.username}`;
  return DISMISS_KEY_PREFIX;
};

const readDismissed = (user) => {
  try {
    const dismissKey = getDismissKey(user);
    if (localStorage.getItem(dismissKey) === "1") {
      return true;
    }

    if (sessionStorage.getItem(LEGACY_DISMISS_KEY) === "1") {
      localStorage.setItem(dismissKey, "1");
      sessionStorage.removeItem(LEGACY_DISMISS_KEY);
      return true;
    }
  } catch {}

  return false;
};

const LastfmBanner = () => {
  const { user, bootstrap } = useAuth();
  const [dismissed, setDismissed] = useState(() => readDismissed(user));
  const lastfmConfigured = bootstrap ? !!bootstrap.lastfmConfigured : null;
  const navigate = useNavigate();

  useEffect(() => {
    setDismissed(readDismissed(user));
  }, [user]);

  if (dismissed || lastfmConfigured === null || lastfmConfigured) {
    return null;
  }

  return (
    <div className="app-banner">
      <div className="app-banner__content">
        <p className="app-banner__title">Personalize your discovery</p>
        <p className="app-banner__text">
          Connect Last.fm for personalized recommendations, related artists, full tag search, and
          flows.
        </p>
      </div>
      <div className="app-banner__actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => navigate("/settings/connect")}
        >
          Connect Last.fm
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(getDismissKey(user), "1");
              sessionStorage.removeItem(LEGACY_DISMISS_KEY);
            } catch {}
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};

export default LastfmBanner;
