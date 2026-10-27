import { useEffect, useState } from "react";
import { parseResponse, type InferResponseType } from "hono/client";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { useAuth } from "../../../contexts/AuthContext";
import type { useToast } from "../../../contexts/ToastContext";
import { readApiError } from "../utils/apiError.ts";

type Toast = ReturnType<typeof useToast>["showSuccess"];
type Identity = InferResponseType<typeof usersClient.me.identities.$get, 200>["identities"][number];
type StartLink = () => Promise<{ authUrl: string }>;

const unlinkIdentity = (id: number) =>
  parseResponse(usersClient.me.identities[":id"].$delete({ param: { id: String(id) } }));

const PROVIDER_LABELS: Partial<Record<string, string>> = {
  oidc: "Single sign-on",
  google: "Google",
  plex: "Plex",
};

export function ConnectedAccountsSection({
  showSuccess,
  showError,
  className = "",
}: {
  showSuccess: Toast;
  showError: Toast;
  className?: string;
}) {
  const { bootstrap } = useAuth();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [hasLocalPassword, setHasLocalPassword] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    return parseResponse(usersClient.me.identities.$get())
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

  const handleUnlink = async (identity: Identity) => {
    setUnlinkingId(identity.id);
    try {
      await unlinkIdentity(identity.id);
      showSuccess?.(
        `Disconnected ${PROVIDER_LABELS[identity.providerType] || identity.providerType}.`,
      );
      await load();
    } catch (err) {
      if (isReauthRequiredError(err)) {
        const shouldRetry = await promptReauth();
        if (shouldRetry) {
          try {
            await unlinkIdentity(identity.id);
            showSuccess?.(
              `Disconnected ${PROVIDER_LABELS[identity.providerType] || identity.providerType}.`,
            );
            await load();
          } catch (retryErr) {
            showError?.(readApiError(retryErr).message || "Failed to disconnect");
          }
        }
      } else {
        const failure = readApiError(err);
        showError?.(failure.message || failure.error || "Failed to disconnect");
      }
    } finally {
      setUnlinkingId(null);
    }
  };

  const connectProvider = async (startLink: StartLink, label: string) => {
    const shouldProceed = await promptReauth();
    if (!shouldProceed) return;
    try {
      const result = await startLink();
      if (!result?.authUrl) throw new Error(`${label} did not return an authorization URL`);
      window.location.assign(result.authUrl);
    } catch (err) {
      const failure = readApiError(err);
      showError?.(failure.message || failure.error || failure.text || `Failed to connect ${label}`);
    }
  };

  if (loading) return null;

  const hasGoogle = identities.some((identity) => identity.providerType === "google");
  const googleAvailable = !!bootstrap?.googleLoginEnabled;
  const hasOidc = identities.some((identity) => identity.providerType === "oidc");
  const oidcAvailable = !!bootstrap?.oidcEnabled;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Connected accounts</h3>
        <p className="settings-page__section-note">Additional sign-in methods.</p>
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

      {!loadError && oidcAvailable && !hasOidc && (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              connectProvider(
                () => parseResponse(authClient.oidc.link.start.$post()),
                "single sign-on",
              )
            }
          >
            Connect single sign-on
          </button>
          <p className="settings-page__hint">
            Your identity provider sets your role when you sign in.
          </p>
        </>
      )}
      {!loadError && googleAvailable && !hasGoogle && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() =>
            connectProvider(() => parseResponse(authClient.google.link.start.$post()), "Google")
          }
        >
          Connect Google
        </button>
      )}
      {!loadError && !hasLocalPassword && (
        <p className="settings-page__hint">
          Set a local password to sign in when a connected provider is unavailable.
        </p>
      )}
    </div>
  );
}
