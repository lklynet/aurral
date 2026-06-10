import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import PropTypes from "prop-types";
import { useAudioPlayerContext } from "react-use-audio-player";
import { useSharedVolume } from "../hooks/useSharedVolume";
import {
  getFormatLoadAttempts,
  getHowlerFormat,
  normalizeQueueTrack,
} from "../utils/audioQueue";
import { AudioQueueContext } from "./audioQueueContext";

function shuffleIds(ids) {
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function AudioQueueProvider({ children }) {
  const player = useAudioPlayerContext();
  const playerRef = useRef(player);
  playerRef.current = player;

  const [sharedVolume, setSharedVolume] = useSharedVolume();
  const sharedVolumeRef = useRef(sharedVolume);
  sharedVolumeRef.current = sharedVolume;

  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [source, setSource] = useState(null);
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);
  const [playbackOrder, setPlaybackOrder] = useState([]);
  const queueRef = useRef([]);
  const currentIndexRef = useRef(-1);
  const playbackOrderRef = useRef([]);
  const isShuffleRef = useRef(false);
  const [repeatMode, setRepeatMode] = useState("off");
  const repeatModeRef = useRef("off");
  const loadedSignatureRef = useRef(null);
  const [queueRevision, setQueueRevision] = useState(0);
  const queueRevisionRef = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    playbackOrderRef.current = playbackOrder;
  }, [playbackOrder]);

  useEffect(() => {
    isShuffleRef.current = isShuffleEnabled;
  }, [isShuffleEnabled]);

  useEffect(() => {
    queueRevisionRef.current = queueRevision;
  }, [queueRevision]);

  useEffect(() => {
    repeatModeRef.current = repeatMode;
  }, [repeatMode]);

  const getTrackAt = useCallback((playbackIndex) => {
    const order = playbackOrderRef.current;
    const queueIndex = order[playbackIndex];
    if (queueIndex == null) return null;
    return queueRef.current[queueIndex] ?? null;
  }, []);

  const advanceRef = useRef(() => {});
  const loadTrackAtIndexRef = useRef(() => {});

  const loadTrackAtIndex = useCallback((playbackIndex, formatAttemptIndex = 0) => {
    const order = playbackOrderRef.current;
    const queueIndex = order[playbackIndex];
    const track =
      queueIndex == null ? null : queueRef.current[queueIndex] ?? null;
    if (!track?.src) {
      advanceRef.current({ fromUserSkip: true });
      return;
    }
    const formatAttempts = getFormatLoadAttempts(track);
    const formatKey = formatAttempts[formatAttemptIndex];
    if (!formatKey) {
      advanceRef.current({ fromUserSkip: true });
      return;
    }
    const signature = `${queueRevisionRef.current}:${queueIndex}:${track.src}:${formatKey}`;
    if (loadedSignatureRef.current === signature) return;
    loadedSignatureRef.current = signature;

    playerRef.current.stop();
    playerRef.current.load(track.src, {
      autoplay: true,
      initialVolume: sharedVolumeRef.current,
      html5: true,
      format: getHowlerFormat(formatKey),
      onloaderror: () => {
        loadedSignatureRef.current = null;
        loadTrackAtIndexRef.current(playbackIndex, formatAttemptIndex + 1);
      },
      onend: () => {
        advanceRef.current();
      },
    });
  }, []);

  useEffect(() => {
    loadTrackAtIndexRef.current = loadTrackAtIndex;
  }, [loadTrackAtIndex]);

  const advance = useCallback(({ fromUserSkip = false } = {}) => {
    const currentPlaybackIndex = currentIndexRef.current;
    if (currentPlaybackIndex < 0) return;

    if (repeatModeRef.current === "one" && !fromUserSkip) {
      loadedSignatureRef.current = null;
      loadTrackAtIndexRef.current(currentPlaybackIndex);
      return;
    }

    const nextIndex = currentPlaybackIndex + 1;
    if (nextIndex < playbackOrderRef.current.length) {
      setCurrentIndex(nextIndex);
      return;
    }

    if (
      repeatModeRef.current === "all" &&
      playbackOrderRef.current.length > 0
    ) {
      loadedSignatureRef.current = null;
      setCurrentIndex(0);
      setQueueRevision((revision) => revision + 1);
      return;
    }

    loadedSignatureRef.current = null;
    setCurrentIndex(-1);
    setQueue([]);
    setPlaybackOrder([]);
    setSource(null);
    playerRef.current.stop();
  }, []);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useEffect(() => {
    if (currentIndex < 0) {
      loadedSignatureRef.current = null;
      return;
    }
    loadTrackAtIndex(currentIndex);
  }, [currentIndex, queueRevision, loadTrackAtIndex]);

  useEffect(() => {
    const activePlayer = playerRef.current;
    activePlayer.setVolume(sharedVolume);
    if (sharedVolume <= 0) {
      activePlayer.mute();
      return;
    }
    activePlayer.unmute();
  }, [sharedVolume]);

  const buildPlaybackOrder = useCallback((tracks, shuffle) => {
    const indices = tracks.map((_, index) => index);
    return shuffle ? shuffleIds(indices) : indices;
  }, []);

  const setShuffleEnabled = useCallback(
    (enabled) => {
      setIsShuffleEnabled(enabled);
      isShuffleRef.current = enabled;
      if (queueRef.current.length === 0 || currentIndexRef.current < 0) {
        return;
      }
      const currentPlaybackIndex = currentIndexRef.current;
      const currentQueueIndex = playbackOrderRef.current[currentPlaybackIndex];
      const order = buildPlaybackOrder(queueRef.current, enabled);
      playbackOrderRef.current = order;
      setPlaybackOrder(order);
      if (currentQueueIndex == null) return;
      const nextPlaybackIndex = order.findIndex(
        (index) => index === currentQueueIndex,
      );
      if (nextPlaybackIndex >= 0 && nextPlaybackIndex !== currentPlaybackIndex) {
        currentIndexRef.current = nextPlaybackIndex;
        setCurrentIndex(nextPlaybackIndex);
      }
    },
    [buildPlaybackOrder],
  );

  const toggleShuffle = useCallback(() => {
    setShuffleEnabled(!isShuffleRef.current);
  }, [setShuffleEnabled]);

  const toggleRepeat = useCallback(() => {
    setRepeatMode((mode) => {
      if (mode === "off") return "all";
      if (mode === "all") return "one";
      return "off";
    });
  }, []);

  const playQueue = useCallback(
    (
      tracks,
      {
        startIndex = 0,
        startTrackId = null,
        source: nextSource = null,
        shuffle = false,
        updateShufflePreference = true,
      } = {},
    ) => {
      const normalized = (Array.isArray(tracks) ? tracks : [])
        .map((track) => normalizeQueueTrack(track))
        .filter((track) => track.src);
      if (normalized.length === 0) return false;

      const order = buildPlaybackOrder(normalized, shuffle);
      let boundedStart = Math.max(0, Math.min(startIndex, order.length - 1));
      if (startTrackId != null) {
        const queueIndex = normalized.findIndex(
          (track) => String(track.id) === String(startTrackId),
        );
        if (queueIndex >= 0) {
          const playbackIndex = order.findIndex((index) => index === queueIndex);
          if (playbackIndex >= 0) {
            boundedStart = playbackIndex;
          }
        }
      }

      loadedSignatureRef.current = null;
      queueRef.current = normalized;
      playbackOrderRef.current = order;
      if (updateShufflePreference) {
        isShuffleRef.current = shuffle;
        setIsShuffleEnabled(shuffle);
      }
      setQueue(normalized);
      setPlaybackOrder(order);
      setSource(nextSource);
      setCurrentIndex(boundedStart);
      setQueueRevision((revision) => revision + 1);
      return true;
    },
    [buildPlaybackOrder],
  );

  const playTrack = useCallback(
    (track, options = {}) => {
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
        shuffle: options.shuffle ?? isShuffleRef.current,
        updateShufflePreference: options.updateShufflePreference ?? false,
      });
    },
    [playQueue],
  );

  const togglePlayPause = useCallback(() => {
    if (queueRef.current.length === 0) return;
    const activePlayer = playerRef.current;
    if (activePlayer.isPlaying) {
      activePlayer.pause();
      return;
    }
    if (activePlayer.isReady || activePlayer.src) {
      activePlayer.play();
      return;
    }
    if (currentIndexRef.current >= 0) {
      loadedSignatureRef.current = null;
      loadTrackAtIndex(currentIndexRef.current);
    }
  }, [loadTrackAtIndex]);

  const playNext = useCallback(() => {
    if (queueRef.current.length === 0) return;
    if (currentIndexRef.current < 0) {
      const order = buildPlaybackOrder(
        queueRef.current,
        isShuffleRef.current,
      );
      loadedSignatureRef.current = null;
      playbackOrderRef.current = order;
      setPlaybackOrder(order);
      setCurrentIndex(0);
      setQueueRevision((revision) => revision + 1);
      return;
    }
    advance({ fromUserSkip: true });
  }, [advance, buildPlaybackOrder]);

  const playPrevious = useCallback(() => {
    if (queueRef.current.length === 0) return;
    if (currentIndexRef.current < 0) {
      const order = buildPlaybackOrder(
        queueRef.current,
        isShuffleRef.current,
      );
      loadedSignatureRef.current = null;
      playbackOrderRef.current = order;
      setPlaybackOrder(order);
      setCurrentIndex(0);
      setQueueRevision((revision) => revision + 1);
      return;
    }
    const prevIndex = currentIndexRef.current - 1;
    if (prevIndex >= 0) {
      loadedSignatureRef.current = null;
      setCurrentIndex(prevIndex);
      return;
    }
    const position = playerRef.current.getPosition();
    if (position > 3) {
      playerRef.current.seek(0);
    }
  }, [buildPlaybackOrder]);

  const clearQueue = useCallback(() => {
    loadedSignatureRef.current = null;
    setQueue([]);
    setPlaybackOrder([]);
    setCurrentIndex(-1);
    setSource(null);
    setIsShuffleEnabled(false);
    isShuffleRef.current = false;
    setRepeatMode("off");
    repeatModeRef.current = "off";
    playerRef.current.stop();
    playerRef.current.cleanup();
  }, []);

  const currentTrack =
    currentIndex >= 0 ? getTrackAt(currentIndex) : null;

  const isActive = queue.length > 0 && currentIndex >= 0;

  const matchesSource = useCallback(
    (candidate) => {
      if (!candidate || !source) return false;
      if (candidate.type && candidate.type !== source.type) return false;
      if (candidate.id != null && String(candidate.id) !== String(source.id)) {
        return false;
      }
      return true;
    },
    [source],
  );

  const value = useMemo(
    () => ({
      queue,
      currentTrack,
      currentIndex,
      source,
      isActive,
      isPlaying: player.isPlaying,
      isLoading: player.isLoading,
      isPaused: player.isPaused,
      duration: player.duration,
      getPosition: player.getPosition,
      seek: player.seek,
      volume: sharedVolume,
      setVolume: setSharedVolume,
      isShuffleEnabled,
      setShuffleEnabled,
      repeatMode,
      toggleRepeat,
      playQueue,
      playTrack,
      togglePlayPause,
      playNext,
      playPrevious,
      clearQueue,
      toggleShuffle,
      matchesSource,
    }),
    [
      clearQueue,
      currentIndex,
      currentTrack,
      isActive,
      isShuffleEnabled,
      matchesSource,
      playNext,
      playPrevious,
      playQueue,
      playTrack,
      player.duration,
      player.getPosition,
      player.isLoading,
      player.isPaused,
      player.isPlaying,
      player.seek,
      queue,
      repeatMode,
      setSharedVolume,
      setShuffleEnabled,
      sharedVolume,
      source,
      togglePlayPause,
      toggleRepeat,
      toggleShuffle,
    ],
  );

  return (
    <AudioQueueContext.Provider value={value}>
      {children}
    </AudioQueueContext.Provider>
  );
}

AudioQueueProvider.propTypes = {
  children: PropTypes.node.isRequired,
};
