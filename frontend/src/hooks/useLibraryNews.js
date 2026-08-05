import { useCallback, useEffect, useState } from "react";
import {
  getLibraryNews,
  updateNewsPreferences,
} from "../utils/api/endpoints/news.js";

export function useLibraryNews({ enabled = false, limit = 60 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setError("");
      return null;
    }
    setLoading(true);
    try {
      const next = await getLibraryNews(limit);
      setData(next);
      setError("");
      return next;
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || "Failed to load artist news");
      return null;
    } finally {
      setLoading(false);
    }
  }, [enabled, limit]);

  const blockPublisher = useCallback(async (publisher) => {
    const current = Array.isArray(data?.blockedPublishers) ? data.blockedPublishers : [];
    const next = [...current, publisher];
    const preferences = await updateNewsPreferences(next);
    setData((previous) => ({ ...(previous || {}), blockedPublishers: preferences.blockedPublishers }));
    await load();
  }, [data?.blockedPublishers, load]);

  const unblockPublisher = useCallback(async (publisher) => {
    const current = Array.isArray(data?.blockedPublishers) ? data.blockedPublishers : [];
    const next = current.filter((entry) => entry.toLowerCase() !== String(publisher || "").toLowerCase());
    const preferences = await updateNewsPreferences(next);
    setData((previous) => ({ ...(previous || {}), blockedPublishers: preferences.blockedPublishers }));
    await load();
  }, [data?.blockedPublishers, load]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    articles: Array.isArray(data?.articles) ? data.articles : [],
    artistCount: Number(data?.artistCount || 0),
    refresh: data?.refresh || null,
    configured: data?.configured === true,
    blockedPublishers: Array.isArray(data?.blockedPublishers) ? data.blockedPublishers : [],
    loading,
    error,
    blockPublisher,
    unblockPublisher,
  };
}
