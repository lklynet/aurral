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
    mutationFn: ({ publisher, sourceUrl }) => disableNewsFeed(sourceUrl, publisher),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const pages = query.data?.pages || [];
  const firstPage = pages[0] || null;
  const articles = pages.flatMap((page) => Array.isArray(page?.articles) ? page.articles : []);
  const loadMore = () =>
    query.hasNextPage && !query.isFetchingNextPage
      ? query.fetchNextPage()
      : Promise.resolve(null);

  return {
    articles,
    artistCount: Number(firstPage?.artistCount || 0),
    refresh: firstPage?.refresh || null,
    configured: firstPage?.configured === true,
    loading: enabled && (query.isPending || query.isFetching),
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage === true,
    loadMore,
    error: query.error?.response?.data?.message || query.error?.message || "",
    disablePublisher: (publisher, sourceUrl) =>
      disableMutation.mutateAsync({ publisher, sourceUrl }),
  };
}
