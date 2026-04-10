import { UserPlus, Lock, Pencil, Trash2, X } from "lucide-react";
import { GRANULAR_PERMISSIONS, granularPerms } from "../constants";
import { loginApi, setStoredAuth } from "../../../utils/api";

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
  showSuccess,
  showError,
}) {
  const isSelfEdit = editUser && editUser.id === authUser?.id;

  return (
    <div className="card animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <h2
          className="text-2xl font-bold flex items-center"
          style={{ color: "#fff" }}
        >
          Users
        </h2>
        {authUser?.role === "admin" && (
          <button
            type="button"
            className="btn btn-primary flex items-center gap-2"
            onClick={() => {
              setNewUserUsername("");
              setNewUserPassword("");
              setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
              setShowAddUserModal(true);
            }}
          >
            <UserPlus className="w-4 h-4" />
            Add user
          </button>
        )}
      </div>

      {authUser?.role !== "admin" ? (
        <div
          className="p-6 rounded-lg space-y-5 max-w-md"
          style={{
            backgroundColor: "#1a1a1e",
            boxShadow: "0 0 0 1px #2a2a2e",
          }}
        >
          <h3 className="text-lg font-medium flex items-center gap-2 text-main">
            <Lock className="w-5 h-5 text-[#707e61]" />
            Change my password
          </h3>
          <form
            className="space-y-4"
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
            <div className="space-y-1">
              <label htmlFor="change-pw-current" className="label">
                Current password
              </label>
              <input
                id="change-pw-current"
                type="password"
                className="input w-full"
                placeholder="Current password"
                autoComplete="current-password"
                value={changePwCurrent}
                onChange={(e) => setChangePwCurrent(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="change-pw-new" className="label">
                New password
              </label>
              <input
                id="change-pw-new"
                type="password"
                className="input w-full"
                placeholder="New password"
                autoComplete="new-password"
                value={changePwNew}
                onChange={(e) => setChangePwNew(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="change-pw-confirm" className="label">
                Confirm new password
              </label>
              <input
                id="change-pw-confirm"
                type="password"
                className="input w-full"
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
          <div className="rounded-lg overflow-hidden">
            {loadingUsers ? (
              <div className="p-8 text-center">
                <p className="text-sub">Loading…</p>
              </div>
            ) : (
              <ul>
                {usersList.map((u, i) => (
                  <li
                    key={u.id}
                    className={`flex items-center justify-between gap-4 px-5 py-4 ${
                      i % 2 === 1 ? "bg-[#1a1a1e]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-medium text-main truncate">
                        {u.username}
                      </span>
                      <span
                        className={`badge shrink-0 ${
                          u.role === "admin"
                            ? "badge-primary"
                            : "badge-neutral"
                        }`}
                        style={{
                          backgroundColor:
                            u.role === "admin" ? "#2a2a2e" : undefined,
                          color: "#c1c1c3",
                        }}
                      >
                        {u.role}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost gap-1.5"
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
                        <Pencil className="w-4 h-4" />
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{
                          backgroundColor: "transparent",
                          color: "#ef4444",
                        }}
                        disabled={u.role === "admin"}
                        onClick={() =>
                          u.role !== "admin" && setDeleteUserTarget(u)
                        }
                      >
                        <Trash2 className="w-4 h-4" />
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
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
              onClick={() => !deletingUser && setDeleteUserTarget(null)}
            >
              <div
                className="card max-w-md w-full shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold text-main">
                    Delete user
                  </h3>
                  <button
                    type="button"
                    className="p-2 rounded transition-colors hover:bg-[#2a2a2e] text-sub disabled:opacity-50"
                    onClick={() =>
                      !deletingUser && setDeleteUserTarget(null)
                    }
                    aria-label="Close"
                    disabled={deletingUser}
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <p className="text-sub mb-6">
                  Are you sure you want to delete{" "}
                  <span className="font-medium text-main">
                    {deleteUserTarget.username}
                  </span>
                  ? This cannot be undone.
                </p>
                <div
                  className="flex gap-3 justify-end pt-4"
                  style={{ boxShadow: "inset 0 1px 0 #2a2a2e" }}
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
                        refreshUsers();
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
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
              onClick={() => setShowAddUserModal(false)}
            >
              <div
                className="card max-w-md w-full max-h-[90vh] overflow-y-auto shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-main">
                    Add user
                  </h3>
                  <button
                    type="button"
                    className="p-2 rounded transition-colors hover:bg-[#2a2a2e] text-sub"
                    onClick={() => setShowAddUserModal(false)}
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <form
                  className="space-y-6"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newUserUsername.trim() || !newUserPassword) {
                      showError("Username and password required");
                      return;
                    }
                    setCreatingUser(true);
                    try {
                      await createUser(
                        newUserUsername.trim(),
                        newUserPassword,
                        "user",
                        newUserPermissions
                      );
                      showSuccess("User created");
                      setShowAddUserModal(false);
                      setNewUserUsername("");
                      setNewUserPassword("");
                      setNewUserPermissions({ ...GRANULAR_PERMISSIONS });
                      refreshUsers();
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
                  <div className="space-y-4">
                    <label className="label text-sub font-normal text-xs uppercase tracking-wider">
                      Account
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label
                          htmlFor="add-user-username"
                          className="label text-sm normal-case tracking-normal"
                        >
                          Username
                        </label>
                        <input
                          id="add-user-username"
                          type="text"
                          className="input"
                          placeholder="Username"
                          autoComplete="off"
                          value={newUserUsername}
                          onChange={(e) =>
                            setNewUserUsername(e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor="add-user-password"
                          className="label text-sm normal-case tracking-normal"
                        >
                          Password
                        </label>
                        <input
                          id="add-user-password"
                          type="password"
                          className="input"
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
                  <div className="space-y-3">
                    <label className="label text-sub font-normal text-xs uppercase tracking-wider">
                      Permissions
                    </label>
                    <div
                      className="p-4 rounded-lg space-y-3"
                      style={{
                        backgroundColor: "#1a1a1e",
                        boxShadow: "0 0 0 1px #2a2a2e",
                      }}
                    >
                      {granularPerms.map(({ key, label }) => (
                        <label
                          key={key}
                          className="flex items-center gap-3 cursor-pointer text-sub hover:text-main transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="rounded border-gray-600 text-[#707e61] focus:ring-[#707e61]"
                            checked={!!newUserPermissions[key]}
                            onChange={(e) =>
                              setNewUserPermissions((p) => ({
                                ...p,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                          <span className="text-sm">{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div
                    className="flex gap-3 justify-end pt-4 mt-4"
                    style={{ boxShadow: "inset 0 1px 0 #2a2a2e" }}
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
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
              onClick={() => setEditUser(null)}
            >
              <div
                className="card max-w-md w-full max-h-[90vh] overflow-y-auto shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-main">
                    Edit {editUser.username}
                  </h3>
                  <button
                    type="button"
                    className="p-2 rounded transition-colors hover:bg-[#2a2a2e] text-sub"
                    onClick={() => setEditUser(null)}
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <form
                  className="space-y-6"
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
                      refreshUsers();
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
                  <div className="space-y-4">
                    <label className="label text-sub font-normal text-xs uppercase tracking-wider">
                      {isSelfEdit
                        ? "Change password"
                        : "Password (optional)"}
                    </label>
                    {isSelfEdit ? (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label
                            htmlFor="edit-current-password"
                            className="label text-sm normal-case tracking-normal"
                          >
                            Current password
                          </label>
                          <input
                            id="edit-current-password"
                            type="password"
                            className="input w-full"
                            placeholder="Current password"
                            autoComplete="current-password"
                            value={editCurrentPassword}
                            onChange={(e) =>
                              setEditCurrentPassword(e.target.value)
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <label
                            htmlFor="edit-new-password"
                            className="label text-sm normal-case tracking-normal"
                          >
                            New password
                          </label>
                          <input
                            id="edit-new-password"
                            type="password"
                            className="input w-full"
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
                      <input
                        type="password"
                        className="input w-full"
                        placeholder="Leave blank to keep current password"
                        autoComplete="new-password"
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                      />
                    )}
                  </div>
                  {!isSelfEdit && (
                    <div className="space-y-3">
                      <label className="label text-sub font-normal text-xs uppercase tracking-wider">
                        Permissions
                      </label>
                      <div
                        className="p-4 rounded-lg space-y-3"
                        style={{
                          backgroundColor: "#1a1a1e",
                          boxShadow: "0 0 0 1px #2a2a2e",
                        }}
                      >
                        {granularPerms.map(({ key, label }) => (
                          <label
                            key={key}
                            className="flex items-center gap-3 cursor-pointer text-sub hover:text-main transition-colors"
                          >
                            <input
                              type="checkbox"
                              className="rounded border-gray-600 text-[#707e61] focus:ring-[#707e61]"
                              checked={!!editPermissions[key]}
                              onChange={(e) =>
                                setEditPermissions((p) => ({
                                  ...p,
                                  [key]: e.target.checked,
                                }))
                              }
                            />
                            <span className="text-sm">{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div
                    className="flex gap-3 justify-end pt-4 mt-4"
                    style={{ boxShadow: "inset 0 1px 0 #2a2a2e" }}
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
