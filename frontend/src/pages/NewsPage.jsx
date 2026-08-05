import { Newspaper, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useLibraryNews } from "../hooks/useLibraryNews";
import { NewsArticleCard } from "../components/NewsArticleCard";

export default function NewsPage() {
  useDocumentTitle("Artist News");
  const navigate = useNavigate();
  const { bootstrap } = useAuth();
  const newsConfigured = bootstrap?.newsapiConfigured === true;
  const {
    articles,
    artistCount,
    refresh,
    blockedPublishers,
    loading,
    error,
    blockPublisher,
    unblockPublisher,
  } = useLibraryNews({
    enabled: newsConfigured,
    limit: 100,
  });
  const refreshWarning = error || refresh?.warning || "";

  return (
    <div className="artist-discover-page discover-news-page">
      <header className="discover-news-page__header">
        <div>
          <h1 className="page-title">Artist News</h1>
          <p className="discover-news-page__subtitle">
            Recent stories about artists in your library
            {artistCount > 0 && refresh
              ? ` · ${refresh.checkedArtistCount} of ${artistCount} artists checked · ${refresh.callsRemaining} calls left`
              : ""}
          </p>
        </div>
        {newsConfigured ? (
          <div className="discover-news-page__header-actions">
            {blockedPublishers.length > 0 ? (
              <details className="discover-news-page__blocked">
                <summary>Blocked publishers</summary>
                <div className="discover-news-page__blocked-list">
                  {blockedPublishers.map((publisher) => (
                    <div key={publisher}>
                      <span>{publisher}</span>
                      <button
                        type="button"
                        onClick={() => void unblockPublisher(publisher).catch(() => {})}
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </header>

      {!newsConfigured ? (
        <section className="discover-news-page__status">
          <Newspaper aria-hidden="true" />
          <h2>Connect NewsAPI</h2>
          <p>Add a NewsAPI key to see recent stories about artists in your library.</p>
          <button type="button" className="btn btn-primary btn--bold" onClick={() => navigate("/settings/connect")}>
            Open NewsAPI settings
          </button>
        </section>
      ) : loading && articles.length === 0 ? (
        <section className="discover-news-page__status">
          <RefreshCw className="animate-spin" aria-hidden="true" />
          <h2>Loading artist news</h2>
          <p>Checking recent stories for your library artists.</p>
        </section>
      ) : articles.length > 0 ? (
        <>
          {refreshWarning ? (
            <div className="discover-news-page__refresh-warning" role="status">
              {refreshWarning}
            </div>
          ) : null}
          <div className="discover-news-page__grid">
            {articles.map((article) => (
              <NewsArticleCard
                key={article.url}
                article={article}
                onBlockPublisher={blockPublisher}
              />
            ))}
          </div>
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
          <p>{refreshWarning || "NewsAPI did not return recent stories for the artists in your library."}</p>
        </section>
      ) : null}
    </div>
  );
}
