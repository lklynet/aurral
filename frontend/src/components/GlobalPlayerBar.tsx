import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router";
import { albumPath } from "../../../lib/albumPath.ts";
import {
  ChevronDown,
  Download,
  Ellipsis,
  ListMusic,
  Mic,
  Music,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Share,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "./icons";
import { useAudioQueue } from "../contexts/audioQueueContext";
import TooltipButton from "./TooltipButton";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { PlayerQueuePanel, UpNextQueue, type PlayerPanelView } from "./PlayerQueue";
import PlayerLyrics from "./PlayerLyrics";
import { PlayerMiniProgress, PlayerSeek } from "./PlayerProgress";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { PLAYER_SHORTCUTS, usePlayerShortcuts } from "../hooks/usePlayerShortcuts.ts";
import { useNowPlayingTitle } from "../hooks/useDocumentTitle";
import { useLibraryShareAction, useShareAction } from "../hooks/useShareAction.ts";
import { useCollectionTint } from "./CollectionHeader";
import ArtworkImage from "./ArtworkImage";
import PreviewChip from "./PreviewChip";
import { DotLoader } from "./DotLoader";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { useAddTrackToLibrary } from "../hooks/useAddTrackToLibrary";
import { trackDownloadActionLabel } from "../pages/library/libraryShared.tsx";
import { useStartRadio } from "../hooks/useQueueTrackActions";
import { radioSeedFor } from "../utils/audioQueue";

const SHEET_EXIT_MS = 260;
const SHEET_DISMISS_DISTANCE = 120;
const SHEET_TAP_DISTANCE = 8;
const SEEK_SHORTCUT_SECONDS = 5;
type PlayerTrack = NonNullable<ReturnType<typeof useAudioQueue>["currentTrack"]>;

function PreviewDownloadButton({
  track,
  className,
  tooltipPlacement,
}: {
  track: PlayerTrack;
  className: string;
  tooltipPlacement?: "top";
}) {
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();
  const { isAlbumDownloading, isTrackDownloading } = useActiveDownloads();
  const payload = track.download;
  if (!payload?.artistName || !payload.trackName) return null;
  const key = String(track.id);
  const sending = savingKeys.has(key);
  const busy =
    sending || isTrackDownloading(payload) || isAlbumDownloading(payload.albumMbid || null);
  const label = busy
    ? trackDownloadActionLabel(sending ? "submitting" : "downloading")
    : "Download full track";
  return (
    <TooltipButton
      className={className}
      tooltipPlacement={tooltipPlacement}
      onClick={() => void addTrackToLibrary(payload, key)}
      disabled={busy}
      label={label}
      aria-label={`${label}: ${track.title}`}
    >
      {busy ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
    </TooltipButton>
  );
}
function GlobalPlayerBar() {
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
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
  const sharePlain = useShareAction();
  const shareLibrary = useLibraryShareAction();
  const startRadio = useStartRadio();
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetLyrics, setSheetLyrics] = useState(false);
  const [panel, setPanel] = useState<PlayerPanelView | null>(null);
  const queuePanelId = useId();
  const queueTriggerRef = useRef<HTMLButtonElement>(null);
  const lyricsTriggerRef = useRef<HTMLButtonElement>(null);
  const queueCloseRef = useRef<HTMLButtonElement>(null);
  const closeQueue = useCallback(() => {
    (panel === "lyrics" ? lyricsTriggerRef : queueTriggerRef).current?.focus({
      preventScroll: true,
    });
    setPanel(null);
  }, [panel]);
  const togglePanel = (view: PlayerPanelView) => (panel === view ? closeQueue() : setPanel(view));
  const [sheetPresence, setSheetPresence] = useState("closed");
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startY: number; fromArt: boolean } | null>(null);
  const draggedRef = useRef(false);
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const sheetQueueRef = useRef<HTMLDivElement>(null);
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
    setPanel(null);
  }, [isActive]);

  const queueOpen = panel !== null;

  useEffect(() => {
    if (queueOpen) queueCloseRef.current?.focus({ preventScroll: true });
  }, [queueOpen]);

  useEffect(() => {
    if (!queueOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".player-queue__item.is-dragging")) return;
      const panelElement = document.getElementById(queuePanelId);
      const target = event.target instanceof Node ? event.target : null;
      const onTrigger = target === queueTriggerRef.current || target === lyricsTriggerRef.current;
      if (!panelElement?.contains(target) && !onTrigger) return;
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
      else setPanel(null);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    let frameId: number | undefined;
    let timeoutId: number | undefined;
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

  const seekBy = (offset: number) => {
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
    lyrics: () => {
      if (window.matchMedia("(min-width: 768px)").matches) togglePanel("lyrics");
    },
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
  const albumRef = albumMbid || String(currentTrack.libraryAlbumId ?? "").trim();
  const albumLink = albumRef ? albumPath(albumRef) : "";
  const canShareTrack = Boolean(currentTrack.title && artistLabel);
  const shareTrack = () =>
    (currentTrack.libraryTrackId ? shareLibrary : sharePlain)(
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
      currentTrack.title!,
    );
  const canStartRadio = !currentTrack.isPreview;
  const startTrackRadio = () =>
    startRadio(radioSeedFor([currentTrack]), {
      label: currentTrack.title || "Track",
      first: currentTrack,
    });
  const metaLink = (label: string, path: string) =>
    label ? (
      path ? (
        <Link to={path} className="global-player__link">
          {label}
        </Link>
      ) : (
        label
      )
    ) : null;

  const handleVolumeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Math.min(Math.max(Number(event.target.value) || 0, 0), 100);
    setVolume(nextVolume / 100);
  };

  const handleSheetPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button:not(.now-playing__art-button), a, input")) return;
    if (!target?.closest(".now-playing__header, .now-playing__art")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      fromArt: Boolean(target.closest(".now-playing__art-button")),
    };
    draggedRef.current = false;
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSheetPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    setDragOffset(Math.max(0, event.clientY - dragRef.current.startY));
  };

  const handleSheetPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const distance = event.clientY - dragRef.current.startY;
    const { fromArt } = dragRef.current;
    dragRef.current = null;
    draggedRef.current = Math.abs(distance) > SHEET_TAP_DISTANCE;
    if (event.type === "pointerup" && fromArt && !draggedRef.current) setSheetLyrics(true);
    setIsDragging(false);
    if (event.type === "pointerup" && distance > SHEET_DISMISS_DISTANCE) {
      setSheetOpen(false);
      return;
    }
    setDragOffset(0);
  };

  const artwork = (className: string, thumbnail = true) => (
    <span className={className} aria-hidden="true">
      {currentTrack.artwork && currentTrack.artwork !== failedArtwork ? (
        <ArtworkImage
          src={currentTrack.artwork}
          thumbnail={thumbnail}
          sizes="3rem"
          alt=""
          loading="eager"
          onError={() => setFailedArtwork(currentTrack.artwork)}
        />
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
              {playbackError ||
                [currentTrack.isPreview ? "Preview" : "", artistLabel, albumLabel]
                  .filter(Boolean)
                  .join(" · ")}
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

      {sheetPresence !== "closed"
        ? createPortal(
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
                  <span className="now-playing__grabber" aria-hidden="true" />
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
                    <LibraryItemMenu
                      label={currentTrack.title || "Track"}
                      contextMenu={false}
                      triggerIcon={<Ellipsis aria-hidden="true" />}
                      triggerLabel="More"
                      triggerClassName="now-playing__icon-button"
                      items={[
                        ...(canShareTrack
                          ? [
                              {
                                id: "share",
                                label: "Share track",
                                icon: Share,
                                onSelect: shareTrack,
                              },
                            ]
                          : []),
                        {
                          id: "stop",
                          label: "Stop and clear queue",
                          icon: X,
                          danger: true,
                          onSelect: clearQueue,
                        },
                      ]}
                    />
                  </span>
                </div>

                <div className="now-playing__body">
                  {sheetLyrics ? (
                    <PlayerLyrics key={currentTrack.entryId} track={currentTrack} variant="sheet" />
                  ) : (
                    <button
                      type="button"
                      className="now-playing__art-button"
                      aria-label="Show lyrics"
                      onClick={() => {
                        if (!draggedRef.current) setSheetLyrics(true);
                        draggedRef.current = false;
                      }}
                    >
                      {artwork("global-player__art now-playing__art", false)}
                    </button>
                  )}

                  <div className="now-playing__meta">
                    <h2 className="now-playing__title">{currentTrack.title}</h2>
                    {currentTrack.isPreview ? (
                      <div className="global-player__title-row">
                        <PreviewChip />
                        <PreviewDownloadButton
                          track={currentTrack}
                          className="global-player__preview-download"
                        />
                      </div>
                    ) : null}
                    {artistLabel || albumLabel ? (
                      <p className="now-playing__subtitle">
                        {metaLink(artistLabel, artistPath)}
                        {artistLabel && albumLabel ? " · " : null}
                        {metaLink(albumLabel, albumLink)}
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
                      {repeatMode === "one" ? (
                        <Repeat1 aria-hidden="true" />
                      ) : (
                        <Repeat aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  <div className="now-playing__actions">
                    <button
                      type="button"
                      className={`now-playing__icon-button now-playing__lyrics-toggle${sheetLyrics ? " is-active" : ""}`}
                      onClick={() => setSheetLyrics((current) => !current)}
                      aria-pressed={sheetLyrics}
                      aria-label="Lyrics"
                    >
                      <Mic aria-hidden="true" />
                    </button>
                    {canStartRadio ? (
                      <button
                        type="button"
                        className="now-playing__icon-button"
                        onClick={startTrackRadio}
                        aria-label="Start radio"
                      >
                        <Radio aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="now-playing__icon-button"
                      onClick={() =>
                        sheetQueueRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        })
                      }
                      aria-label="Up next"
                    >
                      <ListMusic aria-hidden="true" />
                    </button>
                  </div>

                  <div ref={sheetQueueRef}>
                    <UpNextQueue className="now-playing__queue" />
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {panel ? (
        <PlayerQueuePanel
          id={queuePanelId}
          view={panel}
          onViewChange={setPanel}
          onClose={closeQueue}
          closeRef={queueCloseRef}
        />
      ) : null}

      <div className="global-player__inner">
        <div className="global-player__track">
          {artwork("global-player__art global-player__art--bar")}
          <div className="global-player__meta">
            <div className="global-player__title-row">
              <span className="global-player__title">{currentTrack.title}</span>
              {currentTrack.isPreview ? <PreviewChip /> : null}
            </div>
            {artistLabel || albumLabel ? (
              <span className="global-player__subtitle">
                {metaLink(artistLabel, artistPath)}
                {artistLabel && albumLabel ? " · " : null}
                {metaLink(albumLabel, albumLink)}
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
              {isPlaying ? (
                <Pause className="artist-icon-sm" />
              ) : (
                <Play className="artist-icon-sm" />
              )}
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
          {currentTrack.isPreview ? (
            <PreviewDownloadButton
              track={currentTrack}
              className="btn btn-ghost btn-icon btn-xs"
              tooltipPlacement="top"
            />
          ) : null}
          {canStartRadio ? (
            <TooltipButton
              tooltipPlacement="top"
              label="Start radio"
              onClick={startTrackRadio}
              className="btn btn-ghost btn-icon btn-xs"
            >
              <Radio className="artist-icon-sm" />
            </TooltipButton>
          ) : null}
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
            ref={lyricsTriggerRef}
            title={`${panel === "lyrics" ? "Hide lyrics" : "Show lyrics"} (${PLAYER_SHORTCUTS.lyrics.label})`}
            aria-label="Lyrics"
            aria-keyshortcuts={PLAYER_SHORTCUTS.lyrics.keys}
            aria-expanded={panel === "lyrics"}
            aria-controls={panel === "lyrics" ? queuePanelId : undefined}
            onClick={() => togglePanel("lyrics")}
            className={`btn btn-ghost btn-icon btn-xs global-player__panel-toggle${panel === "lyrics" ? " is-active" : ""}`}
          >
            <Mic className="artist-icon-sm" />
          </TooltipButton>
          <TooltipButton
            tooltipPlacement="top"
            ref={queueTriggerRef}
            title={panel === "queue" ? "Hide queue" : "Show queue"}
            aria-label="Queue"
            aria-expanded={panel === "queue"}
            aria-controls={panel === "queue" ? queuePanelId : undefined}
            onClick={() => togglePanel("queue")}
            className={`btn btn-ghost btn-icon btn-xs global-player__panel-toggle${panel === "queue" ? " is-active" : ""}`}
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
