import { useEffect, useId, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { setStoredAuth } from "../../../utils/api/core.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { logIn } from "../../../utils/session.ts";
import { DotLoader } from "../../../components/DotLoader";
import { ConnectedAccountsSection, useMyIdentities } from "../components/ConnectedAccountsSection";
import { PlexSelfLinkSection } from "../components/PlexSelfLinkSection";
import { SettingsInput } from "../components/SettingsField";
import { Select } from "../../../components/Select";
import { readApiError } from "../utils/apiError.ts";
import { useAccountSettingsContext } from "../SettingsProviders";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../SettingsLayout";

const CONNECTED_LABELS: Partial<Record<string, string>> = {
  google: "Google",
  oidc: "single sign-on",
};

function useConnectedNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const { showSuccess } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const provider = params.get("connected");
    if (!provider) return;
    showSuccess(`Connected your ${CONNECTED_LABELS[provider] || provider} account.`);
    params.delete("connected");
    navigate(
      { pathname: location.pathname, search: `?${params}`, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate, showSuccess]);
}

function PasswordGroup() {
  const formId = useId();
  const { user, logout } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const identities = useMyIdentities();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  if (identities.isPending) return null;

  const hasLocalPassword = identities.data?.hasLocalPassword !== false;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const ready =
    newPassword.length > 0 &&
    newPassword === confirmPassword &&
    (!hasLocalPassword || currentPassword.length > 0);

  const save = async () => {
    await parseResponse(
      usersClient.me.password.$post({
        json: { currentPassword: hasLocalPassword ? currentPassword : undefined, newPassword },
      }),
    );
    const session = await logIn(user?.username, newPassword);
    if (session?.token) setStoredAuth({ token: session.token });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      try {
        await save();
      } catch (err) {
        if (!isReauthRequiredError(err)) throw err;
        if (!hasLocalPassword) {
          setNeedsSignIn(true);
          return;
        }
        if (!(await promptReauth())) return;
        await save();
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      showSuccess(hasLocalPassword ? "Password changed" : "Password set");
      await queryClient.invalidateQueries({ queryKey: queryKeys.myIdentities(user?.id) });
    } catch (err) {
      const failure = readApiError(err);
      showError(failure.error || failure.message || failure.text || "Couldn't save your password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Password"
      note={
        hasLocalPassword
          ? undefined
          : "You sign in with a connected account. A password lets you sign in without it."
      }
    >
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user?.username ?? ""}
          readOnly
          hidden
        />
        {hasLocalPassword ? (
          <SettingsRow label="Current password" htmlFor={`${formId}-current`}>
            <SettingsInput
              id={`${formId}-current`}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          label="New password"
          htmlFor={`${formId}-new`}
          help="Subsonic apps use this password too."
        >
          <SettingsInput
            id={`${formId}-new`}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Confirm password"
          htmlFor={`${formId}-confirm`}
          help={mismatch ? "Passwords don't match." : undefined}
          tone="error"
        >
          <SettingsInput
            id={`${formId}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </SettingsRow>
        {needsSignIn ? (
          <SettingsNote tone="warning">
            Sign in again to set a password.{" "}
            <button type="button" className="settings-link" onClick={() => logout()}>
              Sign in again
            </button>
          </SettingsNote>
        ) : null}
        <SettingsActions>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || saving}>
            {saving ? <DotLoader size="xs" label={null} /> : null}
            {hasLocalPassword ? "Change password" : "Set password"}
          </button>
          <span className="settings-group__note">This signs you out on your other devices.</span>
        </SettingsActions>
      </form>
    </SettingsGroup>
  );
}

function LidarrDefaultsGroup() {
  const account = useAccountSettingsContext();
  return (
    <SettingsGroup
      title="Lidarr defaults"
      note="Used for artists you add. These override the server defaults."
    >
      <SettingsRow label="Root folder" htmlFor="profile-root-folder">
        <Select
          id="profile-root-folder"
          value={account.lidarrRootFolderPath}
          onChange={account.setLidarrRootFolderPath}
          options={[
            { value: "", label: "Server default" },
            ...account.lidarrRootFolders.map((folder) => ({
              value: folder.path,
              label: folder.path,
            })),
          ]}
        />
      </SettingsRow>
      <SettingsRow label="Quality profile" htmlFor="profile-quality-profile">
        <Select
          id="profile-quality-profile"
          value={account.lidarrQualityProfileId}
          onChange={account.setLidarrQualityProfileId}
          options={[
            { value: "", label: "Server default" },
            ...account.lidarrQualityProfiles.map((profile) => ({
              value: String(profile.id),
              label: profile.name,
            })),
          ]}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function ProfileSection() {
  const { user } = useAuth();
  const account = useAccountSettingsContext();
  useConnectedNotice();

  return (
    <SettingsPage title="Profile">
      {user?.username ? (
        <SettingsGroup>
          <SettingsRow label="Username">
            <span className="settings-row__value">{user.username}</span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {user?.id != null ? (
        <>
          <PasswordGroup />
          <ConnectedAccountsSection />
          <PlexSelfLinkSection />
        </>
      ) : null}
      {account.lidarrConfigured ? <LidarrDefaultsGroup /> : null}
    </SettingsPage>
  );
}
