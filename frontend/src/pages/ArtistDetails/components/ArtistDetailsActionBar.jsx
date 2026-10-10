import { useState } from "react";
import {
  Ban,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import { getDiscoveryFeedbackLabel } from "../../../utils/discoveryFeedback";
import TooltipButton from "../../../components/TooltipButton";
import Tooltip from "../../../components/Tooltip";
import { ArtistMonitoringButtons } from "../../../components/ArtistMonitoringButtons";
import { useShareAction } from "../../../hooks/useShareAction";

export function ArtistDetailsActionBar({
  library,
  mbid,
  artistName = "",
  existsInLibrary,
  libraryLink = null,
  loadingLibrary,
  canChangeMonitoring,
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
  const share = useShareAction();
  const isPreviewPlaying = isArtistPlaybackActive;

  const renderLibraryAction = () => {
    if (loadingLibrary) {
      return (
        <div className="btn btn-secondary btn--bold btn-min-h">
          <DotLoader size="sm" label={null} />
          {existsInLibrary ? "Loading library" : "Checking library"}
        </div>
      );
    }

    return (
      <ArtistMonitoringButtons
        mbid={mbid}
        artistName={artistName}
        canChange={canChangeMonitoring}
        canAdd={canAddArtist}
        onCustomizeLidarr={library.handleOpenAddCustomizeModal}
        onChanged={library.reloadLibraryState}
      />
    );
  };

  return (
    <div className="artist-action-bar">
      <div className="artist-action-bar__inner">
        <div className="artist-action-bar__group">
          <TooltipButton
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
          </TooltipButton>
          {renderLibraryAction()}
          {libraryLink}
        </div>

        <div className="artist-row-actions">
          {existsInLibrary && canRefreshArtist && (
            <Tooltip content="Refresh artist">
              <button
                type="button"
                onClick={library.handleRefreshArtist}
                disabled={library.refreshingArtist}
                className="btn btn-secondary btn--bold btn-min-h"
                aria-label="Refresh artist"
              >
                {library.refreshingArtist ? (
                  <DotLoader size="sm" label={null} />
                ) : (
                  <RefreshCw className="artist-icon-sm" />
                )}
                <span className="artist-hidden-mobile">Refresh</span>
              </button>
            </Tooltip>
          )}
          <div className="artist-relative">
            <TooltipButton
              type="button"
              onClick={() => setShowMoreMenu((value) => !value)}
              className="btn btn-surface btn-icon-square"
              aria-label="More artist actions"
              title="More artist actions"
            >
              <MoreHorizontal className="artist-icon-md" />
            </TooltipButton>
            {showMoreMenu && (
              <>
                <button
                  type="button"
                  className="artist-backdrop-button"
                  onClick={() => setShowMoreMenu(false)}
                  aria-label="Close artist actions"
                />
                <div className="artist-dropdown artist-dropdown--right">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreMenu(false);
                      void share({ kind: "artist", artistMbid: mbid, artistName }, artistName);
                    }}
                    disabled={!artistName}
                    className="artist-menu-item"
                  >
                    <span className="artist-menu-item__main">
                      <Share className="artist-icon-sm" />
                      Share artist
                    </span>
                  </button>
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
