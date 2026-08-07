import { useEffect, useState } from "react";
import { Ban, Newspaper } from "lucide-react";
import { getArtistCover } from "../utils/api/endpoints/artists.js";
import TooltipButton from "./TooltipButton";

const formatNewsDate = (value) => {
  if (!value) return "Recent";
  const date = new Date(value);
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
      <div className={`discover-news-card${compact ? " discover-news-card--compact" : ""}`}>
        <a
          className="discover-news-card__link"
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
          </div>
        </a>
        <div className="discover-news-card__footer">
          {publisher && onBlockPublisher ? (
            <TooltipButton
              label={`Block ${publisher}`}
              className="discover-news-card__block"
              onClick={() => void Promise.resolve(onBlockPublisher(publisher)).catch(() => {})}
            >
              <Ban aria-hidden="true" />
            </TooltipButton>
          ) : null}
          <span className="discover-news-card__meta">
            {[publisher, formatNewsDate(article.publishedAt)].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
    </article>
  );
}
