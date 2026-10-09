import { useEffect, useId, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { GripVertical, Music, X } from "lucide-react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import TooltipButton from "./TooltipButton";

function QueueArt({ src }) {
  return (
    <span className="player-queue__art" aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <Music />}
    </span>
  );
}

function QueueRow({ entry, onPlay, onRemove }) {
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

export function UpNextQueue({ className = "" }) {
  const { upcoming, skipTo, removeFromQueue, reorderUpcoming, clearUpcoming } = useAudioQueue();
  const { addToast } = useToast();
  const headingId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const entryIds = upcoming.map(({ track }) => track.entryId);
  const titleOf = (id) => upcoming.find(({ track }) => track.entryId === id)?.track.title || "Track";
  const positionOf = (id) => `position ${entryIds.indexOf(id) + 1} of ${entryIds.length}`;
  const announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)} at ${positionOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} moved to ${positionOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${titleOf(active.id)} dropped at ${positionOf(over.id)}.` : undefined,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${titleOf(active.id)} stays at ${positionOf(active.id)}.`,
  };

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = entryIds.indexOf(active.id);
    const to = entryIds.indexOf(over.id);
    if (from < 0 || to < 0) return;
    reorderUpcoming(arrayMove(entryIds, from, to));
  };

  const handleClear = () => {
    const undo = clearUpcoming();
    addToast(
      { message: "Up next cleared", action: { label: "Undo", onClick: undo } },
      "success",
      8000,
    );
  };

  return (
    <section className={`player-queue__section ${className}`} aria-labelledby={headingId}>
      <div className="player-queue__section-header">
        <h3 id={headingId} className="player-queue__heading">Up next</h3>
        {upcoming.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-xs player-queue__clear" onClick={handleClear}>
            Clear
          </button>
        ) : null}
      </div>
      {upcoming.length === 0 ? (
        <p className="player-queue__empty">
          Nothing is up next. Use Play next or Add to queue in a track menu.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={{ announcements }}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <ol className="player-queue__list">
              {upcoming.map((entry) => (
                <QueueRow
                  key={entry.track.entryId}
                  entry={entry}
                  onPlay={skipTo}
                  onRemove={removeFromQueue}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

export function PlayerQueuePanel({ id, onClose, closeRef }) {
  const { currentTrack, source } = useAudioQueue();
  const titleId = useId();
  const [height, setHeight] = useState(null);

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
      aria-labelledby={titleId}
      style={height ? { "--player-queue-height": `${height}px` } : undefined}
    >
      <div className="player-queue__header">
        <h2 id={titleId} className="player-queue__title">Queue</h2>
        <TooltipButton
          ref={closeRef}
          title="Close queue"
          aria-label="Close queue"
          className="btn btn-ghost btn-icon btn-xs"
          onClick={onClose}
        >
          <X className="artist-icon-sm" />
        </TooltipButton>
      </div>
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
          {source?.label ? (
            <p className="player-queue__source">Playing from {source.label}</p>
          ) : null}
        </section>
        <UpNextQueue />
      </div>
    </aside>
  );
}
