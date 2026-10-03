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

export function NewsArticleCard({ article, compact = false, onDisableFeed }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [fallbackImage, setFallbackImage] = useState("");
  const [fallbackFailed, setFallbackFailed] = useState(false);

  const artists = Array.isArray(article?.artists) ? article.artists : [];
  const { artistMbid: fallbackMbid, artistName: fallbackName } =
    artists.find((artist) => artist.artistMbid) || {};
  const shouldLoadFallback = (!article?.imageUrl || imageFailed) && !fallbackFailed;

  useEffect(() => {
    if (!shouldLoadFallback || !fallbackMbid) return undefined;
    let cancelled = false;
    getArtistCover(fallbackMbid, fallbackName)
      .then((data) => {
        if (cancelled) return;
        const image = data?.images?.find((entry) => entry.front)?.image || data?.images?.[0]?.image;
        setFallbackImage(image || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fallbackMbid, fallbackName, shouldLoadFallback]);

  if (!article?.url || !article?.title) return null;

  const imageUrl =
    article.imageUrl && !imageFailed ? article.imageUrl : fallbackFailed ? "" : fallbackImage;
  const publisher = String(article.source || "").trim();
  const artistNames = artists.map((artist) => artist.artistName).join(", ");

  return (
    <article className="discover-news-card-shell">
      <div className={`discover-news-card${compact ? " discover-news-card--compact" : ""}${artistNames ? " discover-news-card--highlighted" : ""}`}>
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
            {artistNames ? <span className="discover-news-card__artist">{artistNames}</span> : null}
            <h3 className="discover-news-card__title">{article.title}</h3>
            {!compact && article.description ? (
              <p className="discover-news-card__description">{article.description}</p>
            ) : null}
          </div>
        </a>
        <div className="discover-news-card__footer">
          {publisher && article.sourceUrl && onDisableFeed ? (
            <TooltipButton
              label={`Disable ${publisher} RSS feed`}
              className="discover-news-card__block"
              onClick={() => void Promise.resolve(onDisableFeed(article.sourceUrl)).catch(() => {})}
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
