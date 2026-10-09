import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Heart, Pause, Play } from "lucide-react";
import { LibraryItemMenu } from "./LibraryItemMenu";
import Tooltip from "./Tooltip";
import TooltipButton from "./TooltipButton";

const SORTABLE_HEADINGS = {
  number: "index",
  title: "song",
  artist: "artist",
  album: "album",
};

export function FavoriteButton({ active, pending, label, onClick, className = "" }) {
  return (
    <TooltipButton
      className={"native-library-favorite " + className + (active ? " is-active" : "")}
      onClick={onClick}
      disabled={pending}
      label={active ? "Remove from favorites" : "Add to favorites"}
      aria-label={active ? "Remove " + label + " from favorites" : "Add " + label + " to favorites"}
      aria-pressed={active}
    >
      <Heart aria-hidden="true" fill={active ? "currentColor" : "none"} />
    </TooltipButton>
  );
}

function PlayingIndicator({ row }) {
  const state = row.loading ? "loading" : row.playing ? "playing" : "paused";
  return (
    <span className={`track-playing-indicator is-${state}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function TrackCover({ cover, indicator = null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [cover?.src]);
  const label = cover?.label || "";
  const content =
    cover?.src && !failed ? (
      <img src={cover.src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    ) : (
      <span className="native-library-cover-fallback is-compact" aria-hidden="true">
        {label.trim().charAt(0).toUpperCase() || "—"}
      </span>
    );
  const overlay = indicator ? (
    <span className="native-library-track__cover-indicator">{indicator}</span>
  ) : null;
  if (cover?.onOpen) {
    return (
      <button
        type="button"
        className="native-library-track__cover"
        onClick={cover.onOpen}
        aria-label={`Open ${label || "album"}`}
      >
        {content}
        {overlay}
      </button>
    );
  }
  return (
    <span className="native-library-track__cover">
      {content}
      {overlay}
    </span>
  );
}

function TrackLink({ link, className }) {
  if (!link?.label) return <span className={`native-library-track__link ${className}`} />;
  if (!link.onOpen) {
    return <span className={`native-library-track__link ${className}`}>{link.label}</span>;
  }
  return (
    <button type="button" className={`native-library-track__link ${className}`} onClick={link.onOpen}>
      {link.label}
    </button>
  );
}

function HeadingCell({ id, label, sort, className = "" }) {
  const sortKey = SORTABLE_HEADINGS[id];
  if (!sort || !sortKey) return <span className={className}>{label}</span>;
  const active = sort.key === sortKey;
  const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <span className={className} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="native-library-track__sort" onClick={() => sort.onSort(sortKey)}>
        {label}
        {active ? <Icon aria-hidden="true" /> : null}
      </button>
    </span>
  );
}

export function TrackList({
  label,
  rows,
  variant = "collection",
  sort = null,
  selection = null,
  highlightKey = null,
}) {
  const rowRefs = useRef({});
  const isCollection = variant === "collection";

  useEffect(() => {
    if (!highlightKey) return undefined;
    const row = rowRefs.current[String(highlightKey)];
    if (!row) return undefined;
    row.classList.add("is-search-focused");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timeout = window.setTimeout(() => row.classList.remove("is-search-focused"), 2400);
    return () => window.clearTimeout(timeout);
  }, [highlightKey, rows.length]);

  return (
    <div className={`native-library-track-list native-library-track-list--${variant}`}>
      <div
        className="native-library-track native-library-track--heading"
        aria-hidden={sort || selection ? undefined : "true"}
      >
        {selection ? (
          <span className="native-library-track__select">
            <input
              type="checkbox"
              checked={selection.allSelected}
              onChange={selection.onToggleAll}
              aria-label="Select all tracks"
            />
          </span>
        ) : (
          <span />
        )}
        <HeadingCell id="number" label="#" sort={sort} className="native-library-track__number" />
        {isCollection ? <span /> : null}
        <HeadingCell id="title" label="Title" sort={sort} />
        {isCollection ? <HeadingCell id="artist" label="Artist" sort={sort} /> : null}
        {isCollection ? <HeadingCell id="album" label="Album" sort={sort} /> : null}
        <span className="native-library-track__time">Time</span>
        <span />
        <span />
        <span />
      </div>
      <div role="list" aria-label={label}>
        {rows.map((row) => {
          const playLabel = `${row.playing ? "Pause" : "Play"} ${row.title}`;
          return (
            <div
              key={row.key}
              ref={(node) => {
                if (node) rowRefs.current[String(row.key)] = node;
              }}
              className={
                "native-library-track" +
                (row.active ? " is-active" : "") +
                (row.missing ? " is-missing" : "")
              }
              data-library-menu-target={row.menu || row.menuElement ? true : undefined}
              role="listitem"
              aria-current={row.active ? "true" : undefined}
            >
              {selection ? (
                <span className="native-library-track__select">
                  <input
                    type="checkbox"
                    checked={Boolean(row.selected)}
                    onChange={row.onToggleSelected}
                    aria-label={`Select ${row.title}`}
                  />
                </span>
              ) : row.onPlay ? (
                <TooltipButton
                  className="native-library-track__play"
                  onClick={row.onPlay}
                  disabled={row.playDisabled}
                  label={playLabel}
                  aria-label={playLabel}
                >
                  {row.playing ? (
                    <Pause aria-hidden="true" fill="currentColor" />
                  ) : (
                    <Play aria-hidden="true" fill="currentColor" />
                  )}
                </TooltipButton>
              ) : (
                <span aria-hidden="true" />
              )}
              <span className="native-library-track__number" aria-hidden="true">
                {row.active ? <PlayingIndicator row={row} /> : row.number}
              </span>
              {isCollection ? (
                <TrackCover
                  cover={row.cover}
                  indicator={row.active ? <PlayingIndicator row={row} /> : null}
                />
              ) : null}
              <Tooltip content={row.title}>
                {row.onPlay && !row.playDisabled && !selection ? (
                  <button type="button" className="native-library-track__title" onClick={row.onPlay}>
                    <span>
                      {row.badge}
                      {row.title}
                    </span>
                    {row.subtitle ? <small>{row.subtitle}</small> : null}
                  </button>
                ) : (
                  <span className="native-library-track__title">
                    <span>
                      {row.badge}
                      {row.title}
                    </span>
                    {row.subtitle ? <small>{row.subtitle}</small> : null}
                  </span>
                )}
              </Tooltip>
              {isCollection ? <TrackLink link={row.artist} className="native-library-track__artist" /> : null}
              {isCollection ? <TrackLink link={row.album} className="native-library-track__album" /> : null}
              <span className={"native-library-track__time" + (row.timeMissing ? " is-missing" : "")}>
                {row.time}
              </span>
              {row.trailing || <span />}
              {selection ? (
                <span />
              ) : row.menuElement ? (
                row.menuElement
              ) : row.menu ? (
                <LibraryItemMenu label={row.title || "Track"} {...row.menu} />
              ) : (
                <span />
              )}
              {row.favorite && !selection ? (
                <FavoriteButton
                  className="native-library-track__favorite"
                  active={row.favorite.active}
                  pending={row.favorite.pending}
                  label={row.title || "track"}
                  onClick={row.favorite.onToggle}
                />
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
