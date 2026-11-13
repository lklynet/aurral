import ArtworkImage from "./ArtworkImage";
import { useEffect, useId, useState, type RefObject } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SortableList } from "./SortableList";
import { GripVertical, ListMusic, Music, X } from "./icons";
import { useAudioQueue, type AudioQueueValue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import TooltipButton from "./TooltipButton";
import PlayerLyrics from "./PlayerLyrics";
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
      { message: "Up next cleared", action: { label: "Undo", onClick: undo } },
      "success",
      8000,
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

export type PlayerPanelView = "queue" | "lyrics";

const PANEL_VIEWS = [
  { id: "queue", label: "Queue" },
  { id: "lyrics", label: "Lyrics" },
] as const satisfies readonly { id: PlayerPanelView; label: string }[];

interface PlayerQueuePanelProps {
  id: string;
  view: PlayerPanelView;
  onViewChange: (view: PlayerPanelView) => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}

export function PlayerQueuePanel({
  id,
  view,
  onViewChange,
  onClose,
  closeRef,
}: PlayerQueuePanelProps) {
  const { currentTrack, source } = useAudioQueue();
  const tabsId = useId();
  const playingFrom = currentTrack?.queueSource?.label ?? source?.label;
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const mainWrap = document.querySelector(".app-main-wrap");
    if (!mainWrap) return undefined;
    const observer = new ResizeObserver(() => setHeight(mainWrap.getBoundingClientRect().height));
    observer.observe(mainWrap);
    return () => observer.disconnect();
  }, []);

  if (!currentTrack) return null;

  return (
    <aside
      id={id}
      className="player-queue"
      aria-label="Player panel"
      style={height ? { "--player-queue-height": `${height}px` } : undefined}
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
              onClick={() => onViewChange(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <TooltipButton
          ref={closeRef}
          title="Close panel"
          aria-label="Close panel"
          className="btn btn-ghost btn-icon btn-xs"
          onClick={onClose}
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
        {view === "lyrics" ? (
          <PlayerLyrics key={currentTrack.entryId} track={currentTrack} variant="panel" />
        ) : (
          <div className="player-queue__body">
            <section className="player-queue__section" aria-label="Now playing">
              <h3 className="player-queue__heading">Now playing</h3>
              <div className="player-queue__now">
                <QueueArt src={currentTrack.artwork} />
                <span className="player-queue__copy">
                  <span className="player-queue__name">{currentTrack.title}</span>
                  {currentTrack.artist ? (
                    <span className="player-queue__artist">{currentTrack.artist}</span>
                  ) : null}
                </span>
              </div>
              {playingFrom ? (
                <p className="player-queue__source">Playing from {playingFrom}</p>
              ) : null}
            </section>
            <UpNextQueue />
          </div>
        )}
      </div>
    </aside>
  );
}
