import { useState, useEffect } from "react";
import { getUsers, createUser, updateUser, deleteUser, changeMyPassword } from "../../../utils/api/endpoints/auth.js";
import { GRANULAR_PERMISSIONS } from "../constants";

export function useSettingsUsers(authUser, showSuccess, showError, activeTab) {
  const [usersList, setUsersList] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [newUserUsername, setNewUserUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserPermissions, setNewUserPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [creatingUser, setCreatingUser] = useState(false);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [editPassword, setEditPassword] = useState("");
  const [editCurrentPassword, setEditCurrentPassword] = useState("");
  const [editPermissions, setEditPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [editStatus, setEditStatus] = useState("active");
  const [savingEdit, setSavingEdit] = useState(false);
  const [changePwCurrent, setChangePwCurrent] = useState("");
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwConfirm, setChangePwConfirm] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleteUserTarget, setDeleteUserTarget] = useState(null);
  const [deletingUser, setDeletingUser] = useState(false);

  useEffect(() => {
    if (activeTab === "users" && authUser?.role === "admin") {
      setLoadingUsers(true);
      getUsers()
        .then(setUsersList)
        .catch(() => setUsersList([]))
        .finally(() => setLoadingUsers(false));
    }
  }, [activeTab, authUser?.role]);

  const refreshUsers = () => {
    return getUsers().then((nextUsers) => {
      setUsersList(nextUsers);
      return nextUsers;
    });
  };

  return {
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
    editStatus,
    setEditStatus,
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
  };
}
