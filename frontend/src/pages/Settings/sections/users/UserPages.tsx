import { useId, useState, type FormEvent, type ReactNode } from "react";
import PillToggle from "../../../../components/PillToggle";
import { DotLoader } from "../../../../components/DotLoader";
import { useAuth } from "../../../../contexts/AuthContext";
import { isReauthRequiredError, promptReauth } from "../../../../utils/reauth.ts";
import { AdminPlexLinkField } from "../../components/AdminPlexLinkField";
import { SettingsInput, SettingsSelect } from "../../components/SettingsField";
import { GRANULAR_PERMISSIONS, granularPerms } from "../../constants";
import {
  createUser,
  deleteUser,
  updateUser,
  useSettingsUsers,
  type SettingsUser,
} from "../../hooks/useSettingsUsers";
import { useServerSettings } from "../../SettingsProviders";
import { useSettingsRoute } from "../../settingsRoute";
import { readApiError } from "../../utils/apiError.ts";
import { SettingsActions, SettingsGroup, SettingsPage, SettingsRow } from "../../SettingsLayout";

type Permissions = typeof GRANULAR_PERMISSIONS;

const USER_STATUSES = {
  active: "Active",
  suspended: "Suspended",
  disabled: "Disabled",
} as const;

const isUserStatus = (value: string): value is keyof typeof USER_STATUSES =>
  Object.hasOwn(USER_STATUSES, value);

const canClaimBySso = (user: SettingsUser, ssoEnabled: boolean) =>
  ssoEnabled && user.needsIdentityMigration && !user.isProtected;

export function describeUser(user: SettingsUser, ssoEnabled: boolean) {
  return [
    user.role === "admin" ? "Admin" : "User",
    user.status === "active"
      ? null
      : isUserStatus(user.status)
        ? USER_STATUSES[user.status]
        : user.status,
    canClaimBySso(user, ssoEnabled)
      ? user.allowIdentityAdoption
        ? "Awaiting SSO claim"
        : "No SSO identity"
      : null,
    user.plexLink.lastError ? "Plex reconnect needed" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatListenHistory(user: SettingsUser) {
  if (!user.listenHistoryUsername && !user.listenHistoryUrl) return null;
  if (user.listenHistoryProvider === "koito") return `Koito: ${user.listenHistoryUrl}`;
  const provider = user.listenHistoryProvider === "listenbrainz" ? "ListenBrainz" : "Last.fm";
  return `${provider}: ${user.listenHistoryUsername}`;
}

function PermissionsGroup({
  permissions,
  onChange,
  children,
}: {
  permissions: Permissions;
  onChange: (permissions: Permissions) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <SettingsGroup title="Permissions">
      {granularPerms.map(({ key, label }) => (
        <SettingsRow key={key} label={label} htmlFor={`${id}-${key}`}>
          <PillToggle
            id={`${id}-${key}`}
            checked={permissions[key]}
            aria-label={label}
            onChange={(event) => onChange({ ...permissions, [key]: event.target.checked })}
          />
        </SettingsRow>
      ))}
      {children}
    </SettingsGroup>
  );
}

export function NewUserPage() {
  const formId = useId();
  const { health, fetchSettings, showSuccess, showError } = useServerSettings();
  const users = useSettingsUsers();
  const route = useSettingsRoute();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<Permissions>({ ...GRANULAR_PERMISSIONS });
  const [creating, setCreating] = useState(false);
  const ready = username.trim().length > 0 && password.length > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const disablesAutoLogin =
      health?.localNetworkBypass?.enabled === true && users.data?.length === 1;
    setCreating(true);
    try {
      await createUser({ username: username.trim(), password, role: "user", permissions });
      showSuccess(
        disablesAutoLogin ? "User created. Local-network auto-login was disabled." : "User created",
      );
      route.back();
      void fetchSettings();
    } catch (err) {
      const failure = readApiError(err);
      showError(failure.error || failure.text || "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  return (
    <SettingsPage title="Add user" back="Users">
      <form onSubmit={handleSubmit}>
        <SettingsGroup>
          <SettingsRow label="Username" htmlFor={`${formId}-username`}>
            <SettingsInput
              id={`${formId}-username`}
              type="text"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow label="Password" htmlFor={`${formId}-password`}>
            <SettingsInput
              id={`${formId}-password`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </SettingsRow>
        </SettingsGroup>
        <PermissionsGroup permissions={permissions} onChange={setPermissions}>
          <SettingsActions>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || creating}>
              {creating ? <DotLoader size="xs" label={null} /> : null}
              Create user
            </button>
          </SettingsActions>
        </PermissionsGroup>
      </form>
    </SettingsPage>
  );
}

export function EditUserPage({ user }: { user: SettingsUser }) {
  const formId = useId();
  const { bootstrap } = useAuth();
  const { fetchSettings, showSuccess, showError } = useServerSettings();
  const route = useSettingsRoute();
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<Permissions>(() => ({
    ...GRANULAR_PERMISSIONS,
    ...user.permissions,
  }));
  const [status, setStatus] = useState(user.status);
  const [allowAdoption, setAllowAdoption] = useState(user.allowIdentityAdoption);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const claimable = canClaimBySso(user, !!bootstrap?.oidcEnabled);
  const listenHistory = formatListenHistory(user);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const apply = () =>
      updateUser(user.id, {
        ...(password ? { password } : {}),
        permissions,
        status: isUserStatus(status) ? status : undefined,
        ...(claimable ? { allowIdentityAdoption: allowAdoption } : {}),
      });
    try {
      try {
        await apply();
      } catch (err) {
        if (!isReauthRequiredError(err) || !(await promptReauth())) throw err;
        await apply();
      }
      showSuccess("User updated");
      route.back();
      void fetchSettings();
    } catch (err) {
      if (!isReauthRequiredError(err)) {
        const failure = readApiError(err);
        showError(failure.error || failure.text || "Failed to update");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Permanently delete ${user.username}?`)) return;
    setDeleting(true);
    try {
      await deleteUser(user.id);
      showSuccess("User deleted");
      route.back();
      void fetchSettings();
    } catch (err) {
      showError(readApiError(err).error || "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SettingsPage title={user.username} back="Users">
      <form onSubmit={handleSubmit}>
        <SettingsGroup>
          <SettingsRow
            label="Role"
            help={user.roleSource === "oidc" ? "Set by your identity provider." : undefined}
          >
            <span className="settings-row__value">{user.role === "admin" ? "Admin" : "User"}</span>
          </SettingsRow>
          <SettingsRow
            label="Status"
            htmlFor={`${formId}-status`}
            help={
              status !== "active"
                ? "Suspended or disabled users can't sign in or run scheduled flows."
                : undefined
            }
          >
            <SettingsSelect
              id={`${formId}-status`}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {Object.entries(USER_STATUSES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow
            label="New password"
            htmlFor={`${formId}-password`}
            help="Leave blank to keep the current password."
          >
            <SettingsInput
              id={`${formId}-password`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </SettingsRow>
          {listenHistory ? (
            <SettingsRow label="Listening history">
              <span className="settings-row__value">{listenHistory}</span>
            </SettingsRow>
          ) : null}
          {claimable ? (
            <SettingsRow
              label="Claim by SSO sign-in"
              htmlFor={`${formId}-adoption`}
              help="The next matching SSO sign-in takes over this account and keeps its flows and history. Turn on only if you know who owns it."
            >
              <PillToggle
                id={`${formId}-adoption`}
                checked={allowAdoption}
                aria-label="Claim by SSO sign-in"
                onChange={(event) => setAllowAdoption(event.target.checked)}
              />
            </SettingsRow>
          ) : null}
        </SettingsGroup>
        <PermissionsGroup permissions={permissions} onChange={setPermissions}>
          <SettingsActions>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? <DotLoader size="xs" label={null} /> : null}
              Save
            </button>
          </SettingsActions>
        </PermissionsGroup>
        <AdminPlexLinkField user={user} />
        {user.role !== "admin" ? (
          <SettingsGroup>
            <SettingsActions>
              <button
                type="button"
                className="btn btn-ghost-danger btn-sm"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete user"}
              </button>
            </SettingsActions>
          </SettingsGroup>
        ) : null}
      </form>
    </SettingsPage>
  );
}
