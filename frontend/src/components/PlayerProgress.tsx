import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { PLAYER_SHORTCUTS } from "../hooks/usePlayerShortcuts.ts";
import { formatPlaybackTime } from "../utils/playbackTime";

const TICK_MS = 250;
const SEEK_KEY_OFFSETS: Partial<Record<string, number>> = {
  ArrowLeft: -5,
  ArrowDown: -5,
  ArrowRight: 5,
  ArrowUp: 5,
  PageDown: -30,
  PageUp: 30,
};

function usePlaybackProgress() {
  const { isActive, isPlaying, isLoading, getPosition, getBufferedEnd } = useAudioQueue();
  const [progress, setProgress] = useState({ position: 0, buffered: 0 });

  useEffect(() => {
    if (!isActive) {
      setProgress({ position: 0, buffered: 0 });
      return undefined;
    }
    const tick = () => {
      const position = getPosition();
      const buffered = getBufferedEnd();
      setProgress((previous) =>
        previous.position === position && previous.buffered === buffered
          ? previous
          : { position, buffered },
      );
    };
    tick();
    const interval = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(interval);
  }, [getBufferedEnd, getPosition, isActive, isLoading, isPlaying]);

  const setPosition = (position: number) => setProgress((previous) => ({ ...previous, position }));
  return [progress, setPosition] as const;
}

function fraction(value: number, duration: number) {
  return duration > 0 ? Math.min(Math.max(value / duration, 0), 1) : 0;
}

type TrackKey = string | number | null;

interface ScrubState {
  trackKey: TrackKey;
  position: number | null;
  stop: () => void;
}

interface PlayerSeekProps {
  variant: "sheet" | "bar";
}

export function PlayerSeek({ variant }: PlayerSeekProps) {
  const { duration, seek, isPlaying, currentTrack } = useAudioQueue();
  const [{ position, buffered }, setPosition] = usePlaybackProgress();
  const trackKey: TrackKey = currentTrack?.entryId ?? currentTrack?.id ?? null;
  const trackKeyRef = useRef(trackKey);
  const [scrub, setScrub] = useState<{ trackKey: TrackKey; position: number } | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const scrubRef = useRef<ScrubState | null>(null);
  const scrubPosition = scrub?.trackKey === trackKey ? scrub.position : null;

  useEffect(() => {
    trackKeyRef.current = trackKey;
  }, [trackKey]);

  useEffect(() => () => scrubRef.current?.stop(), []);

  const displayPosition = scrubPosition ?? position;
  const progress = fraction(displayPosition, duration);
  const clampPosition = (value: string | number) =>
    Math.min(Math.max(Number(value) || 0, 0), duration);

  const seekTo = (value: string | number) => {
    const nextPosition = clampPosition(value);
    seek(nextPosition);
    setPosition(nextPosition);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!duration) return;
    if (scrubRef.current) {
      if (scrubRef.current.trackKey !== trackKey) return;
      scrubRef.current.position = clampPosition(event.currentTarget.value);
      setScrub({ trackKey, position: scrubRef.current.position });
      return;
    }
    seekTo(event.currentTarget.value);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!duration || scrubRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const finish = () => {
      const scrub = scrubRef.current;
      scrub?.stop();
      setScrub(null);
      if (scrub?.position != null && scrub.trackKey === trackKeyRef.current) seekTo(scrub.position);
    };
    const stop = () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      scrubRef.current = null;
    };
    scrubRef.current = { position: null, stop, trackKey };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!duration || event.pointerType === "touch") return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    setHoverRatio(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!duration) return;
    const offset = SEEK_KEY_OFFSETS[event.key];
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? duration
          : offset == null
            ? null
            : displayPosition + offset;
    if (target == null) return;
    event.preventDefault();
    seekTo(target);
  };

  const input = (className: string, style?: CSSProperties) => (
    <input
      type="range"
      min={0}
      max={duration || 0}
      step="any"
      value={Math.min(displayPosition, duration || 0)}
      onChange={handleChange}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverRatio(null)}
      onKeyDown={handleKeyDown}
      aria-label="Playback position"
      aria-keyshortcuts={PLAYER_SHORTCUTS.seek.keys}
      aria-valuetext={`${formatPlaybackTime(displayPosition)} of ${formatPlaybackTime(duration)}`}
      disabled={!duration}
      className={className}
      style={style}
    />
  );

  if (variant === "sheet") {
    return (
      <div className="now-playing__progress">
        {input("now-playing__seek", { "--seek-percent": `${progress * 100}%` } as CSSProperties)}
        <div className="now-playing__times">
          <span>{formatPlaybackTime(displayPosition)}</span>
          <span>{formatPlaybackTime(duration)}</span>
        </div>
      </div>
    );
  }

  const scrubbing = scrubPosition != null;
  const previewRatio = scrubbing ? progress : hoverRatio;
  const className =
    "global-player__progress-wrap" +
    (isPlaying && !scrubbing ? " is-playing" : "") +
    (scrubbing ? " is-scrubbing" : "");

  return (
    <div
      className={className}
      style={
        {
          "--progress": progress,
          "--buffered": Math.max(fraction(buffered, duration), progress),
        } as CSSProperties
      }
    >
      <span className="global-player__progress-time global-player__progress-time--current">
        {formatPlaybackTime(displayPosition)}
      </span>
      <span className="global-player__progress-rail" aria-hidden="true">
        <span className="global-player__progress-track">
          <span className="global-player__progress-buffered" />
          <span className="global-player__progress-fill" />
        </span>
        <span className="global-player__progress-thumb" />
        {previewRatio != null && duration > 0 ? (
          <span
            className="global-player__progress-preview"
            style={{ left: `${previewRatio * 100}%` }}
          >
            {formatPlaybackTime(previewRatio * duration)}
          </span>
        ) : null}
      </span>
      {input("global-player__progress")}
      <span className="global-player__progress-time global-player__progress-time--duration">
        {formatPlaybackTime(duration)}
      </span>
    </div>
  );
}

export function PlayerMiniProgress() {
  const { duration, isPlaying } = useAudioQueue();
  const [{ position }] = usePlaybackProgress();
  return (
    <span
      className={`global-player__mini-progress${isPlaying ? " is-playing" : ""}`}
      aria-hidden="true"
      style={{ "--progress": fraction(position, duration) } as CSSProperties}
    >
      <span />
    </span>
  );
}
