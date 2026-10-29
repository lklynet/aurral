import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { readApiError } from "../utils/apiError.ts";
import { SettingsGroup, SettingsNote, SettingsRow } from "../SettingsLayout";

type Identity = InferResponseType<typeof usersClient.me.identities.$get, 200>["identities"][number];
type StartLink = () => Promise<{ authUrl: string }>;

const unlinkIdentity = (id: number) =>
  parseResponse(usersClient.me.identities[":id"].$delete({ param: { id: String(id) } }));

const PROVIDER_LABELS: Partial<Record<string, string>> = {
  oidc: "Single sign-on",
  google: "Google",
  plex: "Plex",
};

const providerLabel = (identity: Identity) =>
  PROVIDER_LABELS[identity.providerType] || identity.providerType;

export function useMyIdentities() {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.myIdentities(user?.id),
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me.identities.$get({}, { init: { signal } })),
  });
}

export function ConnectedAccountsSection() {
  const { bootstrap, user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const identitiesQuery = useMyIdentities();
  const [unlinkingId, setUnlinkingId] = useState<number | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.myIdentities(user?.id) });

  const handleUnlink = async (identity: Identity) => {
    setUnlinkingId(identity.id);
    const unlink = async () => {
      await unlinkIdentity(identity.id);
      showSuccess(`Disconnected ${providerLabel(identity)}.`);
      await refresh();
    };
    try {
      try {
        await unlink();
      } catch (err) {
        if (!isReauthRequiredError(err)) throw err;
        if (await promptReauth()) await unlink();
      }
    } catch (err) {
      const failure = readApiError(err);
      showError(failure.message || failure.error || "Failed to disconnect");
    } finally {
      setUnlinkingId(null);
    }
  };

  const connectProvider = async (startLink: StartLink, label: string) => {
    if (!(await promptReauth())) return;
    try {
      const result = await startLink();
      if (!result?.authUrl) throw new Error(`${label} did not return an authorization URL`);
      window.location.assign(result.authUrl);
    } catch (err) {
      const failure = readApiError(err);
      showError(failure.message || failure.error || failure.text || `Failed to connect ${label}`);
    }
  };

  if (identitiesQuery.isPending) return null;

  const identities = identitiesQuery.data?.identities ?? [];
  const oidcAvailable = !!bootstrap?.oidcEnabled;
  const googleAvailable = !!bootstrap?.googleLoginEnabled;
  const canConnectOidc =
    oidcAvailable && !identities.some((identity) => identity.providerType === "oidc");
  const canConnectGoogle =
    googleAvailable && !identities.some((identity) => identity.providerType === "google");

  if (!identitiesQuery.isError && !identities.length && !canConnectOidc && !canConnectGoogle) {
    return null;
  }

  return (
    <SettingsGroup title="Sign-in methods">
      {identitiesQuery.isError ? (
        <SettingsNote tone="warning">
          Couldn&apos;t load your sign-in methods.{" "}
          <button type="button" className="settings-link" onClick={() => refresh()}>
            Try again
          </button>
        </SettingsNote>
      ) : null}
      {identities.map((identity) => (
        <SettingsRow key={identity.id} label={providerLabel(identity)} help={identity.displayName}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => handleUnlink(identity)}
            disabled={unlinkingId === identity.id}
          >
            {unlinkingId === identity.id ? "Disconnecting…" : "Disconnect"}
          </button>
        </SettingsRow>
      ))}
      {canConnectOidc ? (
        <SettingsRow
          label="Single sign-on"
          help="Your identity provider sets your role when you sign in."
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              connectProvider(
                () => parseResponse(authClient.oidc.link.start.$post()),
                "single sign-on",
              )
            }
          >
            Connect
          </button>
        </SettingsRow>
      ) : null}
      {canConnectGoogle ? (
        <SettingsRow label="Google">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              connectProvider(() => parseResponse(authClient.google.link.start.$post()), "Google")
            }
          >
            Connect
          </button>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}
