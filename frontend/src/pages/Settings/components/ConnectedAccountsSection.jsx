import { useEffect, useState } from "react";
import { getMyIdentities, unlinkMyIdentity } from "../../../utils/api/endpoints/auth.js";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.js";
import { useAuth } from "../../../contexts/AuthContext";
import { getAppBasePath } from "../../../utils/basePath.js";

const PROVIDER_LABELS = {
  oidc: "Single sign-on",
  google: "Google",
  plex: "Plex",
};

const buildApiUrl = (path) => {
  const basePath = getAppBasePath();
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  return `${prefix}${path}`;
};

export function ConnectedAccountsSection({ showSuccess, showError, className = "" }) {
  const { bootstrap } = useAuth();
  const [identities, setIdentities] = useState([]);
  const [hasLocalPassword, setHasLocalPassword] = useState(true);
  const [loading, setLoading] = useState(true);
  const [unlinkingId, setUnlinkingId] = useState(null);

  const load = () => {
    setLoading(true);
    return getMyIdentities()
      .then((data) => {
        setIdentities(data?.identities || []);
        setHasLocalPassword(data?.hasLocalPassword !== false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleUnlink = async (identity) => {
    setUnlinkingId(identity.id);
    try {
      await unlinkMyIdentity(identity.id);
      showSuccess?.(`Disconnected ${PROVIDER_LABELS[identity.providerType] || identity.providerType}.`);
      await load();
    } catch (err) {
      if (isReauthRequiredError(err)) {
        const shouldRetry = await promptReauth();
        if (shouldRetry) {
          try {
            await unlinkMyIdentity(identity.id);
            showSuccess?.(
              `Disconnected ${PROVIDER_LABELS[identity.providerType] || identity.providerType}.`,
            );
            await load();
          } catch (retryErr) {
            showError?.(retryErr.response?.data?.message || "Failed to disconnect");
          }
        }
      } else {
        showError?.(
          err.response?.data?.message || err.response?.data?.error || "Failed to disconnect",
        );
      }
    } finally {
      setUnlinkingId(null);
    }
  };

  const handleConnectGoogle = async () => {
    const shouldProceed = await promptReauth();
    if (!shouldProceed) return;
    window.location.assign(buildApiUrl("/api/auth/google/link"));
  };

  if (loading) return null;

  const hasGoogle = identities.some((identity) => identity.providerType === "google");
  const googleAvailable = !!bootstrap?.googleLoginEnabled;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Connected Accounts</h3>
        <p className="settings-page__section-note">
          Other ways you can sign in to Aurral. You can always sign in with your local password
          {hasLocalPassword ? "" : " once you set one below"}.
        </p>
      </div>

      {identities.length === 0 ? (
        <p className="settings-page__muted-copy">No other sign-in methods connected.</p>
      ) : (
        <div className="connected-account-list">
          {identities.map((identity) => (
            <div key={identity.id} className="connected-account-row">
              <span>
                <strong>{PROVIDER_LABELS[identity.providerType] || identity.providerType}</strong>
                {identity.displayName ? ` — ${identity.displayName}` : ""}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleUnlink(identity)}
                disabled={unlinkingId === identity.id}
              >
                {unlinkingId === identity.id ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          ))}
        </div>
      )}

      {googleAvailable && !hasGoogle && (
        <button type="button" className="btn btn-secondary" onClick={handleConnectGoogle}>
          Connect Google
        </button>
      )}
      {!hasLocalPassword && (
        <p className="settings-page__hint">
          This account has no local password set. Set one below so you always have a way to sign
          in, even if a connected provider becomes unavailable.
        </p>
      )}
    </div>
  );
}
