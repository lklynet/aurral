import { useEffect, useState } from "react";
import { MoreVertical, Newspaper } from "lucide-react";
import { getArtistCover } from "../utils/api/endpoints/artists.js";

const formatNewsDate = (value) => {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)
    : "Recent";
};

export function NewsArticleCard({ article, compact = false, onBlockPublisher }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [fallbackImage, setFallbackImage] = useState("");
  const [fallbackFailed, setFallbackFailed] = useState(false);

  const shouldLoadFallback = (!article?.imageUrl || imageFailed) && !fallbackFailed;

  useEffect(() => {
    if (!shouldLoadFallback || !article?.artistMbid) return undefined;
    let cancelled = false;
    getArtistCover(article.artistMbid, article.artistName)
      .then((data) => {
        if (cancelled) return;
        const image = data?.images?.find((entry) => entry.front)?.image || data?.images?.[0]?.image;
        setFallbackImage(image || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [article?.artistMbid, article?.artistName, shouldLoadFallback]);

  if (!article?.url || !article?.title) return null;

  const imageUrl =
    article.imageUrl && !imageFailed ? article.imageUrl : fallbackFailed ? "" : fallbackImage;
  const publisher = String(article.source || "").trim();

  return (
    <article className="discover-news-card-shell">
      <a
        className={`discover-news-card${compact ? " discover-news-card--compact" : ""}`}
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <div className="discover-news-card__image-wrap">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="discover-news-card__image"
              loading="lazy"
              onError={() => {
                if (article.imageUrl && !imageFailed) setImageFailed(true);
                else setFallbackFailed(true);
              }}
            />
          ) : (
            <div className="discover-news-card__image-placeholder" aria-hidden="true">
              <Newspaper />
            </div>
          )}
        </div>
        <div className="discover-news-card__content">
          <span className="discover-news-card__artist">{article.artistName || "Library news"}</span>
          <h3 className="discover-news-card__title">{article.title}</h3>
          {!compact && article.description ? (
            <p className="discover-news-card__description">{article.description}</p>
          ) : null}
          <span className="discover-news-card__meta">
            {[article.source, formatNewsDate(article.publishedAt)].filter(Boolean).join(" · ")}
          </span>
        </div>
      </a>
      {publisher && onBlockPublisher ? (
        <details className="discover-news-card__menu">
          <summary aria-label={`Article options for ${publisher}`}>
            <MoreVertical aria-hidden="true" />
          </summary>
          <div className="discover-news-card__menu-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                void Promise.resolve(onBlockPublisher(publisher)).catch(() => {});
              }}
            >
              Block {publisher}
            </button>
          </div>
        </details>
      ) : null}
    </article>
  );
}
