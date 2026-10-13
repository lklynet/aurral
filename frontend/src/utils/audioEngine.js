import { Howl } from "howler";

const IDLE_SNAPSHOT = {
  isLoading: false,
  isPlaying: false,
  isStarting: false,
  duration: 0,
};

const HOWL_EVENTS = ["load", "loaderror", "play", "playerror", "pause", "stop", "end", "seek"];
const MEDIA_EVENTS = ["playing", "pause", "waiting", "seeked", "canplay", "durationchange"];

function mediaNode(howl) {
  return howl?._sounds?.[0]?._node ?? null;
}

function readSnapshot(entry) {
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

function sameSnapshot(a, b) {
  return Object.keys(IDLE_SNAPSHOT).every((key) => a[key] === b[key]);
}

function sameSource(entry, src, format) {
  return entry?.src === src && String(entry.format) === String(format);
}

export function createAudioEngine() {
  let current = null;
  let preloaded = null;
  let volume = 1;
  let muted = false;
  let snapshot = IDLE_SNAPSHOT;
  const listeners = new Set();

  const emit = () => {
    const next = readSnapshot(current);
    if (sameSnapshot(next, snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const createEntry = ({ src, format }) => {
    const entry = {
      src,
      format,
      wantsPlay: false,
      startAt: 0,
      loaded: false,
      failed: false,
      handlers: null,
    };
    entry.howl = new Howl({
      src: [src],
      format,
      html5: true,
      preload: true,
      autoplay: false,
      volume,
      mute: muted,
    });
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
    for (const event of HOWL_EVENTS) {
      entry.howl.on(event, (...args) => {
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
    entry.node?.addEventListener("ended", entry.onEnded);
    for (const event of MEDIA_EVENTS) entry.node?.addEventListener(event, entry.onMediaEvent);
    return entry;
  };

  const release = (entry) => {
    if (!entry) return;
    entry.handlers = null;
    entry.node?.removeEventListener("ended", entry.onEnded);
    for (const event of MEDIA_EVENTS) entry.node?.removeEventListener(event, entry.onMediaEvent);
    entry.howl.unload();
  };

  const discardPreload = () => {
    release(preloaded);
    preloaded = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    load({ src, format, autoplay = true, startAt = 0, onEnd, onLoadError }) {
      const reusable = sameSource(preloaded, src, format) && !preloaded.failed ? preloaded : null;
      if (reusable) preloaded = null;
      else if (sameSource(preloaded, src, format)) discardPreload();
      const previous = current;
      current = reusable ?? createEntry({ src, format });
      current.handlers = { onEnd, onLoadError };
      release(previous);
      if (startAt > 0) {
        current.startAt = startAt;
        current.howl.seek(startAt);
      }
      current.wantsPlay = autoplay;
      if (autoplay) current.howl.play();
      emit();
    },
    preload({ src, format }) {
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
    seek(position) {
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
    setVolume(nextVolume) {
      volume = nextVolume;
      current?.howl.volume(nextVolume);
      preloaded?.howl.volume(nextVolume);
    },
    setMuted(nextMuted) {
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
