import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferRequestType } from "hono/client";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { GRANULAR_PERMISSIONS } from "../constants";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { useAuth } from "../../../contexts/AuthContext.tsx";
import type { useToast } from "../../../contexts/ToastContext.tsx";
import type { userOps } from "../../../../../backend/db/helpers/users.ts";

type AuthUser = NonNullable<NonNullable<ReturnType<typeof useAuth>>["user"]>;
type SettingsUser = ReturnType<typeof userOps.getAllUsers>[number];
type Toast = ReturnType<typeof useToast>["showSuccess"];
type UserUpdate = InferRequestType<(typeof usersClient)[":id"]["$patch"]>["json"];

export function useSettingsUsers(
  authUser: AuthUser | null,
  showSuccess: Toast,
  showError: Toast,
  activeTab: string,
) {
  const usersQuery = useQuery({
    queryKey: queryKeys.users,
    queryFn: () => parseResponse(usersClient.$get()),
    enabled: activeTab === "users" && authUser?.role === "admin",
    staleTime: 30_000,
  });
  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });
  const createUserMutation = useMutation({
    mutationFn: ({
      username,
      password,
      role,
      permissions,
    }: {
      username: string;
      password: string;
      role: string;
      permissions: Record<string, boolean>;
    }) => parseResponse(usersClient.$post({ json: { username, password, role, permissions } })),
    onSuccess: invalidateUsers,
  });
  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UserUpdate }) =>
      parseResponse(usersClient[":id"].$patch({ param: { id: String(id) }, json: data })),
    onSuccess: invalidateUsers,
  });
  const deleteUserMutation = useMutation({
    mutationFn: (id: number) =>
      parseResponse(usersClient[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: invalidateUsers,
  });
  const changePasswordMutation = useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => parseResponse(usersClient.me.password.$post({ json: { currentPassword, newPassword } })),
  });
  const [newUserUsername, setNewUserUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserPermissions, setNewUserPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [creatingUser, setCreatingUser] = useState(false);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [editUser, setEditUser] = useState<SettingsUser | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editCurrentPassword, setEditCurrentPassword] = useState("");
  const [editPermissions, setEditPermissions] = useState({
    ...GRANULAR_PERMISSIONS,
  });
  const [editStatus, setEditStatus] = useState("active");
  const [editAllowAdoption, setEditAllowAdoption] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [changePwCurrent, setChangePwCurrent] = useState("");
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwConfirm, setChangePwConfirm] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleteUserTarget, setDeleteUserTarget] = useState<SettingsUser | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);

  const refreshUsers = () => {
    return usersQuery.refetch().then(({ data }) => data || []);
  };

  return {
    usersList: usersQuery.data || [],
    loadingUsers: usersQuery.isPending || usersQuery.isFetching,
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
    editAllowAdoption,
    setEditAllowAdoption,
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
    createUser: (
      username: string,
      password: string,
      role: string,
      permissions: Record<string, boolean>,
    ) => createUserMutation.mutateAsync({ username, password, role, permissions }),
    updateUser: (id: number, data: UserUpdate) => updateUserMutation.mutateAsync({ id, data }),
    deleteUser: (id: number) => deleteUserMutation.mutateAsync(id),
    changeMyPassword: (currentPassword: string, newPassword: string) =>
      changePasswordMutation.mutateAsync({ currentPassword, newPassword }),
    showSuccess,
    showError,
  };
}
