import { useState, type SyntheticEvent } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import ArtworkImage from "./ArtworkImage";
import { PlayerMiniProgress } from "./PlayerProgress";
import { Music, Pause, Play } from "./icons";

type SidebarPlayerProps = {
  iconsOnly: boolean;
  onRestore: () => void;
  onTooltip?: (event: SyntheticEvent<HTMLElement>) => void;
};

function SidebarPlayer({ iconsOnly, onRestore, onTooltip }: SidebarPlayerProps) {
  const { currentTrack, isPlaying, isStarting, isLoading, togglePlayPause } = useAudioQueue();
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const title = currentTrack?.title || "Nothing playing";
  const playing = isPlaying || isStarting;
  const PlayPauseIcon = playing ? Pause : Play;

  return (
    <div className={`sidebar-player${iconsOnly ? " sidebar-player--icons" : ""}`}>
      <button
        type="button"
        className={`sidebar-link sidebar-link--${iconsOnly ? "icons" : "full"} sidebar-player__open`}
        onClick={onRestore}
        onMouseEnter={onTooltip}
        onFocus={onTooltip}
        aria-label={currentTrack ? `Show player: ${title}` : "Show player"}
      >
        <span className="sidebar-player__art" aria-hidden="true">
          {currentTrack?.artwork && currentTrack.artwork !== failedArtwork ? (
            <ArtworkImage
              src={currentTrack.artwork}
              thumbnail
              sizes="2rem"
              alt=""
              onError={() => setFailedArtwork(currentTrack.artwork)}
            />
          ) : (
            <Music />
          )}
        </span>
        {iconsOnly ? (
          <span className="sidebar-tooltip">Show player</span>
        ) : (
          <span className="sidebar-player__copy">
            <span className="sidebar-player__title">{title}</span>
            {currentTrack?.artist ? (
              <span className="sidebar-player__subtitle">{currentTrack.artist}</span>
            ) : null}
          </span>
        )}
      </button>
      {currentTrack && !iconsOnly ? (
        <button
          type="button"
          className="sidebar-player__toggle"
          onClick={togglePlayPause}
          aria-busy={isLoading || undefined}
          aria-label={playing ? "Pause" : "Play"}
        >
          <PlayPauseIcon aria-hidden="true" />
        </button>
      ) : null}
      {currentTrack ? <PlayerMiniProgress /> : null}
    </div>
  );
}

export default SidebarPlayer;
