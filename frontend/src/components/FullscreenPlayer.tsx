import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AudioWaveform,
  Image,
  ListMusic,
  Mic,
  Minimize,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from "./icons";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { extractArtworkWash } from "../utils/imageColors.ts";
import ArtworkImage from "./ArtworkImage";
import PlayerLyrics from "./PlayerLyrics";
import { PlayerSeek } from "./PlayerProgress";
import { UpNextQueue } from "./PlayerQueue";
import TooltipButton from "./TooltipButton";

export type FullscreenView = "art" | "lyrics" | "queue" | "visualizer";

const VIEWS = [
  { id: "art", label: "Artwork", icon: Image },
  { id: "lyrics", label: "Lyrics", icon: Mic },
  { id: "queue", label: "Queue", icon: ListMusic },
  { id: "visualizer", label: "Visualizer", icon: AudioWaveform },
] as const satisfies readonly { id: FullscreenView; label: string; icon: unknown }[];

const IDLE_MS = 3000;
const BARS = 64;
const MIN_HZ = 40;
const MAX_HZ = 16000;

let audioGraph: { context: AudioContext; analyser: AnalyserNode } | null = null;
const tappedElements = new WeakSet<HTMLMediaElement>();

// ponytail: an element stays routed through the AudioContext once tapped, since Web Audio has no
// way to hand it back. Only same-origin streams are tapped, because a cross-origin one would play
// silence. Aurral serves every stream and preview from /api, so this only skips foreign URLs.
function analyserFor(element: HTMLMediaElement | null) {
  const src = element?.currentSrc || element?.src;
  if (!element || !src) return null;
  try {
    if (new URL(src, window.location.href).origin !== window.location.origin) return null;
  } catch {
    return null;
  }
  try {
    if (!audioGraph) {
      const context = new AudioContext();
      const analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0.75 });
      audioGraph = { context, analyser };
    }
    const { context, analyser } = audioGraph;
    if (!tappedElements.has(element)) {
      const source = context.createMediaElementSource(element);
      source.connect(context.destination);
      source.connect(analyser);
      tappedElements.add(element);
    }
    if (context.state !== "running") void context.resume();
    return analyser;
  } catch {
    return null;
  }
}

function barRanges(sampleRate: number, binCount: number) {
  const nyquist = sampleRate / 2;
  return Array.from({ length: BARS }, (_, index) => {
    const from = MIN_HZ * (MAX_HZ / MIN_HZ) ** (index / BARS);
    const to = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((index + 1) / BARS);
    const start = Math.floor((from / nyquist) * binCount);
    return [start, Math.max(start + 1, Math.ceil((to / nyquist) * binCount))] as const;
  });
}

function Visualizer() {
  const { getMediaElement, isPlaying, currentTrack } = useAudioQueue();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entryId = currentTrack?.entryId;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(BARS);
    let data: Uint8Array<ArrayBuffer> | null = null;
    let ranges: ReturnType<typeof barRanges> = [];
    let frame = 0;

    const draw = () => {
      const analyser = isPlaying && !still ? analyserFor(getMediaElement()) : null;
      if (analyser && !data) {
        data = new Uint8Array(analyser.frequencyBinCount);
        ranges = barRanges(analyser.context.sampleRate, analyser.frequencyBinCount);
      }
      if (analyser && data) analyser.getByteFrequencyData(data);
      let loudest = 0;
      for (let bar = 0; bar < BARS; bar += 1) {
        let target = 0;
        if (analyser && data) {
          const [start, end] = ranges[bar]!;
          for (let bin = start; bin < end; bin += 1) target = Math.max(target, data[bin] ?? 0);
          target = (target / 255) ** 1.6;
        }
        const level = levels[bar]!;
        levels[bar] = level + (target - level) * (target > level ? 0.55 : 0.1);
        loudest = Math.max(loudest, levels[bar]!);
      }

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth * ratio;
      const height = canvas.clientHeight * ratio;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = window.getComputedStyle(canvas).color;
      const slot = width / BARS;
      const barWidth = Math.max(1, slot * 0.6);
      const floor = Math.max(2 * ratio, barWidth);
      for (let bar = 0; bar < BARS; bar += 1) {
        const level = levels[bar]!;
        const barHeight = Math.max(floor, level * height * 0.9);
        context.globalAlpha = 0.35 + 0.65 * level;
        context.beginPath();
        context.roundRect(
          bar * slot + (slot - barWidth) / 2,
          (height - barHeight) / 2,
          barWidth,
          barHeight,
          barWidth / 2,
        );
        context.fill();
      }
      if (analyser || loudest > 0.002) frame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(frame);
  }, [entryId, getMediaElement, isPlaying]);

  return <canvas ref={canvasRef} className="fullscreen-player__visualizer" aria-hidden="true" />;
}

// Unlike useCollectionTint, this ignores the immersive-mode setting: color is the point of this view.
function useArtworkTint(artwork: string | null | undefined) {
  const [tint, setTint] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    void extractArtworkWash(artwork).then((wash) => {
      if (dead || !wash) return;
      setTint({
        "--collection-tint": `light-dark(${wash.light}, ${wash.dark})`,
        "--fullscreen-glow": `light-dark(${wash.dark}, ${wash.light})`,
      });
    });
    return () => {
      dead = true;
    };
  }, [artwork]);
  return tint;
}

function useIdle() {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    wake();
    for (const event of events) window.addEventListener(event, wake);
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, []);
  return idle;
}

function useScreenWakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return undefined;
    let dead = false;
    let lock: WakeLockSentinel | null = null;
    const request = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((sentinel) => {
          if (dead) void sentinel.release();
          else lock = sentinel;
        })
        .catch(() => {});
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", request);
      void lock?.release().catch(() => {});
    };
  }, []);
}

function useBrowserFullscreen(onExit: () => void) {
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  useEffect(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
    const handleChange = () => {
      if (!document.fullscreenElement) onExitRef.current();
    };
    document.addEventListener("fullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
}

interface FullscreenPlayerProps {
  view: FullscreenView;
  onViewChange: (view: FullscreenView) => void;
  onClose: () => void;
}

export default function FullscreenPlayer({ view, onViewChange, onClose }: FullscreenPlayerProps) {
  const {
    currentTrack,
    source,
    isPlaying,
    isStarting,
    isLoading,
    isShuffleEnabled,
    repeatMode,
    togglePlayPause,
    playNext,
    playPrevious,
    toggleShuffle,
    toggleRepeat,
  } = useAudioQueue();
  const stageRef = useRef<HTMLDivElement>(null);
  const dialog = useModalDialog({ open: true, onClose, initialFocusRef: stageRef });
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const tint = useArtworkTint(currentTrack?.artwork);
  const idle = useIdle();
  useScreenWakeLock();
  useBrowserFullscreen(onClose);

  if (!currentTrack) return null;

  const artwork =
    currentTrack.artwork && currentTrack.artwork !== failedArtwork ? currentTrack.artwork : null;
  const playingFrom = currentTrack.queueSource?.label ?? source?.label;
  const subtitle = [currentTrack.artist, currentTrack.album].filter(Boolean).join(" · ");
  const playing = isPlaying || isStarting;
  const PlayPauseIcon = playing ? Pause : Play;
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one track"
      : repeatMode === "all"
        ? "Repeat all tracks"
        : "Enable repeat";

  return createPortal(
    <div
      ref={dialog.dialogRef}
      className={`fullscreen-player is-${view}${idle ? " is-idle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Full screen player"
      tabIndex={-1}
      style={tint}
    >
      {artwork ? (
        <div className="fullscreen-player__backdrop" aria-hidden="true">
          <ArtworkImage src={artwork} thumbnail sizes="25vw" alt="" loading="eager" />
        </div>
      ) : null}

      <header className="fullscreen-player__top">
        <span className="fullscreen-player__eyebrow">
          {playingFrom ? `Playing from ${playingFrom}` : "Now playing"}
        </span>
        <div className="fullscreen-player__views" role="group" aria-label="Show">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <TooltipButton
              key={id}
              label={label}
              aria-pressed={view === id}
              onClick={() => onViewChange(id)}
              className={`fullscreen-player__button${view === id ? " is-active" : ""}`}
            >
              <Icon aria-hidden="true" />
            </TooltipButton>
          ))}
        </div>
        <TooltipButton
          title="Exit full screen (Esc)"
          aria-label="Exit full screen"
          onClick={onClose}
          className="fullscreen-player__button"
        >
          <Minimize aria-hidden="true" />
        </TooltipButton>
      </header>

      <div ref={stageRef} className="fullscreen-player__stage" tabIndex={-1}>
        <div className="fullscreen-player__art" aria-hidden="true">
          {artwork ? (
            <ArtworkImage
              key={artwork}
              src={artwork}
              thumbnail={false}
              alt=""
              loading="eager"
              onError={() => setFailedArtwork(artwork)}
            />
          ) : (
            <Music />
          )}
        </div>
        {view === "art" ? null : (
          <div className="fullscreen-player__pane">
            {view === "lyrics" ? (
              <PlayerLyrics key={currentTrack.entryId} track={currentTrack} variant="fullscreen" />
            ) : view === "queue" ? (
              <UpNextQueue className="fullscreen-player__queue" />
            ) : (
              <Visualizer />
            )}
          </div>
        )}
      </div>

      <footer className="fullscreen-player__bottom">
        <div className="fullscreen-player__meta">
          <h2 className="fullscreen-player__title">{currentTrack.title}</h2>
          {subtitle ? <p className="fullscreen-player__subtitle">{subtitle}</p> : null}
        </div>
        <PlayerSeek variant="bar" />
        <div className="fullscreen-player__controls">
          <TooltipButton
            label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
            aria-pressed={isShuffleEnabled}
            onClick={toggleShuffle}
            className={`fullscreen-player__button${isShuffleEnabled ? " is-active" : ""}`}
          >
            <Shuffle aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            label="Previous track"
            onClick={playPrevious}
            className="fullscreen-player__button"
          >
            <SkipBack aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            label={playing ? "Pause" : "Play"}
            onClick={togglePlayPause}
            aria-busy={isLoading || undefined}
            className="fullscreen-player__button fullscreen-player__button--primary"
          >
            <PlayPauseIcon aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            label="Next track"
            onClick={playNext}
            className="fullscreen-player__button"
          >
            <SkipForward aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            label={repeatLabel}
            aria-pressed={repeatMode !== "off"}
            onClick={toggleRepeat}
            className={`fullscreen-player__button${repeatMode !== "off" ? " is-active" : ""}`}
          >
            {repeatMode === "one" ? <Repeat1 aria-hidden="true" /> : <Repeat aria-hidden="true" />}
          </TooltipButton>
        </div>
      </footer>
    </div>,
    document.body,
  );
}
