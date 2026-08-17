import { useCallback, useMemo, useState } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { getArtistPreview } from "../utils/api/endpoints/artists.js";
import { normalizePreviewTrack } from "../utils/audioQueue";

export function useArtistPreviewPlayback({ mbid, artistName, enabled = true } = {}) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const { playQueue, togglePlayPause, matchesSource, isPlaying, isLoading } = useAudioQueue();

  const source = useMemo(
    () =>
      mbid
        ? {
            type: "artist-preview",
            id: mbid,
            label: artistName || "Artist preview",
          }
        : null,
    [artistName, mbid],
  );
  const canPlayArtistPreview = enabled && Boolean(mbid && artistName);
  const isArtistPreviewSource = matchesSource(source);
  const isArtistPreviewActive = isArtistPreviewSource && (isPlaying || isLoading);

  const playArtistPreview = useCallback(async () => {
    if (!canPlayArtistPreview || isLoadingPreview) return false;
    if (isArtistPreviewSource) {
      togglePlayPause();
      return true;
    }

    setIsLoadingPreview(true);
    try {
      const data = await getArtistPreview(mbid, artistName);
      const tracks = (Array.isArray(data?.tracks) ? data.tracks : [])
        .filter((track) => track?.preview_url)
        .map((track) => normalizePreviewTrack(track, artistName, { artistMbid: mbid }));
      if (tracks.length === 0) return false;
      return playQueue(tracks, {
        source,
        shuffle: false,
        updateShufflePreference: false,
      });
    } finally {
      setIsLoadingPreview(false);
    }
  }, [
    artistName,
    canPlayArtistPreview,
    isArtistPreviewSource,
    isLoadingPreview,
    mbid,
    playQueue,
    source,
    togglePlayPause,
  ]);

  return {
    canPlayArtistPreview,
    isArtistPreviewActive,
    isLoadingPreview,
    playArtistPreview,
  };
}
