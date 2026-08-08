import { useCallback, useEffect, useState } from "react";
import {
  disableNewsFeed,
  getLibraryNews,
} from "../utils/api/endpoints/news.js";

const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const newsPageCache = new Map();

export function useLibraryNews({ enabled = false, limit = 60, mode = "matched", userId = null } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const cacheKey = `${userId || "anonymous"}:${mode}:${limit}`;

  const load = useCallback(async ({ append = false, offset = 0 } = {}) => {
    if (!enabled) {
      setData(null);
      setError("");
      return null;
    }
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const next = await getLibraryNews(limit, mode, offset);
      setData((previous) => {
        const result = append
          ? { ...next, articles: [...(previous?.articles || []), ...(next.articles || [])] }
          : next;
        newsPageCache.set(cacheKey, { data: result, cachedAt: Date.now() });
        return result;
      });
      setError("");
      return next;
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || "Failed to load artist news");
      return null;
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [cacheKey, enabled, limit, mode]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !data?.hasMore) return Promise.resolve(null);
    return load({ append: true, offset: data.articles?.length || 0 });
  }, [data?.articles?.length, data?.hasMore, load, loading, loadingMore]);

  const disablePublisher = useCallback(async (publisher, sourceUrl) => {
    await disableNewsFeed(sourceUrl, publisher);
    await load();
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      load();
      return;
    }
    const cached = newsPageCache.get(cacheKey);
    if (cached) {
      setData(cached.data);
      if (Date.now() - cached.cachedAt < CLIENT_CACHE_TTL_MS) return;
    }
    load();
  }, [cacheKey, enabled, load]);

  return {
    articles: Array.isArray(data?.articles) ? data.articles : [],
    artistCount: Number(data?.artistCount || 0),
    refresh: data?.refresh || null,
    configured: data?.configured === true,
    loading,
    loadingMore,
    hasMore: data?.hasMore === true,
    loadMore,
    error,
    disablePublisher,
  };
}
