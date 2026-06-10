import { useEffect, useRef, useState } from "react";
import {
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useAudioQueue } from "../hooks/useAudioQueue";

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function GlobalPlayerBar() {
  const {
    currentTrack,
    isActive,
    isPlaying,
    isLoading,
    duration,
    volume,
    setVolume,
    isShuffleEnabled,
    repeatMode,
    togglePlayPause,
    playNext,
    playPrevious,
    clearQueue,
    toggleShuffle,
    toggleRepeat,
    seek,
    getPosition,
  } = useAudioQueue();
  const [position, setPosition] = useState(0);
  const lastVolumeRef = useRef(volume > 0 ? volume : 0.7);

  useEffect(() => {
    if (volume > 0) {
      lastVolumeRef.current = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (!isActive) {
      setPosition(0);
      return undefined;
    }
    if (!isPlaying) return undefined;
    const tick = () => setPosition(getPosition());
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [getPosition, isActive, isPlaying]);

  if (!isActive || !currentTrack) {
    return null;
  }

  const volumePercent = Math.round(volume * 100);
  const progress = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;
  const subtitle = [currentTrack.artist, currentTrack.album]
    .filter(Boolean)
    .join(" · ");

  const handleVolumeChange = (event) => {
    const nextVolume = Math.min(
      Math.max(Number(event.target.value) || 0, 0),
      100,
    );
    if (nextVolume > 0) {
      lastVolumeRef.current = nextVolume / 100;
    }
    setVolume(nextVolume / 100);
  };

  const handleToggleMute = () => {
    if (volume <= 0) {
      const restored =
        lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.7;
      setVolume(restored);
      return;
    }
    lastVolumeRef.current = volume;
    setVolume(0);
  };

  const handleSeek = (event) => {
    if (!duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      Math.max((event.clientX - rect.left) / rect.width, 0),
      1,
    );
    const nextPosition = ratio * duration;
    seek(nextPosition);
    setPosition(nextPosition);
  };

  return (
    <div className="global-player" role="region" aria-label="Global audio player">
      <div className="global-player__progress-wrap">
        <button
          type="button"
          className="global-player__progress"
          onClick={handleSeek}
          aria-label="Seek"
        >
          <span
            className="global-player__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </button>
      </div>

      <div className="global-player__inner">
        <div className="global-player__track">
          <div className="global-player__meta">
            <div className="global-player__title-row">
              <span className="global-player__title">{currentTrack.title}</span>
            </div>
            {subtitle ? (
              <span className="global-player__subtitle">{subtitle}</span>
            ) : null}
          </div>
        </div>

        <div className="global-player__controls">
          <button
            type="button"
            onClick={playPrevious}
            className="btn btn-secondary btn-sm btn-icon global-player__control"
            aria-label="Previous track"
          >
            <SkipBack className="artist-icon-sm" />
          </button>
          <button
            type="button"
            onClick={togglePlayPause}
            className="btn btn-primary btn-sm btn-icon global-player__control global-player__control--primary"
            aria-label={isPlaying ? "Pause" : "Play"}
            disabled={isLoading}
          >
            {isPlaying ? (
              <Pause className="artist-icon-sm" />
            ) : (
              <Play className="artist-icon-sm" />
            )}
          </button>
          <button
            type="button"
            onClick={playNext}
            className="btn btn-secondary btn-sm btn-icon global-player__control"
            aria-label="Next track"
          >
            <SkipForward className="artist-icon-sm" />
          </button>
          <button
            type="button"
            onClick={toggleShuffle}
            className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__shuffle${isShuffleEnabled ? " is-active" : ""}`}
            aria-label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
          >
            <Shuffle className="artist-icon-sm" />
          </button>
          <button
            type="button"
            onClick={toggleRepeat}
            className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__repeat${repeatMode !== "off" ? " is-active" : ""}`}
            aria-label={
              repeatMode === "one"
                ? "Repeat one track"
                : repeatMode === "all"
                  ? "Repeat all tracks"
                  : "Enable repeat"
            }
          >
            {repeatMode === "one" ? (
              <Repeat1 className="artist-icon-sm" />
            ) : (
              <Repeat className="artist-icon-sm" />
            )}
          </button>
        </div>

        <div className="global-player__side">
          <span className="global-player__time">
            {formatTime(position)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            onClick={handleToggleMute}
            className="btn btn-ghost btn-icon btn-xs global-player__volume-toggle"
            aria-label={volumePercent <= 0 ? "Unmute" : "Mute"}
          >
            {volumePercent <= 0 ? (
              <VolumeX className="artist-icon-sm" />
            ) : (
              <Volume2 className="artist-icon-sm" />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={volumePercent}
            onChange={handleVolumeChange}
            className="volume-slider global-player__volume"
            aria-label="Volume"
          />
          <button
            type="button"
            onClick={clearQueue}
            className="btn btn-ghost btn-icon btn-xs global-player__close"
            aria-label="Close player"
          >
            <X className="artist-icon-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default GlobalPlayerBar;
