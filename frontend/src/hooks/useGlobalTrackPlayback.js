import { useCallback } from "react";
import { useAudioQueue } from "./useAudioQueue";

export function useGlobalTrackPlayback(normalizeTrack) {
  const {
    currentTrack,
    isPlaying,
    isLoading,
    playTrack,
    togglePlayPause,
    source,
  } = useAudioQueue();

  const handlePlay = useCallback(
    (track, options = {}, ...normalizeArgs) => {
      const normalized = normalizeTrack(track, ...normalizeArgs);
      if (!normalized?.src) return;
      if (currentTrack?.id === normalized.id) {
        togglePlayPause();
        return;
      }
      playTrack(normalized, {
        source: options.source ?? source,
        queue: options.queue,
        shuffle: options.shuffle,
        updateShufflePreference: options.updateShufflePreference,
      });
    },
    [currentTrack?.id, normalizeTrack, playTrack, source, togglePlayPause],
  );

  const isTrackPlaying = useCallback(
    (trackId) =>
      !!trackId &&
      currentTrack?.id === String(trackId) &&
      (isPlaying || isLoading),
    [currentTrack?.id, isLoading, isPlaying],
  );

  const isTrackLoading = useCallback(
    (trackId) =>
      !!trackId && currentTrack?.id === String(trackId) && isLoading,
    [currentTrack?.id, isLoading],
  );

  return {
    currentTrack,
    playingTrackId: isTrackPlaying(currentTrack?.id)
      ? currentTrack?.id
      : null,
    loadingTrackId: isTrackLoading(currentTrack?.id) ? currentTrack?.id : null,
    isTrackPlaying,
    isTrackLoading,
    handlePlay,
  };
}
