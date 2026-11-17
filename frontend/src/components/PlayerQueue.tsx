import ArtworkImage from "./ArtworkImage";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SortableList } from "./SortableList";
import { ChevronLeft, GripVertical, ListMusic, Music, Plus, X } from "./icons";
import { useAudioQueue, type AudioQueueValue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import TooltipButton from "./TooltipButton";
import PlayerLyrics from "./PlayerLyrics";
import PlayerFriends, { FriendsDialog, useFriends } from "./PlayerFriends";
import PlayerOriginLink from "./PlayerOriginLink";
import PillToggle from "./PillToggle";
import { isAutoplayEntry } from "../utils/audioQueue";
import { useAuth } from "../contexts/AuthContext";
import { CreatePlaylistModal } from "./PlaylistModals";
import { useTrackSaveActions } from "../hooks/useTrackSaveActions";
import { reserveUniquePlaylistName } from "../utils/staticPlaylists.ts";

type QueueEntry = AudioQueueValue["upcoming"][number];

function QueueArt({ src }: { src?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className="player-queue__art" aria-hidden="true">
      {src && src !== failedSrc ? (
        <ArtworkImage
          src={src}
          sizes="3rem"
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <Music />
      )}
    </span>
  );
}

interface QueueRowProps {
  entry: QueueEntry;
  onPlay: (index: number) => void;
  onRemove: (entryId: string) => void;
}

function QueueRow({ entry, onPlay, onRemove }: QueueRowProps) {
  const { track } = entry;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.entryId });
  const title = track.title || "Track";

  return (
    <li
      ref={setNodeRef}
      className={`player-queue__item${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="player-queue__handle"
        aria-label={`Reorder ${title}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" />
      </button>
      <button type="button" className="player-queue__track" onClick={() => onPlay(entry.index)}>
        <QueueArt src={track.artwork} />
        <span className="player-queue__copy">
          <span className="player-queue__name">{title}</span>
          {track.artist ? <span className="player-queue__artist">{track.artist}</span> : null}
        </span>
      </button>
      <TooltipButton
        title="Remove from queue"
        aria-label={`Remove ${title} from queue`}
        className="player-queue__remove"
        onClick={() => onRemove(track.entryId)}
      >
        <X aria-hidden="true" />
      </TooltipButton>
    </li>
  );
}

interface QueueListProps {
  entries: QueueEntry[];
  className?: string;
  onReorder: (entryIds: string[]) => void;
}

function QueueList({ entries, className = "", onReorder }: QueueListProps) {
  const { skipTo, removeFromQueue } = useAudioQueue();
  return (
    <SortableList
      ids={entries.map(({ track }) => track.entryId)}
      titleOf={(id) => entries.find(({ track }) => track.entryId === id)?.track.title || "Track"}
      onReorder={onReorder}
    >
      <ol className={`player-queue__list ${className}`.trim()}>
        {entries.map((entry) => (
          <QueueRow
            key={entry.track.entryId}
            entry={entry}
            onPlay={skipTo}
            onRemove={removeFromQueue}
          />
        ))}
      </ol>
    </SortableList>
  );
}

const entryIdsOf = (entries: QueueEntry[]) => entries.map(({ track }) => track.entryId);

type QueueTrack = QueueEntry["track"];

function SaveQueueButton({ tracks }: { tracks: QueueTrack[] }) {
  const { playlists, onBulkAddToPlaylist, bulkActionLoading } = useTrackSaveActions();
  const [open, setOpen] = useState(false);
  if (!onBulkAddToPlaylist) return null;

  const save = async (name: string) => {
    await onBulkAddToPlaylist(
      tracks.map((track) => ({
        id: track.entryId,
        artistName: track.artist ?? "",
        trackName: track.title ?? "",
        albumName: track.album,
        artistMbid: track.artistMbid,
        albumMbid: track.albumMbid,
        trackMbid: track.trackMbid,
        durationMs: track.durationMs,
      })),
      { mode: "new", name },
    );
    setOpen(false);
  };

  return (
    <>
      <TooltipButton
        label="Save as playlist"
        className="btn btn-ghost btn-icon btn-xs"
        onClick={() => setOpen(true)}
      >
        <ListMusic aria-hidden="true" />
      </TooltipButton>
      <CreatePlaylistModal
        open={open}
        defaultName={reserveUniquePlaylistName(playlists, "Queue")}
        saving={bulkActionLoading}
        onClose={() => setOpen(false)}
        onSubmit={save}
      />
    </>
  );
}

export function UpNextQueue({ className = "" }: { className?: string }) {
  const {
    currentTrack,
    upcoming,
    reorderUpcoming,
    clearUpcoming,
    autoplayEnabled,
    setAutoplayEnabled,
  } = useAudioQueue();
  const { hasPermission } = useAuth();
  const { addToast } = useToast();
  const headingId = useId();
  const autoplayHeadingId = useId();
  const queued = upcoming.filter(({ track }) => !isAutoplayEntry(track));
  const autoplayed = upcoming.filter(({ track }) => isAutoplayEntry(track));
  const savable = [
    ...(currentTrack && !isAutoplayEntry(currentTrack) ? [currentTrack] : []),
    ...queued.map(({ track }) => track),
  ];

  const handleClear = () => {
    const undo = clearUpcoming();
    addToast(
      { message: "Up next cleared", action: { label: "Undo", onClick: undo }, duration: 8000 },
      "success",
    );
  };

  return (
    <div className={`player-queue__upcoming ${className}`.trim()}>
      <section className="player-queue__section" aria-labelledby={headingId}>
        <div className="player-queue__section-header">
          <h3 id={headingId} className="player-queue__heading">
            Up next
          </h3>
          <div className="player-queue__section-actions">
            {savable.length > 0 && hasPermission("accessPlaylists") ? (
              <SaveQueueButton tracks={savable} />
            ) : null}
            {queued.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs player-queue__clear"
                onClick={handleClear}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
        {queued.length === 0 ? (
          <p className="player-queue__empty">Use Play next or Add to queue in a track menu.</p>
        ) : (
          <QueueList
            entries={queued}
            onReorder={(order) => reorderUpcoming([...order, ...entryIdsOf(autoplayed)])}
          />
        )}
      </section>
      <section className="player-queue__section" aria-labelledby={autoplayHeadingId}>
        <div className="player-queue__section-header">
          <h3 id={autoplayHeadingId} className="player-queue__heading">
            Autoplay
          </h3>
          <PillToggle
            className="player-queue__autoplay-toggle"
            checked={autoplayEnabled}
            onChange={(event) => setAutoplayEnabled(event.target.checked)}
            aria-label="Autoplay similar music when the queue ends"
          />
        </div>
        {autoplayed.length > 0 ? (
          <QueueList
            entries={autoplayed}
            className="player-queue__list--autoplay"
            onReorder={(order) => reorderUpcoming([...entryIdsOf(queued), ...order])}
          />
        ) : null}
      </section>
    </div>
  );
}

export type PlayerPanelView = "queue" | "lyrics" | "friends";

const PANEL_VIEWS = [
  { id: "queue", label: "Queue" },
  { id: "lyrics", label: "Lyrics" },
  { id: "friends", label: "Friends" },
] as const satisfies readonly { id: PlayerPanelView; label: string }[];

const RAIL_OPEN_KEY = "playerRailOpen";
const RAIL_VIEW_KEY = "playerRailView";
const DOCKED_QUERY = "(min-width: 1024px)";
const RAIL_EXIT_MS = 260;

function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function usePlayerRail() {
  const id = useId();
  const edgeRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [open, setOpenState] = useState(
    () => window.matchMedia(DOCKED_QUERY).matches && readStored(RAIL_OPEN_KEY) === "true",
  );
  const [view, setViewState] = useState<PlayerPanelView>(
    () => PANEL_VIEWS.find((entry) => entry.id === readStored(RAIL_VIEW_KEY))?.id ?? "queue",
  );

  const setOpen = useCallback(
    (next: boolean) => {
      const moveFocus = !next && !!document.getElementById(id)?.contains(document.activeElement);
      flushSync(() => setOpenState(next));
      store(RAIL_OPEN_KEY, String(next));
      if (moveFocus) edgeRef.current?.focus({ preventScroll: true });
    },
    [id],
  );

  const setView = useCallback((next: PlayerPanelView) => {
    setViewState(next);
    store(RAIL_VIEW_KEY, next);
  }, []);

  const show = useCallback(
    (next: PlayerPanelView) => {
      setView(next);
      setOpen(true);
    },
    [setOpen, setView],
  );

  return { id, open, view, edgeRef, closeRef, setOpen, setView, show };
}

export type PlayerRailState = ReturnType<typeof usePlayerRail>;

function PlayerRailEdge({ rail, hidden }: { rail: PlayerRailState; hidden: boolean }) {
  return (
    <TooltipButton
      ref={rail.edgeRef}
      label="Show panel"
      className={`btn btn-ghost player-rail-edge${hidden ? " is-open" : ""}`}
      onClick={() => rail.setOpen(true)}
    >
      <ChevronLeft />
    </TooltipButton>
  );
}

export function PlayerRail({ rail }: { rail: PlayerRailState }) {
  const [mounted, setMounted] = useState(rail.open);
  const [expanded, setExpanded] = useState(rail.open);
  const { edgeRef, closeRef } = rail;
  if (rail.open && !mounted) setMounted(true);
  if (!rail.open && expanded) setExpanded(false);

  useEffect(() => {
    if (rail.open) {
      if (expanded) return undefined;
      let frameId = window.requestAnimationFrame(() => {
        frameId = window.requestAnimationFrame(() => {
          const moveFocus = document.activeElement === edgeRef.current;
          flushSync(() => setExpanded(true));
          if (moveFocus) closeRef.current?.focus({ preventScroll: true });
        });
      });
      return () => window.cancelAnimationFrame(frameId);
    }
    if (!mounted) return undefined;
    const timeoutId = window.setTimeout(() => setMounted(false), RAIL_EXIT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [rail.open, expanded, mounted, edgeRef, closeRef]);

  return (
    <>
      <PlayerRailEdge rail={rail} hidden={expanded} />
      <div className={`player-rail${expanded ? " is-open" : ""}`}>
        {mounted ? <PlayerQueuePanel rail={rail} /> : null}
      </div>
    </>
  );
}

const PlayerQueuePanel = memo(function PlayerQueuePanel({ rail }: { rail: PlayerRailState }) {
  const { currentTrack, activeSource } = useAudioQueue();
  const tabsId = useId();
  const playingFrom = activeSource?.label;
  const [managingFriends, setManagingFriends] = useState(false);
  const friends = useFriends(rail.view === "friends");
  const { view } = rail;

  return (
    <aside
      id={rail.id}
      className="player-queue"
      aria-label="Player panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (document.querySelector(".player-queue__item.is-dragging")) return;
        event.preventDefault();
        rail.setOpen(false);
      }}
    >
      <div className="player-queue__header">
        <div className="player-queue__tabs" role="tablist" aria-label="Player panel">
          {PANEL_VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${tabsId}-${entry.id}`}
              aria-selected={view === entry.id}
              aria-controls={`${tabsId}-panel`}
              className={`player-queue__tab${view === entry.id ? " is-active" : ""}`}
              onClick={() => rail.setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {view === "friends" && friends.data?.state === "linked" ? (
          <TooltipButton
            label="Add friends"
            className="btn btn-ghost btn-icon btn-xs player-queue__header-action"
            onClick={() => setManagingFriends(true)}
          >
            <Plus className="artist-icon-sm" aria-hidden="true" />
          </TooltipButton>
        ) : null}
        <TooltipButton
          ref={rail.closeRef}
          label="Close panel"
          className="btn btn-ghost btn-icon btn-xs"
          onClick={() => rail.setOpen(false)}
        >
          <X className="artist-icon-sm" />
        </TooltipButton>
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${view}`}
        className="player-queue__view"
      >
        {view === "friends" ? (
          <PlayerFriends variant="panel" onManage={() => setManagingFriends(true)} />
        ) : view === "lyrics" ? (
          currentTrack ? (
            <PlayerLyrics key={currentTrack.entryId} track={currentTrack} variant="panel" />
          ) : (
            <div className="player-queue__body">
              <p className="player-queue__empty">Nothing playing</p>
            </div>
          )
        ) : (
          <div className="player-queue__body">
            {currentTrack ? (
              <section className="player-queue__section" aria-label="Now playing">
                <h3 className="player-queue__heading">Now playing</h3>
                <div className="player-queue__now">
                  <QueueArt src={currentTrack.artwork} />
                  <span className="player-queue__copy">
                    <span className="player-queue__name">
                      <PlayerOriginLink className="global-player__link">
                        {currentTrack.title}
                      </PlayerOriginLink>
                    </span>
                    {currentTrack.artist ? (
                      <span className="player-queue__artist">{currentTrack.artist}</span>
                    ) : null}
                  </span>
                </div>
                {playingFrom ? (
                  <p className="player-queue__source">
                    Playing from{" "}
                    <PlayerOriginLink className="global-player__link">
                      {playingFrom}
                    </PlayerOriginLink>
                  </p>
                ) : null}
              </section>
            ) : null}
            <UpNextQueue />
          </div>
        )}
      </div>
      <FriendsDialog open={managingFriends} onClose={() => setManagingFriends(false)} />
    </aside>
  );
});
