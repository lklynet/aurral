import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { getEditorialShelf } from "../utils/api/endpoints/discovery.js";
import { queryKeys } from "../queryClient.js";

export function useEditorialShelf() {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.editorialShelf(user?.id),
    queryFn: ({ signal }) => getEditorialShelf({ signal }),
    staleTime: 60 * 60 * 1000,
  });
}
