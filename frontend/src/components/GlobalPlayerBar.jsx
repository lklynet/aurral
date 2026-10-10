import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router";
import {
  ChevronDown,
  ListMusic,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Share,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import TooltipButton from "./TooltipButton";
import { PlayerQueuePanel, UpNextQueue } from "./PlayerQueue";
import { PlayerMiniProgress, PlayerSeek } from "./PlayerProgress";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { PLAYER_SHORTCUTS, usePlayerShortcuts } from "../hooks/usePlayerShortcuts.js";
import { useNowPlayingTitle } from "../hooks/useDocumentTitle";
import { useShareAction } from "../hooks/useShareAction.js";
import { useCollectionTint } from "./CollectionHeader";

const SHEET_EXIT_MS = 260;
const SHEET_DISMISS_DISTANCE = 120;
const SEEK_SHORTCUT_SECONDS = 5;
function GlobalPlayerBar() {
  const {
    currentTrack,
    playbackError,
    isActive,
    isPlaying,
    isLoading,
    isStarting,
    duration,
    volume,
    muted,
    setVolume,
    toggleMute,
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
  } = useAudioQueue();
  const share = useShareAction();
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const queuePanelId = useId();
  const queueTriggerRef = useRef(null);
  const queueCloseRef = useRef(null);
  const closeQueue = useCallback(() => {
    setQueueOpen(false);
    queueTriggerRef.current?.focus({ preventScroll: true });
  }, []);
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
  const artTint = useCollectionTint(currentTrack?.artwork);

  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (isActive) return;
    setSheetOpen(false);
    setQueueOpen(false);
  }, [isActive]);

  useEffect(() => {
    if (queueOpen) queueCloseRef.current?.focus({ preventScroll: true });
  }, [queueOpen]);

  useEffect(() => {
    if (!queueOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".player-queue__item.is-dragging")) return;
      const panel = document.getElementById(queuePanelId);
      const target = event.target instanceof Node ? event.target : null;
      if (!panel?.contains(target) && target !== queueTriggerRef.current) return;
      event.preventDefault();
      closeQueue();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeQueue, queueOpen, queuePanelId]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setSheetOpen(false);
      else setQueueOpen(false);
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

  const seekBy = (offset) => {
    if (!duration) return;
    const nextPosition = Math.min(Math.max(getPosition() + offset, 0), duration);
    seek(nextPosition);
  };

  usePlayerShortcuts(isActive && Boolean(currentTrack), {
    playPause: togglePlayPause,
    previous: playPrevious,
    next: playNext,
    seekBack: () => seekBy(-SEEK_SHORTCUT_SECONDS),
    seekForward: () => seekBy(SEEK_SHORTCUT_SECONDS),
    mute: toggleMute,
  });

  useNowPlayingTitle(
    isActive && currentTrack && (isPlaying || isStarting)
      ? [currentTrack.title, currentTrack.artist].filter(Boolean).join(" · ")
      : "",
  );

  if (!isActive || !currentTrack) {
    return null;
  }

  const volumePercent = muted ? 0 : Math.round(volume * 100);
  const artistMbid = String(currentTrack.artistMbid || "").trim();
  const albumMbid = String(currentTrack.albumMbid || "").trim();
  const artistLabel = currentTrack.artist || "";
  const albumLabel = currentTrack.album || "";
  const artistPath = artistMbid ? `/artist/${artistMbid}` : "";
  const albumPath = artistMbid && albumMbid ? `/artist/${artistMbid}/release/${albumMbid}` : "";
  const canShareTrack = Boolean(currentTrack.title && artistLabel);
  const shareTrack = () =>
    share(
      {
        kind: "track",
        trackMbid: currentTrack.trackMbid,
        libraryTrackId: currentTrack.libraryTrackId,
        libraryAlbumId: currentTrack.libraryAlbumId,
        albumMbid,
        artistMbid,
        title: currentTrack.title,
        artistName: artistLabel,
        albumTitle: albumLabel,
      },
      currentTrack.title,
    );
  const metaLink = (label, path) =>
    label ? path ? <Link to={path} className="global-player__link">{label}</Link> : label : null;

  const handleVolumeChange = (event) => {
    const nextVolume = Math.min(Math.max(Number(event.target.value) || 0, 0), 100);
    setVolume(nextVolume / 100);
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
        <img src={currentTrack.artwork} alt="" decoding="async" />
      ) : (
        <Music />
      )}
    </span>
  );

  const playPauseLabel = isPlaying || isStarting ? "Pause" : "Play";
  const PlayPauseIcon = isPlaying || isStarting ? Pause : Play;
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one track"
      : repeatMode === "all"
        ? "Repeat all tracks"
        : "Enable repeat";

  return (
    <div
      className="global-player"
      role="region"
      aria-label="Global audio player"
      style={artTint ? { "--player-tint": artTint } : undefined}
    >
      <div className="global-player__mini">
        <PlayerMiniProgress />
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
          aria-busy={isLoading || undefined}
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
              "--now-playing-tint": artTint || "var(--aurral-surface)",
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
              <span className="now-playing__header-actions">
                {canShareTrack ? (
                  <button
                    type="button"
                    className="now-playing__icon-button"
                    onClick={shareTrack}
                    aria-label="Share track"
                  >
                    <Share aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="now-playing__icon-button"
                  onClick={clearQueue}
                  aria-label="Stop and clear queue"
                >
                  <X aria-hidden="true" />
                </button>
              </span>
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

              <PlayerSeek variant="sheet" />

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
                  aria-busy={isLoading || undefined}
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

              <UpNextQueue className="now-playing__queue" />
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {queueOpen ? (
        <PlayerQueuePanel id={queuePanelId} onClose={closeQueue} closeRef={queueCloseRef} />
      ) : null}

      <div className="global-player__inner">
        <div className="global-player__track">
          {artwork("global-player__art global-player__art--bar")}
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
              tooltipPlacement="top"
              label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
              onClick={toggleShuffle}
              className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__shuffle${isShuffleEnabled ? " is-active" : ""}`}
            >
              <Shuffle className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              title={`Previous track (${PLAYER_SHORTCUTS.previous.label})`}
              aria-label="Previous track"
              aria-keyshortcuts={PLAYER_SHORTCUTS.previous.keys}
              onClick={playPrevious}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <SkipBack className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              title={`${playPauseLabel} (${PLAYER_SHORTCUTS.playPause.label})`}
              aria-label={playPauseLabel}
              aria-keyshortcuts={PLAYER_SHORTCUTS.playPause.keys}
              onClick={togglePlayPause}
              className="btn btn-accent btn-sm btn-icon global-player__control global-player__control--primary"
              aria-busy={isLoading || undefined}
            >
              {isPlaying ? <Pause className="artist-icon-sm" /> : <Play className="artist-icon-sm" />}
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
              title={`Next track (${PLAYER_SHORTCUTS.next.label})`}
              aria-label="Next track"
              aria-keyshortcuts={PLAYER_SHORTCUTS.next.keys}
              onClick={playNext}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
            >
              <SkipForward className="artist-icon-sm" />
            </TooltipButton>
            <TooltipButton
              tooltipPlacement="top"
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

          <PlayerSeek variant="bar" />
        </div>

        <div className="global-player__side">
          {canShareTrack ? (
            <TooltipButton
              tooltipPlacement="top"
              label="Share track"
              onClick={shareTrack}
              className="btn btn-ghost btn-icon btn-xs"
            >
              <Share className="artist-icon-sm" />
            </TooltipButton>
          ) : null}
          <TooltipButton
            tooltipPlacement="top"
            ref={queueTriggerRef}
            title={queueOpen ? "Hide queue" : "Show queue"}
            aria-label="Queue"
            aria-expanded={queueOpen}
            aria-controls={queueOpen ? queuePanelId : undefined}
            onClick={() => (queueOpen ? closeQueue() : setQueueOpen(true))}
            className={`btn btn-ghost btn-icon btn-xs global-player__queue-toggle${queueOpen ? " is-active" : ""}`}
          >
            <ListMusic className="artist-icon-sm" />
          </TooltipButton>
          <TooltipButton
            tooltipPlacement="top"
            title={`${volumePercent <= 0 ? "Unmute" : "Mute"} (${PLAYER_SHORTCUTS.mute.label})`}
            aria-label={volumePercent <= 0 ? "Unmute" : "Mute"}
            aria-keyshortcuts={PLAYER_SHORTCUTS.mute.keys}
            onClick={toggleMute}
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
            tooltipPlacement="top"
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
