import { Howl } from "howler";
import { createPlayTracker } from "./playTracker.ts";

declare module "howler" {
  interface Howl {
    _sounds?: { _node?: HTMLAudioElement | null }[];
  }
}

type AudioSnapshot = {
  isLoading: boolean;
  isPlaying: boolean;
  isStarting: boolean;
  duration: number;
};

type AudioHandlers = {
  onEnd?: () => void;
  onStart?: () => void;
  onPlayed?: () => void;
  onLoadError?: (...args: unknown[]) => void;
};

type AudioEntry = {
  src: string;
  format: string[];
  wantsPlay: boolean;
  startAt: number;
  loaded: boolean;
  failed: boolean;
  handlers: AudioHandlers | null;
  gain: number | null;
  gainRequest: AbortController | null;
  howl: Howl;
  node: HTMLAudioElement | null;
  onMediaEvent: () => void;
  onEnded: () => void;
  onTimeUpdate: () => void;
  onSeeking: () => void;
};

const IDLE_SNAPSHOT: AudioSnapshot = {
  isLoading: false,
  isPlaying: false,
  isStarting: false,
  duration: 0,
};

const LEVELING_TARGET_LUFS = -14;
const LOUDNESS_HEADER = "X-Aurral-Loudness";

export function levelingGain(lufs: number) {
  return Math.min(1, 10 ** ((LEVELING_TARGET_LUFS - lufs) / 20));
}

function isOwnStream(src: string) {
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

const HOWL_EVENTS = ["load", "loaderror", "play", "playerror", "pause", "stop", "end", "seek"];
const MEDIA_EVENTS = ["playing", "pause", "waiting", "seeked", "canplay", "durationchange"];

function mediaNode(howl: Howl) {
  return howl?._sounds?.[0]?._node ?? null;
}

function readSnapshot(entry: AudioEntry | null): AudioSnapshot {
  const howl = entry?.howl;
  if (!howl || howl.state() === "unloaded") return IDLE_SNAPSHOT;
  const isLoading = howl.state() === "loading";
  const duration = howl.duration();
  return {
    isLoading,
    isPlaying: howl.playing(),
    isStarting: isLoading && entry.wantsPlay,
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

function sameSnapshot(a: AudioSnapshot, b: AudioSnapshot) {
  return (Object.keys(IDLE_SNAPSHOT) as (keyof AudioSnapshot)[]).every((key) => a[key] === b[key]);
}

function sameSource(entry: AudioEntry | null, src: string, format: string[]): entry is AudioEntry {
  return entry?.src === src && String(entry.format) === String(format);
}

export function createAudioEngine() {
  let current: AudioEntry | null = null;
  let preloaded: AudioEntry | null = null;
  let volume = 1;
  let muted = false;
  let leveling = true;
  let snapshot: AudioSnapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();

  const emit = () => {
    const next = readSnapshot(current);
    if (sameSnapshot(next, snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const volumeFor = (entry: AudioEntry) => volume * (leveling ? (entry.gain ?? 1) : 1);

  const applyVolume = (entry: AudioEntry | null) => {
    entry?.howl.volume(volumeFor(entry));
  };

  const requestGain = (entry: AudioEntry) => {
    if (!leveling || entry.gainRequest || !isOwnStream(entry.src)) return;
    const request = new AbortController();
    entry.gainRequest = request;
    fetch(entry.src, { method: "HEAD", credentials: "same-origin", signal: request.signal })
      .then((response) => {
        const lufs = Number.parseFloat(response.headers.get(LOUDNESS_HEADER) ?? "");
        if (!Number.isFinite(lufs) || request.signal.aborted || entry.node?.played.length) return;
        entry.gain = levelingGain(lufs);
        applyVolume(entry);
      })
      .catch(() => {});
  };

  const createEntry = ({ src, format }: { src: string; format: string[] }) => {
    const entry = {
      src,
      format,
      wantsPlay: false,
      startAt: 0,
      loaded: false,
      failed: false,
      handlers: null,
      gain: null,
      gainRequest: null,
    } as AudioEntry;
    entry.howl = new Howl({
      src: [src],
      format,
      html5: true,
      preload: true,
      autoplay: false,
      volume,
      mute: muted,
    });
    requestGain(entry);
    entry.howl.once("load", () => {
      entry.loaded = true;
    });
    entry.howl.on("loaderror", () => {
      entry.failed = true;
      entry.wantsPlay = false;
    });
    entry.howl.on("playerror", () => {
      entry.wantsPlay = false;
    });
    entry.howl.once("play", () => {
      if (entry === current) entry.handlers?.onStart?.();
    });
    for (const event of HOWL_EVENTS) {
      entry.howl.on(event, (...args: unknown[]) => {
        if (entry !== current) return;
        emit();
        if (event === "loaderror") entry.handlers?.onLoadError?.(...args);
      });
    }
    entry.node = mediaNode(entry.howl);
    entry.onMediaEvent = () => {
      if (entry === current) emit();
    };
    entry.onEnded = () => {
      if (entry !== current) return;
      entry.wantsPlay = false;
      entry.handlers?.onEnd?.();
    };
    const tracker = createPlayTracker();
    entry.onTimeUpdate = () => {
      const node = entry.node;
      if (entry !== current || !node) return;
      if (node.seeking) tracker.seeking();
      else if (tracker.update(node.currentTime, node.duration)) entry.handlers?.onPlayed?.();
    };
    entry.onSeeking = tracker.seeking;
    entry.node?.addEventListener("ended", entry.onEnded);
    entry.node?.addEventListener("timeupdate", entry.onTimeUpdate);
    entry.node?.addEventListener("seeking", entry.onSeeking);
    for (const event of MEDIA_EVENTS) entry.node?.addEventListener(event, entry.onMediaEvent);
    return entry;
  };

  const release = (entry: AudioEntry | null) => {
    if (!entry) return;
    entry.handlers = null;
    entry.gainRequest?.abort();
    entry.node?.removeEventListener("ended", entry.onEnded);
    entry.node?.removeEventListener("timeupdate", entry.onTimeUpdate);
    entry.node?.removeEventListener("seeking", entry.onSeeking);
    for (const event of MEDIA_EVENTS) entry.node?.removeEventListener(event, entry.onMediaEvent);
    entry.howl.unload();
  };

  const discardPreload = () => {
    release(preloaded);
    preloaded = null;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    load({
      src,
      format,
      autoplay = true,
      startAt = 0,
      onEnd,
      onStart,
      onPlayed,
      onLoadError,
    }: AudioHandlers & {
      src: string;
      format: string[];
      autoplay?: boolean;
      startAt?: number;
    }) {
      const reusable = sameSource(preloaded, src, format) && !preloaded.failed ? preloaded : null;
      if (reusable) preloaded = null;
      else if (sameSource(preloaded, src, format)) discardPreload();
      const previous = current;
      current = reusable ?? createEntry({ src, format });
      current.handlers = { onEnd, onStart, onPlayed, onLoadError };
      release(previous);
      if (startAt > 0) {
        current.startAt = startAt;
        current.howl.seek(startAt);
      }
      current.wantsPlay = autoplay;
      if (autoplay) current.howl.play();
      emit();
    },
    preload({ src, format }: { src: string; format: string[] }) {
      if (!src || sameSource(current, src, format) || sameSource(preloaded, src, format)) return;
      discardPreload();
      preloaded = createEntry({ src, format });
    },
    discardPreload,
    play() {
      if (!current || current.howl.playing()) return;
      current.wantsPlay = true;
      current.howl.play();
      emit();
    },
    pause() {
      if (!current) return;
      current.wantsPlay = false;
      current.howl.pause();
      emit();
    },
    seek(position: number) {
      if (!current || !Number.isFinite(position)) return;
      const target = Math.max(0, position);
      if (!current.loaded) current.startAt = target;
      current.howl.seek(target);
    },
    getPosition() {
      if (!current) return 0;
      if (!current.loaded) return current.startAt;
      return current.node?.currentTime || 0;
    },
    getBufferedEnd() {
      const node = current?.node;
      const ranges = node?.buffered;
      if (!ranges) return 0;
      const position = node.currentTime || 0;
      for (let index = 0; index < ranges.length; index += 1) {
        if (ranges.start(index) <= position + 0.5 && ranges.end(index) >= position) {
          return ranges.end(index);
        }
      }
      return 0;
    },
    setVolume(nextVolume: number) {
      volume = nextVolume;
      applyVolume(current);
      applyVolume(preloaded);
    },
    setLeveling(enabled: boolean) {
      leveling = enabled;
      for (const entry of [current, preloaded]) {
        if (!entry) continue;
        requestGain(entry);
        applyVolume(entry);
      }
    },
    setMuted(nextMuted: boolean) {
      muted = nextMuted;
      current?.howl.mute(nextMuted);
      preloaded?.howl.mute(nextMuted);
    },
    unload() {
      discardPreload();
      release(current);
      current = null;
      emit();
    },
  };
}
