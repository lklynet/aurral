import type { ReactNode } from "react";
import { Pause, Play } from "../../../components/icons";
import { PlayingIndicator } from "../../../components/TrackList";
import TooltipButton from "../../../components/TooltipButton";

export function formatTrackDuration(durationMs: number | null | undefined) {
  const duration = Number(durationMs || 0);
  if (!Number.isFinite(duration) || duration <= 0) return "";
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ArtistTrackRow({
  number,
  title,
  subtitle = null,
  artwork,
  duration,
  active,
  playing,
  loading = false,
  onPlay,
  menu = null,
}: {
  number: ReactNode;
  title: string;
  subtitle?: string | null;
  artwork?: string | null;
  duration: string;
  active: boolean;
  playing: boolean;
  loading?: boolean;
  onPlay: (() => void) | null;
  menu?: ReactNode;
}) {
  const playLabel = playing ? `Pause ${title}` : `Play ${title}`;
  const indicator = active ? <PlayingIndicator row={{ playing, loading }} /> : null;
  return (
    <div
      className={`artist-track${active ? " is-active" : ""}${onPlay ? "" : " is-unplayable"}`}
      data-library-menu-target={menu ? true : undefined}
      role="listitem"
    >
      <span className="artist-track__lead">
        <span className="artist-track__number" aria-hidden="true">
          {indicator ?? number}
        </span>
        {onPlay ? (
          <TooltipButton
            className="artist-track__play"
            onClick={onPlay}
            label={playLabel}
            aria-label={playLabel}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </TooltipButton>
        ) : null}
      </span>
      {artwork !== undefined ? (
        <span className="artist-track__art">
          {artwork ? <img src={artwork} alt="" loading="lazy" decoding="async" /> : null}
          {indicator ? <span className="artist-track__art-indicator">{indicator}</span> : null}
        </span>
      ) : null}
      {onPlay ? (
        <button type="button" className="artist-track__text" onClick={onPlay} tabIndex={-1}>
          <span className="artist-track__title">{title}</span>
          {subtitle ? <span className="artist-track__subtitle">{subtitle}</span> : null}
        </button>
      ) : (
        <span className="artist-track__text">
          <span className="artist-track__title">{title}</span>
          {subtitle ? <span className="artist-track__subtitle">{subtitle}</span> : null}
        </span>
      )}
      <span className="artist-track__time">{duration}</span>
      {menu ?? <span aria-hidden="true" />}
    </div>
  );
}
