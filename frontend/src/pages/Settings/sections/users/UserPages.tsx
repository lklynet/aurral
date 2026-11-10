import { useId, useState, type FormEvent, type ReactNode } from "react";
import PillToggle from "../../../../components/PillToggle";
import { DotLoader } from "../../../../components/DotLoader";
import { isReauthRequiredError, promptReauth } from "../../../../utils/reauth.ts";
import { SettingsInput } from "../../components/SettingsField";
import { Select } from "../../../../components/Select";
import { GRANULAR_PERMISSIONS, granularPerms } from "../../constants";
import {
  createUser,
  deleteUser,
  updateUser,
  useSettingsUsers,
  type SettingsUser,
} from "../../hooks/useSettingsUsers";
import { useServerSettings } from "../../SettingsProviders";
import { useSettingsRoute } from "../../../../navigation/settingsRoute";
import { SettingsActions, SettingsGroup, SettingsPage, SettingsRow } from "../../SettingsLayout";
import { readApiError } from "../../../../utils/api/errors.ts";

type Permissions = typeof GRANULAR_PERMISSIONS;

const USER_STATUSES = {
  active: "Active",
  suspended: "Suspended",
  disabled: "Disabled",
} as const;

const isUserStatus = (value: string): value is keyof typeof USER_STATUSES =>
  Object.hasOwn(USER_STATUSES, value);

export function describeUser(user: SettingsUser) {
  return [
    user.role === "admin" ? "Admin" : "User",
    user.status === "active"
      ? null
      : isUserStatus(user.status)
        ? USER_STATUSES[user.status]
        : user.status,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatListenHistory({ listenHistory: { lastfm, listenbrainz, koito } }: SettingsUser) {
  return (
    [
      lastfm ? `Last.fm: ${lastfm}` : null,
      listenbrainz ? `ListenBrainz: ${listenbrainz}` : null,
      koito ? `Koito: ${koito}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

export function PermissionsGroup({
  title = "Permissions",
  note,
  permissions,
  onChange,
  children,
}: {
  title?: string;
  note?: ReactNode;
  permissions: Permissions;
  onChange: (permissions: Permissions) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <SettingsGroup title={title} note={note}>
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
  const { settings, health, fetchSettings, showSuccess, showError } = useServerSettings();
  const users = useSettingsUsers();
  const route = useSettingsRoute();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<Permissions>(() => ({
    ...GRANULAR_PERMISSIONS,
    ...settings.security.defaultPermissions,
  }));
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
  const { fetchSettings, showSuccess, showError } = useServerSettings();
  const route = useSettingsRoute();
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<Permissions>(() => ({
    ...GRANULAR_PERMISSIONS,
    ...user.permissions,
  }));
  const [status, setStatus] = useState(user.status);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const listenHistory = formatListenHistory(user);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const apply = () =>
      updateUser(user.id, {
        ...(password && { password }),
        permissions,
        status: isUserStatus(status) ? status : undefined,
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
            <Select
              id={`${formId}-status`}
              value={status}
              onChange={setStatus}
              options={Object.entries(USER_STATUSES).map(([value, label]) => ({ value, label }))}
            />
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
        </SettingsGroup>
        <PermissionsGroup permissions={permissions} onChange={setPermissions}>
          <SettingsActions>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? <DotLoader size="xs" label={null} /> : null}
              Save
            </button>
          </SettingsActions>
        </PermissionsGroup>
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
