import { useCallback } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { newsClient } from "../utils/api/clients/news.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { asApiError } from "../utils/api/core.ts";

const disableNewsFeed = (sourceUrl: string) =>
  parseResponse(newsClient.feeds.disable.$post({ json: { sourceUrl } }));

export function useLibraryNews({
  enabled = false,
  limit = 60,
  mode = "matched",
  userId = null,
}: {
  enabled?: boolean;
  limit?: number;
  mode?: "matched" | "top";
  userId?: string | number | null;
} = {}) {
  const queryKey = queryKeys.news(userId, mode, limit);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      parseResponse(
        newsClient.$get(
          { query: { limit: String(limit), mode, offset: String(pageParam) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage?.hasMore) return undefined;
      return pages.reduce((count, page) => count + (page?.articles?.length || 0), 0);
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
  const disableMutation = useMutation({
    mutationFn: disableNewsFeed,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["news"] }),
  });
  const pages = query.data?.pages || [];
  const articles = pages.flatMap((page) => (Array.isArray(page?.articles) ? page.articles : []));
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const loadMore = useCallback(
    () => (hasNextPage && !isFetchingNextPage ? fetchNextPage() : Promise.resolve(null)),
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );
  const errorData = asApiError(query.error)?.response?.data;
  return {
    articles,
    refresh: pages[0]?.refresh || null,
    loading: enabled && query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage === true,
    loadMore,
    error:
      (typeof errorData === "object" && errorData ? errorData.message : undefined) ||
      query.error?.message ||
      "",
    disableFeed: disableMutation.mutateAsync,
  };
}
