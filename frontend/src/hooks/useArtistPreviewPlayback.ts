import { useCallback, useMemo, useState } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { getArtistPreview } from "../utils/api/endpoints/artists.ts";
import { normalizePreviewTrack } from "../utils/audioQueue";

interface ArtistPreviewTrack {
  preview_url?: string | null;
}

interface ArtistPreviewResponse {
  tracks?: ArtistPreviewTrack[];
}

interface ArtistPreviewPlaybackOptions {
  mbid?: string | number | null;
  artistName?: string | null;
  enabled?: boolean;
  isInLibrary?: boolean;
}

export function useArtistPreviewPlayback({
  mbid,
  artistName,
  enabled = true,
}: ArtistPreviewPlaybackOptions = {}) {
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
    if (!mbid || !canPlayArtistPreview || isLoadingPreview) return false;
    if (isArtistPreviewSource) {
      togglePlayPause();
      return true;
    }

    setIsLoadingPreview(true);
    try {
      const data: ArtistPreviewResponse | null | undefined = await getArtistPreview(
        mbid,
        artistName,
      );
      const tracks = (Array.isArray(data?.tracks) ? data.tracks : [])
        .filter((track) => track?.preview_url)
        .map((track) => normalizePreviewTrack(track, artistName, { artistMbid: mbid }));
      if (tracks.length === 0) return false;
      return playQueue(tracks, { source });
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
