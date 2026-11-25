import { createPlayTracker } from "./playTracker.ts";
import { API_BASE_URL } from "./api/core.ts";

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
  onLoadError?: (error: MediaError | null) => void;
};

type AudioEntry = {
  src: string;
  wantsPlay: boolean;
  startAt: number;
  loaded: boolean;
  loading: boolean;
  playing: boolean;
  started: boolean;
  handlers: AudioHandlers | null;
  gain: number | null;
  loudness: Loudness | null;
  tracker: ReturnType<typeof createPlayTracker>;
};

type PreloadEntry = {
  src: string;
  loudness: Loudness | null;
};

type Loudness = {
  controller: AbortController;
  lufs: Promise<number | null>;
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
    const url = new URL(src, window.location.href);
    return (
      url.origin === new URL(API_BASE_URL, window.location.href).origin &&
      !/\/deezer\/preview(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function flacFallback(src: string) {
  if (!isOwnStream(src)) return null;
  const url = new URL(src, window.location.href);
  if (url.searchParams.has("format")) return null;
  url.searchParams.set("format", "flac");
  return url.href;
}

function sameSnapshot(a: AudioSnapshot, b: AudioSnapshot) {
  return (Object.keys(IDLE_SNAPSHOT) as (keyof AudioSnapshot)[]).every((key) => a[key] === b[key]);
}

function fetchLoudness(src: string): Loudness {
  const controller = new AbortController();
  const lufs = fetch(src, {
    method: "HEAD",
    credentials: "same-origin",
    redirect: "manual",
    signal: controller.signal,
  })
    .then((response) => {
      const value = Number.parseFloat(response.headers.get(LOUDNESS_HEADER) ?? "");
      return Number.isFinite(value) ? value : null;
    })
    .catch(() => null);
  return { controller, lufs };
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
  let playAttempt = 0;
  const listeners = new Set<() => void>();

  const readSnapshot = (): AudioSnapshot => {
    if (!current) return IDLE_SNAPSHOT;
    const duration = node.duration;
    return {
      isLoading: current.loading,
      isPlaying: current.playing,
      isStarting: current.wantsPlay && !current.playing,
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

  const requestLoudness = (entry: { src: string; loudness: Loudness | null }) => {
    if (leveling && !entry.loudness && isOwnStream(entry.src)) {
      entry.loudness = fetchLoudness(entry.src);
    }
  };

  const levelWhenKnown = (entry: AudioEntry) => {
    void entry.loudness?.lufs.then((lufs) => {
      if (lufs === null || current !== entry || entry.started) return;
      entry.gain = levelingGain(lufs);
      applyVolume();
    });
  };

  const attemptPlay = (entry: AudioEntry) => {
    const attempt = ++playAttempt;
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
      if (current !== entry || attempt !== playAttempt) return;
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
    if (!current || node.ended || !node.paused) return;
    current.playing = false;
    current.wantsPlay = false;
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
  node.addEventListener("error", () => {
    const entry = current;
    if (!entry) return;
    entry.loading = false;
    entry.playing = false;
    entry.wantsPlay = false;
    emit();
    entry.handlers?.onLoadError?.(node.error);
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
    preloaded.loudness?.controller.abort();
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
      autoplay = true,
      startAt = 0,
      onEnd,
      onStart,
      onPlayed,
      onLoadError,
    }: AudioHandlers & {
      src: string;
      autoplay?: boolean;
      startAt?: number;
    }) {
      const upcoming = preloaded?.src === src ? preloaded : null;
      const loudness = upcoming?.loudness ?? null;
      if (upcoming) upcoming.loudness = null;
      discardPreload();
      current?.loudness?.controller.abort();
      const entry: AudioEntry = {
        src,
        wantsPlay: autoplay,
        startAt,
        loaded: false,
        loading: true,
        playing: false,
        started: false,
        handlers: { onEnd, onStart, onPlayed, onLoadError },
        gain: null,
        loudness,
        tracker: createPlayTracker(),
      };
      current = entry;
      requestLoudness(entry);
      levelWhenKnown(entry);
      if (!node.isConnected) document.body.append(node);
      node.muted = muted;
      node.src = src;
      node.load();
      applyVolume();
      if (autoplay) attemptPlay(entry);
      emit();
    },
    preload(src: string) {
      if (!src || current?.src === src || preloaded?.src === src) return;
      discardPreload();
      preloaded = { src, loudness: null };
      requestLoudness(preloaded);
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
      if (current) {
        requestLoudness(current);
        levelWhenKnown(current);
      }
      if (preloaded) requestLoudness(preloaded);
      applyVolume();
    },
    setMuted(nextMuted: boolean) {
      muted = nextMuted;
      node.muted = nextMuted;
    },
    unload() {
      discardPreload();
      current?.loudness?.controller.abort();
      current = null;
      node.pause();
      node.removeAttribute("src");
      node.load();
      emit();
    },
  };
}
