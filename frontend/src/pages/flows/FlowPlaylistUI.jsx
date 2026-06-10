import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  ChevronLeft,
  Clock,
  ExternalLink,
  ListMusic,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";
import PillToggle from "../../components/PillToggle";
import { PlaylistArtworkThumb } from "../FlowPageComponents";
import { formatTrackCountLabel } from "./flowStats";

const MAIN_CONTENT_PORTAL_SELECTOR = ".app-main-wrap";
const LIBRARY_CREATE_MENU_WIDTH = 296;
const LIBRARY_CREATE_MENU_GAP = 10;

const getMainContentPortalRoot = () =>
  document.querySelector(MAIN_CONTENT_PORTAL_SELECTOR);

export function LibrarySidebarToggleIcon({ collapsed = false }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="flow-page__library-collapse-icon"
      aria-hidden="true"
    >
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M9 3.5v17" stroke="currentColor" strokeWidth="1.5" />
      {collapsed ? (
        <path
          d="M13.5 12H18M16 9.5L18.5 12L16 14.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M15.5 12H11M13.5 9.5L11 12L13.5 14.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function FlowLibraryCreateMenu({
  onImport,
  onNewPlaylist,
  onNewFlow,
  creatingPlaylist = false,
  creatingFlow = false,
  canCreateFlow = true,
  compact = false,
  spotifyImportHref = "https://aurral.org/aurral-convert",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    const portalRoot = getMainContentPortalRoot();
    if (!button || !portalRoot) return;
    const wrapRect = portalRoot.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth || LIBRARY_CREATE_MENU_WIDTH;
    const inset = 12;
    const maxLeft = Math.max(wrapRect.width - menuWidth - inset, inset);
    const left = Math.min(
      Math.max(rect.right - wrapRect.left - menuWidth, inset),
      maxLeft,
    );
    const top = rect.bottom - wrapRect.top + LIBRARY_CREATE_MENU_GAP;
    setMenuPosition((prev) => {
      if (prev && prev.top === top && prev.left === left) {
        return prev;
      }
      return { top, left };
    });
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        buttonRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }
    updateMenuPosition();
    const scrollRoot = document.querySelector(".app-main");
    window.addEventListener("resize", updateMenuPosition);
    scrollRoot?.addEventListener("scroll", updateMenuPosition, { passive: true });
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      scrollRoot?.removeEventListener("scroll", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
  }, [isOpen, updateMenuPosition]);

  const close = () => setIsOpen(false);
  const portalRoot = isOpen ? getMainContentPortalRoot() : null;

  const menu = (
    <div
      ref={menuRef}
      className="flow-page__library-create-menu flow-page__library-create-menu--portaled"
      style={
        menuPosition
          ? { top: menuPosition.top, left: menuPosition.left }
          : undefined
      }
      role="menu"
      aria-label="Create and import"
    >
      <p className="flow-page__library-create-menu-label">Create</p>
      <div className="flow-page__library-create-primary">
        <button
          type="button"
          role="menuitem"
          className="flow-page__library-create-action flow-page__library-create-action--playlist"
          disabled={creatingPlaylist}
          onClick={() => {
            onNewPlaylist?.();
            close();
          }}
        >
          <span
            className="flow-page__library-create-action-icon"
            aria-hidden="true"
          >
            <ListMusic className="flow-page__library-create-action-glyph" />
          </span>
          <span className="flow-page__library-create-action-copy">
            <span className="flow-page__library-create-action-title">
              {creatingPlaylist ? "Creating playlist..." : "New playlist"}
            </span>
            <span className="flow-page__library-create-action-desc">
              Curate and play your own track list
            </span>
          </span>
        </button>
        {canCreateFlow ? (
          <button
            type="button"
            role="menuitem"
            className="flow-page__library-create-action flow-page__library-create-action--flow"
            disabled={creatingFlow}
            onClick={() => {
              onNewFlow?.();
              close();
            }}
          >
            <span
              className="flow-page__library-create-action-icon flow-page__library-create-action-icon--flow"
              aria-hidden="true"
            >
              <Sparkles className="flow-page__library-create-action-glyph" />
            </span>
            <span className="flow-page__library-create-action-copy">
              <span className="flow-page__library-create-action-title">
                {creatingFlow ? "Creating flow..." : "New flow"}
              </span>
              <span className="flow-page__library-create-action-desc">
                Auto-updating playlist from your recipe
              </span>
            </span>
          </button>
        ) : null}
      </div>
      <p className="flow-page__library-create-menu-label flow-page__library-create-menu-label--import">
        Import
      </p>
      <div className="flow-page__library-create-secondary">
        <button
          type="button"
          role="menuitem"
          className="flow-page__library-create-secondary-item"
          onClick={() => {
            onImport?.();
            close();
          }}
        >
          <Upload className="flow-page__library-create-secondary-icon" />
          <span>Import JSON</span>
        </button>
        <a
          href={spotifyImportHref}
          target="_blank"
          rel="noreferrer"
          role="menuitem"
          className="flow-page__library-create-secondary-item"
          onClick={close}
        >
          <ExternalLink className="flow-page__library-create-secondary-icon" />
          <span>Spotify import</span>
        </a>
      </div>
    </div>
  );

  return (
    <div
      className={`flow-page__library-create${compact ? " is-compact" : ""}${isOpen ? " is-open" : ""}`}
    >
      <button
        ref={buttonRef}
        type="button"
        className="flow-page__library-create-btn"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Create playlist or flow"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Plus className="flow-page__library-create-icon" aria-hidden="true" />
      </button>
      {isOpen ? (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={close}
            aria-label="Close menu"
          />
          {portalRoot && menuPosition
            ? createPortal(menu, portalRoot)
            : null}
        </>
      ) : null}
    </div>
  );
}

export function PlaylistLibraryItem({
  entry,
  artworkUrl,
  isActive,
  stats,
  collapsed = false,
  onSelect,
  onArtworkClick,
}) {
  const trackCount =
    entry.kind === "flow"
      ? Number(entry.size || 0)
      : Number(entry.trackCount || 0);
  const trackLabel = formatTrackCountLabel(trackCount, stats);
  const typeLabel =
    entry.kind === "flow"
      ? entry.enabled === true
        ? "Flow"
        : "Flow draft"
      : "Playlist";

  return (
    <div
      className={`flow-page__library-item${isActive ? " is-active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      aria-label={collapsed ? entry.name : undefined}
      title={collapsed ? entry.name : undefined}
      onClick={() => onSelect?.(entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(entry);
        }
      }}
    >
      <PlaylistArtworkThumb
        artworkUrl={artworkUrl}
        name={entry.name}
        className="flow-page__library-item-artwork"
        onClick={
          onArtworkClick
            ? (event) => {
                event.stopPropagation();
                onArtworkClick(entry);
              }
            : undefined
        }
      />
      <div className="flow-page__library-item-body">
        <div className="flow-page__library-item-top">
          <span className="flow-page__library-item-type">{typeLabel}</span>
        </div>
        <span className="flow-page__library-item-title" title={entry.name}>
          {entry.name}
        </span>
        <span className="flow-page__library-item-meta" title={trackLabel}>
          {trackLabel}
        </span>
      </div>
    </div>
  );
}

function FlowDetailMeta({ meta }) {
  if (!meta) return null;
  const parts = [];
  if (meta.username) {
    parts.push(<span key="user">{meta.username}</span>);
  }
  if (meta.trackLabel) {
    parts.push(<span key="tracks">{meta.trackLabel}</span>);
  }
  if (meta.lastRunShort || meta.nextRunShort) {
    parts.push(
      <span key="run" className="flow-page__detail-meta-run">
        {meta.lastRunShort ? (
          <span
            className="flow-page__detail-meta-chip"
            title={meta.lastRunTitle || undefined}
          >
            <Clock className="artist-icon-xs" aria-hidden="true" />
            {meta.lastRunShort}
          </span>
        ) : null}
        {meta.nextRunShort ? (
          <span
            className="flow-page__detail-meta-chip flow-page__detail-meta-chip--next"
            title={meta.nextRunTitle || undefined}
          >
            {meta.lastRunShort ? (
              <ArrowRight
                className="artist-icon-xs flow-page__detail-meta-arrow"
                aria-hidden="true"
              />
            ) : null}
            {meta.nextRunShort}
          </span>
        ) : null}
      </span>,
    );
  }
  if (!parts.length) return null;
  return (
    <p className="flow-page__detail-meta flow-page__detail-meta--flow">
      {parts.map((part, index) => (
        <span key={part.key} className="flow-page__detail-meta-group">
          {index > 0 ? (
            <span className="flow-page__detail-meta-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </p>
  );
}

export function PlaylistDetailHero({
  entry,
  artworkUrl,
  metaLine,
  flowMeta = null,
  enabled,
  togglingId,
  onToggleEnabled,
  onBack,
  showBack,
  onRenameTitle,
  onArtworkClick,
  primaryActions,
  moreMenu,
}) {
  const isFlow = entry.kind === "flow";
  const typeLabel = isFlow
    ? enabled
      ? "Flow"
      : "Flow draft"
    : "Playlist";

  return (
    <div className="flow-page__detail-hero">
      {showBack ? (
        <button
          type="button"
          className="flow-page__detail-back btn btn-secondary btn-sm"
          onClick={onBack}
          aria-label="Back to library"
        >
          <ChevronLeft className="artist-icon-sm" />
          Library
        </button>
      ) : null}
      <div className="flow-page__detail-hero-main">
        <div className="flow-page__detail-hero-copy">
          <PlaylistArtworkThumb
            artworkUrl={artworkUrl}
            name={entry.name}
            className="flow-page__detail-artwork"
            onClick={onArtworkClick}
          />
          <div className="flow-page__detail-hero-text">
            <div className="flow-page__detail-hero-top">
              <span className="flow-page__detail-eyebrow">{typeLabel}</span>
            </div>
            <button
              type="button"
              className="flow-page__detail-title flow-page__detail-title--hero flow-page__detail-title-button"
              title={entry.name}
              onClick={onRenameTitle}
            >
              {entry.name}
            </button>
            {flowMeta ? (
              <FlowDetailMeta meta={flowMeta} />
            ) : metaLine ? (
              <p className="flow-page__detail-meta">{metaLine}</p>
            ) : null}
          </div>
        </div>
        <div className="flow-page__detail-hero-actions">
          {primaryActions}
          {isFlow ? (
            <div className="flow-page__toggle-wrap" data-no-card-toggle="true">
              <PillToggle
                checked={enabled}
                className={`pill-toggle--flow-compact${enabled ? "" : " is-off"}`}
                onChange={(event) => onToggleEnabled?.(event.target.checked)}
                disabled={togglingId === entry.id}
              />
            </div>
          ) : null}
          {moreMenu}
        </div>
      </div>
    </div>
  );
}

export function FlowDetailTabs({ activeTab, onChange }) {
  const tabs = [
    { id: "tracks", label: "Tracks", icon: ListMusic },
    { id: "recipe", label: "Recipe", icon: Sparkles },
  ];

  return (
    <div className="artist-segmented flow-page__detail-tabs" role="tablist">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-pressed={isActive}
            className={`artist-segmented-button flow-page__detail-tab${isActive ? " is-active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            <Icon className="artist-icon-xs" aria-hidden="true" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
