import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import {
  ChevronDown,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import TooltipButton from "./TooltipButton";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { useImageGradientColors } from "../utils/imageColors.js";

const SHEET_EXIT_MS = 260;
const SHEET_DISMISS_DISTANCE = 120;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function GlobalPlayerBar() {
  const {
    currentTrack,
    playbackError,
    isActive,
    isPlaying,
    isLoading,
    duration,
    volume,
    setVolume,
    isShuffleEnabled,
    repeatMode,
    togglePlayPause,
    playNext,
    playPrevious,
    clearQueue,
    toggleShuffle,
    toggleRepeat,
    seek,
    getPosition,
    playbackQueue,
    currentIndex,
    skipTo,
  } = useAudioQueue();
  const [position, setPosition] = useState(0);
  const lastVolumeRef = useRef(volume > 0 ? volume : 0.7);
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetPresence, setSheetPresence] = useState("closed");
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef(null);
  const sheetCloseRef = useRef(null);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const sheetDialog = useModalDialog({
    open: sheetPresence !== "closed",
    onClose: closeSheet,
    initialFocusRef: sheetCloseRef,
  });
  const artColors = useImageGradientColors(sheetPresence !== "closed" ? currentTrack?.artwork : null);

  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isActive) setSheetOpen(false);
  }, [isActive]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setSheetOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    let frameId;
    let timeoutId;
    if (sheetOpen) {
      setSheetPresence("opening");
      frameId = window.requestAnimationFrame(() => setSheetPresence("open"));
    } else {
      setSheetPresence((current) => (current === "closed" ? current : "closing"));
      timeoutId = window.setTimeout(() => setSheetPresence("closed"), SHEET_EXIT_MS);
    }
    setDragOffset(0);
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (volume > 0) {
      lastVolumeRef.current = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (!isActive) {
      setPosition(0);
      return undefined;
    }
    const tick = () => setPosition(getPosition());
    if (!isPlaying) {
      tick();
      return undefined;
    }
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [getPosition, isActive, isPlaying]);

  if (!isActive || !currentTrack) {
    return null;
  }

  const volumePercent = Math.round(volume * 100);
  const progress = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;
  const artistMbid = String(currentTrack.artistMbid || "").trim();
  const albumMbid = String(currentTrack.albumMbid || "").trim();
  const artistLabel = currentTrack.artist || "";
  const albumLabel = currentTrack.album || "";
  const artistPath = artistMbid ? `/artist/${artistMbid}` : "";
  const albumPath = artistMbid && albumMbid ? `/artist/${artistMbid}/release/${albumMbid}` : "";
  const metaLink = (label, path) =>
    label ? path ? <Link to={path} className="global-player__link">{label}</Link> : label : null;

  const handleVolumeChange = (event) => {
    const nextVolume = Math.min(Math.max(Number(event.target.value) || 0, 0), 100);
    if (nextVolume > 0) {
      lastVolumeRef.current = nextVolume / 100;
    }
    setVolume(nextVolume / 100);
  };

  const handleToggleMute = () => {
    if (volume <= 0) {
      const restored = lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.7;
      setVolume(restored);
      return;
    }
    lastVolumeRef.current = volume;
    setVolume(0);
  };

  const handleSeek = (event) => {
    if (!duration) return;
    const nextPosition = Math.min(Math.max(Number(event.currentTarget.value) || 0, 0), duration);
    seek(nextPosition);
    setPosition(nextPosition);
  };

  const handleSheetPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest("button, a, input")) return;
    if (!event.target.closest(".now-playing__header, .now-playing__art")) return;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY };
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSheetPointerMove = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    setDragOffset(Math.max(0, event.clientY - dragRef.current.startY));
  };

  const handleSheetPointerEnd = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const distance = event.clientY - dragRef.current.startY;
    dragRef.current = null;
    setIsDragging(false);
    if (event.type === "pointerup" && distance > SHEET_DISMISS_DISTANCE) {
      setSheetOpen(false);
      return;
    }
    setDragOffset(0);
  };

  const artwork = (className) => (
    <span className={className} aria-hidden="true">
      {currentTrack.artwork ? (
        <img src={currentTrack.artwork} alt="" loading="lazy" />
      ) : (
        <Music />
      )}
    </span>
  );

  const playPauseLabel = isPlaying ? "Pause" : "Play";
  const PlayPauseIcon = isPlaying ? Pause : Play;
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one track"
      : repeatMode === "all"
        ? "Repeat all tracks"
        : "Enable repeat";
  const upNext = playbackQueue
    .map((track, index) => ({ track, index }))
    .slice(currentIndex + 1)
    .concat(
      repeatMode === "all"
        ? playbackQueue.map((track, index) => ({ track, index })).slice(0, currentIndex)
        : [],
    );

  return (
    <div className="global-player" role="region" aria-label="Global audio player">
      <div className="global-player__mini">
        <span className="global-player__mini-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </span>
        <button
          type="button"
          className="global-player__mini-open"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label={`Open now playing: ${currentTrack.title}`}
        >
          {artwork("global-player__art global-player__art--mini")}
          <span className="global-player__mini-copy">
            <span className="global-player__title">{currentTrack.title}</span>
            <span className="global-player__subtitle">
              {playbackError || [artistLabel, albumLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="global-player__mini-control"
          onClick={togglePlayPause}
          disabled={isLoading}
          aria-label={playPauseLabel}
        >
          <PlayPauseIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="global-player__mini-control"
          onClick={playNext}
          aria-label="Next track"
        >
          <SkipForward aria-hidden="true" />
        </button>
      </div>

      {sheetPresence !== "closed" ? createPortal(
        <div
          className={`now-playing-backdrop is-${sheetPresence}`}
          onClick={sheetDialog.handleBackdropClick}
        >
          <div
            ref={sheetDialog.dialogRef}
            className="now-playing"
            role="dialog"
            aria-modal="true"
            aria-label="Now playing"
            tabIndex={-1}
            style={{
              "--now-playing-drag": `${dragOffset}px`,
              "--now-playing-tint": artColors?.top || "var(--aurral-surface)",
            }}
            data-dragging={isDragging || undefined}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={handleSheetPointerEnd}
            onPointerCancel={handleSheetPointerEnd}
          >
            <div className="now-playing__header">
              <button
                ref={sheetCloseRef}
                type="button"
                className="now-playing__icon-button"
                onClick={closeSheet}
                aria-label="Close now playing"
              >
                <ChevronDown aria-hidden="true" />
              </button>
              <span className="now-playing__eyebrow">Now playing</span>
              <button
                type="button"
                className="now-playing__icon-button"
                onClick={clearQueue}
                aria-label="Stop and clear queue"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="now-playing__body">
              {artwork("global-player__art now-playing__art")}

              <div className="now-playing__meta">
                <h2 className="now-playing__title">{currentTrack.title}</h2>
                {artistLabel || albumLabel ? (
                  <p className="now-playing__subtitle">
                    {metaLink(artistLabel, artistPath)}
                    {artistLabel && albumLabel ? " · " : null}
                    {metaLink(albumLabel, albumPath)}
                  </p>
                ) : null}
                {playbackError ? (
                  <p className="now-playing__error" role="alert">
                    {playbackError}
                  </p>
                ) : null}
              </div>

              <div className="now-playing__progress">
                <input
                  type="range"
                  className="now-playing__seek"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(position, duration || 0)}
                  onChange={handleSeek}
                  aria-label="Playback position"
                  aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
                  disabled={!duration}
                  style={{ "--seek-percent": `${progress}%` }}
                />
                <div className="now-playing__times">
                  <span>{formatTime(position)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              <div className="now-playing__controls">
                <button
                  type="button"
                  className={`now-playing__control now-playing__control--toggle${isShuffleEnabled ? " is-active" : ""}`}
                  onClick={toggleShuffle}
                  aria-pressed={isShuffleEnabled}
                  aria-label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
                >
                  <Shuffle aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="now-playing__control"
                  onClick={playPrevious}
                  aria-label="Previous track"
                >
                  <SkipBack aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="now-playing__control now-playing__control--primary"
                  onClick={togglePlayPause}
                  disabled={isLoading}
                  aria-label={playPauseLabel}
                >
                  <PlayPauseIcon aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="now-playing__control"
                  onClick={playNext}
                  aria-label="Next track"
                >
                  <SkipForward aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`now-playing__control now-playing__control--toggle${repeatMode !== "off" ? " is-active" : ""}`}
                  onClick={toggleRepeat}
                  aria-pressed={repeatMode !== "off"}
                  aria-label={repeatLabel}
                >
                  {repeatMode === "one" ? <Repeat1 aria-hidden="true" /> : <Repeat aria-hidden="true" />}
                </button>
              </div>

              {upNext.length > 0 ? (
                <section className="now-playing__queue" aria-label="Up next">
                  <h3 className="now-playing__queue-title">Up next</h3>
                  <ol className="now-playing__queue-list">
                    {upNext.map(({ track, index }) => (
                      <li key={`${track.id}-${index}`}>
                        <button
                          type="button"
                          className="now-playing__queue-item"
                          onClick={() => skipTo(index)}
                        >
                          <span className="now-playing__queue-copy">
                            <span className="now-playing__queue-name">{track.title}</span>
                            {track.artist ? (
                              <span className="now-playing__queue-artist">{track.artist}</span>
                            ) : null}
                          </span>
                          <Play className="now-playing__queue-play" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      <div className="global-player__inner">
        <div className="global-player__track">
          <div className="global-player__meta">
            <div className="global-player__title-row">
              <span className="global-player__title">{currentTrack.title}</span>
            </div>
            {artistLabel || albumLabel ? (
              <span className="global-player__subtitle">
                {metaLink(artistLabel, artistPath)}
                {artistLabel && albumLabel ? " · " : null}
                {metaLink(albumLabel, albumPath)}
              </span>
            ) : null}
            {playbackError ? (
              <span className="global-player__error" role="alert">
                {playbackError}
              </span>
            ) : null}
          </div>
        </div>

        <div className="global-player__main">
          <div className="global-player__controls">
            <TooltipButton
              label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
              onClick={toggleShuffle}
              className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__shuffle${isShuffleEnabled ? " is-active" : ""}`}
            >
              <Shuffle className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              label="Previous track"
              onClick={playPrevious}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <SkipBack className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              label={isPlaying ? "Pause" : "Play"}
              onClick={togglePlayPause}
              className="btn btn-accent btn-sm btn-icon global-player__control global-player__control--primary"
              disabled={isLoading}
            >
              {isPlaying ? <Pause className="artist-icon-sm" /> : <Play className="artist-icon-sm" />}
            </TooltipButton>
            <TooltipButton
              label="Next track"
              onClick={playNext}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <SkipForward className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              label={
                repeatMode === "one"
                  ? "Repeat one track"
                  : repeatMode === "all"
                    ? "Repeat all tracks"
                    : "Enable repeat"
              }
              onClick={toggleRepeat}
              className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__repeat${repeatMode !== "off" ? " is-active" : ""}`}
            >
              {repeatMode === "one" ? (
                <Repeat1 className="artist-icon-sm" />
              ) : (
                <Repeat className="artist-icon-sm" />
              )}
            </TooltipButton>
          </div>

          <div className="global-player__progress-wrap">
            <span className="global-player__progress-time global-player__progress-time--current">
              {formatTime(position)}
            </span>
            <span className="global-player__progress-track" aria-hidden="true">
              <span className="global-player__progress-fill" style={{ width: `${progress}%` }} />
            </span>
            <input
              type="range"
              className="global-player__progress"
              min="0"
              max={duration || 0}
              step="0.1"
              value={Math.min(position, duration || 0)}
              onChange={handleSeek}
              aria-label="Playback position"
              aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
              disabled={!duration}
            />
            <span className="global-player__progress-time global-player__progress-time--duration">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        <div className="global-player__side">
          <TooltipButton
            label={volumePercent <= 0 ? "Unmute" : "Mute"}
            onClick={handleToggleMute}
            className="btn btn-ghost btn-icon btn-xs global-player__volume-toggle"
          >
            {volumePercent <= 0 ? (
              <VolumeX className="artist-icon-sm" />
            ) : (
              <Volume2 className="artist-icon-sm" />
            )}
          </TooltipButton>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={volumePercent}
            onChange={handleVolumeChange}
            className="volume-slider global-player__volume"
            style={{ "--volume-percent": `${volumePercent}%` }}
            aria-label="Volume"
          />
          <TooltipButton
            label="Close player"
            onClick={clearQueue}
            className="btn btn-ghost btn-icon btn-xs global-player__close"
          >
            <X className="artist-icon-sm" />
          </TooltipButton>
        </div>
      </div>
    </div>
  );
}

export default GlobalPlayerBar;
