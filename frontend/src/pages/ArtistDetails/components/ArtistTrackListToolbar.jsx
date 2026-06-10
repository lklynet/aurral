import PropTypes from "prop-types";
import { Pause, Play, Shuffle } from "lucide-react";

export function ArtistTrackListToolbar({
  disabled = false,
  isPlaying = false,
  isShuffleEnabled = false,
  onPlayAll,
  onShufflePlay,
}) {
  return (
    <div className="artist-track-list__toolbar">
      <button
        type="button"
        onClick={onPlayAll}
        className="btn btn-primary btn-round-lg"
        disabled={disabled}
        aria-label={isPlaying ? "Pause playback" : "Play all tracks"}
      >
        {isPlaying ? (
          <Pause className="artist-icon-md" />
        ) : (
          <Play className="artist-icon-md" />
        )}
      </button>
      <button
        type="button"
        onClick={onShufflePlay}
        className={`btn btn-secondary btn-round-lg artist-track-list__toolbar-shuffle${isShuffleEnabled ? " is-active" : ""}`}
        disabled={disabled}
        aria-label="Shuffle and play"
      >
        <Shuffle className="artist-icon-md" />
      </button>
    </div>
  );
}

ArtistTrackListToolbar.propTypes = {
  disabled: PropTypes.bool,
  isPlaying: PropTypes.bool,
  isShuffleEnabled: PropTypes.bool,
  onPlayAll: PropTypes.func.isRequired,
  onShufflePlay: PropTypes.func.isRequired,
};
