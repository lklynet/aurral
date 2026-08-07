import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
import { useAudioQueue } from "../contexts/audioQueueContext";

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
  const artistMbid = String(currentTrack.artistMbid || "").trim();
  const albumMbid = String(currentTrack.albumMbid || "").trim();
  const artistLabel = currentTrack.artist || "";
  const albumLabel = currentTrack.album || "";
  const artistPath = artistMbid ? `/artist/${artistMbid}` : "";
  const albumPath = artistMbid && albumMbid ? `/artist/${artistMbid}/release/${albumMbid}` : "";
  const metaLink = (label, path) =>
    label ? path ? <Link to={path} className="global-player__link">{label}</Link> : label : null;

  const handleVolumeChange = (event) => {
    const nextVolume = Math.min(Math.max(Number(event.target.value) || 0, 0), 100);
    if (nextVolume > 0) {
      lastVolumeRef.current = nextVolume / 100;
    }
    setVolume(nextVolume / 100);
  };

  const handleToggleMute = () => {
    if (volume <= 0) {
      const restored = lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.7;
      setVolume(restored);
      return;
    }
    lastVolumeRef.current = volume;
    setVolume(0);
  };

  const handleSeek = (event) => {
    if (!duration) return;
    const nextPosition = Math.min(Math.max(Number(event.currentTarget.value) || 0, 0), duration);
    seek(nextPosition);
    setPosition(nextPosition);
  };

  return (
    <div className="global-player" role="region" aria-label="Global audio player">
      <div className="global-player__inner">
        <div className="global-player__track">
          <div className="global-player__meta">
            <div className="global-player__title-row">
              <span className="global-player__title">{currentTrack.title}</span>
            </div>
            {artistLabel || albumLabel ? (
              <span className="global-player__subtitle">
                {metaLink(artistLabel, artistPath)}
                {artistLabel && albumLabel ? " · " : null}
                {metaLink(albumLabel, albumPath)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="global-player__main">
          <div className="global-player__controls">
            <button
              type="button"
              onClick={toggleShuffle}
              className={`btn btn-secondary btn-sm btn-icon global-player__control global-player__shuffle${isShuffleEnabled ? " is-active" : ""}`}
              aria-label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
              title={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
            >
              <Shuffle className="artist-icon-sm" />
            </button>
            <button
              type="button"
              onClick={playPrevious}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
              aria-label="Previous track"
              title="Previous track"
            >
              <SkipBack className="artist-icon-sm" />
            </button>
            <button
              type="button"
              onClick={togglePlayPause}
              className="btn btn-accent btn-sm btn-icon global-player__control global-player__control--primary"
              aria-label={isPlaying ? "Pause" : "Play"}
              title={isPlaying ? "Pause" : "Play"}
              disabled={isLoading}
            >
              {isPlaying ? <Pause className="artist-icon-sm" /> : <Play className="artist-icon-sm" />}
            </button>
            <button
              type="button"
              onClick={playNext}
              className="btn btn-secondary btn-sm btn-icon global-player__control"
              aria-label="Next track"
              title="Next track"
            >
              <SkipForward className="artist-icon-sm" />
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
              title={
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

          <div className="global-player__progress-wrap">
            <span className="global-player__progress-time global-player__progress-time--current">
              {formatTime(position)}
            </span>
            <span className="global-player__progress-track" aria-hidden="true">
              <span className="global-player__progress-fill" style={{ width: `${progress}%` }} />
            </span>
            <input
              type="range"
              className="global-player__progress"
              min="0"
              max={duration || 0}
              step="0.1"
              value={Math.min(position, duration || 0)}
              onChange={handleSeek}
              aria-label="Playback position"
              aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
              disabled={!duration}
            />
            <span className="global-player__progress-time global-player__progress-time--duration">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        <div className="global-player__side">
          <button
            type="button"
            onClick={handleToggleMute}
            className="btn btn-ghost btn-icon btn-xs global-player__volume-toggle"
            aria-label={volumePercent <= 0 ? "Unmute" : "Mute"}
            title={volumePercent <= 0 ? "Unmute" : "Mute"}
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
            style={{ "--volume-percent": `${volumePercent}%` }}
            aria-label="Volume"
          />
          <button
            type="button"
            onClick={clearQueue}
            className="btn btn-ghost btn-icon btn-xs global-player__close"
            aria-label="Close player"
            title="Close player"
          >
            <X className="artist-icon-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default GlobalPlayerBar;
