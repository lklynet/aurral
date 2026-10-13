import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { editorialShelfQueryOptions } from "../queryOptions.js";

export function useEditorialShelf() {
  const { user } = useAuth();
  return useQuery(editorialShelfQueryOptions(user?.id));
}
