import { UserPlus, Lock, Trash2, X } from "lucide-react";
import { GRANULAR_PERMISSIONS, granularPerms } from "../constants";
import { loginApi, setStoredAuth } from "../../../utils/api";
import { SettingsInput } from "./SettingsField";

function getLocalBypassStatus(status) {
  if (!status) {
    return {
      title: "Unavailable: status unknown",
      detail: "Aurral could not load the current local-network auto-login status.",
      canToggle: false,
    };
  }
  if (status.active) {
    return {
      title: "Active for this device",
      detail:
        "This device is currently being auto-signed in as the sole admin from the trusted local subnet.",
      canToggle: true,
    };
  }
  if (status.enabled) {
    return {
      title: "Enabled",
      detail:
        "Auto-login is enabled for the sole admin user. It will only activate from the server's trusted local subnet.",
      canToggle: true,
    };
  }
  switch (status.reason) {
    case "disabled":
      return {
        title: "Disabled",
        detail:
          "Automatically sign in as the sole admin user when accessing Aurral from this server's local subnet. If additional users are added, this setting turns off automatically.",
        canToggle: true,
      };
    case "not_single_user":
      return {
        title: "Unavailable: more than one user exists",
        detail:
          "Local-network auto-login is only available while exactly one stored user exists.",
        canToggle: false,
      };
    case "sole_user_not_admin":
      return {
        title: "Unavailable: sole user is not admin",
        detail:
          "The only stored user must have the admin role before local-network auto-login can be enabled.",
        canToggle: false,
      };
    case "not_trusted_network":
      return {
        title: "Unavailable: local subnet could not be determined",
        detail:
          "Aurral could not infer a single trusted IPv4 local subnet for this server, so local-network auto-login stays disabled.",
        canToggle: false,
      };
    case "not_onboarded":
      return {
        title: "Unavailable: onboarding incomplete",
        detail:
          "Finish onboarding before enabling local-network auto-login.",
        canToggle: false,
      };
    default:
      return {
        title: "Unavailable",
        detail:
          "Local-network auto-login is not currently available for this installation.",
        canToggle: false,
      };
  }
}

export function SettingsUsersTab({
  authUser,
  usersList,
  loadingUsers,
  newUserUsername,
  setNewUserUsername,
  newUserPassword,
  setNewUserPassword,
  newUserPermissions,
  setNewUserPermissions,
  creatingUser,
  setCreatingUser,
  showAddUserModal,
  setShowAddUserModal,
  editUser,
  setEditUser,
  editPassword,
  setEditPassword,
  editCurrentPassword,
  setEditCurrentPassword,
  editPermissions,
  setEditPermissions,
  savingEdit,
  setSavingEdit,
  changePwCurrent,
  setChangePwCurrent,
  changePwNew,
  setChangePwNew,
  changePwConfirm,
  setChangePwConfirm,
  changingPassword,
  setChangingPassword,
  deleteUserTarget,
  setDeleteUserTarget,
  deletingUser,
  setDeletingUser,
  refreshUsers,
  createUser,
  updateUser,
  deleteUser,
  changeMyPassword,
  settings,
  updateSettings,
  handleSaveSettings,
  health,
  refreshSettingsData,
  showSuccess,
  showError,
}) {
  const isSelfEdit = editUser && editUser.id === authUser?.id;
  const localBypassStatus = getLocalBypassStatus(health?.localNetworkBypass);
  const localBypassEnabled =
    settings?.security?.localNetworkBypass?.enabled === true;

  return (
    <div className="settings-page__panel">
      <div className="settings-page__panel-header">
        <h2 className="settings-page__panel-title">Users</h2>
        {authUser?.role === "admin" && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setNewUserUsername("");
              setNewUserPassword("");
              setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
              setShowAddUserModal(true);
            }}
          >
            <UserPlus className="artist-icon-xs" />
            Add user
          </button>
        )}
      </div>

      {authUser?.role !== "admin" ? (
        <div
          className="settings-page__section settings-page__section--narrow"
        >
          <h3 className="settings-page__section-title">
            <Lock className="settings-page__panel-title-icon" />
            Change my password
          </h3>
          <form
            className="settings-page__fields"
            onSubmit={async (e) => {
              e.preventDefault();
              if (changePwNew !== changePwConfirm) {
                showError("New passwords do not match");
                return;
              }
              setChangingPassword(true);
              try {
                await changeMyPassword(changePwCurrent, changePwNew);
                const result = await loginApi(authUser?.username, changePwNew);
                if (result?.token) {
                  setStoredAuth({ token: result.token });
                }
                showSuccess("Password changed");
                setChangePwCurrent("");
                setChangePwNew("");
                setChangePwConfirm("");
              } catch (err) {
                showError(
                  err.response?.data?.error ||
                    err.message ||
                    "Failed to change password"
                );
              } finally {
                setChangingPassword(false);
              }
            }}
          >
            <div className="settings-page__field-stack">
              <label htmlFor="change-pw-current" className="label">
                Current password
              </label>
              <SettingsInput id="change-pw-current"
                type="password"

                placeholder="Current password"
                autoComplete="current-password"
                value={changePwCurrent}
                onChange={(e) => setChangePwCurrent(e.target.value)}
                required
              />
            </div>
            <div className="settings-page__field-stack">
              <label htmlFor="change-pw-new" className="label">
                New password
              </label>
              <SettingsInput id="change-pw-new"
                type="password"

                placeholder="New password"
                autoComplete="new-password"
                value={changePwNew}
                onChange={(e) => setChangePwNew(e.target.value)}
                required
              />
            </div>
            <div className="settings-page__field-stack">
              <label htmlFor="change-pw-confirm" className="label">
                Confirm new password
              </label>
              <SettingsInput id="change-pw-confirm"
                type="password"

                placeholder="Confirm new password"
                autoComplete="new-password"
                value={changePwConfirm}
                onChange={(e) => setChangePwConfirm(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                changingPassword ||
                !changePwCurrent ||
                !changePwNew ||
                changePwNew !== changePwConfirm
              }
            >
              {changingPassword ? "Changing…" : "Change password"}
            </button>
          </form>
        </div>
      ) : (
        <>
          <div
            className="settings-page__section"
          >
            <div className="settings-page__toggle-row">
              <div className="settings-page__toggle-copy">
                <h3 className="settings-page__section-title">
                  Auto-login from local network
                </h3>
                <p className="settings-page__hint">
                  {localBypassStatus.title}
                </p>
              </div>
              <label className="artist-checkbox-label">
                <span className="settings-page__hint">
                  {localBypassEnabled ? "On" : "Off"}
                </span>
                <input
                  type="checkbox"
                  className="artist-checkbox"
                  checked={localBypassEnabled}
                  disabled={!localBypassStatus.canToggle}
                  onChange={async (e) => {
                    const nextSettings = {
                      ...settings,
                      security: {
                        ...(settings.security || {}),
                        localNetworkBypass: {
                          enabled: e.target.checked,
                        },
                      },
                    };
                    updateSettings(nextSettings);
                    try {
                      await handleSaveSettings(null, nextSettings);
                    } catch {
                      // handleSaveSettings already reports failure and resets local state.
                    }
                  }}
                />
              </label>
            </div>
            <p className="settings-page__toggle-detail">
              {localBypassStatus.detail}
            </p>
          </div>

          <div className="settings-page__users-list">
            {loadingUsers ? (
              <div className="settings-page__loading">Loading…</div>
            ) : (
              <ul>
                {usersList.map((u) => (
                  <li
                    key={u.id}
                    className="settings-page__user-row"
                  >
                    <div className="settings-page__user-main">
                      <span className="settings-page__user-name">
                        {u.username}
                      </span>
                      <span className="badge badge-primary settings-page__role-badge">
                        {u.role}
                      </span>
                      {(u.listenHistoryUsername || u.listenHistoryUrl) && (
                        <span
                          className="settings-page__user-meta"
                          title={
                            u.listenHistoryProvider === "koito"
                              ? `Koito: ${u.listenHistoryUrl}`
                              : `${
                                  u.listenHistoryProvider === "listenbrainz"
                                    ? "ListenBrainz"
                                    : "Last.fm"
                                }: ${u.listenHistoryUsername}`
                          }
                        >
                          {u.listenHistoryProvider === "koito"
                            ? "Koito"
                            : u.listenHistoryProvider === "listenbrainz"
                              ? "ListenBrainz"
                              : "Last.fm"}
                          :{" "}
                          {u.listenHistoryProvider === "koito"
                            ? u.listenHistoryUrl
                            : u.listenHistoryUsername}
                        </span>
                      )}
                    </div>
                    <div className="settings-page__user-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setEditUser(u);
                          setEditPassword("");
                          setEditCurrentPassword("");
                          setEditPermissions(
                            u.permissions
                              ? {
                                  ...GRANULAR_PERMISSIONS,
                                  ...u.permissions,
                                }
                              : { ...GRANULAR_PERMISSIONS }
                          );
                        }}
                      >
                        <Lock className="artist-icon-sm" />
                        Manage
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost-danger"
                        disabled={u.role === "admin"}
                        onClick={() =>
                          u.role !== "admin" && setDeleteUserTarget(u)
                        }
                      >
                        <Trash2 className="artist-icon-sm" />
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {deleteUserTarget && (
            <div
              className="artist-modal-backdrop"
              onClick={() => !deletingUser && setDeleteUserTarget(null)}
            >
              <div
                className="settings-page__modal"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="settings-page__modal-header">
                  <h3 className="settings-page__modal-title">
                    Delete user
                  </h3>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-square"
                    onClick={() =>
                      !deletingUser && setDeleteUserTarget(null)
                    }
                    aria-label="Close"
                    disabled={deletingUser}
                  >
                    <X className="artist-icon-md" />
                  </button>
                </div>
                <p className="settings-page__modal-copy">
                  Are you sure you want to delete{" "}
                  <span className="settings-page__meta-value">
                    {deleteUserTarget.username}
                  </span>
                  ? This cannot be undone.
                </p>
                <div
                  className="settings-page__modal-actions"
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      !deletingUser && setDeleteUserTarget(null)
                    }
                    disabled={deletingUser}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={deletingUser}
                    onClick={async () => {
                      setDeletingUser(true);
                      try {
                        await deleteUser(deleteUserTarget.id);
                        showSuccess("User deleted");
                        setDeleteUserTarget(null);
                        await refreshUsers();
                        await refreshSettingsData();
                      } catch (err) {
                        showError(
                          err.response?.data?.error || "Failed to delete"
                        );
                      } finally {
                        setDeletingUser(false);
                      }
                    }}
                  >
                    {deletingUser ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showAddUserModal && (
            <div
              className="artist-modal-backdrop"
              onClick={() => setShowAddUserModal(false)}
            >
              <div
                className="settings-page__modal settings-page__modal--wide"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="settings-page__panel-header">
                  <h3 className="settings-page__modal-title">
                    Add user
                  </h3>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-square"
                    onClick={() => setShowAddUserModal(false)}
                    aria-label="Close"
                  >
                    <X className="artist-icon-md" />
                  </button>
                </div>
                <form
                  className="settings-page__form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newUserUsername.trim() || !newUserPassword) {
                      showError("Username and password required");
                      return;
                    }
                    setCreatingUser(true);
                    try {
                      const shouldWarnLocalBypass =
                        health?.localNetworkBypass?.enabled === true &&
                        usersList.length === 1;
                      await createUser(
                        newUserUsername.trim(),
                        newUserPassword,
                        "user",
                        newUserPermissions
                      );
                      showSuccess(
                        shouldWarnLocalBypass
                          ? "User created. Local-network auto-login was disabled."
                          : "User created"
                      );
                      setShowAddUserModal(false);
                      setNewUserUsername("");
                      setNewUserPassword("");
                      setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
                      await refreshUsers();
                      await refreshSettingsData();
                    } catch (err) {
                      showError(
                        err.response?.data?.error ||
                          err.message ||
                          "Failed to create user"
                      );
                    } finally {
                      setCreatingUser(false);
                    }
                  }}
                >
                  <div className="settings-page__fields">
                    <label className="settings-page__section-label">
                      Account
                    </label>
                    <div className="settings-page__two-col-grid">
                      <div className="settings-page__field-stack">
                        <label
                          htmlFor="add-user-username"
                          className="artist-field-label"
                        >
                          Username
                        </label>
                        <SettingsInput id="add-user-username"
                          type="text"

                          placeholder="Username"
                          autoComplete="off"
                          value={newUserUsername}
                          onChange={(e) =>
                            setNewUserUsername(e.target.value)
                          }
                        />
                      </div>
                      <div className="settings-page__field-stack">
                        <label
                          htmlFor="add-user-password"
                          className="artist-field-label"
                        >
                          Password
                        </label>
                        <SettingsInput id="add-user-password"
                          type="password"

                          placeholder="Password"
                          autoComplete="new-password"
                          value={newUserPassword}
                          onChange={(e) =>
                            setNewUserPassword(e.target.value)
                          }
                        />
                      </div>
                    </div>
                  </div>
                  <div className="settings-page__field-stack--md">
                    <label className="settings-page__section-label">
                      Permissions
                    </label>
                    <div
                      className="settings-page__permissions"
                    >
                      {granularPerms.map(({ key, label }) => (
                        <label
                          key={key}
                          className="artist-checkbox-label"
                        >
                          <input
                            type="checkbox"
                            className="artist-checkbox"
                            checked={!!newUserPermissions[key]}
                            onChange={(e) =>
                              setNewUserPermissions((p) => ({
                                ...p,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                          <span className="settings-page__muted-copy">{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div
                    className="settings-page__modal-actions"
                  >
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowAddUserModal(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={creatingUser}
                    >
                      {creatingUser ? "Creating…" : "Create user"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {editUser && (
            <div
              className="artist-modal-backdrop"
              onClick={() => setEditUser(null)}
            >
              <div
                className="settings-page__modal settings-page__modal--wide"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="settings-page__panel-header">
                  <h3 className="settings-page__modal-title">
                    Manage {editUser.username}
                  </h3>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-square"
                    onClick={() => setEditUser(null)}
                    aria-label="Close"
                  >
                    <X className="artist-icon-md" />
                  </button>
                </div>
                <form
                  className="settings-page__form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (isSelfEdit) {
                      if (!editPassword) {
                        setEditUser(null);
                        return;
                      }
                      if (!editCurrentPassword) {
                        showError("Current password required");
                        return;
                      }
                      setSavingEdit(true);
                      try {
                        await updateUser(editUser.id, {
                          currentPassword: editCurrentPassword,
                          password: editPassword,
                        });
                        const result = await loginApi(authUser?.username, editPassword);
                        if (result?.token) {
                          setStoredAuth({ token: result.token });
                        }
                        showSuccess("Password changed");
                        setEditUser(null);
                      } catch (err) {
                        showError(
                          err.response?.data?.error ||
                            err.message ||
                            "Failed to update"
                        );
                      } finally {
                        setSavingEdit(false);
                      }
                      return;
                    }
                    setSavingEdit(true);
                    try {
                      await updateUser(editUser.id, {
                        ...(editPassword
                          ? { password: editPassword }
                          : {}),
                        permissions: editPermissions,
                      });
                      showSuccess("User updated");
                      setEditUser(null);
                      await refreshUsers();
                      await refreshSettingsData();
                    } catch (err) {
                      showError(
                        err.response?.data?.error ||
                          err.message ||
                          "Failed to update"
                      );
                    } finally {
                      setSavingEdit(false);
                    }
                  }}
                >
                  <div className="settings-page__fields">
                    <label className="settings-page__section-label">
                      {isSelfEdit
                        ? "Change password"
                        : "Password (optional)"}
                    </label>
                    {isSelfEdit ? (
                      <div className="settings-page__field-stack--md">
                        <div className="settings-page__field-stack">
                          <label
                            htmlFor="edit-current-password"
                            className="artist-field-label"
                          >
                            Current password
                          </label>
                          <SettingsInput id="edit-current-password"
                            type="password"

                            placeholder="Current password"
                            autoComplete="current-password"
                            value={editCurrentPassword}
                            onChange={(e) =>
                              setEditCurrentPassword(e.target.value)
                            }
                          />
                        </div>
                        <div className="settings-page__field-stack">
                          <label
                            htmlFor="edit-new-password"
                            className="artist-field-label"
                          >
                            New password
                          </label>
                          <SettingsInput id="edit-new-password"
                            type="password"

                            placeholder="New password"
                            autoComplete="new-password"
                            value={editPassword}
                            onChange={(e) =>
                              setEditPassword(e.target.value)
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <SettingsInput type="password"

                        placeholder="Leave blank to keep current password"
                        autoComplete="new-password"
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                      />
                    )}
                  </div>
                  {!isSelfEdit && (
                    <div className="settings-page__field-stack--md">
                      <label className="settings-page__section-label">
                        Permissions
                      </label>
                      <div
                        className="settings-page__permissions"
                      >
                        {granularPerms.map(({ key, label }) => (
                          <label
                            key={key}
                            className="artist-checkbox-label"
                          >
                            <input
                              type="checkbox"
                              className="artist-checkbox"
                              checked={!!editPermissions[key]}
                              onChange={(e) =>
                                setEditPermissions((p) => ({
                                  ...p,
                                  [key]: e.target.checked,
                                }))
                              }
                            />
                            <span className="settings-page__muted-copy">{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div
                    className="settings-page__modal-actions"
                  >
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setEditUser(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={savingEdit}
                    >
                      {savingEdit ? "Saving…" : "Save"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
