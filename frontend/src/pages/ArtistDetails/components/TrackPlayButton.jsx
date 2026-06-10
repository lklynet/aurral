import PropTypes from "prop-types";
import { Loader, Pause, Play } from "lucide-react";
import {
  getTrackPlayAccessibilityLabel,
  isLibraryPlaybackTrack,
} from "../utils";

export function TrackPlayButton({
  track,
  isPlaying,
  isLoading,
  onClick,
  size = "default",
}) {
  const fromLibrary = isLibraryPlaybackTrack(track);
  const playLabel = getTrackPlayAccessibilityLabel(track, isPlaying);
  const sizeClass = size === "large" ? "btn-track-play-lg" : "btn-track-play";

  return (
    <button
      type="button"
      className={`btn btn-surface ${sizeClass}${fromLibrary ? " btn-track-play--library" : ""}`}
      onClick={onClick}
      aria-label={playLabel}
      title={playLabel}
    >
      {isLoading ? (
        <Loader className="artist-icon-xs animate-spin" />
      ) : isPlaying ? (
        <Pause className="artist-icon-xs" />
      ) : (
        <Play className="artist-icon-xs" />
      )}
    </button>
  );
}

TrackPlayButton.propTypes = {
  track: PropTypes.object.isRequired,
  isPlaying: PropTypes.bool.isRequired,
  isLoading: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
  size: PropTypes.oneOf(["default", "large"]),
};
