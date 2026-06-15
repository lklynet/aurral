import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { SPONSOR_URL } from "../constants/sponsor";

const DISMISS_KEY_PREFIX = "aurral:settings-sponsor-banner-dismissed";

const getDismissKey = (user) => {
  if (user?.id != null) return `${DISMISS_KEY_PREFIX}:${user.id}`;
  if (user?.username) return `${DISMISS_KEY_PREFIX}:${user.username}`;
  return DISMISS_KEY_PREFIX;
};

const readDismissed = (user) => {
  try {
    return localStorage.getItem(getDismissKey(user)) === "1";
  } catch {
    return false;
  }
};

function SettingsSponsorBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(() => readDismissed(user));

  useEffect(() => {
    setDismissed(readDismissed(user));
  }, [user]);

  if (dismissed) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(getDismissKey(user), "1");
    } catch {}
  };

  return (
    <div className="settings-page__banner settings-page__banner--sponsor">
      <div className="settings-page__banner-copy">
        <p className="settings-page__banner-title">Support Aurral</p>
        <p className="settings-page__banner-text">
          Aurral&apos;s hosted metadata and search services run on personal
          infrastructure and may experience occasional downtime. Sponsoring
          development helps keep those services reliable, fund cloud capacity
          when needed, and sustain ongoing work on Aurral.
        </p>
        <a
          href={SPONSOR_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary btn-sm settings-page__banner-cta"
        >
          <ExternalLink className="settings-page__banner-cta-icon" aria-hidden="true" />
          Sponsor on GitHub
        </a>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon-square"
        onClick={dismiss}
        aria-label="Dismiss sponsor message"
      >
        <X className="settings-page__tab-icon" />
      </button>
    </div>
  );
}

export default SettingsSponsorBanner;
