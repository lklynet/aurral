import { useEffect, useRef, useState } from "react";
import { Newspaper } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useLibraryNews } from "../hooks/useLibraryNews";
import { NewsArticleCard } from "../components/NewsArticleCard";
import { DotLoader } from "../components/DotLoader";

export default function NewsPage() {
  useDocumentTitle("Artist News");
  const navigate = useNavigate();
  const { bootstrap } = useAuth();
  const newsConfigured = bootstrap?.newsConfigured === true;
  const [highlightedOnly, setHighlightedOnly] = useState(false);
  const loadMoreRef = useRef(null);
  const {
    articles,
    refresh,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
    disablePublisher,
  } = useLibraryNews({
    enabled: newsConfigured,
    limit: 24,
    mode: "top",
  });
  const visibleArticles = highlightedOnly
    ? articles.filter((article) => article.artistName)
    : articles;
  const refreshWarning = error || refresh?.warning || "";

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadMore();
    }, { rootMargin: "600px" });
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="artist-discover-page discover-news-page">
      <header className="discover-news-page__header">
        <div>
          <h1 className="page-title">Artist News</h1>
        </div>
        {newsConfigured ? (
          <button
            type="button"
            className={`discover-news-page__highlight-toggle${highlightedOnly ? " is-active" : ""}`}
            aria-pressed={highlightedOnly}
            onClick={() => setHighlightedOnly((value) => !value)}
          >
            Highlighted only
          </button>
        ) : null}
      </header>

      {!newsConfigured ? (
        <section className="discover-news-page__status">
          <Newspaper aria-hidden="true" />
          <h2>Enable News</h2>
          <p>Enable the RSS news feed in Settings to see recent stories about artists in your library.</p>
          <button type="button" className="btn btn-primary btn--bold" onClick={() => navigate("/settings/rss-news")}>
            Open News settings
          </button>
        </section>
      ) : loading && articles.length === 0 ? (
        <section className="discover-news-page__status">
          <DotLoader size="2xl" label={null} />
          <h2>Loading artist news</h2>
        </section>
      ) : articles.length > 0 ? (
        <>
          {refreshWarning ? (
            <div className="discover-news-page__refresh-warning" role="status">
              {refreshWarning}
            </div>
          ) : null}
          <div className="discover-news-page__grid">
            {visibleArticles.map((article) => (
              <NewsArticleCard
                key={article.url}
                article={article}
                onDisablePublisher={disablePublisher}
              />
            ))}
          </div>
          {highlightedOnly && visibleArticles.length === 0 ? (
            <section className="discover-news-page__status">
              <Newspaper aria-hidden="true" />
              <h2>No highlighted stories</h2>
              <p>None of the loaded stories mention a library or recommended artist.</p>
            </section>
          ) : null}
          {hasMore ? (
            <div ref={loadMoreRef} className="discover-news-page__load-more" aria-live="polite">
              {loadingMore ? <DotLoader size="sm" label={null} /> : "Loading more stories…"}
            </div>
          ) : null}
        </>
      ) : error ? (
        <section className="discover-news-page__status" role="alert">
          <Newspaper aria-hidden="true" />
          <h2>Artist news is unavailable</h2>
          <p>{error}</p>
        </section>
      ) : articles.length === 0 ? (
        <section className="discover-news-page__status">
          <Newspaper aria-hidden="true" />
          <h2>No recent artist news</h2>
          <p>{refreshWarning || "No recent RSS stories matched the artists in your library or recommendations."}</p>
        </section>
      ) : null}
    </div>
  );
}
