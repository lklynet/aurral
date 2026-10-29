import ArtworkImage from "./ArtworkImage";
import { useEffect, useState } from "react";
import { Ban, Newspaper } from "./icons";
import { getArtistCover } from "../utils/api/endpoints/artists.ts";
import TooltipButton from "./TooltipButton";
import RelativeTime from "./RelativeTime";

export interface NewsArticle {
  title: string;
  description: string;
  url: string;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  imageUrl: string | null;
  artists: { artistMbid: string | null; artistName: string }[];
}

interface NewsArticleCardProps {
  article: NewsArticle;
  onDisableFeed?: (sourceUrl: string) => unknown;
}

export function useNewsArticleImage(article: Pick<NewsArticle, "imageUrl" | "artists">) {
  const [imageFailed, setImageFailed] = useState(false);
  const [fallbackImage, setFallbackImage] = useState("");
  const [fallbackFailed, setFallbackFailed] = useState(false);

  const artists: NewsArticle["artists"] = Array.isArray(article?.artists) ? article.artists : [];
  const { artistMbid: fallbackMbid, artistName: fallbackName } =
    artists.find((artist) => artist.artistMbid) || {};
  const shouldLoadFallback = (!article?.imageUrl || imageFailed) && !fallbackFailed;

  useEffect(() => {
    if (!shouldLoadFallback || !fallbackMbid) return undefined;
    let cancelled = false;
    getArtistCover(fallbackMbid, fallbackName)
      .then((data) => {
        if (cancelled) return;
        const image =
          data?.images?.find((entry: { front?: boolean }) => entry.front)?.image ||
          data?.images?.[0]?.image;
        setFallbackImage(image || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fallbackMbid, fallbackName, shouldLoadFallback]);

  const imageUrl =
    article.imageUrl && !imageFailed ? article.imageUrl : fallbackFailed ? "" : fallbackImage;
  const onImageError = () => {
    if (article.imageUrl && !imageFailed) setImageFailed(true);
    else setFallbackFailed(true);
  };
  return { imageUrl, onImageError };
}

export function NewsArticleCard({ article, onDisableFeed }: NewsArticleCardProps) {
  const { imageUrl, onImageError } = useNewsArticleImage(article);

  if (!article?.url || !article?.title) return null;

  const artists = Array.isArray(article?.artists) ? article.artists : [];
  const publisher = String(article.source || "").trim();
  const artistNames = artists.map((artist) => artist.artistName).join(", ");

  return (
    <article className="discover-news-card-shell">
      <div className={`discover-news-card${artistNames ? " discover-news-card--highlighted" : ""}`}>
        <a
          className="discover-news-card__link"
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="discover-news-card__image-wrap">
            {imageUrl ? (
              <ArtworkImage
                src={imageUrl}
                alt=""
                className="discover-news-card__image"
                loading="lazy"
                onError={onImageError}
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
            {article.description ? (
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
            {publisher}
            {publisher ? " · " : null}
            {Number.isFinite(new Date(article.publishedAt || "").getTime()) ? (
              <RelativeTime value={article.publishedAt} />
            ) : (
              "Recent"
            )}
          </span>
        </div>
      </div>
    </article>
  );
}
