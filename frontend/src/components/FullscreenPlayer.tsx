import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useMediaQuery } from "../hooks/useMediaQuery.ts";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import ArtworkImage from "./ArtworkImage";
import { LibraryItemMenu } from "./LibraryItemMenu";
import PlayerLyrics, { useTrackLyrics } from "./PlayerLyrics";
import { PlayerMiniProgress, PlayerSeek } from "./PlayerProgress";
import { UpNextQueue } from "./PlayerQueue";
import PlayerVisualizer, { type VisualizerMode, type VisualizerScene } from "./PlayerVisualizer";
import TooltipButton from "./TooltipButton";
import {
  Activity,
  Ban,
  Columns3,
  Drop,
  LayoutBottom,
  LayoutRight,
  Minimize,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  type IconComponent,
} from "./icons";
import "./FullscreenPlayer.css";

type PlayerTrack = NonNullable<ReturnType<typeof useAudioQueue>["currentTrack"]>;

const IDLE_MS = 3000;

type StageOption<T extends string> = { id: T; label: string; icon: IconComponent };

const LAYOUTS = [
  { id: "minimal", label: "Minimal", icon: LayoutBottom },
  { id: "tabbed", label: "Tabbed", icon: LayoutRight },
  { id: "split", label: "Split", icon: Columns3 },
] as const satisfies readonly StageOption<VisualizerScene>[];

const VISUALIZERS = [
  { id: "chill", label: "Chill", icon: Drop },
  { id: "beat", label: "Beat", icon: Activity },
  { id: "off", label: "No visualizer", icon: Ban },
] as const satisfies readonly StageOption<VisualizerMode>[];

const TABS = [
  { id: "lyrics", label: "Lyrics" },
  { id: "queue", label: "Queue" },
] as const;

function useStoredChoice<T extends string>(
  key: string,
  choices: readonly { id: T }[],
  fallback: T,
) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return choices.find((choice) => choice.id === stored)?.id ?? fallback;
    } catch {
      return fallback;
    }
  });
  const choose = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      return;
    }
  };
  return [value, choose] as const;
}

function useIdle() {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = 0;
    const sleep = () => {
      if (document.querySelector("[role='menu']")) wake();
      else setIdle(true);
    };
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(sleep, IDLE_MS);
    };
    timer = window.setTimeout(sleep, IDLE_MS);
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const event of events) window.addEventListener(event, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, []);
  return idle;
}

function useScreenWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const acquire = () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      navigator.wakeLock.request("screen").then(
        (sentinel) => {
          if (done) void sentinel.release();
          else lock = sentinel;
        },
        () => {},
      );
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [enabled]);
}

function useDocumentFullscreen(onExit: () => void) {
  const exit = useEffectEvent(onExit);
  useEffect(() => {
    const owns = document.fullscreenEnabled && !document.fullscreenElement;
    if (owns) document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    let entered = Boolean(document.fullscreenElement);
    const sync = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) exit();
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (owns && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);
}

function StageArt({ track, className }: { track: PlayerTrack; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`fullscreen-player__art ${className}`} aria-hidden="true">
      {track.artwork && track.artwork !== failed ? (
        <ArtworkImage
          src={track.artwork}
          sizes="40vw"
          alt=""
          loading="eager"
          onError={() => setFailed(track.artwork)}
        />
      ) : (
        <Music />
      )}
    </span>
  );
}

function StageMeta({ track }: { track: PlayerTrack }) {
  const subtitle = [track.artist, track.album].filter(Boolean).join(" · ");
  return (
    <div className="fullscreen-player__meta">
      <h2 className="fullscreen-player__title">{track.title}</h2>
      {subtitle ? <p className="fullscreen-player__subtitle">{subtitle}</p> : null}
    </div>
  );
}

function StageControls({ compact = false }: { compact?: boolean }) {
  const {
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
  const playing = isPlaying || isStarting;
  const PlayPauseIcon = playing ? Pause : Play;
  const RepeatIcon = repeatMode === "one" ? Repeat1 : Repeat;
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one track"
      : repeatMode === "all"
        ? "Repeat all tracks"
        : "Enable repeat";
  return (
    <div
      className={`now-playing__controls fullscreen-player__controls${compact ? " fullscreen-player__controls--compact" : ""}`}
    >
      {compact ? null : (
        <button
          type="button"
          className={`now-playing__control now-playing__control--toggle${isShuffleEnabled ? " is-active" : ""}`}
          onClick={toggleShuffle}
          aria-pressed={isShuffleEnabled}
          aria-label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
        >
          <Shuffle aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="now-playing__control"
        onClick={playPrevious}
        aria-label="Previous track"
      >
        <SkipBack aria-hidden="true" />
      </button>
      <button
        type="button"
        className="now-playing__control now-playing__control--primary"
        onClick={togglePlayPause}
        aria-busy={isLoading || undefined}
        aria-label={playing ? "Pause" : "Play"}
      >
        <PlayPauseIcon aria-hidden="true" />
      </button>
      <button
        type="button"
        className="now-playing__control"
        onClick={playNext}
        aria-label="Next track"
      >
        <SkipForward aria-hidden="true" />
      </button>
      {compact ? null : (
        <button
          type="button"
          className={`now-playing__control now-playing__control--toggle${repeatMode !== "off" ? " is-active" : ""}`}
          onClick={toggleRepeat}
          aria-pressed={repeatMode !== "off"}
          aria-label={repeatLabel}
        >
          <RepeatIcon aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function CurrentLyric({ track }: { track: PlayerTrack }) {
  const { lines, synced, active } = useTrackLyrics(track);
  const line = synced ? lines[active] : undefined;
  if (!line) return null;
  const next = lines[active + 1]?.value;
  return (
    <div className="fullscreen-player__lyric">
      <p key={active} className="fullscreen-player__lyric-now">
        {line.value || "♪"}
      </p>
      {next ? <p className="fullscreen-player__lyric-next">{next}</p> : null}
    </div>
  );
}

function MinimalStage({ track }: { track: PlayerTrack }) {
  return (
    <div className="fullscreen-player__minimal">
      <CurrentLyric key={track.entryId} track={track} />
      <div className="fullscreen-player__foot">
        <StageArt track={track} className="fullscreen-player__art--thumb" />
        <StageMeta track={track} />
        <div className="fullscreen-player__chrome">
          <StageControls compact />
        </div>
      </div>
      <PlayerMiniProgress />
    </div>
  );
}

function NowPlaying({ track }: { track: PlayerTrack }) {
  return (
    <div className="fullscreen-player__now">
      <StageArt track={track} className="fullscreen-player__art--cover" />
      <StageMeta track={track} />
      <div className="fullscreen-player__chrome">
        <PlayerSeek variant="sheet" />
        <StageControls />
      </div>
    </div>
  );
}

function TabbedStage({ track }: { track: PlayerTrack }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("lyrics");
  return (
    <div className="fullscreen-player__tabbed">
      <NowPlaying track={track} />
      <div className="fullscreen-player__column">
        <div className="player-queue__tabs fullscreen-player__chrome" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`player-queue__tab${tab === entry.id ? " is-active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {tab === "lyrics" ? (
          <PlayerLyrics key={track.entryId} track={track} variant="stage" />
        ) : (
          <UpNextQueue className="fullscreen-player__queue" />
        )}
      </div>
    </div>
  );
}

function SplitStage({ track }: { track: PlayerTrack }) {
  return (
    <div className="fullscreen-player__split">
      <div className="fullscreen-player__column fullscreen-player__chrome">
        <UpNextQueue className="fullscreen-player__queue" />
      </div>
      <NowPlaying track={track} />
      <div className="fullscreen-player__column">
        <PlayerLyrics key={track.entryId} track={track} variant="stage" />
      </div>
    </div>
  );
}

export default function FullscreenPlayer({
  track,
  onClose,
}: {
  track: PlayerTrack;
  onClose: () => void;
}) {
  const { isPlaying } = useAudioQueue();
  const [layout, setLayout] = useStoredChoice("fullscreen-player:layout", LAYOUTS, "minimal");
  const [visualizer, setVisualizer] = useStoredChoice(
    "fullscreen-player:visualizer",
    VISUALIZERS,
    "chill",
  );
  const wide = useMediaQuery("(min-width: 1024px)");
  const view = layout === "split" && !wide ? "tabbed" : layout;
  const idle = useIdle();
  const rootRef = useRef<HTMLDivElement>(null);
  const { dialogRef } = useModalDialog({ open: true, onClose, initialFocusRef: rootRef });
  useScreenWakeLock(isPlaying);
  useDocumentFullscreen(onClose);

  const settings = [
    ...LAYOUTS.filter((entry) => wide || entry.id !== "split").map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      radio: true,
      selected: view === entry.id,
      onSelect: () => setLayout(entry.id),
    })),
    ...VISUALIZERS.map((entry, index) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      radio: true,
      selected: visualizer === entry.id,
      separatorBefore: index === 0,
      onSelect: () => setVisualizer(entry.id),
    })),
  ];

  return createPortal(
    <div
      ref={(element) => {
        rootRef.current = element;
        dialogRef.current = element;
      }}
      className={`fullscreen-player${idle ? " is-idle" : ""}`}
      data-layout={view}
      data-player-stage=""
      role="dialog"
      aria-modal="true"
      aria-label="Full screen player"
      tabIndex={-1}
    >
      <PlayerVisualizer mode={visualizer} scene={view} track={track} />
      <div className="fullscreen-player__grain" aria-hidden="true" />
      <div className="fullscreen-player__corner fullscreen-player__chrome">
        <LibraryItemMenu
          label="Full screen player"
          menuLabel="Full screen player settings"
          triggerLabel="Player settings"
          triggerIcon={<SlidersHorizontal aria-hidden="true" />}
          triggerClassName="btn btn-ghost btn-icon"
          contextMenu={false}
          items={settings}
        />
        <TooltipButton
          label="Exit full screen"
          className="btn btn-ghost btn-icon"
          onClick={onClose}
        >
          <Minimize aria-hidden="true" />
        </TooltipButton>
      </div>
      {view === "minimal" ? (
        <MinimalStage track={track} />
      ) : view === "tabbed" ? (
        <TabbedStage track={track} />
      ) : (
        <SplitStage track={track} />
      )}
    </div>,
    document.body,
  );
}
