import { useEffect, useRef, useState } from "react";
import { AlertCircle, Newspaper } from "../components/icons";
import { SettingsLink } from "./Settings/settingsRoute";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useLibraryNews } from "../hooks/useLibraryNews";
import { DiscoverRail } from "../components/DiscoverRail";
import { NewsFeedRow, NewsFeedTile, NewsLead } from "../components/DiscoverFeed";
import { DotLoader } from "../components/DotLoader";
import { SkeletonFeedPage } from "../components/Skeletons";
import StatePanel from "../components/StatePanel";
import { newsDayLabel, splitFeed } from "../utils/feedSections.ts";

const NEWS_FILTERS = [
  { highlighted: false, label: "All" },
  { highlighted: true, label: "Your artists" },
];

export default function NewsPage() {
  useDocumentTitle("News");
  const { user, bootstrap, hasPermission } = useAuth();
  const canManageServer = hasPermission("accessSettings");
  const newsConfigured = bootstrap?.newsConfigured === true;
  const [highlightedOnly, setHighlightedOnly] = useState(false);
  const loadMoreRef = useRef(null);
  const { articles, refresh, loading, loadingMore, hasMore, loadMore, error, disableFeed } =
    useLibraryNews({
      enabled: newsConfigured,
      limit: 24,
      mode: highlightedOnly ? "matched" : "top",
    });
  const refreshWarning = error || refresh?.warning || "";
  const onDisableFeed = user?.role === "admin" ? disableFeed : undefined;
  const { lead, shelf, groups } = splitFeed(
    articles,
    (article) => newsDayLabel(article.publishedAt),
    (article) => article.artists.length > 0,
  );

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="feed-page news-page">
      <header className="feed-page__header">
        <div className="feed-page__title-row">
          <h1 className="page-title">News</h1>
        </div>
        {newsConfigured ? (
          <div className="artist-tabs" role="group" aria-label="News filters">
            {NEWS_FILTERS.map((entry) => (
              <button
                key={entry.label}
                type="button"
                className={`artist-tab${entry.highlighted === highlightedOnly ? " is-active" : ""}`}
                aria-pressed={entry.highlighted === highlightedOnly}
                onClick={() => setHighlightedOnly(entry.highlighted)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {!newsConfigured ? (
        <StatePanel
          icon={<Newspaper />}
          title="Enable News"
          message={
            canManageServer
              ? "Turn on News in Settings → Discovery."
              : "An admin needs to turn on News."
          }
        >
          {canManageServer ? (
            <SettingsLink to="discovery/news" className="btn btn-primary">
              Open News settings
            </SettingsLink>
          ) : null}
        </StatePanel>
      ) : loading && articles.length === 0 ? (
        <SkeletonFeedPage label="Loading news" />
      ) : lead ? (
        <section className="feed-page__content">
          {refreshWarning ? (
            <p className="feed-page__notice" role="status">
              {refreshWarning}
            </p>
          ) : null}
          <NewsLead article={lead} onDisableFeed={onDisableFeed} />
          {shelf.length > 0 ? (
            <DiscoverRail title="Latest">
              {shelf.map((article) => (
                <NewsFeedTile
                  key={article.id}
                  article={article}
                  feedStyle="wide"
                  onDisableFeed={onDisableFeed}
                />
              ))}
            </DiscoverRail>
          ) : null}
          {groups.map((group) => (
            <section key={group.label} className="feed-page__group">
              <h2 className="artist-section-title--discover">{group.label}</h2>
              <div className="feed-page__list feed-page__list--news">
                {group.items.map((article) => (
                  <NewsFeedRow key={article.id} article={article} onDisableFeed={onDisableFeed} />
                ))}
              </div>
            </section>
          ))}
          {hasMore ? (
            <div ref={loadMoreRef} className="feed-page__load-more" aria-live="polite">
              {loadingMore ? <DotLoader size="sm" label={null} /> : "Loading more stories…"}
            </div>
          ) : null}
        </section>
      ) : error ? (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load news"
          message={error}
        />
      ) : (
        <StatePanel
          icon={<Newspaper />}
          title={highlightedOnly ? "No stories about your artists" : "No recent stories"}
          message={
            refreshWarning ||
            (highlightedOnly
              ? "No recent news for your Library or recommended artists."
              : "No recent stories.")
          }
        />
      )}
    </div>
  );
}
