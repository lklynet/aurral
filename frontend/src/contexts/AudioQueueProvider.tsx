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
  getUpcomingTracks,
  getFormatLoadAttempts,
  getHowlerFormat,
  initialQueueState,
  normalizeQueueTrack,
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
} from "../utils/audioQueue";
import { AudioQueueContext } from "./audioQueueContext";
import { useAuth } from "./AuthContext";
import { getRequestToken } from "../utils/api/core";
import { QUEUE_STORAGE_KEY, parseStoredQueue, serializeQueue } from "../utils/queueStorage";
import { parseResponse } from "hono/client";
import { playEventsClient } from "../utils/api/clients/playEvents.ts";
import { getReleaseGroupCoversBatch } from "../utils/api/endpoints/artists";
import { createAudioEngine } from "../utils/audioEngine";
import {
  MEDIA_SESSION_SEEK_SECONDS,
  mediaSessionArtwork,
  mediaSessionPosition,
} from "../utils/mediaSession";

const SHARED_VOLUME_KEY = "aurral.preview.volume";
const SHARED_MUTED_KEY = "aurral.preview.muted";
const SHARED_VOLUME_EVENT = "aurral:shared-volume-change";
const DEFAULT_VOLUME = 0.7;
const PRELOAD_LEAD_SECONDS = 20;
const POSITION_SAVE_MS = 5000;
const PLAYER_CHANNEL = "aurral.player";
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

  const { volume, muted, setVolume, setMuted } = useSharedVolume();

  const [state, applyAction] = useReducer(queueReducer, initialQueueState);
  const dispatch = useCallback((action: QueueAction) => {
    if (!PASSIVE_ACTIONS.has(action.type)) ownsQueueRef.current = true;
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
        onEnd: () => {
          const cur = stateRef.current;
          if (cur.currentIndex < 0) return;
          recordPlay(track);
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

  const clearQueue = useCallback(() => {
    loadedSignatureRef.current = null;
    dispatch({ type: "CLEAR_QUEUE" });
    engine.unload();
  }, [dispatch, engine]);

  const saveQueue = useCallback(() => {
    if (!ownsQueueRef.current || !owner || restoredOwnerRef.current !== owner) return;
    const s = stateRef.current;
    const track = s.currentIndex >= 0 ? trackAt(s, s.currentIndex) : null;
    const resumeAt = resumeAtRef.current;
    let position = 0;
    if (track && loadedSignatureRef.current?.startsWith(`${s.queueRevision}:${track.entryId}:`)) {
      position = engine.getPosition();
    } else if (track && resumeAt?.entryId === track.entryId) {
      position = resumeAt.position;
    }
    writeStoredQueue(serializeQueue(s, { owner, position }));
  }, [engine, owner]);

  useEffect(() => {
    if (restoredOwnerRef.current === owner) return;
    const previousOwner = restoredOwnerRef.current;
    restoredOwnerRef.current = owner;
    let cur = stateRef.current;
    if (previousOwner != null) {
      ownsQueueRef.current = false;
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
    channel.onmessage = (event) => {
      if (event.data?.type !== "playing") return;
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

  const missingArtworkMbid = currentTrack && !currentTrack.artwork ? currentTrack.albumMbid : null;
  const currentArtist = currentTrack?.artist || "";
  const currentAlbum = currentTrack?.album || "";

  useEffect(() => {
    if (!missingArtworkMbid) return undefined;
    let cancelled = false;
    getReleaseGroupCoversBatch([
      { mbid: missingArtworkMbid, artistName: currentArtist, albumTitle: currentAlbum },
    ])
      .then((covers) => {
        const artwork = covers?.[missingArtworkMbid]?.image;
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
      clearQueue,
      clearUpcoming,
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
