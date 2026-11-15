import { createPlayTracker } from "./playTracker.ts";

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
  loading: boolean;
  playing: boolean;
  started: boolean;
  handlers: AudioHandlers | null;
  gain: number | null;
  gainRequest: AbortController | null;
  tracker: ReturnType<typeof createPlayTracker>;
};

type PreloadEntry = {
  src: string;
  format: string[];
  node: HTMLAudioElement;
};

const IDLE_SNAPSHOT: AudioSnapshot = {
  isLoading: false,
  isPlaying: false,
  isStarting: false,
  duration: 0,
};

const LEVELING_TARGET_LUFS = -14;
const LOUDNESS_HEADER = "X-Aurral-Loudness";
const HAVE_METADATA = 1;

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

function sameSnapshot(a: AudioSnapshot, b: AudioSnapshot) {
  return (Object.keys(IDLE_SNAPSHOT) as (keyof AudioSnapshot)[]).every((key) => a[key] === b[key]);
}

function sameSource(
  entry: Pick<AudioEntry, "src" | "format"> | PreloadEntry | null,
  src: string,
  format: string[],
) {
  return entry?.src === src && String(entry.format) === String(format);
}

export function createAudioEngine(createNode: () => HTMLAudioElement = () => new Audio()) {
  const node = createNode();
  node.preload = "auto";
  let current: AudioEntry | null = null;
  let preloaded: PreloadEntry | null = null;
  let volume = 1;
  let muted = false;
  let leveling = true;
  let snapshot: AudioSnapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();

  const readSnapshot = (): AudioSnapshot => {
    if (!current) return IDLE_SNAPSHOT;
    const duration = node.duration;
    return {
      isLoading: current.loading,
      isPlaying: current.playing,
      isStarting: current.loading && current.wantsPlay,
      duration: Number.isFinite(duration) ? duration : 0,
    };
  };

  const emit = () => {
    const next = readSnapshot();
    if (sameSnapshot(next, snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const volumeFor = (entry: AudioEntry) => volume * (leveling ? (entry.gain ?? 1) : 1);

  const applyVolume = () => {
    node.volume = current ? volumeFor(current) : volume;
  };

  const requestGain = (entry: AudioEntry) => {
    if (!leveling || entry.gainRequest || !isOwnStream(entry.src)) return;
    const request = new AbortController();
    entry.gainRequest = request;
    fetch(entry.src, { method: "HEAD", credentials: "same-origin", signal: request.signal })
      .then((response) => {
        const lufs = Number.parseFloat(response.headers.get(LOUDNESS_HEADER) ?? "");
        if (
          !Number.isFinite(lufs) ||
          request.signal.aborted ||
          current !== entry ||
          entry.started
        ) {
          return;
        }
        entry.gain = levelingGain(lufs);
        applyVolume();
      })
      .catch(() => {});
  };

  const attemptPlay = (entry: AudioEntry) => {
    let request: Promise<void>;
    try {
      request = node.play();
    } catch {
      entry.wantsPlay = false;
      entry.loading = false;
      emit();
      return;
    }
    request.catch(() => {
      if (current !== entry) return;
      entry.wantsPlay = false;
      entry.loading = false;
      entry.playing = false;
      emit();
    });
  };

  const seekToStart = (entry: AudioEntry) => {
    if (entry.startAt <= 0 || node.readyState < HAVE_METADATA) return;
    try {
      node.currentTime = entry.startAt;
      entry.startAt = 0;
    } catch {}
  };

  node.addEventListener("loadstart", () => {
    if (!current) return;
    current.loading = true;
    emit();
  });
  node.addEventListener("loadedmetadata", () => {
    if (!current) return;
    current.loaded = true;
    seekToStart(current);
    emit();
  });
  node.addEventListener("canplay", () => {
    if (!current) return;
    current.loaded = true;
    current.loading = false;
    emit();
  });
  node.addEventListener("playing", () => {
    const entry = current;
    if (!entry) return;
    entry.loaded = true;
    entry.loading = false;
    entry.playing = true;
    if (!entry.started) {
      entry.started = true;
      entry.handlers?.onStart?.();
    }
    emit();
  });
  node.addEventListener("pause", () => {
    if (!current) return;
    current.playing = false;
    emit();
  });
  node.addEventListener("ended", () => {
    const entry = current;
    if (!entry) return;
    entry.playing = false;
    entry.wantsPlay = false;
    entry.handlers?.onEnd?.();
    if (current === entry) emit();
  });
  node.addEventListener("error", (event) => {
    const entry = current;
    if (!entry) return;
    entry.loading = false;
    entry.playing = false;
    entry.wantsPlay = false;
    emit();
    entry.handlers?.onLoadError?.(event, node.error);
  });
  node.addEventListener("timeupdate", () => {
    const entry = current;
    if (!entry) return;
    if (node.seeking) entry.tracker.seeking();
    else if (entry.tracker.update(node.currentTime, node.duration)) entry.handlers?.onPlayed?.();
  });
  node.addEventListener("seeking", () => current?.tracker.seeking());
  for (const event of ["waiting", "seeked", "durationchange"]) {
    node.addEventListener(event, emit);
  }

  const discardPreload = () => {
    if (!preloaded) return;
    preloaded.node.removeAttribute("src");
    preloaded.node.load();
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
      discardPreload();
      current?.gainRequest?.abort();
      const entry: AudioEntry = {
        src,
        format,
        wantsPlay: autoplay,
        startAt,
        loaded: false,
        loading: true,
        playing: false,
        started: false,
        handlers: { onEnd, onStart, onPlayed, onLoadError },
        gain: null,
        gainRequest: null,
        tracker: createPlayTracker(),
      };
      current = entry;
      node.muted = muted;
      applyVolume();
      node.src = src;
      node.load();
      requestGain(entry);
      seekToStart(entry);
      if (autoplay) attemptPlay(entry);
      emit();
    },
    preload({ src, format }: { src: string; format: string[] }) {
      if (!src || sameSource(current, src, format) || sameSource(preloaded, src, format)) return;
      discardPreload();
      const preloadNode = createNode();
      preloadNode.preload = "auto";
      preloadNode.muted = true;
      preloaded = { src, format, node: preloadNode };
      preloadNode.src = src;
      preloadNode.load();
    },
    discardPreload,
    play() {
      if (!current || current.playing) return;
      current.wantsPlay = true;
      current.loading = !current.loaded;
      attemptPlay(current);
      emit();
    },
    pause() {
      if (!current) return;
      current.wantsPlay = false;
      current.playing = false;
      node.pause();
      emit();
    },
    seek(position: number) {
      if (!current || !Number.isFinite(position)) return;
      const target = Math.max(0, position);
      if (!current.loaded || node.readyState < HAVE_METADATA) {
        current.startAt = target;
        return;
      }
      try {
        node.currentTime = target;
      } catch {}
    },
    getPosition() {
      if (!current) return 0;
      if (!current.loaded) return current.startAt;
      return node.currentTime || 0;
    },
    getBufferedEnd() {
      if (!current) return 0;
      const { buffered } = node;
      const position = node.currentTime || 0;
      for (let index = 0; index < buffered.length; index += 1) {
        if (buffered.start(index) <= position + 0.5 && buffered.end(index) >= position) {
          return buffered.end(index);
        }
      }
      return 0;
    },
    setVolume(nextVolume: number) {
      volume = nextVolume;
      applyVolume();
    },
    setLeveling(enabled: boolean) {
      leveling = enabled;
      if (current) requestGain(current);
      applyVolume();
    },
    setMuted(nextMuted: boolean) {
      muted = nextMuted;
      node.muted = nextMuted;
    },
    unload() {
      discardPreload();
      current?.gainRequest?.abort();
      current = null;
      node.pause();
      node.removeAttribute("src");
      node.load();
      emit();
    },
  };
}
