import { useState } from "react";
import {
  Ban,
  ChevronDown,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import AddActionButton from "../../../components/AddActionButton";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import { getDiscoveryFeedbackLabel } from "../../../utils/discoveryFeedback";

const MONITOR_OPTIONS = [
  { value: "none", label: "None (Artist Only)" },
  { value: "existing", label: "Existing Albums" },
  { value: "all", label: "All Albums" },
  { value: "future", label: "Future Albums" },
  { value: "missing", label: "Missing Albums" },
  { value: "latest", label: "Latest Album" },
  { value: "first", label: "First Album" },
];

export function ArtistDetailsActionBar({
  library,
  existsInLibrary,
  loadingLibrary,
  canChangeMonitoring,
  canDeleteArtist,
  canAddArtist,
  canRefreshArtist,
  buildingQueue = false,
  isArtistPlaybackActive,
  handlePreviewPlayAll,
  onEditIds,
  onTasteFeedback,
  tasteFeedbackUsed = {},
  tasteActionPending = null,
}) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const currentMonitorOption = library.getCurrentMonitorOption?.();
  const isPreviewPlaying = isArtistPlaybackActive;

  const renderLibraryAction = () => {
    if (loadingLibrary) {
      return (
        <div className="btn btn-secondary btn--bold btn-min-h">
          <DotLoader size="sm" label={null} />
          {existsInLibrary ? "Loading library" : "Checking Lidarr"}
        </div>
      );
    }

    if (existsInLibrary) {
      return (
        <div className="artist-relative">
          <button
            type="button"
            onClick={() => library.setShowRemoveDropdown(!library.showRemoveDropdown)}
            className="btn btn-neutral-active btn--bold btn-min-h"
          >
            <SearchLibraryCheck size="sm" />
            In Library
            {(canChangeMonitoring || canDeleteArtist) && (
              <ChevronDown
                className={`artist-icon-sm${library.showRemoveDropdown ? " artist-chevron--open" : ""}`}
              />
            )}
          </button>
          {library.showRemoveDropdown && (canChangeMonitoring || canDeleteArtist) && (
            <>
              <button
                type="button"
                className="artist-backdrop-button"
                onClick={() => library.setShowRemoveDropdown(false)}
                aria-label="Close library actions"
              />
              <div className="artist-dropdown artist-dropdown--left">
                {canChangeMonitoring && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      library.setShowMonitorOptionMenu(!library.showMonitorOptionMenu);
                    }}
                    disabled={library.updatingMonitor}
                    className="artist-menu-item"
                  >
                    <span>Monitor: {library.getCurrentMonitorOption()}</span>
                    <ChevronDown
                      className={`artist-icon-sm${library.showMonitorOptionMenu ? " artist-chevron--open" : ""}`}
                    />
                  </button>
                )}
                {canChangeMonitoring && library.showMonitorOptionMenu && (
                  <div className="artist-menu-section">
                    {MONITOR_OPTIONS.map((option) => {
                      const isActive = option.value === currentMonitorOption;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            library.handleUpdateMonitorOption(option.value);
                            library.setShowMonitorOptionMenu(false);
                            library.setShowRemoveDropdown(false);
                          }}
                          disabled={library.updatingMonitor}
                          className={`artist-menu-item${isActive ? " is-active" : ""}`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {canDeleteArtist && (
                  <button
                    type="button"
                    onClick={() => {
                      library.handleDeleteClick();
                      library.setShowRemoveDropdown(false);
                    }}
                    className="artist-menu-item artist-menu-item--danger"
                  >
                    <Trash2 className="artist-icon-sm" />
                    Remove from Library
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      );
    }

    if (!canAddArtist) return null;

    return (
      <div className="btn-add-action-group">
        <AddActionButton
          onClick={library.handleAddToLibrary}
          isLoading={library.addingToLibrary}
          label="Add to Lidarr"
        />
        <AddActionButton
          type="button"
          icon={SlidersHorizontal}
          label="Customize add options"
          onClick={library.handleOpenAddCustomizeModal}
          disabled={library.addingToLibrary}
          className="btn-add-action-options"
        />
      </div>
    );
  };

  return (
    <div className="artist-action-bar">
      <div className="artist-action-bar__inner">
        <div className="artist-action-bar__group">
          <button
            type="button"
            onClick={handlePreviewPlayAll}
            disabled={buildingQueue}
            className="btn btn-accent btn-round-lg"
            aria-label={isPreviewPlaying ? "Pause playback" : "Play artist"}
            title={isPreviewPlaying ? "Pause playback" : "Play artist"}
          >
            {buildingQueue ? (
              <DotLoader size="md" label={null} />
            ) : isPreviewPlaying ? (
              <Pause className="artist-icon-md" />
            ) : (
              <Play className="artist-icon-md" />
            )}
          </button>
          {renderLibraryAction()}
        </div>

        <div className="artist-row-actions">
          {existsInLibrary && canRefreshArtist && (
            <button
              type="button"
              onClick={library.handleRefreshArtist}
              disabled={library.refreshingArtist}
              className="btn btn-secondary btn--bold btn-min-h"
              aria-label="Refresh artist"
              title="Refresh artist"
            >
              {library.refreshingArtist ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" />
              )}
              <span className="artist-hidden-mobile">Refresh</span>
            </button>
          )}
          <div className="artist-relative">
            <button
              type="button"
              onClick={() => setShowMoreMenu((value) => !value)}
              className="btn btn-surface btn-icon-square"
              aria-label="More artist actions"
              title="More artist actions"
            >
              <MoreHorizontal className="artist-icon-md" />
            </button>
            {showMoreMenu && (
              <>
                <button
                  type="button"
                  className="artist-backdrop-button"
                  onClick={() => setShowMoreMenu(false)}
                  aria-label="Close artist actions"
                />
                <div className="artist-dropdown artist-dropdown--right">
                  {onTasteFeedback && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          onTasteFeedback("more_like_this");
                          setShowMoreMenu(false);
                        }}
                        disabled={!!tasteActionPending}
                        className={`artist-menu-item${tasteFeedbackUsed.more_like_this ? " is-active" : ""}`}
                      >
                        <span className="artist-menu-item__main">
                          {tasteActionPending === "more_like_this" ? (
                            <DotLoader size="sm" label={null} />
                          ) : (
                            <ThumbsUp className="artist-icon-sm" />
                          )}
                          {getDiscoveryFeedbackLabel("more_like_this")}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onTasteFeedback("less_like_this");
                          setShowMoreMenu(false);
                        }}
                        disabled={!!tasteActionPending}
                        className={`artist-menu-item${tasteFeedbackUsed.less_like_this ? " is-active" : ""}`}
                      >
                        <span className="artist-menu-item__main">
                          {tasteActionPending === "less_like_this" ? (
                            <DotLoader size="sm" label={null} />
                          ) : (
                            <ThumbsDown className="artist-icon-sm" />
                          )}
                          {getDiscoveryFeedbackLabel("less_like_this")}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onTasteFeedback("block_artist");
                          setShowMoreMenu(false);
                        }}
                        disabled={!!tasteActionPending}
                        className={`artist-menu-item artist-menu-item--danger${tasteFeedbackUsed.block_artist ? " is-active" : ""}`}
                      >
                        <span className="artist-menu-item__main">
                          {tasteActionPending === "block_artist" ? (
                            <DotLoader size="sm" label={null} />
                          ) : (
                            <Ban className="artist-icon-sm" />
                          )}
                          {tasteFeedbackUsed.block_artist ? "Unblock artist" : getDiscoveryFeedbackLabel("block_artist")}
                        </span>
                      </button>
                    </>
                  )}
                  {onEditIds && (
                    <button
                      type="button"
                      onClick={() => {
                        onEditIds();
                        setShowMoreMenu(false);
                      }}
                      className="artist-menu-item"
                    >
                      <span className="artist-menu-item__main">
                        <Pencil className="artist-icon-sm" />
                        Edit IDs
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
