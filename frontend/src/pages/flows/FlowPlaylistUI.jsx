import {
  ArrowRight,
  Clock,
  ChevronDown,
  ListMusic,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import PillToggle from "../../components/PillToggle";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import { PlaylistArtworkThumb } from "./flowComponents/PlaylistArtworkThumb.jsx";
import {
  formatTrackCountLabel,
  getFlowDisplayTrackCount,
  getSharedPlaylistTrackCount,
} from "./flowStats";

export function LibrarySidebarToggleIcon({ collapsed = false }) {
  return (
    <svg viewBox="0 0 24 24" className="flow-page__library-collapse-icon" aria-hidden="true">
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
  showPlaylists = true,
  showFlows = true,
  showImport = true,
  compact = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);
  const triggerLabel = showFlows ? "Create playlist or flow" : "Create playlist";

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const triggerContent = (
    <>
      <Plus className="flow-page__library-create-icon" aria-hidden="true" />
      {!compact ? <span className="flow-page__library-create-label">New</span> : null}
      {!compact ? (
        <ChevronDown
          className={`flow-page__library-create-chevron${isOpen ? " is-open" : ""}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  return (
    <div
      className={`flow-page__library-create${compact ? " is-compact" : ""}${isOpen ? " is-open" : ""}`}
    >
      {compact ? (
        <TooltipButton
          label={triggerLabel}
          className="flow-page__library-create-btn"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
          aria-haspopup="menu"
        >
          {triggerContent}
        </TooltipButton>
      ) : (
        <button
          type="button"
          className="flow-page__library-create-btn"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={triggerLabel}
          aria-expanded={isOpen}
          aria-haspopup="menu"
        >
          {triggerContent}
        </button>
      )}
      {isOpen ? (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={close}
            aria-label="Close menu"
          />
          <div className="flow-page__library-create-menu" role="menu" aria-label="Create and import">
            {showPlaylists || showFlows ? (
              <p className="flow-page__library-create-menu-label">Create</p>
            ) : null}
            {showPlaylists || (showFlows && canCreateFlow) ? (
              <div className="flow-page__library-create-primary">
              {showPlaylists ? <button
                type="button"
                role="menuitem"
                className="flow-page__library-create-action flow-page__library-create-action--playlist"
                disabled={creatingPlaylist}
                onClick={() => {
                  onNewPlaylist?.();
                  close();
                }}
              >
                <span className="flow-page__library-create-action-icon" aria-hidden="true">
                  {creatingPlaylist ? (
                    <DotLoader size="sm" label={null} />
                  ) : (
                    <ListMusic className="flow-page__library-create-action-glyph" />
                  )}
                </span>
                <span className="flow-page__library-create-action-copy">
                  <span className="flow-page__library-create-action-title">
                    {creatingPlaylist ? "Creating playlist…" : "New playlist"}
                  </span>
                </span>
              </button> : null}
              {showFlows && canCreateFlow ? (
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
                    {creatingFlow ? (
                      <DotLoader size="sm" label={null} />
                    ) : (
                      <Sparkles className="flow-page__library-create-action-glyph" />
                    )}
                  </span>
                  <span className="flow-page__library-create-action-copy">
                    <span className="flow-page__library-create-action-title">
                      {creatingFlow ? "Creating flow…" : "New flow"}
                    </span>
                  </span>
                </button>
              ) : null}
              </div>
            ) : null}
            {showImport ? <p className="flow-page__library-create-menu-label flow-page__library-create-menu-label--import">
              Import
            </p> : null}
            {showImport ? <div className="flow-page__library-create-primary">
              <button
                type="button"
                role="menuitem"
                className="flow-page__library-create-action flow-page__library-create-action--import"
                onClick={() => {
                  onImport?.();
                  close();
                }}
              >
                <span
                  className="flow-page__library-create-action-icon flow-page__library-create-action-icon--import"
                  aria-hidden="true"
                >
                  <Upload className="flow-page__library-create-action-glyph" />
                </span>
                <span className="flow-page__library-create-action-copy">
                  <span className="flow-page__library-create-action-title">Import playlist</span>
                </span>
              </button>
            </div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PlaylistLibraryItem({
  entry,
  artworkUrl,
  isActive,
  expanded = false,
  stats,
  activityHint = null,
  collapsed = false,
  onSelect,
  trailing = null,
  viewerUsername = null,
  viewerIsAdmin = false,
}) {
  const trackCount =
    entry.kind === "flow"
      ? getFlowDisplayTrackCount(entry, stats)
      : getSharedPlaylistTrackCount(entry, stats);
  const trackLabel =
    entry.kind === "flow"
      ? formatTrackCountLabel(trackCount, stats)
      : `${trackCount} ${trackCount === 1 ? "track" : "tracks"}`;
  const baseTypeLabel =
    entry.kind === "flow" ? (entry.enabled === true ? "Flow" : "Flow draft") : "Playlist";
  const showOwner =
    Boolean(entry.ownerUsername) && (viewerIsAdmin || entry.ownerUsername !== viewerUsername);
  const typeLabel = showOwner ? `${entry.ownerUsername} · ${baseTypeLabel}` : baseTypeLabel;
  const showSyncedBadge =
    entry.kind === "shared" &&
    entry.importSource?.syncEnabled === true &&
    ["spotify-playlist", "listenbrainz-playlist", "listenbrainz-createdfor", "lastfm-station"].includes(
      entry.importSource?.provider,
    );

  return (
    <div
      className={`flow-page__library-item${isActive ? " is-active" : ""}${expanded ? " is-expanded" : ""}`}
    >
      <button
        type="button"
        className="flow-page__library-item-main"
        aria-current={isActive ? "true" : undefined}
        aria-expanded={expanded ? "true" : undefined}
        aria-label={collapsed ? entry.name : undefined}
        title={collapsed ? entry.name : undefined}
        onClick={() => onSelect?.(entry)}
      >
        <PlaylistArtworkThumb
          artworkUrl={artworkUrl}
          name={entry.name}
          className="flow-page__library-item-artwork"
        />
        <div
          className="flow-page__library-item-body"
          title={collapsed && activityHint ? activityHint : undefined}
        >
          <div className="flow-page__library-item-top">
            <span className="flow-page__library-item-type-row">
              <span className="flow-page__library-item-type">{typeLabel}</span>
              {showSyncedBadge ? (
                <span className="flow-page__badge flow-page__badge--sync">Synced</span>
              ) : null}
            </span>
            {activityHint ? (
              <span
                className="flow-page__library-item-activity"
                title={activityHint}
                aria-label={activityHint}
              >
                <DotLoader size="xs" label={null} />
              </span>
            ) : null}
          </div>
          <span className="flow-page__library-item-title" title={entry.name}>
            {entry.name}
          </span>
          <span className="flow-page__library-item-meta" title={trackLabel}>
            {trackLabel}
          </span>
        </div>
      </button>
      {trailing ? <div className="flow-page__library-item-trailing">{trailing}</div> : null}
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
          <span className="flow-page__detail-meta-chip" title={meta.lastRunTitle || undefined}>
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
  activityHint = null,
  enabled,
  togglingId,
  onToggleEnabled,
  onRenameTitle,
  onArtworkClick,
  moreMenu,
}) {
  const isFlow = entry.kind === "flow";
  const typeLabel = isFlow ? (enabled ? "Flow" : "Flow draft") : "Playlist";

  return (
    <div className="flow-page__detail-hero">
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
            {activityHint ? (
              <p className="flow-page__detail-meta flow-page__detail-activity">
                <DotLoader size="xs" label={null} />
                <span>{activityHint}</span>
              </p>
            ) : null}
          </div>
        </div>
        <div className="flow-page__detail-hero-actions">
          {isFlow ? (
            <div className="flow-page__toggle-wrap" data-no-card-toggle="true">
              <PillToggle
                checked={enabled}
                className={`pill-toggle--flow-compact${enabled ? "" : " is-off"}`}
                aria-label={`Enable ${entry.name || "flow"}`}
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
