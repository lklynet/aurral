import { useState } from "react";
import PropTypes from "prop-types";
import {
  Ban,
  CheckCircle,
  ChevronDown,
  Loader,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import AddToLibraryButton from "../../../components/AddToLibraryButton";

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
  existsInLibrary,
  loadingLibrary,
  showRemoveDropdown,
  setShowRemoveDropdown,
  showMonitorOptionMenu,
  setShowMonitorOptionMenu,
  updatingMonitor,
  canChangeMonitoring,
  getCurrentMonitorOption,
  handleUpdateMonitorOption,
  canDeleteArtist,
  handleDeleteClick,
  canAddArtist,
  handleAddToLibrary,
  handleOpenAddCustomizeModal,
  addingToLibrary,
  canRefreshArtist,
  handleRefreshArtist,
  refreshingArtist,
  buildingQueue = false,
  isArtistPlaybackActive,
  handlePreviewPlayAll,
  onEditIds,
  onToggleBlockArtist,
  blockingArtist,
  artistBlocked,
}) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const currentMonitorOption = getCurrentMonitorOption?.();
  const isPreviewPlaying = isArtistPlaybackActive;

  const renderLibraryAction = () => {
    if (loadingLibrary) {
      return (
        <div className="btn btn-secondary btn--bold btn-min-h">
          <Loader className="artist-icon-sm animate-spin" />
          {existsInLibrary ? "Loading library" : "Checking Lidarr"}
        </div>
      );
    }

    if (existsInLibrary) {
      return (
        <div className="artist-relative">
          <button
            type="button"
            onClick={() => setShowRemoveDropdown(!showRemoveDropdown)}
            className="btn btn-neutral-active btn--bold btn-min-h"
          >
            <CheckCircle className="artist-icon-sm" />
            In Library
            {(canChangeMonitoring || canDeleteArtist) && (
              <ChevronDown
                className={`artist-icon-sm${showRemoveDropdown ? " artist-chevron--open" : ""}`}
              />
            )}
          </button>
          {showRemoveDropdown && (canChangeMonitoring || canDeleteArtist) && (
            <>
              <button
                type="button"
                className="artist-backdrop-button"
                onClick={() => setShowRemoveDropdown(false)}
                aria-label="Close library actions"
              />
              <div className="artist-dropdown artist-dropdown--left">
                {canChangeMonitoring && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowMonitorOptionMenu(!showMonitorOptionMenu);
                    }}
                    disabled={updatingMonitor}
                    className="artist-menu-item"
                  >
                    <span>Monitor: {getCurrentMonitorOption()}</span>
                    <ChevronDown
                      className={`artist-icon-sm${showMonitorOptionMenu ? " artist-chevron--open" : ""}`}
                    />
                  </button>
                )}
                {canChangeMonitoring && showMonitorOptionMenu && (
                  <div className="artist-menu-section">
                    {MONITOR_OPTIONS.map((option) => {
                      const isActive = option.value === currentMonitorOption;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleUpdateMonitorOption(option.value);
                            setShowMonitorOptionMenu(false);
                            setShowRemoveDropdown(false);
                          }}
                          disabled={updatingMonitor}
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
                      handleDeleteClick();
                      setShowRemoveDropdown(false);
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
      <div className="btn-add-library-group">
        <AddToLibraryButton
          onClick={handleAddToLibrary}
          isLoading={addingToLibrary}
          className="btn-add-library--split"
        />
        <button
          type="button"
          onClick={handleOpenAddCustomizeModal}
          disabled={addingToLibrary}
          className="btn btn-add-library-split"
          aria-label="Customize add options"
          title="Customize add options"
        >
          <SlidersHorizontal className="artist-icon-sm" />
        </button>
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
            className="btn btn-primary btn-round-lg"
            aria-label={isPreviewPlaying ? "Pause playback" : "Play artist"}
            title={isPreviewPlaying ? "Pause playback" : "Play artist"}
          >
            {buildingQueue ? (
              <Loader className="artist-icon-md animate-spin" />
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
              onClick={handleRefreshArtist}
              disabled={refreshingArtist}
              className="btn btn-secondary btn--bold btn-min-h"
              aria-label="Refresh artist"
              title="Refresh artist"
            >
              {refreshingArtist ? (
                <Loader className="artist-icon-sm animate-spin" />
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
                  {onToggleBlockArtist && (
                    <button
                      type="button"
                      onClick={() => {
                        onToggleBlockArtist();
                        setShowMoreMenu(false);
                      }}
                      disabled={blockingArtist}
                      className={`artist-menu-item${artistBlocked ? " artist-menu-item--danger" : ""}`}
                    >
                      <span className="artist-menu-item__main">
                        {blockingArtist ? (
                          <Loader className="artist-icon-sm animate-spin" />
                        ) : (
                          <Ban className="artist-icon-sm" />
                        )}
                        {artistBlocked ? "Remove from Blocklist" : "Add to Blocklist"}
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

ArtistDetailsActionBar.propTypes = {
  existsInLibrary: PropTypes.bool,
  loadingLibrary: PropTypes.bool,
  showRemoveDropdown: PropTypes.bool,
  setShowRemoveDropdown: PropTypes.func.isRequired,
  showMonitorOptionMenu: PropTypes.bool,
  setShowMonitorOptionMenu: PropTypes.func.isRequired,
  updatingMonitor: PropTypes.bool,
  canChangeMonitoring: PropTypes.bool,
  getCurrentMonitorOption: PropTypes.func.isRequired,
  handleUpdateMonitorOption: PropTypes.func.isRequired,
  canDeleteArtist: PropTypes.bool,
  handleDeleteClick: PropTypes.func.isRequired,
  canAddArtist: PropTypes.bool,
  handleAddToLibrary: PropTypes.func.isRequired,
  handleOpenAddCustomizeModal: PropTypes.func.isRequired,
  addingToLibrary: PropTypes.bool,
  canRefreshArtist: PropTypes.bool,
  handleRefreshArtist: PropTypes.func.isRequired,
  refreshingArtist: PropTypes.bool,
  buildingQueue: PropTypes.bool,
  isArtistPlaybackActive: PropTypes.bool,
  handlePreviewPlayAll: PropTypes.func.isRequired,
  onEditIds: PropTypes.func,
  onToggleBlockArtist: PropTypes.func,
  blockingArtist: PropTypes.bool,
  artistBlocked: PropTypes.bool,
};
