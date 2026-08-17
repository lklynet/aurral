import { loginApi } from "../../../utils/api/endpoints/auth.js";
import { setStoredAuth } from "../../../utils/api/core.js";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";

import { createPortal } from "react-dom";
import { Lock, Trash2, UserPlus, X } from "lucide-react";
import { GRANULAR_PERMISSIONS, granularPerms } from "../constants";
import { useModalDialog } from "../../../hooks/useModalDialog.js";
import { AdminPlexLinkField } from "./AdminPlexLinkField";
import { PlexSelfLinkSection } from "./PlexSelfLinkSection";
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
        detail: "Local-network auto-login is only available while exactly one stored user exists.",
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
        detail: "Finish onboarding before enabling local-network auto-login.",
        canToggle: false,
      };
    default:
      return {
        title: "Unavailable",
        detail: "Local-network auto-login is not currently available for this installation.",
        canToggle: false,
      };
  }
}

function formatPlexLink(user) {
  const plexLink = user.plexLink;
  if (plexLink?.connected) {
    const label = plexLink.linkType === "managed" ? "Managed" : "Self";
    const summary = `${label}: ${plexLink.plexUsername || "unknown"}`;
    return plexLink.lastError ? `${summary} (reconnect needed)` : summary;
  }
  if (user.role === "admin") {
    const globalAccount = user.plexGlobalAccount;
    const ownsGlobalAccount =
      globalAccount?.configuredByUserId == null ||
      Number(globalAccount.configuredByUserId) === Number(user.id);
    if (globalAccount?.configured && ownsGlobalAccount) {
      return `Global: ${globalAccount.plexUsername || "unknown"}`;
    }
  }
  return "—";
}

function PermissionChecklist({ permissions, onChange }) {
  return (
    <div className="arr-permissions">
      {granularPerms.map(({ key, label }) => (
        <div key={key} className="settings-toggle-row">
          <span>{label}</span>
          <PillToggle
            className="settings-toggle"
            checked={!!permissions[key]}
            onChange={(event) =>
              onChange({
                ...permissions,
                [key]: event.target.checked,
              })
            }
            aria-label={label}
          />
        </div>
      ))}
    </div>
  );
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
  const localBypassEnabled = settings?.security?.localNetworkBypass?.enabled === true;
  const deleteDialog = useModalDialog({
    open: Boolean(deleteUserTarget),
    onClose: () => setDeleteUserTarget(null),
    closeDisabled: deletingUser,
  });
  const addDialog = useModalDialog({
    open: showAddUserModal,
    onClose: () => setShowAddUserModal(false),
    closeDisabled: creatingUser,
  });
  const editDialog = useModalDialog({
    open: Boolean(editUser),
    onClose: () => setEditUser(null),
    closeDisabled: savingEdit,
  });

  const openAddUserModal = () => {
    setNewUserUsername("");
    setNewUserPassword("");
    setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
    setShowAddUserModal(true);
  };

  return (
    <div className="arr-page">
      {authUser?.role !== "admin" ? (
        <SettingsArrFieldSet legend="Change password">
          <form
            className="arr-form"
            onSubmit={async (event) => {
              event.preventDefault();
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
                showError(err.response?.data?.error || err.message || "Failed to change password");
              } finally {
                setChangingPassword(false);
              }
            }}
          >
            <SettingsArrFormGroup label="Current password" labelFor="change-pw-current">
              <SettingsInput
                id="change-pw-current"
                type="password"
                placeholder="Current password"
                autoComplete="current-password"
                value={changePwCurrent}
                onChange={(event) => setChangePwCurrent(event.target.value)}
                required
              />
            </SettingsArrFormGroup>
            <SettingsArrFormGroup label="New password" labelFor="change-pw-new">
              <SettingsInput
                id="change-pw-new"
                type="password"
                placeholder="New password"
                autoComplete="new-password"
                value={changePwNew}
                onChange={(event) => setChangePwNew(event.target.value)}
                required
              />
            </SettingsArrFormGroup>
            <SettingsArrFormGroup label="Confirm password" labelFor="change-pw-confirm">
              <SettingsInput
                id="change-pw-confirm"
                type="password"
                placeholder="Confirm new password"
                autoComplete="new-password"
                value={changePwConfirm}
                onChange={(event) => setChangePwConfirm(event.target.value)}
                required
              />
            </SettingsArrFormGroup>
            <div className="arr-form-actions">
              <button
                type="submit"
                className="arr-btn arr-btn--primary"
                disabled={
                  changingPassword ||
                  !changePwCurrent ||
                  !changePwNew ||
                  changePwNew !== changePwConfirm
                }
              >
                {changingPassword ? "Changing…" : "Change password"}
              </button>
            </div>
          </form>
        </SettingsArrFieldSet>
      ) : (
        <>
          <SettingsArrFieldSet legend="Local network auto-login">
            <SettingsArrFormGroup
              label="Auto-login"
              help={`${localBypassStatus.title}. ${localBypassStatus.detail}`}
            >
              <div className="settings-toggle-row">
                <span>{localBypassEnabled ? "Enabled" : "Disabled"}</span>
                <PillToggle
                  className="settings-toggle"
                  checked={localBypassEnabled}
                  disabled={!localBypassStatus.canToggle}
                  onChange={async (event) => {
                    const nextSettings = {
                      ...settings,
                      security: {
                        ...(settings.security || {}),
                        localNetworkBypass: {
                          enabled: event.target.checked,
                        },
                      },
                    };
                    updateSettings(nextSettings);
                    try {
                      await handleSaveSettings(null, nextSettings);
                    } catch {}
                  }}
                  aria-label="Auto-login"
                />
              </div>
            </SettingsArrFormGroup>
          </SettingsArrFieldSet>

          <SettingsArrFieldSet
            legend="Users"
            actions={
              <button type="button" className="arr-btn arr-btn--primary" onClick={openAddUserModal}>
                <UserPlus className="artist-icon-xs" aria-hidden />
                Add user
              </button>
            }
          >
            <div className="arr-table-wrap">
              <table className="arr-table">
                <thead>
                  <tr>
                    <th scope="col">Username</th>
                    <th scope="col">Role</th>
                    <th scope="col">Plex</th>
                    <th scope="col" className="arr-table__actions-head">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loadingUsers ? (
                    <tr className="arr-table__empty-row">
                      <td colSpan={4}>Loading users…</td>
                    </tr>
                  ) : usersList.length === 0 ? (
                    <tr className="arr-table__empty-row">
                      <td colSpan={4}>No users configured.</td>
                    </tr>
                  ) : (
                    usersList.map((user) => (
                      <tr key={user.id}>
                        <td>{user.username}</td>
                        <td>
                          <span
                            className={`arr-badge${
                              user.role === "admin" ? " arr-badge--admin" : ""
                            }`}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td>
                          <span className="arr-table__path">{formatPlexLink(user)}</span>
                        </td>
                        <td className="arr-table__actions">
                          <div className="arr-table__actions-inner">
                            <button
                              type="button"
                              className="arr-btn arr-btn--ghost arr-btn--icon"
                              aria-label={`Manage ${user.username}`}
                              onClick={() => {
                                setEditUser(user);
                                setEditPassword("");
                                setEditCurrentPassword("");
                                setEditPermissions(
                                  user.permissions
                                    ? {
                                        ...GRANULAR_PERMISSIONS,
                                        ...user.permissions,
                                      }
                                    : { ...GRANULAR_PERMISSIONS },
                                );
                              }}
                            >
                              <Lock className="artist-icon-sm" aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="arr-btn arr-btn--ghost arr-btn--icon"
                              aria-label={`Delete ${user.username}`}
                              disabled={user.role === "admin"}
                              onClick={() => user.role !== "admin" && setDeleteUserTarget(user)}
                            >
                              <Trash2 className="artist-icon-sm" aria-hidden />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SettingsArrFieldSet>

          {deleteUserTarget
            ? createPortal(
                <div className="arr-portal">
                  <div
                    className="arr-modal-backdrop"
                    onClick={deleteDialog.handleBackdropClick}
                  >
                    <div
                      ref={deleteDialog.dialogRef}
                      className="arr-modal"
                      role="alertdialog"
                      aria-modal="true"
                      aria-labelledby="delete-user-modal-title"
                      tabIndex={-1}
                    >
                      <div className="arr-modal__header">
                        <h3 id="delete-user-modal-title" className="arr-modal__title">
                          Delete user
                        </h3>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          onClick={() => !deletingUser && setDeleteUserTarget(null)}
                          aria-label="Close"
                          disabled={deletingUser}
                        >
                          <X className="artist-icon-md" />
                        </button>
                      </div>
                      <div className="arr-modal__body">
                        <p className="arr-modal__copy">
                          Are you sure you want to delete{" "}
                          <strong>{deleteUserTarget.username}</strong>? This cannot be undone.
                        </p>
                      </div>
                      <div className="arr-modal__footer">
                        <button
                          type="button"
                          className="arr-btn"
                          onClick={() => !deletingUser && setDeleteUserTarget(null)}
                          disabled={deletingUser}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="arr-btn arr-btn--primary"
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
                              showError(err.response?.data?.error || "Failed to delete");
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
                </div>,
                document.body,
              )
            : null}

          {showAddUserModal
            ? createPortal(
                <div className="arr-portal">
                  <div className="arr-modal-backdrop" onClick={addDialog.handleBackdropClick}>
                    <div
                      ref={addDialog.dialogRef}
                      className="arr-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="add-user-modal-title"
                      tabIndex={-1}
                    >
                      <div className="arr-modal__header">
                        <h3 id="add-user-modal-title" className="arr-modal__title">
                          Add user
                        </h3>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          onClick={() => setShowAddUserModal(false)}
                          aria-label="Close"
                        >
                          <X className="artist-icon-md" />
                        </button>
                      </div>
                      <form
                        onSubmit={async (event) => {
                          event.preventDefault();
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
                              newUserPermissions,
                            );
                            showSuccess(
                              shouldWarnLocalBypass
                                ? "User created. Local-network auto-login was disabled."
                                : "User created",
                            );
                            setShowAddUserModal(false);
                            setNewUserUsername("");
                            setNewUserPassword("");
                            setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
                            await refreshUsers();
                            await refreshSettingsData();
                          } catch (err) {
                            showError(
                              err.response?.data?.error || err.message || "Failed to create user",
                            );
                          } finally {
                            setCreatingUser(false);
                          }
                        }}
                      >
                        <div className="arr-modal__body">
                          <SettingsArrFormGroup label="Username" labelFor="add-user-username">
                            <SettingsInput
                              id="add-user-username"
                              type="text"
                              placeholder="Username"
                              autoComplete="off"
                              value={newUserUsername}
                              onChange={(event) => setNewUserUsername(event.target.value)}
                            />
                          </SettingsArrFormGroup>
                          <SettingsArrFormGroup label="Password" labelFor="add-user-password">
                            <SettingsInput
                              id="add-user-password"
                              type="password"
                              placeholder="Password"
                              autoComplete="new-password"
                              value={newUserPassword}
                              onChange={(event) => setNewUserPassword(event.target.value)}
                            />
                          </SettingsArrFormGroup>
                          <SettingsArrFormGroup label="Permissions" size="large">
                            <PermissionChecklist
                              permissions={newUserPermissions}
                              onChange={setNewUserPermissions}
                            />
                          </SettingsArrFormGroup>
                        </div>
                        <div className="arr-modal__footer">
                          <button
                            type="button"
                            className="arr-btn"
                            onClick={() => setShowAddUserModal(false)}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="arr-btn arr-btn--primary"
                            disabled={creatingUser}
                          >
                            {creatingUser ? "Creating…" : "Create user"}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>,
                document.body,
              )
            : null}

          {editUser
            ? createPortal(
                <div className="arr-portal">
                  <div className="arr-modal-backdrop" onClick={editDialog.handleBackdropClick}>
                    <div
                      ref={editDialog.dialogRef}
                      className="arr-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="edit-user-modal-title"
                      tabIndex={-1}
                    >
                      <div className="arr-modal__header">
                        <h3 id="edit-user-modal-title" className="arr-modal__title">
                          Manage {editUser.username}
                        </h3>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          onClick={() => setEditUser(null)}
                          aria-label="Close"
                        >
                          <X className="artist-icon-md" />
                        </button>
                      </div>
                      <form
                        onSubmit={async (event) => {
                          event.preventDefault();
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
                                err.response?.data?.error || err.message || "Failed to update",
                              );
                            } finally {
                              setSavingEdit(false);
                            }
                            return;
                          }
                          setSavingEdit(true);
                          try {
                            await updateUser(editUser.id, {
                              ...(editPassword ? { password: editPassword } : {}),
                              permissions: editPermissions,
                            });
                            showSuccess("User updated");
                            setEditUser(null);
                            await refreshUsers();
                            await refreshSettingsData();
                          } catch (err) {
                            showError(
                              err.response?.data?.error || err.message || "Failed to update",
                            );
                          } finally {
                            setSavingEdit(false);
                          }
                        }}
                      >
                        <div className="arr-modal__body">
                          {isSelfEdit ? (
                            <>
                              <SettingsArrFormGroup
                                label="Current password"
                                labelFor="edit-current-password"
                              >
                                <SettingsInput
                                  id="edit-current-password"
                                  type="password"
                                  placeholder="Current password"
                                  autoComplete="current-password"
                                  value={editCurrentPassword}
                                  onChange={(event) => setEditCurrentPassword(event.target.value)}
                                />
                              </SettingsArrFormGroup>
                              <SettingsArrFormGroup
                                label="New password"
                                labelFor="edit-new-password"
                              >
                                <SettingsInput
                                  id="edit-new-password"
                                  type="password"
                                  placeholder="New password"
                                  autoComplete="new-password"
                                  value={editPassword}
                                  onChange={(event) => setEditPassword(event.target.value)}
                                />
                              </SettingsArrFormGroup>
                              <PlexSelfLinkSection showSuccess={showSuccess} showError={showError} />
                            </>
                          ) : (
                            <>
                              <SettingsArrFormGroup
                                label="Password"
                                labelFor="edit-user-password"
                                help="Leave blank to keep the current password."
                              >
                                <SettingsInput
                                  id="edit-user-password"
                                  type="password"
                                  placeholder="New password"
                                  autoComplete="new-password"
                                  value={editPassword}
                                  onChange={(event) => setEditPassword(event.target.value)}
                                />
                              </SettingsArrFormGroup>
                              <SettingsArrFormGroup label="Permissions" size="large">
                                <PermissionChecklist
                                  permissions={editPermissions}
                                  onChange={setEditPermissions}
                                />
                              </SettingsArrFormGroup>
                              <SettingsArrFormGroup
                                label="Plex account"
                                help="Link this user to a Plex Home managed user so their flow and playlists are created under that Plex account."
                              >
                                <AdminPlexLinkField
                                  user={editUser}
                                  showSuccess={showSuccess}
                                  showError={showError}
                                  onChanged={async () => {
                                    const nextUsers = await refreshUsers();
                                    const updated = nextUsers.find((u) => u.id === editUser.id);
                                    if (updated) setEditUser(updated);
                                  }}
                                />
                              </SettingsArrFormGroup>
                            </>
                          )}
                        </div>
                        <div className="arr-modal__footer">
                          <button
                            type="button"
                            className="arr-btn"
                            onClick={() => setEditUser(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="arr-btn arr-btn--primary"
                            disabled={savingEdit}
                          >
                            {savingEdit ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>,
                document.body,
              )
            : null}
        </>
      )}
    </div>
  );
}
