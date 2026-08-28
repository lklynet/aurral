import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getUsers, createUser, updateUser, deleteUser, changeMyPassword } from "../../../utils/api/endpoints/auth.js";
import { GRANULAR_PERMISSIONS } from "../constants";
import { queryClient, queryKeys } from "../../../queryClient.js";

export function useSettingsUsers(authUser, showSuccess, showError, activeTab) {
  const usersQuery = useQuery({
    queryKey: queryKeys.users,
    queryFn: getUsers,
    enabled: activeTab === "users" && authUser?.role === "admin",
    staleTime: 30_000,
  });
  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });
  const createUserMutation = useMutation({
    mutationFn: ({ username, password, role, permissions }) =>
      createUser({ username, password, role, permissions }),
    onSuccess: invalidateUsers,
  });
  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }) => updateUser(id, data),
    onSuccess: invalidateUsers,
  });
  const deleteUserMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: invalidateUsers,
  });
  const changePasswordMutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }) => changeMyPassword(currentPassword, newPassword),
  });
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserPermissions, setNewUserPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [creatingUser, setCreatingUser] = useState(false);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [editUserName, setEditUserName] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editCurrentPassword, setEditCurrentPassword] = useState("");
  const [editPermissions, setEditPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [changePwCurrent, setChangePwCurrent] = useState("");
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwConfirm, setChangePwConfirm] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleteUserTarget, setDeleteUserTarget] = useState(null);
  const [deletingUser, setDeletingUser] = useState(false);

  const refreshUsers = () => {
    return usersQuery.refetch().then(({ data }) => data || []);
  };

  return {
    usersList: usersQuery.data || [],
    loadingUsers: usersQuery.isPending || usersQuery.isFetching,
    newUserName,
    setNewUserName,
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
    editUserName,
    setEditUserName,
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
    createUser: (username, password, role, permissions) =>
      createUserMutation.mutateAsync({ username, password, role, permissions }),
    updateUser: (id, data) => updateUserMutation.mutateAsync({ id, data }),
    deleteUser: (id) => deleteUserMutation.mutateAsync(id),
    changeMyPassword: (currentPassword, newPassword) =>
      changePasswordMutation.mutateAsync({ currentPassword, newPassword }),
    showSuccess,
    showError,
  };
}
