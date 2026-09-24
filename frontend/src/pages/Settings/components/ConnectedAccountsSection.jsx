import { useEffect, useState } from "react";
import {
  getMyIdentities,
  startGoogleLink,
  unlinkMyIdentity,
} from "../../../utils/api/endpoints/auth.js";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.js";
import { useAuth } from "../../../contexts/AuthContext";

const PROVIDER_LABELS = {
  oidc: "Single sign-on",
  google: "Google",
  plex: "Plex",
};

export function ConnectedAccountsSection({ showSuccess, showError, className = "" }) {
  const { bootstrap } = useAuth();
  const [identities, setIdentities] = useState([]);
  const [hasLocalPassword, setHasLocalPassword] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState(null);

  const load = () => {
    setLoading(true);
    return getMyIdentities()
      .then((data) => {
        setIdentities(data?.identities || []);
        setHasLocalPassword(data?.hasLocalPassword !== false);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
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
    try {
      const result = await startGoogleLink();
      if (!result?.authUrl) throw new Error("Google did not return an authorization URL");
      window.location.assign(result.authUrl);
    } catch (err) {
      showError?.(
        err.response?.data?.message || err.response?.data?.error || err.message ||
          "Failed to connect Google",
      );
    }
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

      {loadError ? (
        <p className="settings-page__hint settings-page__hint--warning">
          Failed to load your connected accounts.{" "}
          <button type="button" className="settings-page__link" onClick={() => load()}>
            Try again
          </button>
        </p>
      ) : identities.length === 0 ? (
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

      {!loadError && googleAvailable && !hasGoogle && (
        <button type="button" className="btn btn-secondary" onClick={handleConnectGoogle}>
          Connect Google
        </button>
      )}
      {!loadError && !hasLocalPassword && (
        <p className="settings-page__hint">
          This account has no local password set. Set one below so you always have a way to sign
          in, even if a connected provider becomes unavailable.
        </p>
      )}
    </div>
  );
}
