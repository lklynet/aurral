import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { editorialShelfQueryOptions } from "../queryOptions.ts";

export function useEditorialShelf() {
  const { user } = useAuth();
  return useQuery(editorialShelfQueryOptions(user?.id));
}
