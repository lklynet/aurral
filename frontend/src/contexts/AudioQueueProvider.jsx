import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getFormatLoadAttempts,
  getHowlerFormat,
  initialQueueState,
  normalizeQueueTrack,
  queueReducer,
  shouldRestartTrack,
} from "../utils/audioQueue";
import { AudioQueueContext } from "./audioQueueContext";
import { recordPlayEvent } from "../utils/api/endpoints/auth";
import { getReleaseGroupCoversBatch } from "../utils/api/endpoints/artists";
import { createAudioEngine } from "../utils/audioEngine";

const SHARED_VOLUME_KEY = "aurral.preview.volume";
const SHARED_VOLUME_EVENT = "aurral:shared-volume-change";
const DEFAULT_VOLUME = 0.7;
const PRELOAD_LEAD_SECONDS = 20;

function normalizeVolume(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, parsed));
}

function readStoredVolume() {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  const stored = window.localStorage.getItem(SHARED_VOLUME_KEY);
  return stored == null ? DEFAULT_VOLUME : normalizeVolume(stored);
}

function writeStoredVolume(value) {
  if (typeof window === "undefined") return;
  const nextVolume = normalizeVolume(value);
  window.localStorage.setItem(SHARED_VOLUME_KEY, String(nextVolume));
  window.dispatchEvent(new CustomEvent(SHARED_VOLUME_EVENT, { detail: nextVolume }));
}

function useSharedVolume() {
  const [volume, setVolumeState] = useState(readStoredVolume);

  useEffect(() => {
    const handleVolumeChange = (event) => {
      if (event.type === "storage" && event.key !== SHARED_VOLUME_KEY) return;
      setVolumeState(
        event.type === SHARED_VOLUME_EVENT ? normalizeVolume(event.detail) : readStoredVolume(),
      );
    };

    window.addEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
    window.addEventListener("storage", handleVolumeChange);

    return () => {
      window.removeEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
      window.removeEventListener("storage", handleVolumeChange);
    };
  }, []);

  const setVolume = useCallback((nextVolume) => {
    const normalized =
      typeof nextVolume === "function"
        ? normalizeVolume(nextVolume(readStoredVolume()))
        : normalizeVolume(nextVolume);
    setVolumeState(normalized);
    writeStoredVolume(normalized);
  }, []);

  return [volume, setVolume];
}

function trackAt(state, playbackIndex) {
  const queueIndex = state.playbackOrder[playbackIndex];
  return queueIndex == null ? null : state.queue[queueIndex] ?? null;
}

function trackSignature(state, playbackIndex, track, formatKey) {
  return `${state.queueRevision}:${track.entryId ?? state.playbackOrder[playbackIndex]}:${track.src}:${formatKey}`;
}

export function AudioQueueProvider({ children }) {
  const [engine] = useState(createAudioEngine);
  const playback = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const [sharedVolume, setSharedVolume] = useSharedVolume();

  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadedSignatureRef = useRef(null);

  const loadTrackRef = useRef(() => {});

  const recordPlay = useCallback((track) => {
    if (!track.recordHistory) return;
    recordPlayEvent({
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
    }).catch(() => {});
  }, []);

  const loadTrack = useCallback((s, playbackIndex, { formatAttemptIndex = 0, autoplay = true } = {}) => {
    const track = trackAt(s, playbackIndex);
    if (!track?.src) return;
    const formatAttempts = getFormatLoadAttempts(track);
    const formatKey = formatAttempts[formatAttemptIndex];
    if (!formatKey) return;
    const signature = trackSignature(s, playbackIndex, track, formatKey);
    if (loadedSignatureRef.current === signature) return;
    loadedSignatureRef.current = signature;

    engine.load({
      src: track.src,
      format: getHowlerFormat(formatKey),
      autoplay,
      onLoadError: () => {
        loadedSignatureRef.current = null;
        if (formatAttemptIndex + 1 >= formatAttempts.length) {
          dispatch({
            type: "SET_ERROR",
            error: "This track is unavailable. Restore the file or refresh the library.",
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
        const action = { type: cur.repeatMode === "one" ? "REPLAY" : "NEXT" };
        const next = queueReducer(cur, action);
        if (next.autoplay) loadTrackRef.current(next, next.currentIndex);
        dispatch(action);
      },
    });
  }, [engine, recordPlay]);

  const loadTrackAtIndex = useCallback(
    (playbackIndex, options) => loadTrack(stateRef.current, playbackIndex, options),
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
    engine.setVolume(sharedVolume);
    engine.setMuted(sharedVolume <= 0);
  }, [engine, sharedVolume]);

  const setShuffleEnabled = useCallback((enabled) => {
    dispatch({ type: "SET_SHUFFLE", enabled });
  }, []);

  const toggleShuffle = useCallback(() => {
    dispatch({ type: "SET_SHUFFLE", enabled: !stateRef.current.isShuffleEnabled });
  }, []);

  const toggleRepeat = useCallback(() => {
    dispatch({ type: "TOGGLE_REPEAT" });
  }, []);

  const playQueue = useCallback((
    tracks,
    { startTrackId = null, source: nextSource = null, shuffle = false } = {},
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
  }, []);

  const playTrack = useCallback((track, options = {}) => {
    const normalized = normalizeQueueTrack(track);
    if (!normalized.src) return false;
    const contextTracks = (
      Array.isArray(options.queue) && options.queue.length > 0
        ? options.queue
        : [track]
    )
      .map((entry) => normalizeQueueTrack(entry))
      .filter((entry) => entry.src);
    if (contextTracks.length === 0) return false;
    return playQueue(contextTracks, {
      startTrackId: normalized.id,
      source: options.source ?? null,
    });
  }, [playQueue]);

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
  }, [engine, loadTrackAtIndex]);

  const playNext = useCallback(() => {
    dispatch({ type: "NEXT" });
  }, []);

  const playPrevious = useCallback(() => {
    const s = stateRef.current;
    if (s.queue.length === 0) return;
    if (shouldRestartTrack(s, engine.getPosition())) {
      engine.seek(0);
      return;
    }
    dispatch({ type: "PREVIOUS" });
  }, [engine]);

  const skipTo = useCallback((playbackIndex) => {
    if (playbackIndex === stateRef.current.currentIndex) return;
    dispatch({ type: "SKIP_TO", index: playbackIndex });
  }, []);

  const clearQueue = useCallback(() => {
    loadedSignatureRef.current = null;
    dispatch({ type: "CLEAR_QUEUE" });
    engine.unload();
  }, [engine]);

  const currentTrack = state.currentIndex >= 0 ? trackAt(state, state.currentIndex) : null;
  const isActive = state.queue.length > 0 && state.currentIndex >= 0;
  const playbackQueue = useMemo(
    () => state.playbackOrder.map((queueIndex) => state.queue[queueIndex]).filter(Boolean),
    [state.playbackOrder, state.queue],
  );

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
  }, [currentAlbum, currentArtist, missingArtworkMbid]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || typeof MediaMetadata === "undefined") return;
    mediaSession.metadata = currentTrack
      ? new MediaMetadata({
          title: currentTrack.title || "",
          artist: currentTrack.artist || "",
          album: currentTrack.album || "",
          artwork: currentTrack.artwork
            ? [{ src: new URL(currentTrack.artwork, window.location.href).href }]
            : [],
        })
      : null;
  }, [currentTrack]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;
    mediaSession.playbackState = !isActive ? "none" : playback.isPlaying ? "playing" : "paused";
  }, [isActive, playback.isPlaying]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !isActive) return undefined;
    const handlers = {
      play: () => {
        if (!engine.getSnapshot().isPlaying) togglePlayPause();
      },
      pause: () => {
        if (engine.getSnapshot().isPlaying) togglePlayPause();
      },
      nexttrack: playNext,
      previoustrack: playPrevious,
      seekto: (details) => {
        if (Number.isFinite(details?.seekTime)) engine.seek(details.seekTime);
      },
      stop: clearQueue,
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [clearQueue, engine, isActive, playNext, playPrevious, togglePlayPause]);

  const matchesSource = useCallback(
    (candidate) => {
      if (!candidate || !state.source) return false;
      if (candidate.type && candidate.type !== state.source.type) return false;
      if (candidate.id != null && String(candidate.id) !== String(state.source.id)) return false;
      return true;
    },
    [state.source],
  );

  const value = useMemo(
    () => ({
      queue: state.queue,
      playbackQueue,
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
      seek: engine.seek,
      volume: sharedVolume,
      setVolume: setSharedVolume,
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
    }),
    [
      clearQueue,
      playbackQueue,
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
      setSharedVolume,
      setShuffleEnabled,
      sharedVolume,
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
