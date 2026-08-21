import { Pause, Play } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import { getTrackPlayAccessibilityLabel, isLibraryPlaybackTrack } from "../utils";

export function TrackPlayButton({ track, isPlaying, isLoading, onClick, size = "default" }) {
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
        <DotLoader size="xs" label={null} />
      ) : isPlaying ? (
        <Pause className="artist-icon-xs" />
      ) : (
        <Play className="artist-icon-xs" />
      )}
    </button>
  );
}
