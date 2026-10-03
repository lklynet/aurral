import { useCallback } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  disableNewsFeed,
  getLibraryNews,
} from "../utils/api/endpoints/news.js";
import { queryClient, queryKeys } from "../queryClient.js";

export function useLibraryNews({ enabled = false, limit = 60, mode = "matched", userId = null } = {}) {
  const queryKey = queryKeys.news(userId, mode, limit);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => getLibraryNews(limit, mode, pageParam, { signal }),
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
  const articles = pages.flatMap((page) => Array.isArray(page?.articles) ? page.articles : []);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const loadMore = useCallback(
    () =>
      hasNextPage && !isFetchingNextPage
        ? fetchNextPage()
        : Promise.resolve(null),
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );
  return {
    articles,
    refresh: pages[0]?.refresh || null,
    loading: enabled && query.isLoading,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage === true,
    loadMore,
    error: query.error?.response?.data?.message || query.error?.message || "",
    disableFeed: disableMutation.mutateAsync,
  };
}
