import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";

export type SettingsUser = InferResponseType<typeof usersClient.$get, 200>[number];
type NewUser = InferRequestType<typeof usersClient.$post>["json"];
type UserUpdate = InferRequestType<(typeof usersClient)[":id"]["$patch"]>["json"];

export const refreshUsers = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });

export const useSettingsUsers = () =>
  useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => parseResponse(usersClient.$get({}, { init: { signal } })),
    staleTime: 30_000,
  });

export async function createUser(json: NewUser) {
  await parseResponse(usersClient.$post({ json }));
  void refreshUsers();
}

export async function updateUser(id: number, json: UserUpdate) {
  await parseResponse(usersClient[":id"].$patch({ param: { id: String(id) }, json }));
  void refreshUsers();
}

export async function deleteUser(id: number) {
  await parseResponse(usersClient[":id"].$delete({ param: { id: String(id) } }));
  void refreshUsers();
}
