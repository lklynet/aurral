import PillToggle from "../../../components/PillToggle";
import { DotLoader } from "../../../components/DotLoader";
import { useAuth } from "../../../contexts/AuthContext";
import { getAppBasePath } from "../../../utils/basePath.ts";
import { SettingsInput } from "../components/SettingsField";
import { useSettingsUsers } from "../hooks/useSettingsUsers";
import { useServerSettings } from "../SettingsProviders";
import { SettingsLink } from "../settingsRoute";
import type { SettingsState } from "../utils";
import { providerStatus } from "../utils/serviceStatus";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import { EditUserPage, NewUserPage, describeUser } from "./users/UserPages";

type GoogleSettings = NonNullable<SettingsState["integrations"]["google"]>;
type AutoLoginStatus = NonNullable<
  ReturnType<typeof useServerSettings>["health"]
>["localNetworkBypass"];

const AUTO_LOGIN_UNAVAILABLE: Partial<Record<string, string>> = {
  not_single_user: "Unavailable while more than one user exists.",
  sole_user_not_admin: "Unavailable because the only user isn't an admin.",
  not_trusted_network: "Unavailable because the local IPv4 network couldn't be determined.",
  not_onboarded: "Unavailable until onboarding is finished.",
};

function autoLoginState(status: AutoLoginStatus) {
  if (!status) return { help: "Couldn't check auto-login status.", canToggle: false };
  if (status.active) {
    return { help: "This device signs in automatically as the only admin.", canToggle: true };
  }
  if (status.enabled) {
    return {
      help: "The only admin signs in automatically on the trusted local network.",
      canToggle: true,
    };
  }
  if (status.reason === "disabled") {
    return {
      help: "Signs in the only admin on the trusted local network. Adding another user turns it off.",
      canToggle: true,
    };
  }
  return {
    help: AUTO_LOGIN_UNAVAILABLE[status.reason ?? ""] ?? "Unavailable.",
    canToggle: false,
  };
}

function useSaveSecurity() {
  const { settings, updateSettings, handleSaveSettings } = useServerSettings();
  return async (patch: Partial<SettingsState["security"]>) => {
    const saved = await handleSaveSettings(null, {
      ...settings,
      security: { ...settings.security, ...patch },
    });
    if (!saved) updateSettings(settings);
  };
}

function googleCallbackUrl() {
  const basePath = getAppBasePath();
  return `${window.location.origin}${basePath === "/" ? "" : basePath.replace(/\/$/, "")}/sso/google/callback`;
}

function GooglePage() {
  const { settings, updateSettings } = useServerSettings();
  const google: GoogleSettings = settings.integrations.google ?? {};
  const update = (patch: Partial<GoogleSettings>) =>
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, google: { ...google, ...patch } },
    });

  return (
    <SettingsPage title="Google" back="Users">
      <SettingsGroup
        note={
          <>
            Users sign in after linking Google in their{" "}
            <SettingsLink to="profile" className="settings-link">
              Profile
            </SettingsLink>
            . Google can&apos;t create accounts or change roles.
          </>
        }
      >
        <SettingsRow label="Enabled" htmlFor="users-google-enabled">
          <PillToggle
            id="users-google-enabled"
            checked={google.enabled === true}
            aria-label="Enabled"
            onChange={(event) => update({ enabled: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="OAuth client"
        note={
          <>
            Create one in{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="settings-link"
            >
              Google Cloud Console
            </a>{" "}
            and add the redirect URI below as an authorized redirect URI.
          </>
        }
      >
        <SettingsRow label="Client ID" htmlFor="users-google-client-id">
          <SettingsInput
            id="users-google-client-id"
            type="text"
            placeholder="123456789-abcdefg.apps.googleusercontent.com"
            autoComplete="off"
            value={google.clientId || ""}
            onChange={(event) => update({ clientId: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="Client secret" htmlFor="users-google-client-secret">
          <SettingsInput
            id="users-google-client-secret"
            type="password"
            autoComplete="off"
            value={google.clientSecret || ""}
            onChange={(event) => update({ clientSecret: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label="Redirect URI"
          htmlFor="users-google-redirect-uri"
          help={
            <>
              Usually <span className="settings-code">{googleCallbackUrl()}</span>
            </>
          }
        >
          <SettingsInput
            id="users-google-redirect-uri"
            type="url"
            placeholder="https://aurral.example.com/sso/google/callback"
            autoComplete="off"
            value={google.redirectUri || ""}
            onChange={(event) => update({ redirectUri: event.target.value })}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

function UsersGroup({ users }: { users: ReturnType<typeof useSettingsUsers> }) {
  const { bootstrap, user: me } = useAuth();
  const ssoEnabled = !!bootstrap?.oidcEnabled;

  return (
    <SettingsGroup
      title="Users"
      actions={
        <SettingsLink to="users/new" className="btn btn-secondary btn-sm">
          Add user
        </SettingsLink>
      }
    >
      {users.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading users…
        </p>
      ) : users.isError ? (
        <SettingsNote tone="warning">
          Couldn&apos;t load users.{" "}
          <button type="button" className="settings-link" onClick={() => users.refetch()}>
            Try again
          </button>
        </SettingsNote>
      ) : users.data.length === 0 ? (
        <p className="settings-group__note">No users yet.</p>
      ) : (
        users.data.map((user) => (
          <SettingsServiceRow
            key={user.id}
            to={user.id === me?.id ? "profile" : `users/${user.id}`}
            name={user.username}
            status={{ label: describeUser(user, ssoEnabled) }}
          />
        ))
      )}
    </SettingsGroup>
  );
}

function SignInGroup() {
  const { settings, updateSettings } = useServerSettings();
  const saveSecurity = useSaveSecurity();
  const google: GoogleSettings = settings.integrations.google ?? {};
  const plex = settings.integrations.plex;
  const plexConfigured = Boolean(plex.token && plex.url);

  return (
    <SettingsGroup title="Sign-in">
      <SettingsRow
        label="SSO-only"
        htmlFor="users-sso-only"
        help="Hide the password form behind a link when another sign-in method is on."
      >
        <PillToggle
          id="users-sso-only"
          checked={settings.security.ssoOnly === true}
          aria-label="SSO-only"
          onChange={(event) => void saveSecurity({ ssoOnly: event.target.checked })}
        />
      </SettingsRow>
      <SettingsServiceRow
        to="users/google"
        name="Google"
        status={providerStatus(
          google.enabled === true,
          Boolean(google.clientId && google.clientSecret && google.redirectUri),
        )}
      />
      <SettingsRow
        label="Sign in with Plex"
        htmlFor="users-plex-login"
        help={
          plexConfigured ? (
            "Users sign in after linking Plex in their Profile. Plex can't create accounts or change roles."
          ) : (
            <>
              Connect Plex in{" "}
              <SettingsLink to="playback/plex" className="settings-link">
                Playback
              </SettingsLink>{" "}
              first.
            </>
          )
        }
      >
        <PillToggle
          id="users-plex-login"
          checked={plex.loginEnabled === true}
          disabled={!plexConfigured}
          aria-label="Sign in with Plex"
          onChange={(event) =>
            updateSettings({
              ...settings,
              integrations: {
                ...settings.integrations,
                plex: { ...plex, loginEnabled: event.target.checked },
              },
            })
          }
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function AutoLoginGroup() {
  const { settings, health } = useServerSettings();
  const saveSecurity = useSaveSecurity();
  const { help, canToggle } = autoLoginState(health?.localNetworkBypass);

  return (
    <SettingsGroup title="Local network auto-login">
      <SettingsRow label="Auto-login" htmlFor="users-auto-login" help={help}>
        <PillToggle
          id="users-auto-login"
          checked={settings.security.localNetworkBypass.enabled === true}
          disabled={!canToggle}
          aria-label="Auto-login"
          onChange={(event) =>
            void saveSecurity({ localNetworkBypass: { enabled: event.target.checked } })
          }
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function UsersSection() {
  const item = useSettingsItem();
  const { user: me } = useAuth();
  const users = useSettingsUsers();

  if (item === "new") return <NewUserPage />;
  if (item === "google") return <GooglePage />;
  if (item && /^\d+$/.test(item)) {
    const user = users.data?.find((entry) => String(entry.id) === item && entry.id !== me?.id);
    if (user) return <EditUserPage key={user.id} user={user} />;
    if (users.isPending) {
      return (
        <SettingsPage title="User" back="Users">
          <p className="settings-loading">
            <DotLoader size="sm" label={null} /> Loading…
          </p>
        </SettingsPage>
      );
    }
  }

  return (
    <SettingsPage title="Users">
      <UsersGroup users={users} />
      <SignInGroup />
      <AutoLoginGroup />
    </SettingsPage>
  );
}
