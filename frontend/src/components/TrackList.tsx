import ArtworkImage from "./ArtworkImage";
import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { defaultRangeExtractor, measureElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clock,
  Flame,
  GripVertical,
  Heart,
  Pause,
  Play,
} from "./icons";
import { SortableList } from "./SortableList";
import { DotLoader } from "./DotLoader";
import PreviewChip from "./PreviewChip";
import type { To } from "react-router";
import { LibraryItemMenu } from "./LibraryItemMenu";
import Tooltip from "./Tooltip";
import TooltipButton from "./TooltipButton";
import RouteLink from "./RouteLink";
import { MainScrollContext } from "../contexts/mainScrollContext.ts";

const SORTABLE_HEADINGS = {
  number: "index",
  title: "song",
  artist: "artist",
  album: "album",
  year: "year",
} as const;

const ROW_SIZE_ESTIMATE = 56;
const SECTION_SIZE_ESTIMATE = 46;
const learnedRowSizes = new Map<string, number>();

type SortableHeading = keyof typeof SORTABLE_HEADINGS;
type SortKey = (typeof SORTABLE_HEADINGS)[SortableHeading];

type TrackSort = {
  key: string;
  direction: "asc" | "desc";
  onSort: (key: SortKey) => void;
};

type TrackSelection = {
  allSelected: boolean;
  onToggleAll: ChangeEventHandler<HTMLInputElement>;
};

type TrackLinkField = {
  label?: string | null;
  to?: To | null;
  state?: unknown;
  onOpen?: (() => void) | null;
};

type TrackCoverField = TrackLinkField & { src?: string | null };

export type TrackListRow = {
  key: string | number;
  section?: string | null;
  title: string;
  number: ReactNode;
  year?: string | null;
  time?: ReactNode;
  timeMissing?: boolean;
  badge?: ReactNode;
  subtitle?: ReactNode;
  detail?: ReactNode;
  reason?: ReactNode;
  addedBy?: string | null;
  trailing?: ReactNode;
  active?: boolean;
  missing?: boolean;
  popular?: boolean;
  status?: { label: string; kind: "active" | "queued" | "missing" } | null;
  playing?: boolean;
  loading?: boolean;
  selected?: boolean;
  onToggleSelected?: ChangeEventHandler<HTMLInputElement>;
  onPlay?: (() => void) | null;
  playDisabled?: boolean;
  previewOnly?: boolean;
  cover?: TrackCoverField | null;
  artist?: TrackLinkField | null;
  album?: TrackLinkField | null;
  menu?: Omit<ComponentProps<typeof LibraryItemMenu>, "label">;
  menuElement?: ReactNode;
  favorite?: { active: boolean; pending: boolean; onToggle: () => void } | null;
};

export function FavoriteButton({
  active,
  pending,
  label,
  onClick,
  className = "",
}: {
  active: boolean;
  pending: boolean;
  label: string;
  onClick: () => void;
  className?: string;
}) {
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

export function PlayingIndicator({ row }: { row: Pick<TrackListRow, "loading" | "playing"> }) {
  const state = row.loading ? "loading" : row.playing ? "playing" : "paused";
  return (
    <span className={`track-playing-indicator is-${state}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function TrackCover({
  cover,
  indicator = null,
}: {
  cover?: TrackCoverField | null;
  indicator?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [cover?.src]);
  const label = cover?.label || "";
  const content =
    cover?.src && !failed ? (
      <ArtworkImage
        src={cover.src}
        sizes="2.5rem"
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    ) : (
      <span className="native-library-cover-fallback is-compact" aria-hidden="true">
        {label.trim().charAt(0).toUpperCase() || "—"}
      </span>
    );
  const overlay = indicator ? (
    <span className="native-library-track__cover-indicator">{indicator}</span>
  ) : null;
  if (cover?.to) {
    return (
      <RouteLink
        to={cover.to}
        state={cover.state}
        className="native-library-track__cover"
        aria-label={`Open ${label || "album"}`}
      >
        {content}
        {overlay}
      </RouteLink>
    );
  }
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

function TrackLink({ link, className }: { link?: TrackLinkField | null; className: string }) {
  if (!link?.label) return <span className={`native-library-track__link ${className}`} />;
  if (link.to) {
    return (
      <RouteLink
        to={link.to}
        state={link.state}
        className={`native-library-track__link ${className}`}
      >
        {link.label}
      </RouteLink>
    );
  }
  if (!link.onOpen) {
    return <span className={`native-library-track__link ${className}`}>{link.label}</span>;
  }
  return (
    <button
      type="button"
      className={`native-library-track__link ${className}`}
      onClick={link.onOpen}
    >
      {link.label}
    </button>
  );
}

type RowDrag = {
  ref: (node: HTMLElement | null) => void;
  style: CSSProperties;
  dragging: boolean;
  handle: ReactNode;
};

function SortableTrackRow({
  id,
  title,
  children,
}: {
  id: TrackListRow["key"];
  title: string;
  children: (drag: RowDrag) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return children({
    ref: setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition },
    dragging: isDragging,
    handle: (
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="native-library-track__grip"
        aria-label={`Reorder ${title}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" />
      </button>
    ),
  });
}

function HeadingCell({
  id,
  label,
  sort,
  className = "",
}: {
  id: SortableHeading;
  label: string;
  sort: TrackSort | null;
  className?: string;
}) {
  const sortKey = SORTABLE_HEADINGS[id];
  if (!sort || !sortKey) return <span className={className}>{label}</span>;
  const active = sort.key === sortKey;
  const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <span
      className={className}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="native-library-track__sort"
        onClick={() => sort.onSort(sortKey)}
      >
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
  showYear = false,
  showReason = false,
  showAddedBy = false,
  wideTime = false,
  onReorder = null,
}: {
  label: string;
  rows: TrackListRow[];
  onReorder?: ((keys: TrackListRow["key"][]) => void) | null;
  showYear?: boolean;
  showReason?: boolean;
  showAddedBy?: boolean;
  wideTime?: boolean;
  variant?: "collection" | "release" | "compact";
  sort?: TrackSort | null;
  selection?: TrackSelection | null;
  highlightKey?: string | number | null;
}) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const isCollection = variant === "collection";
  const hasCover = variant !== "release";
  const showPopular = rows.some((row) => row.popular);
  const items = useMemo(
    () =>
      rows.flatMap((row) => {
        const entry = { key: String(row.key), row, section: false };
        return row.section ? [{ key: `section-${row.key}`, row, section: true }, entry] : [entry];
      }),
    [rows],
  );
  const ids = useMemo(() => rows.map((row) => row.key), [rows]);
  const getItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const pickedIndex = pickedKey === null ? -1 : items.findIndex((item) => item.key === pickedKey);

  const scroller = use(MainScrollContext);
  const windowed = variant !== "compact" && scroller !== null;
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled: windowed,
    getScrollElement: () => scroller?.current ?? null,
    initialOffset: () => scroller?.current?.scrollTop ?? 0,
    getItemKey,
    estimateSize: (index) =>
      items[index]?.section
        ? SECTION_SIZE_ESTIMATE
        : (learnedRowSizes.get(variant) ?? ROW_SIZE_ESTIMATE),
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance);
      if (element.getAttribute("role") === "listitem") learnedRowSizes.set(variant, size);
      return size;
    },
    overscan: 12,
    scrollMargin,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      return pickedIndex < 0 || indexes.includes(pickedIndex) ? indexes : [...indexes, pickedIndex];
    },
  });

  useLayoutEffect(() => {
    const main = scroller?.current;
    if (!windowed || !listNode || !main) return undefined;
    const update = () =>
      setScrollMargin(
        listNode.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main.firstElementChild ?? listNode);
    return () => observer.disconnect();
  }, [listNode, scroller, windowed]);

  const [flashKey, setFlashKey] = useState<string | null>(null);
  const scrolledKey = useRef<string | null>(null);
  const target = highlightKey ? String(highlightKey) : null;
  const targetIndex = target === null ? -1 : items.findIndex((item) => item.key === target);

  useEffect(() => {
    if (!target) {
      scrolledKey.current = null;
      return undefined;
    }
    if (targetIndex < 0 || scrolledKey.current === target) return undefined;
    // Layout resets the page scroll after child effects run, so scroll on the next frame.
    const frame = window.requestAnimationFrame(() => {
      scrolledKey.current = target;
      if (windowed) virtualizer.scrollToIndex(targetIndex, { align: "center" });
      else rowRefs.current.get(target)?.scrollIntoView({ block: "center" });
      setFlashKey(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target, targetIndex, windowed, virtualizer]);

  useEffect(() => {
    if (!flashKey) return undefined;
    const timeout = window.setTimeout(() => setFlashKey(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [flashKey]);

  const renderRow = (row: TrackListRow, index: number | null, drag: RowDrag | null) => {
    const playLabel = row.playing
      ? `Pause ${row.title}`
      : row.previewOnly
        ? `Preview ${row.title}`
        : `Play ${row.title}`;
    return (
      <div
        key={row.key}
        data-index={index ?? undefined}
        ref={(node) => {
          if (index === null) return;
          drag?.ref(node);
          if (windowed) virtualizer.measureElement(node);
          if (node) rowRefs.current.set(String(row.key), node);
          else rowRefs.current.delete(String(row.key));
        }}
        style={drag?.style}
        className={
          "native-library-track" +
          (index === null ? " is-dragging" : drag?.dragging ? " is-drag-source" : "") +
          (row.active ? " is-active" : "") +
          (flashKey === String(row.key) ? " is-search-focused" : "") +
          (row.missing ? " is-missing" : "") +
          (row.missing && row.previewOnly ? " is-preview" : "")
        }
        data-library-menu-target={row.menu || row.menuElement ? true : undefined}
        role={index === null ? undefined : "listitem"}
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
        ) : row.status ? (
          <Tooltip content={row.status.label}>
            <span className="native-library-track__status" role="img" aria-label={row.status.label}>
              {row.status.kind === "active" ? (
                <DotLoader size="xs" label={null} />
              ) : row.status.kind === "queued" ? (
                <Clock aria-hidden="true" />
              ) : (
                <AlertTriangle aria-hidden="true" />
              )}
            </span>
          </Tooltip>
        ) : row.onPlay ? (
          <TooltipButton
            className="native-library-track__play"
            onClick={row.onPlay}
            disabled={row.playDisabled}
            label={playLabel}
            aria-label={playLabel}
          >
            {row.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </TooltipButton>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="native-library-track__number" aria-hidden="true">
          {row.active ? <PlayingIndicator row={row} /> : row.number}
        </span>
        {hasCover ? (
          <TrackCover
            cover={row.cover}
            indicator={row.active ? <PlayingIndicator row={row} /> : null}
          />
        ) : null}
        <Tooltip content={row.title}>
          {row.onPlay && !row.playDisabled && !selection ? (
            <button
              type="button"
              className="native-library-track__title"
              onClick={row.onPlay}
              aria-label={row.previewOnly ? playLabel : undefined}
            >
              <span>
                {row.previewOnly ? <PreviewChip /> : null}
                {row.badge}
                {row.title}
              </span>
              {row.subtitle ? <small>{row.subtitle}</small> : null}
              {row.detail ? (
                <small className="native-library-track__detail">{row.detail}</small>
              ) : null}
            </button>
          ) : (
            <span className="native-library-track__title">
              <span>
                {row.previewOnly ? <PreviewChip /> : null}
                {row.badge}
                {row.title}
              </span>
              {row.subtitle ? <small>{row.subtitle}</small> : null}
              {row.detail ? (
                <small className="native-library-track__detail">{row.detail}</small>
              ) : null}
            </span>
          )}
        </Tooltip>
        {isCollection ? (
          <TrackLink link={row.artist} className="native-library-track__artist" />
        ) : null}
        {isCollection ? (
          <TrackLink link={row.album} className="native-library-track__album" />
        ) : null}
        {showReason ? <span className="native-library-track__reason">{row.reason}</span> : null}
        {showAddedBy ? <span className="native-library-track__added-by">{row.addedBy}</span> : null}
        {showYear ? <span className="native-library-track__year">{row.year}</span> : null}
        {!showPopular ? null : row.popular ? (
          <Tooltip content="Popular on this album">
            <span
              className="native-library-track__popular"
              role="img"
              aria-label="Popular on this album"
            >
              <Flame aria-hidden="true" />
            </span>
          </Tooltip>
        ) : (
          <span className="native-library-track__popular" />
        )}
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
        {drag ? (
          drag.handle
        ) : row.favorite && !selection ? (
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
  };

  const renderItem = (index: number) => {
    const item = items[index];
    if (!item) return null;
    if (item.section) {
      return (
        <div
          key={item.key}
          data-index={index}
          ref={windowed ? virtualizer.measureElement : undefined}
          className="native-library-track-section"
          role="presentation"
        >
          {item.row.section}
        </div>
      );
    }
    if (!onReorder) return renderRow(item.row, index, null);
    return (
      <SortableTrackRow key={item.key} id={item.row.key} title={item.row.title}>
        {(drag) =>
          renderRow(
            item.row,
            index,
            pinned?.index === index
              ? {
                  ...drag,
                  style: {
                    ...drag.style,
                    position: "absolute",
                    insetInline: 0,
                    top: pinned.start - scrollMargin,
                  },
                }
              : drag,
          )
        }
      </SortableTrackRow>
    );
  };

  const virtualItems = windowed ? virtualizer.getVirtualItems() : [];
  const pinned = virtualItems.find(
    (item) =>
      item.index === pickedIndex &&
      !virtualItems.some((other) => Math.abs(other.index - pickedIndex) === 1),
  );
  const shown = virtualItems.filter((item) => item !== pinned);
  const first = shown[0];
  const last = shown.at(-1);
  const list = (
    <div
      ref={setListNode}
      role="list"
      aria-label={label}
      style={
        windowed
          ? {
              position: "relative",
              paddingTop: first ? first.start - scrollMargin : 0,
              paddingBottom: virtualizer.getTotalSize() - (last ? last.end - scrollMargin : 0),
            }
          : undefined
      }
    >
      {windowed
        ? virtualItems.map((item) => renderItem(item.index))
        : items.map((_, index) => renderItem(index))}
    </div>
  );

  const overlayRow = (id: TrackListRow["key"]) => {
    const row = rows.find((entry) => entry.key === id);
    if (!row) return null;
    return renderRow(row, null, {
      ref: () => undefined,
      style: {},
      dragging: true,
      handle: (
        <span className="native-library-track__grip" aria-hidden="true">
          <GripVertical aria-hidden="true" />
        </span>
      ),
    });
  };

  return (
    <div
      className={`native-library-track-list native-library-track-list--${variant}${showYear ? " native-library-track-list--year" : ""}${showReason ? " native-library-track-list--reason" : ""}${showAddedBy ? " native-library-track-list--added-by" : ""}${wideTime ? " native-library-track-list--wide-time" : ""}${showPopular ? " native-library-track-list--popular" : ""}`}
    >
      {variant === "compact" ? null : (
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
          {showReason ? <span className="native-library-track__reason">Why</span> : null}
          {showAddedBy ? <span className="native-library-track__added-by">Added by</span> : null}
          {showYear ? (
            <HeadingCell
              id="year"
              label="Year"
              sort={sort}
              className="native-library-track__year"
            />
          ) : null}
          {showPopular ? <span /> : null}
          <span className="native-library-track__time">Time</span>
          <span />
          <span />
          <span />
        </div>
      )}
      {onReorder ? (
        <SortableList
          ids={ids}
          titleOf={(id) => rows.find((row) => row.key === id)?.title || "Track"}
          onReorder={onReorder}
          overlay={overlayRow}
          onPickUp={(id) => setPickedKey(String(id))}
        >
          {list}
        </SortableList>
      ) : (
        list
      )}
    </div>
  );
}
