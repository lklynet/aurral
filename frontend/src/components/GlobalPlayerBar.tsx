import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router";
import { albumPath } from "../../../lib/albumPath.ts";
import {
  ChevronDown,
  ChevronLeft,
  Download,
  Ellipsis,
  Heart,
  Library,
  ListMusic,
  Maximize,
  Mic,
  Users,
  Music,
  Pause,
  Play,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Share,
  Shuffle,
  SkipBack,
  SkipForward,
  Stop,
  Volume2,
  VolumeX,
} from "./icons";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext.tsx";
import { useAuth } from "../contexts/AuthContext.tsx";
import { usePlayerFavorite } from "../hooks/usePlayerFavorite.ts";
import Tooltip from "./Tooltip";
import TooltipButton from "./TooltipButton";
import { LibraryItemMenu, type LibraryMenuItem } from "./LibraryItemMenu";
import { UpNextQueue, type PlayerRailState } from "./PlayerQueue";
import PlayerLyrics from "./PlayerLyrics";
import PlayerFriends, { FriendsDialog } from "./PlayerFriends";
import FullscreenPlayer from "./FullscreenPlayer";
import PlayerOriginLink from "./PlayerOriginLink";
import PlayerDevicesButton from "./PlayerDevicesButton";
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
import { trackDownloadActionLabel } from "../utils/trackDownloadLabel.ts";
import { useStartRadio } from "../hooks/useQueueTrackActions";
import { radioSeedFor } from "../utils/audioQueue";
import { TrackPlaylistSubmenu } from "./TrackPlaylistMenu";
import { useTrackSaveActions } from "../hooks/useTrackSaveActions.ts";
import { buildStaticPlaylistTrackPayload } from "../utils/staticPlaylists.ts";

const SHEET_EXIT_MS = 260;
const SHEET_DISMISS_DISTANCE = 120;
const SHEET_TAP_DISTANCE = 8;
const SEEK_SHORTCUT_SECONDS = 5;

function PreviewDownloadButton({
  payload,
  className,
  tooltipPlacement,
}: {
  payload: SavePayload;
  className: string;
  tooltipPlacement?: "top";
}) {
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();
  const { isAlbumDownloading, isTrackDownloading } = useActiveDownloads();
  if (!payload.artistName || !payload.trackName) return null;
  const key = payload.id;
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
      aria-label={`${label}: ${payload.trackName}`}
    >
      {busy ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
    </TooltipButton>
  );
}
type SavePayload = ReturnType<typeof buildStaticPlaylistTrackPayload> & { id: string };

function PlayerPlaylistSubmenu({
  track,
  separator,
  onClose,
}: {
  track: SavePayload;
  separator: boolean;
  onClose: () => void;
}) {
  const save = useTrackSaveActions();
  const addToPlaylist = save.onAddTrackToPlaylist;
  if (!addToPlaylist) return null;
  return (
    <>
      {separator ? <div className="native-library-item-menu__separator" /> : null}
      <TrackPlaylistSubmenu
        label="Add to playlist"
        icon={Plus}
        track={track}
        playlists={save.playlists}
        loading={save.playlistsLoading}
        saving={save.playlistSavingKey === track.id}
        error={save.playlistMenuError}
        defaultNewPlaylistName={save.getDefaultPlaylistName(track)}
        onSelect={(target) => addToPlaylist(track, target)}
        onClose={onClose}
        toggleOnClick
      />
    </>
  );
}

type GlobalPlayerBarProps = {
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  rail: PlayerRailState;
};

function GlobalPlayerBar({ minimized, onMinimizedChange, rail }: GlobalPlayerBarProps) {
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
  const { addToast } = useToast();
  const favorite = usePlayerFavorite(isActive ? currentTrack : null);
  const { hasPermission } = useAuth();
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetView, setSheetView] = useState<"art" | "lyrics" | "friends">("art");
  const [sheetFriendsDialog, setSheetFriendsDialog] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
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
    setStageOpen(false);
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

  const openStage = () => {
    setSheetOpen(false);
    setStageOpen(true);
  };
  const closeStage = useCallback(() => setStageOpen(false), []);

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
      if (stageOpen || !window.matchMedia("(min-width: 768px)").matches) return;
      if (rail.open && rail.view === "lyrics") rail.setOpen(false);
      else rail.show("lyrics");
    },
    fullscreen: () => (stageOpen ? closeStage() : openStage()),
  });

  useNowPlayingTitle(
    isActive && currentTrack && (isPlaying || isStarting)
      ? [currentTrack.title, currentTrack.artist].filter(Boolean).join(" · ")
      : "",
  );

  const stop = () => {
    const undo = clearQueue();
    addToast(
      { message: "Queue cleared", action: { label: "Undo", onClick: undo }, duration: 8000 },
      "success",
    );
  };
  const minimizedClass = minimized ? " global-player--minimized" : "";
  const minimizeArt = (art: ReactNode) => (
    <TooltipButton
      label="Minimize player"
      onClick={() => onMinimizedChange(true)}
      className="global-player__minimize"
    >
      {art}
      <span className="player-art-hover" aria-hidden="true">
        <ChevronLeft />
      </span>
    </TooltipButton>
  );

  if (!isActive || !currentTrack) {
    return (
      <div
        className={`global-player global-player--empty${minimizedClass}`}
        role="region"
        aria-label="Global audio player"
      >
        <div className="global-player__inner">
          <div className="global-player__track">
            {minimizeArt(
              <span className="global-player__art global-player__art--bar" aria-hidden="true">
                <Music />
              </span>,
            )}
            <div className="global-player__meta">
              <span className="global-player__title">Nothing playing</span>
            </div>
          </div>
          <div className="global-player__main">
            <div className="global-player__controls">
              <TooltipButton
                tooltipPlacement="top"
                disabled
                label="Previous track"
                className="btn btn-secondary btn-sm btn-icon global-player__control"
              >
                <SkipBack className="artist-icon-sm" />
              </TooltipButton>
              <TooltipButton
                tooltipPlacement="top"
                disabled
                label="Play"
                className="btn btn-accent btn-sm btn-icon global-player__control global-player__control--primary"
              >
                <Play className="artist-icon-sm" />
              </TooltipButton>
              <TooltipButton
                tooltipPlacement="top"
                disabled
                label="Next track"
                className="btn btn-secondary btn-sm btn-icon global-player__control"
              >
                <SkipForward className="artist-icon-sm" />
              </TooltipButton>
            </div>
          </div>
          <div className="global-player__side" />
        </div>
      </div>
    );
  }

  const volumePercent = muted ? 0 : Math.round(volume * 100);
  const artistMbid = String(currentTrack.artistMbid || "").trim();
  const albumMbid = String(currentTrack.albumMbid || "").trim();
  const artistLabel = currentTrack.artist || "";
  const albumLabel = currentTrack.album || "";
  const libraryArtistId = String(currentTrack.libraryArtistId ?? "").trim();
  const artistPath = libraryArtistId
    ? `/library/artist/${encodeURIComponent(libraryArtistId)}`
    : artistMbid
      ? `/artist/${artistMbid}`
      : "";
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
  const savePayload: SavePayload = {
    ...(currentTrack.download ??
      buildStaticPlaylistTrackPayload({
        artistName: artistLabel,
        trackName: currentTrack.title || "",
        albumName: albumLabel,
        artistMbid,
        albumMbid,
        trackMbid: currentTrack.trackMbid || "",
        durationMs: currentTrack.durationMs,
      })),
    id: String(currentTrack.id),
  };
  const inLibrary =
    currentTrack.libraryTrackId != null || Boolean(currentTrack.favoriteId?.startsWith("song:"));
  const canAddToLibrary =
    !inLibrary &&
    hasPermission("addAlbum") &&
    Boolean(savePayload.artistName && savePayload.trackName);
  const trackMenuItems: LibraryMenuItem[] = [
    ...(canStartRadio
      ? [{ id: "radio", label: "Start radio", icon: Radio, onSelect: startTrackRadio }]
      : []),
    ...(canShareTrack
      ? [{ id: "share", label: "Share track", icon: Share, onSelect: shareTrack }]
      : []),
    ...(canAddToLibrary
      ? [
          {
            id: "add-to-library",
            label: "Add to library",
            icon: Library,
            separatorBefore: true,
            disabled: savingKeys.has(savePayload.id),
            onSelect: () => addTrackToLibrary(savePayload, savePayload.id),
          },
        ]
      : []),
  ];
  const playlistItemAfter = trackMenuItems.at(-1)?.id;
  const renderPlaylistItem = ({ closeMenu }: { closeMenu: () => void }) => (
    <PlayerPlaylistSubmenu
      track={savePayload}
      separator={!canAddToLibrary && trackMenuItems.length > 0}
      onClose={closeMenu}
    />
  );
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
    if (event.type === "pointerup" && fromArt && !draggedRef.current) setSheetView("lyrics");
    setIsDragging(false);
    if (event.type === "pointerup" && distance > SHEET_DISMISS_DISTANCE) {
      setSheetOpen(false);
      return;
    }
    setDragOffset(0);
  };

  const artworkImage = (thumbnail: boolean) =>
    currentTrack.artwork && currentTrack.artwork !== failedArtwork ? (
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
    );

  const artwork = (className: string, thumbnail = true) => (
    <span className={className} aria-hidden="true">
      {artworkImage(thumbnail)}
    </span>
  );

  const playPauseLabel = isPlaying || isStarting ? "Pause" : "Play";
  const favoriteLabel = favorite?.active ? "Remove from favorites" : "Add to favorites";
  const PlayPauseIcon = isPlaying || isStarting ? Pause : Play;
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one track"
      : repeatMode === "all"
        ? "Repeat all tracks"
        : "Enable repeat";

  return (
    <div
      className={`global-player${minimizedClass}`}
      role="region"
      aria-label="Global audio player"
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
        <PlayerDevicesButton className="global-player__mini-control" />
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
                    <button
                      type="button"
                      className="now-playing__icon-button"
                      onClick={openStage}
                      aria-label="Full screen"
                    >
                      <Maximize aria-hidden="true" />
                    </button>
                    <LibraryItemMenu
                      label={currentTrack.title || "Track"}
                      contextMenu={false}
                      triggerIcon={<Ellipsis aria-hidden="true" />}
                      triggerLabel="More"
                      triggerClassName="now-playing__icon-button"
                      items={[
                        ...trackMenuItems,
                        {
                          id: "stop",
                          label: "Stop and clear queue",
                          icon: Stop,
                          danger: true,
                          separatorBefore: true,
                          onSelect: stop,
                        },
                      ]}
                      additionalItemsAfter={playlistItemAfter}
                      renderAdditionalItems={renderPlaylistItem}
                    />
                  </span>
                </div>

                <div className="now-playing__body">
                  {sheetView === "lyrics" ? (
                    <PlayerLyrics key={currentTrack.entryId} track={currentTrack} variant="sheet" />
                  ) : sheetView === "friends" ? (
                    <PlayerFriends variant="sheet" onManage={() => setSheetFriendsDialog(true)} />
                  ) : (
                    <button
                      type="button"
                      className="now-playing__art-button"
                      aria-label="Show lyrics"
                      onClick={() => {
                        if (!draggedRef.current) setSheetView("lyrics");
                        draggedRef.current = false;
                      }}
                    >
                      {artwork("global-player__art now-playing__art", false)}
                    </button>
                  )}

                  <div className="now-playing__meta">
                    <div className="now-playing__title-row">
                      <h2 className="now-playing__title">
                        <PlayerOriginLink className="global-player__link" onClick={closeSheet}>
                          {currentTrack.title}
                        </PlayerOriginLink>
                      </h2>
                      {favorite ? (
                        <button
                          type="button"
                          className={`now-playing__icon-button now-playing__favorite${favorite.active ? " is-active" : ""}`}
                          onClick={() => void favorite.toggle()}
                          disabled={favorite.pending}
                          aria-pressed={favorite.active}
                          aria-label={favoriteLabel}
                        >
                          <Heart
                            aria-hidden="true"
                            fill={favorite.active ? "currentColor" : "none"}
                          />
                        </button>
                      ) : null}
                    </div>
                    {currentTrack.isPreview ? (
                      <div className="global-player__title-row">
                        <PreviewChip />
                        <PreviewDownloadButton
                          payload={savePayload}
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
                      className={`now-playing__icon-button now-playing__lyrics-toggle${sheetView === "lyrics" ? " is-active" : ""}`}
                      onClick={() =>
                        setSheetView((current) => (current === "lyrics" ? "art" : "lyrics"))
                      }
                      aria-pressed={sheetView === "lyrics"}
                      aria-label="Lyrics"
                    >
                      <Mic aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={`now-playing__icon-button now-playing__friends-toggle${sheetView === "friends" ? " is-active" : ""}`}
                      onClick={() =>
                        setSheetView((current) => (current === "friends" ? "art" : "friends"))
                      }
                      aria-pressed={sheetView === "friends"}
                      aria-label="Friends"
                    >
                      <Users aria-hidden="true" />
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
                    <PlayerDevicesButton className="now-playing__icon-button" />
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

      <FriendsDialog open={sheetFriendsDialog} onClose={() => setSheetFriendsDialog(false)} />

      {stageOpen ? <FullscreenPlayer track={currentTrack} onClose={closeStage} /> : null}

      <div className="global-player__inner">
        <div className="global-player__track">
          {minimizeArt(artwork("global-player__art global-player__art--bar"))}
          <div className="global-player__meta">
            <div className="global-player__title-row">
              <span className="global-player__title">
                <PlayerOriginLink className="global-player__link">
                  {currentTrack.title}
                </PlayerOriginLink>
              </span>
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
              <Tooltip content={playbackError} placement="top">
                <span className="global-player__error" role="alert">
                  {playbackError}
                </span>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="global-player__main">
          <div className="global-player__controls">
            <TooltipButton
              tooltipPlacement="top"
              label="Stop and clear queue"
              onClick={stop}
              className="btn btn-secondary btn-sm btn-icon global-player__control global-player__stop"
            >
              <Stop className="artist-icon-sm" />
            </TooltipButton>
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
            {currentTrack.isPreview ? (
              <PreviewDownloadButton
                payload={savePayload}
                className="btn btn-secondary btn-sm btn-icon global-player__control"
                tooltipPlacement="top"
              />
            ) : (
              <TooltipButton
                tooltipPlacement="top"
                label={favorite ? favoriteLabel : "Only Library tracks can be favorites"}
                aria-pressed={favorite?.active ?? false}
                onClick={favorite ? () => void favorite.toggle() : undefined}
                disabled={!favorite || favorite.pending}
                className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__favorite${favorite?.active ? " is-active" : ""}`}
              >
                <Heart
                  className="artist-icon-sm"
                  fill={favorite?.active ? "currentColor" : "none"}
                />
              </TooltipButton>
            )}
          </div>

          <PlayerSeek variant="bar" />
        </div>

        <div className="global-player__side">
          <PlayerDevicesButton className="btn btn-ghost btn-icon btn-xs" />
          <LibraryItemMenu
            label={currentTrack.title || "Track"}
            contextMenu={false}
            tooltipPlacement="top"
            triggerIcon={<Ellipsis aria-hidden="true" />}
            triggerLabel="More"
            triggerClassName="btn btn-ghost btn-icon btn-xs"
            items={trackMenuItems}
            additionalItemsAfter={playlistItemAfter}
            renderAdditionalItems={renderPlaylistItem}
          />
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
            title={`Full screen (${PLAYER_SHORTCUTS.fullscreen.label})`}
            aria-label="Full screen"
            aria-keyshortcuts={PLAYER_SHORTCUTS.fullscreen.keys}
            onClick={openStage}
            className="btn btn-ghost btn-icon btn-xs"
          >
            <Maximize className="artist-icon-sm" />
          </TooltipButton>
        </div>
      </div>
    </div>
  );
}

export default GlobalPlayerBar;
