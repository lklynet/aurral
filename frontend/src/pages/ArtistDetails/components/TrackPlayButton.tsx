import { Pause, Play } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import type { MouseEvent } from "react";
import {
  getTrackPlayAccessibilityLabel,
  isLibraryPlaybackTrack,
  type PlayableTrack,
} from "../utils";
import TooltipButton from "../../../components/TooltipButton";

interface TrackPlayButtonProps {
  track: PlayableTrack;
  isPlaying: boolean;
  isLoading: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  size?: "default" | "large";
}

export function TrackPlayButton({
  track,
  isPlaying,
  isLoading,
  onClick,
  size = "default",
}: TrackPlayButtonProps) {
  const fromLibrary = isLibraryPlaybackTrack(track);
  const playLabel = getTrackPlayAccessibilityLabel(track, isPlaying);
  const sizeClass = size === "large" ? "btn-track-play-lg" : "btn-track-play";

  return (
    <TooltipButton
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
    </TooltipButton>
  );
}
