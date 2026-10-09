import { Pause, Play, Shuffle } from "lucide-react";
import { useArtworkWash } from "../utils/imageColors";
import TooltipButton from "./TooltipButton";
import { useSharedArtworkStyle } from "../navigation/viewTransitions.js";

export function useCollectionTint(src) {
  const wash = useArtworkWash(src || null);
  return wash ? `light-dark(${wash.light}, ${wash.dark})` : null;
}

export function CollectionPage({ tintSrc, tintColor = null, className = "", children }) {
  const tint = useCollectionTint(tintSrc) || tintColor;
  return (
    <div
      className={`library-page native-library-page collection-page${className ? ` ${className}` : ""}`}
      style={tint ? { "--collection-tint": tint } : undefined}
    >
      <div className="native-library-content">
        <div className="native-library-detail">{children}</div>
      </div>
    </div>
  );
}

export function CollectionPlayButtons({ label, disabled, isPlaying, isShuffleEnabled, onPlay, onShuffle }) {
  return (
    <>
      <button
        type="button"
        className="native-library-page-play"
        onClick={onPlay}
        disabled={disabled}
        aria-label={`${isPlaying ? "Pause" : "Play"} ${label}`}
      >
        {isPlaying ? (
          <Pause aria-hidden="true" fill="currentColor" />
        ) : (
          <Play aria-hidden="true" fill="currentColor" />
        )}
        {isPlaying ? "Pause" : "Play"}
      </button>
      {onShuffle ? (
        <TooltipButton
          className={`native-library-favorite collection-header__shuffle${isShuffleEnabled ? " is-active" : ""}`}
          onClick={onShuffle}
          disabled={disabled}
          label={`Shuffle ${label}`}
          aria-label={`Shuffle ${label}`}
        >
          <Shuffle aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </>
  );
}

export function CollectionHeader({ cover, kicker, title, subtitle, meta, status, actions, corner }) {
  const artworkStyle = useSharedArtworkStyle();
  return (
    <header className="native-library-detail__hero collection-header">
      {corner ? <div className="collection-header__corner">{corner}</div> : null}
      <div className="native-library-detail__cover" style={artworkStyle}>{cover}</div>
      <div className="native-library-detail__body">
        {kicker ? <p className="native-library-kicker">{kicker}</p> : null}
        <h1 className="collection-header__title">{title}</h1>
        {typeof subtitle === "string" ? (
          <p className="collection-header__description">{subtitle}</p>
        ) : subtitle ? (
          <div className="collection-header__subtitle">{subtitle}</div>
        ) : null}
        {meta ? <p className="native-library-detail__meta">{meta}</p> : null}
        {status}
        {actions ? <div className="native-library-detail__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
