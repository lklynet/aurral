import { Pause, Play, Shuffle } from "lucide-react";
import TooltipButton from "../../../components/TooltipButton";

export function ArtistTrackListToolbar({
  disabled = false,
  isPlaying = false,
  isShuffleEnabled = false,
  onPlayAll,
  onShufflePlay,
}) {
  return (
    <div className="artist-track-list__toolbar">
      <TooltipButton label={isPlaying ? "Pause playback" : "Play all tracks"}
        type="button"
        onClick={onPlayAll}
        className="btn btn-accent btn-round-lg"
        disabled={disabled}
        aria-label={isPlaying ? "Pause playback" : "Play all tracks"}
      >
        {isPlaying ? <Pause className="artist-icon-md" /> : <Play className="artist-icon-md" />}
      </TooltipButton>
      <TooltipButton label="Shuffle and play"
        type="button"
        onClick={onShufflePlay}
        className={`btn btn-secondary btn-round-lg artist-track-list__toolbar-shuffle${isShuffleEnabled ? " is-active" : ""}`}
        disabled={disabled}
        aria-label="Shuffle and play"
      >
        <Shuffle className="artist-icon-md" />
      </TooltipButton>
    </div>
  );
}
