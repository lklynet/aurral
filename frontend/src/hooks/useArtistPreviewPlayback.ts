import { useCallback, useMemo, useState } from "react";
import { parseResponse } from "hono/client";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { getArtistPreview } from "../utils/api/endpoints/artists.ts";
import { libraryArtistsClient } from "../utils/api/clients/libraryArtists.ts";
import { normalizePreviewTrack, normalizeStreamQueueTrack } from "../utils/audioQueue";

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

const loadLibraryTracks = async (mbid: string | number) => {
  const { tracks } = await parseResponse(
    libraryArtistsClient.artists[":mbid"].queue.$get({ param: { mbid: String(mbid) } }),
  );
  return tracks.map(normalizeStreamQueueTrack);
};

const loadPreviewTracks = async (mbid: string | number, artistName: string | null | undefined) => {
  const data: ArtistPreviewResponse | null | undefined = await getArtistPreview(mbid, artistName);
  return (Array.isArray(data?.tracks) ? data.tracks : [])
    .filter((track) => track?.preview_url)
    .map((track) => normalizePreviewTrack(track, artistName, { artistMbid: mbid }));
};

export function useArtistPreviewPlayback({
  mbid,
  artistName,
  enabled = true,
  isInLibrary = false,
}: ArtistPreviewPlaybackOptions = {}) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const { playQueue, togglePlayPause, matchesSource, isPlaying, isLoading } = useAudioQueue();

  const source = useMemo(
    () =>
      mbid
        ? {
            type: isInLibrary ? "artist-library" : "artist-preview",
            id: mbid,
            label: artistName || "Artist preview",
          }
        : null,
    [artistName, isInLibrary, mbid],
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
      const libraryTracks = isInLibrary ? await loadLibraryTracks(mbid).catch(() => []) : [];
      const tracks = libraryTracks.length
        ? libraryTracks
        : await loadPreviewTracks(mbid, artistName);
      if (tracks.length === 0) return false;
      return playQueue(tracks, { source });
    } finally {
      setIsLoadingPreview(false);
    }
  }, [
    artistName,
    canPlayArtistPreview,
    isArtistPreviewSource,
    isInLibrary,
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
