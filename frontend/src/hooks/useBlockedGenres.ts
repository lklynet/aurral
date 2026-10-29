import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import { asApiError } from "../utils/api/core.ts";

const EMPTY_GENRES: string[] = [];

const genreKey = (genre: string) => genre.toLowerCase().replace(/[\s_-]+/g, "");

const blockedTagsClient = discoveryClient["blocked-tags"];

export function useBlockedGenres() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryKey = queryKeys.blockedTags(user?.id);
  const { data: blockedGenres = EMPTY_GENRES, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await parseResponse(blockedTagsClient.$get())).tags,
    enabled: user?.id != null,
    staleTime: 60_000,
  });

  const { mutateAsync, isPending, variables } = useMutation({
    scope: { id: `blocked-tags:${user?.id ?? "anonymous"}` },
    mutationFn: ({ genre, blocked }: { genre: string; blocked: boolean }) =>
      blocked
        ? parseResponse(blockedTagsClient.$post({ json: { tag: genre } }))
        : parseResponse(blockedTagsClient.$delete({ query: { tag: genre } })),
    onSuccess: ({ tags }) => {
      queryClient.setQueryData(queryKey, tags);
      void queryClient.invalidateQueries({ queryKey: queryKeys.discovery(user?.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.editorialShelf(user?.id) });
    },
  });

  const blockedKeys = useMemo(() => new Set(blockedGenres.map(genreKey)), [blockedGenres]);

  const isGenreBlocked = useCallback(
    (genre: string) => blockedKeys.has(genreKey(genre)),
    [blockedKeys],
  );

  const setGenreBlocked = useCallback(
    async (genre: string, blocked: boolean) => {
      const label = `#${genre.trim()}`;
      try {
        await mutateAsync({ genre, blocked });
      } catch (error) {
        const data = asApiError(error)?.response?.data;
        const reason = typeof data === "object" && data?.message ? data.message : "Try again.";
        showError(`Could not ${blocked ? "block" : "unblock"} ${label}. ${reason}`);
        return false;
      }
      showSuccess(
        blocked ? `Blocked ${label} from recommendations and flows` : `Unblocked ${label}`,
      );
      return true;
    },
    [mutateAsync, showError, showSuccess],
  );

  return {
    blockedGenres,
    isGenreBlocked,
    setGenreBlocked,
    pendingGenre: isPending ? variables.genre : null,
    isLoading,
  };
}
