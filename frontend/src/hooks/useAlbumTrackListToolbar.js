import { useCallback, useMemo } from "react";
import { useAudioQueue } from "./useAudioQueue";

export function useAlbumTrackListToolbar({ getQueueTracks, playbackSource }) {
  const {
    playQueue,
    togglePlayPause,
    isShuffleEnabled,
    matchesSource,
    isPlaying,
    isLoading,
    currentTrack,
  } = useAudioQueue();

  const queueTracks = useMemo(() => getQueueTracks(), [getQueueTracks]);

  const isSourceActive = matchesSource(playbackSource);
  const isCurrentListTrack = useMemo(
    () =>
      !!currentTrack &&
      queueTracks.some(
        (track) => String(track.id) === String(currentTrack.id),
      ),
    [currentTrack, queueTracks],
  );
  const isListPlaying =
    isSourceActive && isCurrentListTrack && (isPlaying || isLoading);

  const handlePlayAll = useCallback(() => {
    if (queueTracks.length === 0) return;
    if (isSourceActive && isCurrentListTrack) {
      togglePlayPause();
      return;
    }
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: false,
      updateShufflePreference: false,
    });
  }, [
    isCurrentListTrack,
    isSourceActive,
    playbackSource,
    playQueue,
    queueTracks,
    togglePlayPause,
  ]);

  const handleShufflePlay = useCallback(() => {
    if (queueTracks.length === 0) return;
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: true,
      updateShufflePreference: true,
    });
  }, [playbackSource, playQueue, queueTracks]);

  return {
    disabled: queueTracks.length === 0,
    isListPlaying,
    isShuffleEnabled,
    handlePlayAll,
    handleShufflePlay,
  };
}
