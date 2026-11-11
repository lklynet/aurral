import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AUTOPLAY_SOURCE,
  getUpcomingTracks,
  getFormatLoadAttempts,
  isAutoplayEntry,
  radioSeedFor,
  getHowlerFormat,
  initialQueueState,
  normalizeQueueTrack,
  normalizeStreamQueueTrack,
  queueReducer,
  shouldRestartTrack,
} from "../utils/audioQueue";
import type {
  ArtworkTarget,
  QueueAction,
  QueueEntry,
  QueueSource,
  QueueState,
  QueueTrackInput,
  RadioSeed,
} from "../utils/audioQueue";
import { AudioQueueContext } from "./audioQueueContext";
import { useAuth } from "./AuthContext";
import { getRequestToken } from "../utils/api/core";
import {
  QUEUE_STORAGE_KEY,
  parseStoredQueue,
  remoteQueueFor,
  serializeQueue,
} from "../utils/queueStorage";
import { parseResponse } from "hono/client";
import { playQueueClient } from "../utils/api/clients/playQueue.ts";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { playEventsClient } from "../utils/api/clients/playEvents.ts";
import { libraryRadioClient } from "../utils/api/clients/libraryRadio.ts";
import { getReleaseGroupCover } from "../utils/api/endpoints/artists";
import { createAudioEngine } from "../utils/audioEngine";
import {
  MEDIA_SESSION_SEEK_SECONDS,
  mediaSessionArtwork,
  mediaSessionPosition,
} from "../utils/mediaSession";
import { isRecord } from "../../../lib/isRecord.ts";

const SHARED_VOLUME_KEY = "aurral.preview.volume";
const SHARED_MUTED_KEY = "aurral.preview.muted";
const SHARED_VOLUME_EVENT = "aurral:shared-volume-change";
const DEFAULT_VOLUME = 0.7;
const PRELOAD_LEAD_SECONDS = 20;
const POSITION_SAVE_MS = 5000;
const PLAYER_CHANNEL = "aurral.player";
const DEVICE_KEY = "aurral.player.device";
const REMOTE_SAVE_MS = 30000;
const AUTOPLAY_KEY = "aurral.player.autoplay";
const LEVELING_KEY = "aurral.player.leveling";
const RADIO_REFILL_AT = 2;
const AUTOPLAY_SEED_TRACKS = 5;
const RADIO_EXCLUDE_LIMIT = 500;
const PASSIVE_ACTIONS = new Set([
  "SET_ALBUM_ARTWORK",
  "UPDATE_ARTWORK",
  "SET_ERROR",
  "RESTORE_QUEUE",
]);

const SHARED_AUDIO_KEYS: (string | null)[] = [SHARED_VOLUME_KEY, SHARED_MUTED_KEY];

type StoredAudio = { volume: number; muted: boolean };
type LoadTrackOptions = { formatAttemptIndex?: number; autoplay?: boolean };

function normalizeVolume(value: string | number) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, parsed));
}

function readStoredAudio() {
  if (typeof window === "undefined") return { volume: DEFAULT_VOLUME, muted: false };
  const storedVolume = window.localStorage.getItem(SHARED_VOLUME_KEY);
  const storedMuted = window.localStorage.getItem(SHARED_MUTED_KEY);
  const volume = storedVolume == null ? DEFAULT_VOLUME : normalizeVolume(storedVolume);
  if (volume <= 0) return { volume: DEFAULT_VOLUME, muted: storedMuted !== "false" };
  return { volume, muted: storedMuted === "true" };
}

function writeStoredAudio(audio: StoredAudio) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SHARED_VOLUME_KEY, String(audio.volume));
  window.localStorage.setItem(SHARED_MUTED_KEY, String(audio.muted));
  window.dispatchEvent(new CustomEvent(SHARED_VOLUME_EVENT));
}

function useSharedVolume() {
  const [audio, setAudio] = useState(readStoredAudio);

  useEffect(() => {
    const handleVolumeChange = (event: Event) => {
      if (event.type === "storage" && !SHARED_AUDIO_KEYS.includes((event as StorageEvent).key)) {
        return;
      }
      setAudio(readStoredAudio());
    };

    window.addEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
    window.addEventListener("storage", handleVolumeChange);

    return () => {
      window.removeEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
      window.removeEventListener("storage", handleVolumeChange);
    };
  }, []);

  const update = useCallback((change: Partial<StoredAudio>) => {
    const next = { ...readStoredAudio(), ...change };
    setAudio(next);
    writeStoredAudio(next);
  }, []);

  const setVolume = useCallback(
    (nextVolume: string | number) => {
      const volume = normalizeVolume(nextVolume);
      update(volume > 0 ? { volume, muted: false } : { muted: true });
    },
    [update],
  );

  const setMuted = useCallback((muted: boolean) => update({ muted: Boolean(muted) }), [update]);

  return { ...audio, setVolume, setMuted };
}

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function writeFlag(key: string, enabled: boolean) {
  try {
    window.localStorage.setItem(key, String(enabled));
  } catch {}
}

function readDevice() {
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
  } catch {}
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const created = `Aurral web ${suffix}`;
  try {
    window.localStorage.setItem(DEVICE_KEY, created);
  } catch {}
  return created;
}

async function fetchRadio(seed: RadioSeed, queue: QueueEntry[] = []) {
  const exclude = queue
    .flatMap((entry) => (entry.libraryTrackId == null ? [] : [String(entry.libraryTrackId)]))
    .slice(-RADIO_EXCLUDE_LIMIT);
  const { tracks } = await parseResponse(
    libraryRadioClient.radio.$post({ json: { ...seed, exclude } }),
  );
  return tracks.map(normalizeStreamQueueTrack);
}

function trackAt(state: QueueState, playbackIndex: number) {
  const queueIndex = state.playbackOrder[playbackIndex];
  return queueIndex == null ? null : (state.queue[queueIndex] ?? null);
}

function trackSignature(
  state: QueueState,
  playbackIndex: number,
  track: QueueEntry,
  formatKey: string,
) {
  return `${state.queueRevision}:${track.entryId ?? state.playbackOrder[playbackIndex]}:${track.src}:${formatKey}`;
}

function readStoredQueue(owner: string | null) {
  try {
    return parseStoredQueue(window.localStorage.getItem(QUEUE_STORAGE_KEY), {
      owner,
      token: getRequestToken(),
    });
  } catch {
    return null;
  }
}

function writeStoredQueue(value: string | null) {
  try {
    if (value) window.localStorage.setItem(QUEUE_STORAGE_KEY, value);
    else window.localStorage.removeItem(QUEUE_STORAGE_KEY);
  } catch {
    try {
      window.localStorage.removeItem(QUEUE_STORAGE_KEY);
    } catch {}
  }
}

export function AudioQueueProvider({ children }: { children: ReactNode }) {
  const [engine] = useState(createAudioEngine);
  const playback = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const { user } = useAuth() ?? {};
  const owner = user ? String(user.id ?? user.username ?? "local") : null;
  const ownsQueueRef = useRef(false);
  const restoredOwnerRef = useRef<string | null>(null);
  const resumeAtRef = useRef<{ entryId: string; position: number } | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [device] = useState(readDevice);
  const remoteSentRef = useRef<{ key: string; positionMs: number; at: number } | null>(null);
  const remoteSeenRef = useRef(0);
  const userActionsRef = useRef(0);

  const { volume, muted, setVolume, setMuted } = useSharedVolume();
  const [autoplayEnabled, setAutoplayState] = useState(() => readFlag(AUTOPLAY_KEY));
  const [levelingEnabled, setLevelingState] = useState(() => readFlag(LEVELING_KEY));
  const autoplayRef = useRef(autoplayEnabled);
  autoplayRef.current = autoplayEnabled;
  const refillRef = useRef<{ entryId: string; queue: QueueEntry[] } | null>(null);
  const radioRequestRef = useRef(0);

  const [state, applyAction] = useReducer(queueReducer, initialQueueState);
  const dispatch = useCallback((action: QueueAction) => {
    if (!PASSIVE_ACTIONS.has(action.type)) {
      ownsQueueRef.current = true;
      userActionsRef.current += 1;
    }
    applyAction(action);
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadedSignatureRef = useRef<string | null>(null);

  const loadTrackRef = useRef<
    (s: QueueState, playbackIndex: number, options?: LoadTrackOptions) => void
  >(() => {});

  const recordPlay = useCallback((track: QueueEntry) => {
    if (!track.recordHistory) return;
    parseResponse(
      playEventsClient.$post({
        json: {
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          albumId: track.libraryAlbumId,
          artistMbid: track.artistMbid,
          albumMbid: track.albumMbid,
          trackMbid: track.trackMbid,
          durationMs: track.durationMs,
          playedAt: Date.now(),
          source: "native-player",
        },
      }),
    ).catch(() => {});
  }, []);

  const loadTrack = useCallback(
    (
      s: QueueState,
      playbackIndex: number,
      { formatAttemptIndex = 0, autoplay = true }: LoadTrackOptions = {},
    ) => {
      const track = trackAt(s, playbackIndex);
      if (!track?.src) return;
      const formatAttempts = getFormatLoadAttempts(track);
      const formatKey = formatAttempts[formatAttemptIndex];
      if (!formatKey) return;
      const signature = trackSignature(s, playbackIndex, track, formatKey);
      if (loadedSignatureRef.current === signature) return;
      loadedSignatureRef.current = signature;
      const resumeAt = resumeAtRef.current;
      if (resumeAt?.entryId !== track.entryId) resumeAtRef.current = null;

      engine.load({
        src: track.src,
        format: getHowlerFormat(formatKey),
        autoplay,
        startAt: resumeAt?.entryId === track.entryId ? resumeAt.position : 0,
        onLoadError: () => {
          loadedSignatureRef.current = null;
          if (formatAttemptIndex + 1 >= formatAttempts.length) {
            resumeAtRef.current = null;
            dispatch({
              type: "SET_ERROR",
              error: "Track unavailable. Restore the file or refresh the Library.",
            });
            engine.pause();
            return;
          }
          loadTrackRef.current(stateRef.current, playbackIndex, {
            formatAttemptIndex: formatAttemptIndex + 1,
            autoplay,
          });
        },
        onPlayed: () => recordPlay(track),
        onEnd: () => {
          const cur = stateRef.current;
          if (cur.currentIndex < 0) return;
          const action: QueueAction = { type: cur.repeatMode === "one" ? "REPLAY" : "NEXT" };
          const next = queueReducer(cur, action);
          if (next.autoplay) loadTrackRef.current(next, next.currentIndex);
          dispatch(action);
        },
      });
    },
    [dispatch, engine, recordPlay],
  );

  const loadTrackAtIndex = useCallback(
    (playbackIndex: number, options?: LoadTrackOptions) =>
      loadTrack(stateRef.current, playbackIndex, options),
    [loadTrack],
  );

  loadTrackRef.current = loadTrack;
  useEffect(() => {
    if (state.currentIndex < 0) {
      loadedSignatureRef.current = null;
      return;
    }
    loadTrackAtIndex(state.currentIndex, { autoplay: state.autoplay });
  }, [state.autoplay, state.currentIndex, state.queueRevision, loadTrackAtIndex]);

  useEffect(() => {
    if (!playback.isPlaying) return undefined;
    const preloadUpcoming = () => {
      const s = stateRef.current;
      const { duration } = engine.getSnapshot();
      if (!duration || duration - engine.getPosition() > PRELOAD_LEAD_SECONDS) return;
      const next = queueReducer(s, { type: s.repeatMode === "one" ? "REPLAY" : "NEXT" });
      const track = next.autoplay ? trackAt(next, next.currentIndex) : null;
      if (!track?.src) {
        engine.discardPreload();
        return;
      }
      engine.preload({
        src: track.src,
        format: getHowlerFormat(getFormatLoadAttempts(track)[0]),
      });
    };
    preloadUpcoming();
    const interval = window.setInterval(preloadUpcoming, 1000);
    return () => window.clearInterval(interval);
  }, [engine, playback.isPlaying, state.currentIndex, state.playbackOrder, state.repeatMode]);

  useEffect(() => () => engine.unload(), [engine]);

  useEffect(() => {
    engine.setVolume(volume);
    engine.setMuted(muted);
  }, [engine, muted, volume]);

  useEffect(() => engine.setLeveling(levelingEnabled), [engine, levelingEnabled]);

  const setLevelingEnabled = useCallback((enabled: boolean) => {
    setLevelingState(enabled);
    writeFlag(LEVELING_KEY, enabled);
  }, []);

  const toggleMute = useCallback(() => setMuted(!muted), [muted, setMuted]);

  const setShuffleEnabled = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "SET_SHUFFLE", enabled });
    },
    [dispatch],
  );

  const toggleShuffle = useCallback(() => {
    dispatch({ type: "SET_SHUFFLE", enabled: !stateRef.current.isShuffleEnabled });
  }, [dispatch]);

  const toggleRepeat = useCallback(() => {
    dispatch({ type: "TOGGLE_REPEAT" });
  }, [dispatch]);

  const playQueue = useCallback(
    (
      tracks: QueueTrackInput[],
      {
        startTrackId = null,
        source: nextSource = null,
        shuffle = false,
      }: {
        startTrackId?: string | number | null;
        source?: QueueSource | null;
        shuffle?: boolean;
      } = {},
    ) => {
      const normalized = (Array.isArray(tracks) ? tracks : [])
        .map((track) => normalizeQueueTrack(track))
        .filter((track) => track.src);
      if (normalized.length === 0) return false;
      dispatch({
        type: "PLAY_QUEUE",
        tracks: normalized,
        startTrackId,
        shuffle,
        source: nextSource,
      });
      return true;
    },
    [dispatch],
  );

  const playTrack = useCallback(
    (
      track: QueueTrackInput,
      options: { queue?: QueueTrackInput[]; source?: QueueSource | null } = {},
    ) => {
      const normalized = normalizeQueueTrack(track);
      if (!normalized.src) return false;
      const contextTracks = (
        Array.isArray(options.queue) && options.queue.length > 0 ? options.queue : [track]
      )
        .map((entry) => normalizeQueueTrack(entry))
        .filter((entry) => entry.src);
      if (contextTracks.length === 0) return false;
      return playQueue(contextTracks, {
        startTrackId: normalized.id,
        source: options.source ?? null,
      });
    },
    [playQueue],
  );

  const startRadio = useCallback(
    async (
      seed: RadioSeed,
      { label, first }: { label: string; first?: QueueTrackInput | null },
    ) => {
      const source: QueueSource = {
        type: "radio",
        id: JSON.stringify(seed),
        label: `${label} radio`,
        seed,
      };
      refillRef.current = null;
      const request = ++radioRequestRef.current;
      if (first && playQueue([first], { source })) return true;
      const revision = stateRef.current.queueRevision;
      const tracks = await fetchRadio(seed);
      if (request !== radioRequestRef.current || stateRef.current.queueRevision !== revision) {
        return true;
      }
      return playQueue(tracks, { source });
    },
    [playQueue],
  );

  const setAutoplayEnabled = useCallback(
    (enabled: boolean) => {
      setAutoplayState(enabled);
      writeFlag(AUTOPLAY_KEY, enabled);
      refillRef.current = null;
      if (!enabled) dispatch({ type: "REMOVE_AUTOPLAY" });
    },
    [dispatch],
  );

  const insertTracks = useCallback(
    (
      tracks: QueueTrackInput | QueueTrackInput[],
      position: "next" | "end",
      { source: nextSource = null }: { source?: QueueSource | null } = {},
    ) => {
      const normalized = (Array.isArray(tracks) ? tracks : [tracks])
        .map((track) => normalizeQueueTrack(track))
        .filter((track) => track.src)
        .map((track) => ({ ...track, queueSource: nextSource }));
      if (normalized.length === 0) return false;
      const started = stateRef.current.currentIndex < 0;
      dispatch({ type: "INSERT_TRACKS", tracks: normalized, position, source: nextSource });
      return started ? "started" : "queued";
    },
    [dispatch],
  );

  const queueNext = useCallback(
    (tracks: QueueTrackInput | QueueTrackInput[], options?: { source?: QueueSource | null }) =>
      insertTracks(tracks, "next", options),
    [insertTracks],
  );

  const addToQueue = useCallback(
    (tracks: QueueTrackInput | QueueTrackInput[], options?: { source?: QueueSource | null }) =>
      insertTracks(tracks, "end", options),
    [insertTracks],
  );

  const removeFromQueue = useCallback(
    (entryId: string) => {
      dispatch({ type: "REMOVE_ENTRY", entryId });
    },
    [dispatch],
  );

  const reorderUpcoming = useCallback(
    (entryIds: string[]) => {
      dispatch({ type: "REORDER_UPCOMING", entryIds });
    },
    [dispatch],
  );

  const clearUpcoming = useCallback(() => {
    const { queue, playbackOrder, isShuffleEnabled } = stateRef.current;
    dispatch({ type: "CLEAR_UPCOMING" });
    return () => dispatch({ type: "RESTORE_ORDER", queue, playbackOrder, isShuffleEnabled });
  }, [dispatch]);

  const updateQueueArtwork = useCallback(
    (target: ArtworkTarget, artwork: string | null, artworkSource: string | null = null) => {
      dispatch({ type: "UPDATE_ARTWORK", target, artwork, artworkSource });
    },
    [dispatch],
  );

  const togglePlayPause = useCallback(() => {
    if (stateRef.current.queue.length === 0) return;
    if (stateRef.current.error) {
      dispatch({ type: "CLEAR_ERROR" });
      loadedSignatureRef.current = null;
      loadTrackAtIndex(stateRef.current.currentIndex);
      return;
    }
    const snapshot = engine.getSnapshot();
    if (snapshot.isPlaying || snapshot.isStarting) {
      engine.pause();
      return;
    }
    if (loadedSignatureRef.current) {
      engine.play();
      return;
    }
    if (stateRef.current.currentIndex >= 0) loadTrackAtIndex(stateRef.current.currentIndex);
  }, [dispatch, engine, loadTrackAtIndex]);

  const playNext = useCallback(() => {
    dispatch({ type: "NEXT" });
  }, [dispatch]);

  const updatePositionState = useCallback(
    (position = engine.getPosition()) => {
      const mediaSession = navigator.mediaSession;
      if (typeof mediaSession?.setPositionState !== "function") return;
      const positionState =
        stateRef.current.currentIndex >= 0
          ? mediaSessionPosition(engine.getSnapshot().duration, position)
          : null;
      try {
        if (positionState) mediaSession.setPositionState(positionState);
        else mediaSession.setPositionState();
      } catch {}
    },
    [engine],
  );

  const seek = useCallback(
    (position: number) => {
      const { duration } = engine.getSnapshot();
      if (!Number.isFinite(position)) return;
      const target = Math.max(0, duration > 0 ? Math.min(position, duration) : position);
      engine.seek(target);
      updatePositionState(target);
    },
    [engine, updatePositionState],
  );

  const playPrevious = useCallback(() => {
    const s = stateRef.current;
    if (s.queue.length === 0) return;
    if (shouldRestartTrack(s, engine.getPosition())) {
      seek(0);
      return;
    }
    dispatch({ type: "PREVIOUS" });
  }, [dispatch, engine, seek]);

  const skipTo = useCallback(
    (playbackIndex: number) => {
      if (playbackIndex === stateRef.current.currentIndex) return;
      dispatch({ type: "SKIP_TO", index: playbackIndex });
    },
    [dispatch],
  );

  const isRunning = useCallback(() => {
    const snapshot = engine.getSnapshot();
    return snapshot.isPlaying || snapshot.isStarting;
  }, [engine]);

  const positionOf = useCallback(
    (s: QueueState, track: QueueEntry | null | undefined) => {
      if (!track) return 0;
      if (loadedSignatureRef.current?.startsWith(`${s.queueRevision}:${track.entryId}:`)) {
        return engine.getPosition();
      }
      const resumeAt = resumeAtRef.current;
      return resumeAt?.entryId === track.entryId ? resumeAt.position : 0;
    },
    [engine],
  );

  const clearQueue = useCallback(() => {
    const stopped = stateRef.current;
    const track = trackAt(stopped, stopped.currentIndex);
    const position = positionOf(stopped, track);
    const wasRunning = isRunning();
    loadedSignatureRef.current = null;
    dispatch({ type: "CLEAR_QUEUE" });
    engine.unload();
    remoteSentRef.current = null;
    if (owner) {
      playQueueClient.$delete({ json: { device, changed: remoteSeenRef.current } }).catch(() => {});
    }
    return () => {
      if (!track) return;
      const action: QueueAction = {
        type: "RESTORE_QUEUE",
        queue: stopped.queue,
        playbackOrder: stopped.playbackOrder,
        currentIndex: stopped.currentIndex,
        source: stopped.source,
        isShuffleEnabled: stopped.isShuffleEnabled,
        repeatMode: stopped.repeatMode,
        autoplay: wasRunning,
      };
      const restored = queueReducer(stateRef.current, action);
      const restoredTrack = trackAt(restored, restored.currentIndex);
      if (!restoredTrack) return;
      resumeAtRef.current = { entryId: restoredTrack.entryId, position };
      dispatch(action);
    };
  }, [device, dispatch, engine, isRunning, owner, positionOf]);

  const pushRemote = useCallback(
    (s: QueueState, position: number) => {
      const remote = remoteQueueFor(s, position);
      if (!remote) return;
      const key = JSON.stringify([remote.streamPaths, remote.current]);
      const sent = remoteSentRef.current;
      const now = Date.now();
      if (sent?.key === key) {
        const moved = Math.abs(sent.positionMs - remote.positionMs) >= 1000;
        if (!moved || (isRunning() && now - sent.at < REMOTE_SAVE_MS)) return;
      }
      remoteSentRef.current = { key, positionMs: remote.positionMs, at: now };
      parseResponse(
        playQueueClient.$put({ json: { ...remote, device } }, { init: { keepalive: true } }),
      )
        .then(({ changed }) => {
          if (changed) remoteSeenRef.current = Math.max(remoteSeenRef.current, changed);
        })
        .catch(() => {
          if (remoteSentRef.current?.key === key) remoteSentRef.current = null;
        });
    },
    [device, isRunning],
  );

  const saveQueue = useCallback(() => {
    if (!ownsQueueRef.current || !owner || restoredOwnerRef.current !== owner) return;
    const s = stateRef.current;
    const position = positionOf(s, trackAt(s, s.currentIndex));
    writeStoredQueue(serializeQueue(s, { owner, position }));
    pushRemote(s, position);
  }, [owner, positionOf, pushRemote]);

  const pullRemote = useCallback(async () => {
    if (!owner || restoredOwnerRef.current !== owner || isRunning()) return;
    const actions = userActionsRef.current;
    const { queue } = await parseResponse(playQueueClient.$get()).catch(() => ({ queue: null }));
    if (!queue || queue.changedBy === device || queue.changed <= remoteSeenRef.current) return;
    if (restoredOwnerRef.current !== owner || userActionsRef.current !== actions || isRunning()) {
      return;
    }
    remoteSeenRef.current = queue.changed;
    const tracks = queue.tracks.map(normalizeStreamQueueTrack);
    const action: QueueAction = {
      type: "RESTORE_QUEUE",
      queue: tracks,
      playbackOrder: tracks.map((_, index) => index),
      currentIndex: queue.currentIndex,
    };
    const position = queue.positionMs / 1000;
    const restored = queueReducer(queueReducer(stateRef.current, { type: "CLEAR_QUEUE" }), action);
    const track = trackAt(restored, restored.currentIndex);
    ownsQueueRef.current = false;
    loadedSignatureRef.current = null;
    engine.unload();
    resumeAtRef.current = track ? { entryId: track.entryId, position } : null;
    applyAction({ type: "CLEAR_QUEUE" });
    applyAction(action);
    writeStoredQueue(serializeQueue(restored, { owner, position }));
  }, [device, engine, isRunning, owner]);

  useEffect(() => {
    if (restoredOwnerRef.current === owner) return;
    const previousOwner = restoredOwnerRef.current;
    restoredOwnerRef.current = owner;
    let cur = stateRef.current;
    if (previousOwner != null) {
      ownsQueueRef.current = false;
      remoteSentRef.current = null;
      remoteSeenRef.current = 0;
      resumeAtRef.current = null;
      loadedSignatureRef.current = null;
      engine.unload();
      cur = queueReducer(cur, { type: "CLEAR_QUEUE" });
      applyAction({ type: "CLEAR_QUEUE" });
    }
    if (!owner || cur.currentIndex >= 0) return;
    const saved = readStoredQueue(owner);
    if (!saved) return;
    const action: QueueAction = { type: "RESTORE_QUEUE", ...saved };
    const restored = queueReducer(cur, action);
    const track = trackAt(restored, restored.currentIndex);
    resumeAtRef.current = track ? { entryId: track.entryId, position: saved.position } : null;
    applyAction(action);
  }, [engine, owner]);

  useEffect(() => {
    if (!owner) return undefined;
    void pullRemote();
    const handleVisible = () => {
      if (document.visibilityState === "visible") void pullRemote();
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [owner, pullRemote]);

  useWebSocketChannel(
    "play-queue",
    (message) => {
      if (message.type === "play_queue_changed" && message.changedBy !== device) {
        void pullRemote();
      }
    },
    { enabled: Boolean(owner) },
  );

  useEffect(() => {
    saveQueue();
  }, [saveQueue, state]);

  const isPlayingOrStarting = playback.isPlaying || playback.isStarting;

  useEffect(() => {
    if (!isPlayingOrStarting) {
      saveQueue();
      return undefined;
    }
    resumeAtRef.current = null;
    ownsQueueRef.current = true;
    channelRef.current?.postMessage({ type: "playing" });
    const interval = window.setInterval(saveQueue, POSITION_SAVE_MS);
    return () => window.clearInterval(interval);
  }, [isPlayingOrStarting, saveQueue]);

  useEffect(() => {
    const handleHide = () => {
      if (document.visibilityState === "hidden") saveQueue();
    };
    window.addEventListener("pagehide", saveQueue);
    document.addEventListener("visibilitychange", handleHide);
    return () => {
      window.removeEventListener("pagehide", saveQueue);
      document.removeEventListener("visibilitychange", handleHide);
    };
  }, [saveQueue]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(PLAYER_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.type !== "playing") return;
      ownsQueueRef.current = false;
      const snapshot = engine.getSnapshot();
      if (snapshot.isPlaying || snapshot.isStarting) engine.pause();
    };
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [engine]);

  const currentTrack = state.currentIndex >= 0 ? trackAt(state, state.currentIndex) : null;
  const isActive = state.queue.length > 0 && state.currentIndex >= 0;
  const upcoming = useMemo(() => getUpcomingTracks(state), [state]);

  useEffect(() => {
    if (!isPlayingOrStarting || state.repeatMode !== "off" || !currentTrack) return;
    if (currentTrack.isPreview || upcoming.length > RADIO_REFILL_AT) return;
    const station =
      currentTrack.queueSource === undefined ? state.source : currentTrack.queueSource;
    const radio = station?.type === "radio" && station.seed ? station : null;
    if (!radio && !(autoplayEnabled && upcoming.every(({ track }) => isAutoplayEntry(track)))) {
      return;
    }
    const { queue } = state;
    const entryId = currentTrack.entryId;
    if (refillRef.current?.entryId === entryId && refillRef.current.queue === queue) return;
    refillRef.current = { entryId, queue };
    const played = state.playbackOrder
      .slice(Math.max(0, state.currentIndex - AUTOPLAY_SEED_TRACKS + 1), state.currentIndex + 1)
      .flatMap((queueIndex) => state.queue[queueIndex] ?? [])
      .filter((entry) => !entry.isPreview)
      .reverse();
    const seed = radio?.seed ?? radioSeedFor(played);
    const queueSource = radio ?? AUTOPLAY_SOURCE;
    const revision = state.queueRevision;
    fetchRadio(seed, queue)
      .then((tracks) => {
        const latest = stateRef.current;
        if (!ownsQueueRef.current || tracks.length === 0) return;
        if (latest.queue !== queue) return;
        if (!radio && !autoplayRef.current) return;
        const ranOut = !latest.autoplay && latest.queueRevision !== revision;
        dispatch({
          type: "EXTEND_QUEUE",
          tracks: tracks.map((track) => ({ ...track, queueSource })),
        });
        if (ranOut) dispatch({ type: "SKIP_TO", index: latest.playbackOrder.length });
      })
      .catch(() => {});
  }, [autoplayEnabled, currentTrack, dispatch, isPlayingOrStarting, state, upcoming]);

  const missingArtworkMbid = currentTrack && !currentTrack.artwork ? currentTrack.albumMbid : null;
  const currentArtist = currentTrack?.artist || "";
  const currentAlbum = currentTrack?.album || "";

  useEffect(() => {
    if (!missingArtworkMbid) return undefined;
    let cancelled = false;
    getReleaseGroupCover(missingArtworkMbid, {
      artistName: currentArtist,
      albumTitle: currentAlbum,
    })
      .then(({ images }) => {
        const artwork = images[0]?.image;
        if (!cancelled && artwork) {
          dispatch({ type: "SET_ALBUM_ARTWORK", albumMbid: missingArtworkMbid, artwork });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dispatch, currentAlbum, currentArtist, missingArtworkMbid]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || typeof MediaMetadata === "undefined") return;
    mediaSession.metadata = currentTrack
      ? new MediaMetadata({
          title: currentTrack.title || "",
          artist: currentTrack.artist || "",
          album: currentTrack.album || "",
          artwork: mediaSessionArtwork(currentTrack.artwork, window.location.href),
        })
      : null;
  }, [currentTrack]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;
    mediaSession.playbackState = !isActive ? "none" : isPlayingOrStarting ? "playing" : "paused";
  }, [isActive, isPlayingOrStarting]);

  useEffect(() => {
    updatePositionState();
  }, [
    currentTrack,
    isActive,
    playback.duration,
    playback.isLoading,
    playback.isPlaying,
    updatePositionState,
  ]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !isActive) return undefined;
    const isRunning = () => {
      const snapshot = engine.getSnapshot();
      return snapshot.isPlaying || snapshot.isStarting;
    };
    const seekBy = (offset: number) => seek(engine.getPosition() + offset);
    const handlers = {
      play: () => {
        if (!isRunning()) togglePlayPause();
      },
      pause: () => {
        if (isRunning()) togglePlayPause();
      },
      nexttrack: playNext,
      previoustrack: playPrevious,
      seekto: (details: MediaSessionActionDetails) => {
        if (details?.seekTime !== undefined) seek(details.seekTime);
      },
      seekforward: (details: MediaSessionActionDetails) =>
        seekBy(details?.seekOffset || MEDIA_SESSION_SEEK_SECONDS),
      seekbackward: (details: MediaSessionActionDetails) =>
        seekBy(-(details?.seekOffset || MEDIA_SESSION_SEEK_SECONDS)),
      stop: clearQueue,
    } satisfies Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;
    for (const [action, handler] of Object.entries(handlers) as [
      MediaSessionAction,
      MediaSessionActionHandler,
    ][]) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const action of Object.keys(handlers) as MediaSessionAction[]) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [clearQueue, engine, isActive, playNext, playPrevious, seek, togglePlayPause]);

  const activeSource =
    currentTrack && "queueSource" in currentTrack ? currentTrack.queueSource : state.source;

  const matchesSource = useCallback(
    (candidate: Partial<QueueSource> | null | undefined) => {
      if (!candidate || !activeSource) return false;
      if (candidate.type && candidate.type !== activeSource.type) return false;
      if (candidate.id != null && String(candidate.id) !== String(activeSource.id)) return false;
      return true;
    },
    [activeSource],
  );

  const value = useMemo(
    () => ({
      queue: state.queue,
      upcoming,
      currentTrack,
      currentIndex: state.currentIndex,
      source: state.source,
      playbackError: state.error,
      isActive,
      isPlaying: playback.isPlaying,
      isLoading: playback.isLoading,
      isStarting: playback.isStarting,
      duration: playback.duration,
      getPosition: engine.getPosition,
      getBufferedEnd: engine.getBufferedEnd,
      seek,
      volume,
      muted,
      setVolume,
      setMuted,
      toggleMute,
      isShuffleEnabled: state.isShuffleEnabled,
      setShuffleEnabled,
      repeatMode: state.repeatMode,
      toggleRepeat,
      autoplayEnabled,
      setAutoplayEnabled,
      levelingEnabled,
      setLevelingEnabled,
      startRadio,
      playQueue,
      playTrack,
      togglePlayPause,
      playNext,
      playPrevious,
      clearQueue,
      skipTo,
      toggleShuffle,
      matchesSource,
      queueNext,
      addToQueue,
      removeFromQueue,
      reorderUpcoming,
      clearUpcoming,
      updateQueueArtwork,
    }),
    [
      addToQueue,
      autoplayEnabled,
      clearQueue,
      clearUpcoming,
      setAutoplayEnabled,
      levelingEnabled,
      setLevelingEnabled,
      startRadio,
      updateQueueArtwork,
      queueNext,
      removeFromQueue,
      reorderUpcoming,
      upcoming,
      skipTo,
      currentTrack,
      isActive,
      matchesSource,
      playNext,
      playPrevious,
      playQueue,
      playTrack,
      engine,
      playback.duration,
      playback.isLoading,
      playback.isPlaying,
      playback.isStarting,
      seek,
      muted,
      setMuted,
      setVolume,
      setShuffleEnabled,
      toggleMute,
      volume,
      state.queue,
      state.currentIndex,
      state.error,
      state.source,
      state.isShuffleEnabled,
      state.repeatMode,
      togglePlayPause,
      toggleRepeat,
      toggleShuffle,
    ],
  );

  return <AudioQueueContext.Provider value={value}>{children}</AudioQueueContext.Provider>;
}
