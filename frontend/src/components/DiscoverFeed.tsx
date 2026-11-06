import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { DiscoverFeedStyle } from "../../../lib/discoverLayout.ts";
import { getArtistCover } from "../utils/api/endpoints/artists.ts";
import { formatDate } from "../utils/dateTime.ts";
import {
  formatDistance,
  formatShowDate,
  formatShowTime,
  getEventUrl,
  getShowDay,
  titleNamesArtists,
  type NearbyShow,
} from "../utils/shows.ts";
import ArtworkImage from "./ArtworkImage";
import { Ban, Music, Newspaper } from "./icons";
import RelativeTime from "./RelativeTime";
import TooltipButton from "./TooltipButton";

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

type DisableFeed = (sourceUrl: string) => unknown;

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

const joinMeta = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

function FeedTile({
  feedStyle,
  href,
  label,
  image,
  onImageError,
  fallbackIcon: FallbackIcon,
  round = false,
  title,
  meta,
  leading,
  trailing,
  overlay,
  action,
}: {
  feedStyle: DiscoverFeedStyle;
  href: string;
  label: string;
  image: string;
  onImageError?: () => void;
  fallbackIcon: ComponentType<{ "aria-hidden"?: boolean }>;
  round?: boolean;
  title: string;
  meta: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  overlay?: ReactNode;
  action?: ReactNode;
}) {
  const content = (
    <>
      {leading}
      <span className={`discover-feed-tile__art${round ? " discover-feed-tile__art--round" : ""}`}>
        {image ? (
          <ArtworkImage src={image} alt="" loading="lazy" onError={onImageError} />
        ) : (
          <FallbackIcon aria-hidden />
        )}
        {overlay ? <span className="discover-feed-tile__overlay">{overlay}</span> : null}
      </span>
      <span className="discover-feed-tile__text">
        <span className="discover-feed-tile__title">{title}</span>
        <span className="discover-feed-tile__meta">{meta}</span>
      </span>
      {trailing}
    </>
  );

  return (
    <article className={`discover-feed-tile discover-feed-tile--${feedStyle}`}>
      {href ? (
        <a
          className="discover-feed-tile__body"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
        >
          {content}
        </a>
      ) : (
        <div className="discover-feed-tile__body">{content}</div>
      )}
      {action}
    </article>
  );
}

export function ShowFeedTile({
  show,
  feedStyle,
}: {
  show: NearbyShow;
  feedStyle: DiscoverFeedStyle;
}) {
  const artistNames = (show.artistNames || []).filter(Boolean);
  const eventLabel = show.eventName || artistNames.join(", ") || "Upcoming show";
  const day = getShowDay(show);
  const distance = formatDistance(show.distance);
  const place =
    (show.venueName && show.city ? `${show.venueName}, ${show.city}` : null) ||
    show.venueName ||
    show.city;
  const datePart = (options: Intl.DateTimeFormatOptions) =>
    day ? day.toLocaleDateString(undefined, options) : null;
  const date = day ? formatDate(day, { month: "short", day: "numeric" }) : null;

  const layouts = {
    list: {
      meta: joinMeta(place, datePart({ weekday: "short" }), formatShowTime(show.time)),
      leading: day ? (
        <span className="discover-feed-tile__date">
          <span className="discover-feed-tile__day">{day.getDate()}</span>
          <span className="discover-feed-tile__month">{datePart({ month: "short" })}</span>
        </span>
      ) : null,
      trailing: distance ? <span className="discover-feed-tile__trailing">{distance}</span> : null,
    },
    square: {
      meta: joinMeta(datePart({ weekday: "short" }), date, show.city),
    },
    wide: {
      meta: joinMeta(show.venueName || show.city, distance),
      overlay: date,
    },
  } satisfies Record<
    DiscoverFeedStyle,
    { meta: string; leading?: ReactNode; trailing?: ReactNode; overlay?: ReactNode }
  >;

  return (
    <FeedTile
      feedStyle={feedStyle}
      href={getEventUrl(show.url)}
      label={`Open tickets for ${eventLabel}`}
      image={show.image || ""}
      fallbackIcon={Music}
      round={feedStyle === "list"}
      title={artistNames.join(", ") || eventLabel}
      {...layouts[feedStyle]}
    />
  );
}

function NewsByline({ article }: { article: NewsArticle }) {
  const byline = joinMeta(
    article.artists.map((artist) => artist.artistName).join(", "),
    article.source.trim(),
  );
  return (
    <>
      {byline ? `${byline} · ` : null}
      {Number.isFinite(new Date(article.publishedAt).getTime()) ? (
        <RelativeTime value={article.publishedAt} />
      ) : (
        "Recent"
      )}
    </>
  );
}

function DisableFeedButton({
  article,
  onDisableFeed,
  className,
}: {
  article: NewsArticle;
  onDisableFeed?: DisableFeed;
  className: string;
}) {
  const publisher = article.source.trim();
  if (!publisher || !article.sourceUrl || !onDisableFeed) return null;
  return (
    <TooltipButton
      label={`Disable ${publisher} RSS feed`}
      className={`btn btn-surface btn-icon ${className}`}
      onClick={() => void Promise.resolve(onDisableFeed(article.sourceUrl)).catch(() => {})}
    >
      <Ban aria-hidden="true" />
    </TooltipButton>
  );
}

export function NewsFeedTile({
  article,
  feedStyle,
  onDisableFeed,
}: {
  article: NewsArticle;
  feedStyle: DiscoverFeedStyle;
  onDisableFeed?: DisableFeed;
}) {
  const { imageUrl, onImageError } = useNewsArticleImage(article);
  return (
    <FeedTile
      feedStyle={feedStyle}
      href={article.url}
      label={article.title}
      image={imageUrl}
      onImageError={onImageError}
      fallbackIcon={Newspaper}
      title={article.title}
      meta={<NewsByline article={article} />}
      action={
        <DisableFeedButton
          article={article}
          onDisableFeed={onDisableFeed}
          className="discover-feed-tile__action"
        />
      }
    />
  );
}

export function NewsFeedRow({
  article,
  onDisableFeed,
}: {
  article: NewsArticle;
  onDisableFeed?: DisableFeed;
}) {
  const { imageUrl, onImageError } = useNewsArticleImage(article);
  return (
    <article className="news-row">
      <a className="news-row__body" href={article.url} target="_blank" rel="noopener noreferrer">
        <span className="news-row__text">
          <span className="news-row__title">{article.title}</span>
          {article.description ? (
            <span className="news-row__description">{article.description}</span>
          ) : null}
          <span className="news-row__meta">
            <NewsByline article={article} />
          </span>
        </span>
        <span className="news-row__art">
          {imageUrl ? (
            <ArtworkImage src={imageUrl} alt="" loading="lazy" onError={onImageError} />
          ) : (
            <Newspaper aria-hidden />
          )}
        </span>
      </a>
      <DisableFeedButton
        article={article}
        onDisableFeed={onDisableFeed}
        className="news-row__action"
      />
    </article>
  );
}

function FeedLead({
  href,
  image,
  onImageError,
  fallbackIcon: FallbackIcon,
  title,
  children,
}: {
  href: string;
  image: string;
  onImageError?: () => void;
  fallbackIcon: ComponentType<{ "aria-hidden"?: boolean }>;
  title: string;
  children: ReactNode;
}) {
  const art = image ? (
    <ArtworkImage src={image} alt="" onError={onImageError} />
  ) : (
    <FallbackIcon aria-hidden />
  );
  const linkProps = { href, target: "_blank", rel: "noopener noreferrer" };
  return (
    <article className="feed-lead">
      {href ? (
        <a className="feed-lead__art" {...linkProps} tabIndex={-1} aria-hidden="true">
          {art}
        </a>
      ) : (
        <span className="feed-lead__art">{art}</span>
      )}
      <div className="feed-lead__body">
        <h2 className="feed-lead__title">{href ? <a {...linkProps}>{title}</a> : title}</h2>
        {children}
      </div>
    </article>
  );
}

export function ShowLead({ show }: { show: NearbyShow }) {
  const artistNames = (show.artistNames || []).filter(Boolean);
  const title = show.eventName || artistNames.join(", ") || "Upcoming show";
  const href = getEventUrl(show.url);
  const place = [show.city, show.region].filter(Boolean).join(", ");
  return (
    <FeedLead href={href} image={show.image || ""} fallbackIcon={Music} title={title}>
      {titleNamesArtists(title, artistNames) ? null : (
        <p className="feed-lead__meta">{artistNames.join(", ")}</p>
      )}
      <p className="feed-lead__meta">{formatShowDate(show)}</p>
      <p className="feed-lead__meta">
        {joinMeta(show.venueName, place, formatDistance(show.distance))}
      </p>
      {href ? (
        <a
          className="btn btn-primary feed-lead__action"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Get tickets
        </a>
      ) : null}
    </FeedLead>
  );
}

export function NewsLead({
  article,
  onDisableFeed,
}: {
  article: NewsArticle;
  onDisableFeed?: DisableFeed;
}) {
  const { imageUrl, onImageError } = useNewsArticleImage(article);
  return (
    <FeedLead
      href={article.url}
      image={imageUrl}
      onImageError={onImageError}
      fallbackIcon={Newspaper}
      title={article.title}
    >
      {article.description ? <p className="feed-lead__description">{article.description}</p> : null}
      <div className="feed-lead__byline">
        <span className="feed-lead__meta">
          <NewsByline article={article} />
        </span>
        <DisableFeedButton article={article} onDisableFeed={onDisableFeed} className="" />
      </div>
    </FeedLead>
  );
}
