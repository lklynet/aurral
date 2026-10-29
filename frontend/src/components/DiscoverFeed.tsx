import type { ComponentType, ReactNode } from "react";
import type { DiscoverFeedStyle } from "../../../lib/discoverLayout.ts";
import { formatDate } from "../utils/dateTime.ts";
import { formatDistance, getEventUrl, getShowDay, type NearbyShow } from "../utils/shows.ts";
import ArtworkImage from "./ArtworkImage";
import { Ban, Music, Newspaper } from "./icons";
import { useNewsArticleImage, type NewsArticle } from "./NewsArticleCard";
import RelativeTime from "./RelativeTime";
import TooltipButton from "./TooltipButton";

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
      meta: joinMeta(place, datePart({ weekday: "short" })),
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

export function NewsFeedTile({
  article,
  feedStyle,
  onDisableFeed,
}: {
  article: NewsArticle;
  feedStyle: DiscoverFeedStyle;
  onDisableFeed?: (sourceUrl: string) => unknown;
}) {
  const { imageUrl, onImageError } = useNewsArticleImage(article);
  const publisher = article.source.trim();
  const published = new Date(article.publishedAt);
  const byline = joinMeta(article.artists.map((artist) => artist.artistName).join(", "), publisher);

  return (
    <FeedTile
      feedStyle={feedStyle}
      href={article.url}
      label={article.title}
      image={imageUrl}
      onImageError={onImageError}
      fallbackIcon={Newspaper}
      title={article.title}
      meta={
        <>
          {byline ? `${byline} · ` : null}
          {Number.isFinite(published.getTime()) ? (
            <RelativeTime value={article.publishedAt} />
          ) : (
            "Recent"
          )}
        </>
      }
      action={
        publisher && article.sourceUrl && onDisableFeed ? (
          <TooltipButton
            label={`Disable ${publisher} RSS feed`}
            className="btn btn-surface btn-icon discover-feed-tile__action"
            onClick={() => void Promise.resolve(onDisableFeed(article.sourceUrl)).catch(() => {})}
          >
            <Ban aria-hidden="true" />
          </TooltipButton>
        ) : null
      }
    />
  );
}
